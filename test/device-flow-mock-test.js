/**
 * Mock auth server + end-to-end test of the device code flow.
 * Simulates: /device/code issue -> pending polls -> approval -> token issue.
 */
const http = require('http');

const PORT = 3999;
const AUTH_BASE = `http://127.0.0.1:${PORT}/openapi/cli/v1/auth`;

let approvals = {}; // device_code -> { approved: bool }
let pollCounts = {};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.setHeader('content-type', 'application/json');

    if (req.url.endsWith('/device/code')) {
      const code = {
        device_code: 'dev-' + Math.random().toString(36).slice(2, 10),
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://example.com/verify',
        verification_uri_complete: 'http://example.com/verify?code=ABCD-EFGH',
        expires_in: 120,
        interval: 1,
      };
      approvals[code.device_code] = { approved: false };
      // auto-approve after 2.5s to simulate the user authorizing
      setTimeout(() => { approvals[code.device_code].approved = true; }, 2500);
      res.end(JSON.stringify(code));
      return;
    }

    if (req.url.endsWith('/device/token')) {
      const state = approvals[req.body_device_code || body.device_code];
      const count = (pollCounts[body.device_code] = (pollCounts[body.device_code] || 0) + 1);
      if (!state) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'access_denied' }));
        return;
      }
      if (!state.approved) {
        if (count === 2) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'slow_down' }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'authorization_pending' }));
        }
        return;
      }
      res.end(JSON.stringify({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_in: 1800,
        user_name: 'mock-user',
        user_id: '42',
        corp_id: 'mock-corp',
        base_url: 'http://127.0.0.1:3999',
        status: 'ok',
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
      access_token: token.access_token,
      user: token.user_name,
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
