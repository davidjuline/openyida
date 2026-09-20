/**
 * oauth-device.js - Device Authorization Grant (RFC 8628) flow.
 *
 * Enables headless / sandbox login: the CLI requests a device code from the
 * auth service, the user completes authorization on ANY device (phone,
 * another browser, CI dashboard), and the CLI polls until tokens are issued.
 *
 * The /device/* endpoints use a unified camelCase contract (deviceCode,
 * userCode, verificationUri, grantType, accessToken, ...) matching the
 * tianshu CliAuthRpc device endpoints. Legacy CLI token endpoints
 * (/dingtalk/token, /refresh, /status) keep their snake_case contract and are
 * not handled here.
 *
 * Reuses the same token normalization / profile persistence pipeline as the
 * loopback flow in oauth-loopback.js.
 */

const { requestJson } = require('./token-auth');

const DEVICE_CODE_PATH = '/device/code';
const DEVICE_TOKEN_PATH = '/device/token';
const DEFAULT_DEVICE_TIMEOUT_MS = 10 * 60 * 1000; // device codes are usually valid 10 minutes
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const SLOW_DOWN_EXTRA_DELAY_MS = 5 * 1000;

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Request a device code from the auth service.
 *
 * @param {object} options
 * @param {string} options.authBaseUrl - e.g. https://yida-group.alibaba-inc.com/openapi/cli/v1/auth
 * @param {string} options.clientId
 * @param {string} [options.scope] - defaults handled by caller
 * @param {string} [options.envHint] - environment name to pin the token audience
 * @param {string} [options.timeoutMs] - overall flow timeout
 * @returns {Promise<{deviceCode, userCode, verificationUri,
 *   verificationUriComplete, expiresIn, interval}>}
 */
async function requestDeviceCode(options = {}) {
  const { authBaseUrl, clientId } = options;
  if (!authBaseUrl || !clientId) {
    throw new Error('device code flow requires authBaseUrl and clientId');
  }
  const body = { clientId };
  if (options.scope) { body.scope = options.scope; }
  if (options.envHint) { body.envHint = options.envHint; }

  const response = await requestJson(
    'POST',
    `${authBaseUrl}${DEVICE_CODE_PATH}`,
    body
  );
  const payload = unwrapPayload(response);
  if (!payload.deviceCode || !payload.userCode || !payload.verificationUri) {
    const message = payload.message || payload.errorDescription || payload.errorMsg
      || 'auth service did not return a usable device code';
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}

/**
 * Poll the token endpoint until the device flow completes.
 *
 * @param {object} options
 * @param {string} options.authBaseUrl
 * @param {string} options.clientId
 * @param {string} options.deviceCode
 * @param {number} [options.intervalMs] - from /device/code response
 * @param {number} [options.timeoutMs] - overall wall clock budget
 * @param {(state: object) => void} [options.onState] - progress callback for agents
 * @returns {Promise<object>} token payload (accessToken, refreshToken, ...)
 */
async function pollDeviceToken(options = {}) {
  const { authBaseUrl, clientId, deviceCode } = options;
  if (!authBaseUrl || !clientId || !deviceCode) {
    throw new Error('device token polling requires authBaseUrl, clientId and deviceCode');
  }
  const intervalMs = Math.max(1, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + (Number(options.timeoutMs) || DEFAULT_DEVICE_TIMEOUT_MS);
  let currentInterval = intervalMs;

  // First poll immediately, then honor the interval.
  for (;;) {
    let response;
    try {
      response = await requestJson('POST', `${authBaseUrl}${DEVICE_TOKEN_PATH}`, {
        grantType: DEVICE_GRANT_TYPE,
        deviceCode: deviceCode,
        clientId: clientId,
      });
    } catch (error) {
      const payload = error.payload || {};
      const errorCode = payload.error || payload.errorCode || payload.error_msg || payload.errorMsg;
      if (errorCode === 'authorization_pending') {
        await waitFor(deadline, currentInterval, options);
        continue;
      }
      if (errorCode === 'slow_down') {
        currentInterval += SLOW_DOWN_EXTRA_DELAY_MS;
        if (options.onState) {
          options.onState({ state: 'slow_down', intervalMs: currentInterval });
        }
        await waitFor(deadline, currentInterval, options);
        continue;
      }
      if (errorCode === 'expired_token') {
        const expired = new Error('device code expired; run login --device again');
        expired.code = 'device_code_expired';
        throw expired;
      }
      if (errorCode === 'access_denied') {
        const denied = new Error('authorization was denied on the verification page');
        denied.code = 'device_access_denied';
        throw denied;
      }
      if (error.statusCode === 400 || error.statusCode === 429) {
        // Unrecognized 400/429 bodies are treated as transient: the device
        // flow relies on HTTP 400 to carry authorization_pending, so gateways
        // or intermediate error shapes must not abort polling on the first
        // hop. Keep polling until the overall deadline expires.
        if (options.onState) {
          options.onState({
            state: 'poll_retry',
            statusCode: error.statusCode,
            body: typeof payload.errorDescription === 'string'
              ? payload.errorDescription
              : (payload.error_description || payload.errorMsg || payload.raw || '')
                .toString().slice(0, 200),
          });
        }
        await waitFor(deadline, currentInterval, options);
        continue;
      }
      throw error;
    }

    const payload = unwrapPayload(response);
    if (!payload.accessToken && !payload.access_token) {
      // 2xx without a token is unexpected; surface raw payload for diagnosis.
      const invalid = new Error('auth service returned 2xx without accessToken');
      invalid.payload = payload;
      throw invalid;
    }
    return payload;
  }
}

function waitFor(deadline, intervalMs, options) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const timeout = new Error('device authorization timed out; device code may still be pending');
    timeout.code = 'device_timeout';
    throw timeout;
  }
  if (options && options.onState) {
    options.onState({ state: 'pending', nextPollMs: Math.min(intervalMs, remaining) });
  }
  return new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
}

