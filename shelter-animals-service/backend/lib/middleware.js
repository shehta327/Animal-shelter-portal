// Request middleware shared by every service: request id + structured access
// log, security headers, JSON-only bodies, and the API Gateway body fix.
const crypto = require('crypto');
const log = require('./logger');

function requestLogger(req, res, next) {
  req.id = crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    const fields = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - started,
      userId: req.user ? req.user.sub : undefined,
      role: req.user ? req.user.role : undefined
    };
    if (res.statusCode === 401 || res.statusCode === 403) {
      // Security signal: CloudWatch metric filter counts these lines
      log.warn('AUTH_DENIED', { ...fields, reason: req.authFailure });
    } else if (res.statusCode >= 500) {
      log.error('request failed', fields);
    } else {
      log.info('request', fields);
    }
  });
  next();
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer'
  });
  next();
}

// 415 for writes that are not JSON (stops form-encoded CSRF-style posts)
function jsonOnly(req, res, next) {
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasBody && !req.is('application/json')) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON with Content-Type: application/json.' }
    });
  }
  return next();
}

// From Lab 7: some API Gateway emulators hand Lambda the body as a Buffer or
// base64 text. Turn it into an object so validation sees the real fields.
const MAX_BODY_BYTES = 20 * 1024; // same limit as express.json({ limit: '20kb' }) in app.js

function bodyFix(req, res, next) {
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    const raw = req.body.toString('utf8').trim();
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(raw) && !raw.startsWith('{')
      ? Buffer.from(raw, 'base64').toString('utf8')
      : raw;
    // In Lambda, serverless-http hands over the already-read body, so express.json's
    // 20 kB limit never runs: enforce the same limit here (413, like on a PC).
    if (Buffer.byteLength(decoded, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
    }
    try {
      req.body = decoded ? JSON.parse(decoded) : {};
    } catch {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
    }
  }
  if (req.body === undefined || req.body === null) req.body = {};
  return next();
}

module.exports = { requestLogger, securityHeaders, jsonOnly, bodyFix };
