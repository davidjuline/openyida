/**
 * Mock auth server + end-to-end test of the device code flow (camelCase
 * contract, mirroring tianshu CliAuthRpc device endpoints).
 * Simulates: /device/code issue -> pending polls -> approval -> token issue.
 */
const http = require('http');

const PORT = 3999;
const AUTH_BASE = `http://127.0.0.1:${PORT}/openapi/cli/v1/auth`;

let approvals = {}; // deviceCode -> { approved: bool }
let pollCounts = {};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.setHeader('content-type', 'application/json');

    if (req.url.endsWith('/device/code')) {
      const code = {
        deviceCode: 'dev-' + Math.random().toString(36).slice(2, 10),
        userCode: 'ABCD-EFGH',
        verificationUri: 'http://example.com/verify',
        verificationUriComplete: 'http://example.com/verify?userCode=ABCD-EFGH',
        expiresIn: 120,
        interval: 1,
      };
      approvals[code.deviceCode] = { approved: false };
      // auto-approve after 2.5s to simulate the user authorizing
      setTimeout(() => { approvals[code.deviceCode].approved = true; }, 2500);
      res.end(JSON.stringify(code));
      return;
    }

    if (req.url.endsWith('/device/token')) {
      if (body.grantType !== 'urn:ietf:params:oauth:grant-type:device_code' || !body.deviceCode) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_request', errorDescription: 'deviceCode is required' }));
        return;
      }
      const state = approvals[body.deviceCode];
      const count = (pollCounts[body.deviceCode] = (pollCounts[body.deviceCode] || 0) + 1);
      if (!state) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'access_denied', errorDescription: 'denied' }));
        return;
      }
      if (!state.approved) {
        if (count === 2) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'slow_down', errorDescription: 'poll faster' }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'authorization_pending', errorDescription: 'pending' }));
        }
        return;
      }
      res.end(JSON.stringify({
        status: 'ok',
        tokenType: 'Bearer',
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 1800,
        refreshTokenExpiresIn: 2592000,
        userName: 'mock-user',
        userId: '42',
        corpId: 'mock-corp',
        baseUrl: `http://127.0.0.1:${PORT}`,
      }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });
});

server.listen(PORT, async () => {
  const { runDeviceCodeFlow } = require('/Users/david/openyida/lib/auth/oauth-device');
  const events = [];
  try {
    const token = await runDeviceCodeFlow({
      authBaseUrl: AUTH_BASE,
      clientId: 'test-client',
      envHint: 'alibaba',
      quiet: true,
      onState: (s) => events.push(s.state),
    });
    console.log('RESULT:', JSON.stringify({
      accessToken: token.accessToken,
      user: token.userName,
      events,
    }));
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message, '| events:', events);
    server.close();
    process.exit(1);
  }
});