function unwrapPayload(response) {
  if (response && typeof response === 'object' && response.content && typeof response.content === 'object') {
    return response.content;
  }
  return response || {};
}

/**
 * Run the full device code flow and return a token payload for
 * normalizeTokenResponse(). Designed to be called from tokenLogin().
 *
 * @param {object} options - same option bag as tokenLogin plus:
 *   options.authBaseUrl  resolved auth base (with /openapi/cli/v1/auth prefix)
 *   options.envHint      environment name to pin audience
 *   options.quiet        suppress human-oriented stderr
 *   options.onState      optional machine-readable progress callback
 */
async function runDeviceCodeFlow(options = {}) {
  const code = await requestDeviceCode(options);

  // The server may return verification URIs as absolute paths (e.g.
  // /openapi/cli/v1/auth/device/verify); resolve them against the business
  // base URL so users and agent hosts get clickable links.
  const resolveUrl = (value) => {
    if (!value || /^https?:\/\//i.test(value)) {
      return value;
    }
    try {
      const origin = new URL(options.baseUrl || options.authBaseUrl).origin;
      return new URL(value, origin).toString();
    } catch {
      return value;
    }
  };
  const verificationUri = resolveUrl(code.verificationUri);
  const verificationUriComplete = resolveUrl(code.verificationUriComplete);

  const intro = [
    '',
    'Device code login:',
    `  1. Open ${verificationUri}`,
    `  2. Enter code: ${code.userCode}`,
    '',
  ];
  if (verificationUriComplete) {
    intro.push(`  Or open directly: ${verificationUriComplete}`, '');
  }
  if (!options.quiet) {
    process.stderr.write(intro.join('\n') + '\n');
  }

  if (options.onState) {
    options.onState({
      state: 'awaiting_verification',
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      user_code: code.userCode,
      expires_in: code.expiresIn,
      interval: code.interval,
    });
  }

  const tokenPayload = await pollDeviceToken({
    authBaseUrl: options.authBaseUrl,
    clientId: options.clientId,
    deviceCode: code.deviceCode,
    intervalMs: (code.interval || 5) * 1000,
    timeoutMs: (code.expiresIn || 600) * 1000,
    onState: options.onState,
  });

  if (!options.quiet) {
    process.stderr.write('Device authorization completed.\n');
  }
  return tokenPayload;
}

module.exports = {
  runDeviceCodeFlow,
  requestDeviceCode,
  pollDeviceToken,
  DEVICE_CODE_PATH,
  DEVICE_TOKEN_PATH,
  DEVICE_GRANT_TYPE,
};
