// Small, explicit validators. Each returns the clean value or throws a 400
// with the field name, so controllers read as a list of rules.
const { badRequest } = require('./http');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, field, { required = false, min = 0, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`, { field });
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`, { field });
  const clean = value.trim();
  if (clean.length < min || clean.length > max) {
    throw badRequest(`${field} must be ${min}-${max} characters.`, { field });
  }
  return clean;
}

function oneOf(value, field, allowed, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`, { field, allowed });
    return undefined;
  }
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`, { field, allowed });
  return value;
}

function int(value, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`, { field });
    return undefined;
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${field} must be a whole number between ${min} and ${max}.`, { field });
  }
  return n;
}

function bool(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${field} is required.`, { field });
    return undefined;
  }
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false.`, { field });
  return value;
}

function isoDate(value, field, { required = false } = {}) {
  const s = text(value, field, { required, max: 40 });
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    throw badRequest(`${field} must be an ISO date-time, e.g. 2026-12-01T10:00:00Z.`, { field });
  }
  return new Date(t).toISOString();
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest(`${field} must be a valid id.`, { field });
  return value.toLowerCase();
}

const isUuid = (value) => typeof value === 'string' && UUID.test(value);

// Reject fields the client is not allowed to set (mass-assignment guard)
function onlyFields(body, allowed) {
  const extra = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (extra.length) throw badRequest(`Unknown or read-only field(s): ${extra.join(', ')}.`, { fields: extra });
}

module.exports = { text, oneOf, int, bool, isoDate, uuid, isUuid, onlyFields };
