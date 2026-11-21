// One place for every call to the three backend services (through API Gateway).
import { CONFIG } from './config.js';
import { token, signOut } from './auth.js';

export class ApiError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.message || `Request failed (${status})`);
    this.status = status;
    this.code = e.code;
    this.details = e.details;
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  const t = auth ? token() : null;
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && t) {
    signOut();
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  return s.toString() ? `?${s}` : '';
};

// Upload a photo straight to the private S3 bucket with the presigned URL the
// Animals service returned; the browser never holds AWS credentials.
export async function uploadToS3(upload, file) {
  if (file.size > upload.maxBytes) throw new Error('The photo must be 5 MB or smaller.');
  const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file });
  if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
}
