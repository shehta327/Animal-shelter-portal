// Integrated + security tests across the three services, through the real API Gateway.
// Usage (after platform + all three services are deployed):   node tests/run-tests.mjs
// Reads infra/out/platform.env (IDs) and infra/out/seed-users.txt (local demo passwords).
// Writes tests/out/results.md and results.json for the report. Never prints tokens or passwords.
//
// For the visit flow the Visits service must be deployed with
// VISIT_LEAD_MINUTES=2 and SLOT_STEP_MINUTES=1 (otherwise the outcome step is skipped).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'infra/out/platform.env'), 'utf8')
  .split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const users = Object.fromEntries(fs.readFileSync(path.join(root, 'infra/out/seed-users.txt'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const [email, password] = l.split(/\s+/); return [email.split('@')[0], { email, password }]; }));
const API = env.API_URL;
const COGNITO = 'http://localhost:4566/';
const WEB_ORIGIN = 'http://localhost:4566';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(who) {
  const r = await fetch(COGNITO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: env.COGNITO_CLIENT_ID, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: users[who].email, PASSWORD: users[who].password } })
  });
  const j = await r.json();
  if (!j.AuthenticationResult) throw new Error(`sign-in failed for ${who}`);
  return j.AuthenticationResult.IdToken;
}

async function call(method, p, { token, body, raw, headers = {} } = {}) {
  const h = { Origin: WEB_ORIGIN, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${p}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
}

function record(group, id, name, expected, actual, pass, note = '') {
  results.push({ group, id, name, expected, actual: String(actual), pass, note });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}  (expected ${expected}, got ${actual}${note ? `; ${note}` : ''})`);
}
const expectStatus = (group, id, name, res, want, extra = true, note = '') =>
  record(group, id, name, String(want), `${res.status}${res.body && res.body.error ? ` ${res.body.error.code}` : ''}`, res.status === want && extra, note);

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); }
  return null;
}

const nextStart = (leadMin) => {
  const d = new Date(Date.now() + (leadMin + 1) * 60000);
  d.setUTCSeconds(0, 0);
  return d;
};

async function main() {
  console.log(`API ${API}\n`);
  for (const s of ['animals', 'applications', 'visits']) {
    const r = await call('GET', `/api/health/${s}`);
    expectStatus('Health', `H-${s[0].toUpperCase()}`, `${s} service is up`, r, 200);
  }
  const [admin, staff, a1, a2] = await Promise.all(['admin', 'staff', 'adopter1', 'adopter2'].map(signIn));

  // ---------- security tests
  const S = 'Security';
  expectStatus(S, 'S1', 'Unauthenticated create animal is rejected', await call('POST', '/api/animals', { body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small' } }), 401);
  expectStatus(S, 'S2', 'Unauthenticated list of applications is rejected', await call('GET', '/api/applications'), 401);
  expectStatus(S, 'S3', 'Adopter (wrong role) cannot create an animal', await call('POST', '/api/animals', { token: a1, body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small' } }), 403);
  expectStatus(S, 'S4', 'Adopter cannot open a visit slot', await call('POST', '/api/visits/slots', { token: a1, body: { animalId: '00000000-0000-4000-8000-000000000000', startsAt: new Date().toISOString() } }), 403);
  // tamper: change the role claim, keep the old signature
  const [h, p, sig] = a1.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims['cognito:groups'] = ['Admin'];
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
  expectStatus(S, 'S5', 'Forged token (role changed to Admin) is rejected', await call('POST', '/api/animals', { token: forged, body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small' } }), 401);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  expectStatus(S, 'S6', 'Unsigned alg=none token is rejected', await call('GET', '/api/applications', { token: none }), 401);
  expectStatus(S, 'S7', 'Invalid input (empty name, negative age) is rejected', await call('POST', '/api/animals', { token: staff, body: { name: '', species: 'dragon', ageMonths: -1, size: 'small' } }), 400);
  expectStatus(S, 'S8', 'Mass assignment (client sets status=adopted) is rejected', await call('POST', '/api/animals', { token: staff, body: { name: 'Rex', species: 'dog', ageMonths: 5, size: 'small', status: 'adopted' } }), 400);
  expectStatus(S, 'S9', 'Non-JSON body is rejected (415)', await call('POST', '/api/animals', { token: staff, raw: 'name=Rex', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 415);
  expectStatus(S, 'S10', 'Oversized body (>20 kB) is rejected', await call('POST', '/api/animals', { token: staff, body: { name: 'Rex', description: 'x'.repeat(30000) } }), 413);
  const sqli = await call('GET', `/api/animals?q=${encodeURIComponent("' OR 1=1 --")}`);
  record(S, 'S11', 'SQL-injection text in search is treated as data', '200, 0 results', `${sqli.status}, ${sqli.body && sqli.body.total} results`, sqli.status === 200 && sqli.body.total === 0);
  expectStatus(S, 'S12', 'Injection in an enum filter is rejected', await call('GET', `/api/applications?status=${encodeURIComponent("approved' OR '1'='1")}`, { token: staff }), 400);
  const pre = await fetch(`${API}/api/animals`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  const acao = pre.headers.get('access-control-allow-origin');
  record(S, 'S13', 'CORS: unknown website origin is not allowed', 'no Access-Control-Allow-Origin', acao || 'none', !acao || acao === WEB_ORIGIN);
  const hidden = await call('GET', '/api/animals?status=on_hold', { token: a1 });
  record(S, 'S14', 'Adopter cannot list hidden (on_hold) animals', 'only available', hidden.body ? [...new Set(hidden.body.items.map((x) => x.status))].join(',') || 'empty' : hidden.status,
    hidden.status === 200 && hidden.body.items.every((x) => x.status === 'available'));

  // ---------- integrated flow across the three services
  const I = 'Integration';
  const created = await call('POST', '/api/animals', {
    token: staff,
    body: { name: `Test Luna ${Date.now() % 10000}`, species: 'dog', breed: '<script>alert(1)</script>', sex: 'female', ageMonths: 18, size: 'medium', temperament: ['calm'], description: 'Integration test animal', vaccinated: true }
  });
  expectStatus(I, 'I1', 'Staff create animal returns 201 + Location', created, 201, Boolean(created.headers.get('location')));
  const animal = created.body;
  record(S, 'S15', 'Script text is stored as plain data; API sends CSP + nosniff', 'literal text, headers set',
    `${animal.breed === '<script>alert(1)</script>' ? 'literal' : 'changed'}, ${created.headers.get('x-content-type-options')}`,
    animal.breed === '<script>alert(1)</script>' && created.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(created.headers.get('content-security-policy') || ''));

  // photo: presigned PUT straight to private S3, then the API verifies it
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await call('POST', `/api/animals/${animal.id}/photos`, { token: staff, body: { contentType: 'image/png' } });
  expectStatus(I, 'I2', 'Photo upload URL (presigned S3 PUT) created', up, 201);
  if (up.status === 201) {
    const put = await fetch(up.body.upload.url, { method: 'PUT', headers: up.body.upload.headers, body: png });
    record(I, 'I3', 'Browser-style PUT to presigned URL succeeds', '200', put.status, put.ok);
    const conf = await call('PATCH', `/api/animals/${animal.id}/photos/${up.body.photo.id}`, { token: staff, body: { status: 'ready' } });
    expectStatus(I, 'I4', 'API verifies the object in S3 and marks it ready', conf, 200);
    const direct = await fetch(`http://localhost:4566/shelter-animal-photos/${encodeURIComponent('animals')}/`);
    record(S, 'S16', 'Photo bucket is private (no anonymous listing)', '403/404', direct.status, [403, 404].includes(direct.status), 'Floci may not enforce public-access blocks; real S3 does');
  }

  const apply = (token, extra = {}) => call('POST', '/api/applications', { token, body: { animalId: animal.id, housingType: 'house', hasOtherPets: false, ...extra } });
  const app1 = await apply(a1, { experience: 'Grew up with dogs' });
  expectStatus(I, 'I5', 'Adopter 1 applies (Applications checks Animals) - 201', app1, 201);
  const app2 = await apply(a2);
  expectStatus(I, 'I6', 'Adopter 2 applies - 201', app2, 201);
  expectStatus(I, 'I7', 'Duplicate application is rejected', await apply(a1), 409);
  expectStatus(S, 'S17', 'Ownership: adopter 2 cannot read adopter 1\'s application', await call('GET', `/api/applications/${app1.body.id}`, { token: a2 }), 404);
  expectStatus(S, 'S18', 'Ownership: adopter 2 cannot withdraw adopter 1\'s application', await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: a2, body: { status: 'withdrawn' } }), 404);
  expectStatus(S, 'S19', 'Adopter cannot approve their own application', await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: a1, body: { status: 'approved' } }), 409,
    true, 'submitted -> approved is not a valid transition for anyone');
  const own = await call('GET', `/api/applications/${app1.body.id}`, { token: a1 });
  record(S, 'S20', 'Responses do not leak the adopter email', 'no adopterEmail field', own.body && 'adopterEmail' in own.body ? 'present' : 'absent', own.status === 200 && !('adopterEmail' in own.body));
  expectStatus(I, 'I8', 'Staff moves application to review', await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: staff, body: { status: 'under_review' } }), 200);
  expectStatus(I, 'I9', 'Approve without completed visit -> 409 VISIT_REQUIRED', await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: staff, body: { status: 'approved' } }), 409);

  // visits: an adopter with no application cannot book
  const lead = Number(process.env.VISIT_LEAD_MINUTES || 2);
  const soon = nextStart(lead);
  const later = new Date(Date.now() + 3 * 24 * 3600e3); later.setUTCHours(10, 0, 0, 0);
  const slotA = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animal.id, startsAt: soon.toISOString(), durationMinutes: 30, capacity: 1 } });
  const shortLead = slotA.status === 201;
  if (!shortLead) console.log(`   (slot in ${lead + 1} min refused: ${slotA.body && slotA.body.error && slotA.body.error.message}) - deploy Visits with VISIT_LEAD_MINUTES=2 SLOT_STEP_MINUTES=1 for the full flow`);
  const slotB = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animal.id, startsAt: later.toISOString(), durationMinutes: 30, capacity: 2 } });
  expectStatus(I, 'I10', 'Staff opens a visit slot (Visits checks Animals) - 201', slotB, 201);
  expectStatus(I, 'I11', 'Overlapping slot is rejected', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animal.id, startsAt: later.toISOString(), durationMinutes: 30 } }), 409);
  const pub = await call('GET', `/api/visits/slots?animalId=${animal.id}`);
  record(I, 'I12', 'Public slot list hides internal counts', 'placesLeft only', pub.body && pub.body.items[0] && 'bookedCount' in pub.body.items[0] ? 'bookedCount shown' : 'hidden', pub.status === 200 && pub.body.items.every((s) => !('bookedCount' in s)));

  const admin2 = await signIn('admin');
  const other = await call('POST', '/api/animals', { token: admin2, body: { name: 'Test Milo', species: 'cat', ageMonths: 30, size: 'small' } });
  const otherSlot = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: other.body.id, startsAt: later.toISOString(), durationMinutes: 30 } });
  expectStatus(S, 'S21', 'Booking without an application is refused (Visits asks Applications)', await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: otherSlot.body.id } }), 409);

  const b2 = await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: slotB.body.id } });
  expectStatus(I, 'I13', 'Adopter 2 books a visit - 201', b2, 201);
  expectStatus(I, 'I14', 'Second active booking for the same animal is refused', await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: slotB.body.id } }), 409);
  expectStatus(S, 'S22', 'Ownership: adopter 1 cannot read adopter 2\'s booking', await call('GET', `/api/visits/bookings/${b2.body.id}`, { token: a1 }), 404);
  expectStatus(S, 'S23', 'Adopter cannot record a visit outcome', await call('PATCH', `/api/visits/bookings/${b2.body.id}`, { token: a2, body: { status: 'completed' } }), 403);
  expectStatus(I, 'I15', 'Outcome before the visit starts is refused', await call('PATCH', `/api/visits/bookings/${b2.body.id}`, { token: staff, body: { status: 'completed' } }), 409);
  expectStatus(I, 'I16', 'Adopter cancels 3 days ahead - 200', await call('PATCH', `/api/visits/bookings/${b2.body.id}`, { token: a2, body: { status: 'cancelled' } }), 200);

  if (shortLead) {
    const b1 = await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: slotA.body.id } });
    expectStatus(I, 'I17', 'Adopter 1 books the soon slot - 201', b1, 201);
    expectStatus(I, 'I18', 'Full slot (capacity 1) refuses adopter 2', await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: slotA.body.id } }), 409);
    const wait = Date.parse(soon.toISOString()) - Date.now() + 2000;
    console.log(`   waiting ${Math.ceil(wait / 1000)} s for the visit to start...`);
    await sleep(Math.max(0, wait));
    const done = await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: staff, body: { status: 'completed', note: 'Great match' } });
    expectStatus(I, 'I19', 'Staff records visit completed - 200 (emits VisitCompleted)', done, 200);
    const seen = await waitFor(async () => { const r = await call('GET', `/api/applications/${app1.body.id}`, { token: staff }); return r.body && r.body.visitCompletedAt ? r : null; });
    record(I, 'I20', 'EventBridge: Applications recorded the visit', 'visitCompletedAt set', seen ? 'set' : 'not set', Boolean(seen));
    const appr = await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: staff, body: { status: 'approved' } });
    expectStatus(I, 'I21', 'Staff approves after the visit - 200 (emits ApplicationApproved)', appr, 200);
    const reserved = await waitFor(async () => { const r = await call('GET', `/api/animals/${animal.id}`); return r.body && r.body.status === 'reserved' ? r : null; });
    record(I, 'I22', 'EventBridge: Animals reserved the animal', 'reserved', reserved ? 'reserved' : 'not reserved', Boolean(reserved));
    expectStatus(I, 'I23', 'Staff cannot archive a reserved animal', await call('DELETE', `/api/animals/${animal.id}`, { token: staff }), 409);
    const comp = await call('PATCH', `/api/applications/${app1.body.id}/status`, { token: staff, body: { status: 'completed' } });
    expectStatus(I, 'I24', 'Staff completes the adoption - 200, other application auto-rejected', comp, 200, comp.body && comp.body.autoRejected === 1);
    const adopted = await waitFor(async () => { const r = await call('GET', `/api/animals/${animal.id}`); return r.body && r.body.status === 'adopted' ? r : null; });
    record(I, 'I25', 'EventBridge: Animals marked the animal adopted', 'adopted', adopted ? 'adopted' : 'not adopted', Boolean(adopted));
    const closed = await waitFor(async () => {
      const r = await call('GET', `/api/visits/slots?animalId=${animal.id}&includePast=true`, { token: staff });
      const s = r.body && r.body.items.find((x) => x.id === slotB.body.id);
      return s && s.status === 'cancelled' ? s : null;
    });
    record(I, 'I26', 'EventBridge: Visits cancelled future slots of the adopted animal', 'cancelled', closed ? 'cancelled' : 'still open', Boolean(closed));
    const a2app = await call('GET', `/api/applications/${app2.body.id}`, { token: a2 });
    record(I, 'I27', 'Adopter 2 sees their application rejected', 'rejected', a2app.body && a2app.body.status, a2app.body && a2app.body.status === 'rejected');
  }

  // ---------- report
  const out = path.join(root, 'tests/out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), api: API, results }, null, 2));
  const rows = results.map((r) => `| ${r.id} | ${r.group} | ${r.name} | ${r.expected} | ${r.actual} | ${r.pass ? 'Pass' : 'FAIL'} |`);
  fs.writeFileSync(path.join(out, 'results.md'),
    `# Test run ${new Date().toISOString()}\n\n| ID | Type | Test | Expected | Actual | Result |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Saved tests/out/results.md`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Test run stopped:', e.message); process.exit(2); });
