// Calls a sibling service through the shared API Gateway (the same public
// routes the website uses). The caller's own token is forwarded, so the
// other service applies its own authorization: no shared service password.
//
// API_BASE_URL     the gateway URL, e.g. http://abc123.execute-api.localhost.floci.io:4566
// API_CONNECT_URL  optional: where to open the TCP connection when the gateway
//                  host name does not resolve inside the Lambda container (Floci).
//                  The Host header still names the gateway, so routing is unchanged.
const http = require('http');
const https = require('https');
const { unavailable } = require('./http');
const log = require('./logger');

function request(url, { headers, timeoutMs }) {
  const target = new URL(url);
  const connect = process.env.API_CONNECT_URL ? new URL(process.env.API_CONNECT_URL) : target;
  const lib = connect.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: connect.protocol,
      hostname: connect.hostname,
      port: connect.port || (connect.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { ...headers, Host: target.host, Accept: 'application/json' },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function callService(path, { token, timeoutMs = 5000 } = {}) {
  try {
    return await request(`${process.env.API_BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeoutMs
    });
  } catch (error) {
    log.error('service call failed', { path: path.split('?')[0], error: error.message });
    throw unavailable();
  }
}

module.exports = { callService };
