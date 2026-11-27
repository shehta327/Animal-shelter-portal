// Shared team authentication contract (the same file in every service).
// Login happens in Amazon Cognito (user pool "shelter-users"). Every protected
// request carries the Cognito ID token as "Authorization: Bearer <token>".
// This middleware verifies it in the backend: RS256 signature against the
// pool's public keys (JWKS), issuer, audience (our app client), expiry and
// token_use. The role comes from the Cognito group in the signed token, so a
// client cannot change it.
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { unauthorized, forbidden } = require('./http');

const ISSUER = process.env.COGNITO_ISSUER;                 // e.g. http://localhost:4566/us-east-1_abc123
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const JWKS_URL = process.env.COGNITO_JWKS_URL || `${ISSUER}/.well-known/jwks.json`;

let jwks;
const getJwks = () => {
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL), { cacheMaxAge: 10 * 60 * 1000 });
  return jwks;
};

const ROLES = { ADOPTER: 'adopter', STAFF: 'staff', ADMIN: 'admin' };
const STAFF_ROLES = [ROLES.STAFF, ROLES.ADMIN];

function roleFromGroups(groups) {
  if (groups.includes('Admin')) return ROLES.ADMIN;
  if (groups.includes('Staff')) return ROLES.STAFF;
  return ROLES.ADOPTER;
}

async function verifyToken(token) {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: ISSUER,
    audience: CLIENT_ID,
    algorithms: ['RS256']
  });
  if (payload.token_use !== 'id') throw new Error('not an ID token');
  const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [];
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    groups,
    role: roleFromGroups(groups),
    token
  };
}

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// Protected routes: no valid token -> 401
async function authenticate(req, res, next) {
  const token = bearer(req);
  if (!token) {
    req.authFailure = 'missing token';
    return next(unauthorized());
  }
  try {
    req.user = await verifyToken(token);
    return next();
  } catch (error) {
    req.authFailure = error.code || error.message;          // e.g. ERR_JWT_EXPIRED, never the token
    return next(unauthorized('Session expired or invalid. Sign in again.'));
  }
}

// Public routes that show more to signed-in staff: a bad token is still a 401
async function optionalAuth(req, res, next) {
  if (!bearer(req)) return next();
  return authenticate(req, res, next);
}

// Deny by default: only the listed roles pass -> otherwise 403
const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) return next();
  req.authFailure = `role ${req.user ? req.user.role : 'none'} not in [${roles.join(',')}]`;
  return next(forbidden());
};

const isStaff = (user) => Boolean(user) && STAFF_ROLES.includes(user.role);

module.exports = { authenticate, optionalAuth, requireRole, isStaff, ROLES, STAFF_ROLES, verifyToken };
