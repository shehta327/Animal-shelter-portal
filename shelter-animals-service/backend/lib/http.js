// Errors with an HTTP status, and the middleware that turns them into the
// shared error format: { "error": { "code", "message", "details"? } }.
const log = require('./logger');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Sign in required.') => new HttpError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You do not have access to this action.') => new HttpError(403, 'FORBIDDEN', message);
const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
const conflict = (code, message) => new HttpError(409, code, message);
const unavailable = (message = 'A required service is not available. Try again shortly.') =>
  new HttpError(503, 'DEPENDENCY_UNAVAILABLE', message);

function notFoundRoute(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
  }
  // Details go to CloudWatch Logs only; the client never sees a stack trace.
  log.error('unhandled error', { requestId: req.id, path: req.originalUrl.split('?')[0], error: err.name, detail: err.message });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, unavailable, notFoundRoute, errorHandler };
