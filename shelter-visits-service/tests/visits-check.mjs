// Visit Scheduling service: step-by-step functional + security checks through the real API Gateway.
//
// Run from the service folder after deploying (Visits with VISIT_LEAD_MINUTES=2 SLOT_STEP_MINUTES=1):
//   node tests/visits-check.mjs              pauses between sections (press Enter)
//   node tests/visits-check.mjs --no-pause   runs straight through
// Needs: the shared platform, the Animals service and (for booking) the Applications service deployed on Floci.
// Reads the local, git-ignored infra/out/platform.env and infra/out/seed-users.txt of the shared repo.
// Never prints passwords or tokens. Cleans up the test data at the end.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, '..');
const PAUSE = !process.argv.includes('--no-pause') && process.stdin.isTTY;

// ---------- find the shared platform output
const candidates = [
  process.env.PLATFORM_DIR,
  path.resolve(serviceRoot, '..', 'infra', 'out'),                        // inside the shared repo
  path.resolve(serviceRoot, '..', 'Animal-shelter-portal', 'infra', 'out') // service folder next to the shared repo
].filter(Boolean);
const outDir = candidates.find((d) => fs.existsSync(path.join(d, 'platform.env')));
if (!outDir) { console.error('Cannot find infra/out/platform.env: run infra/platform.sh in the shared repo first (or set PLATFORM_DIR).'); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync(path.join(outDir, 'platform.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const users = Object.fromEntries(fs.readFileSync(path.join(outDir, 'seed-users.txt'), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#')).map((l) => { const [email, password] = l.split(/\s+/); return [email.split('@')[0], { email, password }]; }));
const API = env.API_URL;

// ---------- small helpers
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
let pass = 0; let fail = 0; let warn = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = PAUSE ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

async function section(n, title, explain) {
  if (PAUSE && n > 1) await rl.question(`${C.d}\nPress Enter for section ${n}…${C.x}`);
  console.log(`\n${C.b}${n}. ${title}${C.x}\n${C.d}${explain}${C.x}`);
}
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ${C.g}PASS${C.x}  ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`); }
  else { fail += 1; console.log(`  ${C.r}FAIL${C.x}  ${name}${detail ? `  ${detail}` : ''}`); }
  return ok;
}
function soft(name, detail) { warn += 1; console.log(`  ${C.y}WARN${C.x}  ${name}  ${C.d}${detail}${C.x}`); }
const got = (r) => `${r.status}${r.body && r.body.error ? ` ${r.body.error.code}` : ''}`;
function expect(name, r, status, code) {
  const ok = r.status === status && (!code || (r.body && r.body.error && r.body.error.code === code));
  return check(`${name} → ${status}${code ? ` ${code}` : ''}`, ok, ok ? '' : `got ${got(r)}${r.body && r.body.error ? `: ${r.body.error.message}` : ''}`);
}

async function signIn(who) {
  const r = await fetch('http://localhost:4566/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: env.COGNITO_CLIENT_ID, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: users[who].email, PASSWORD: users[who].password } })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.AuthenticationResult) throw new Error(`sign-in failed for ${who} (HTTP ${r.status})`);
  return j.AuthenticationResult.IdToken;
}

async function call(method, p, { token, body } = {}) {
  const headers = { Origin: 'http://localhost:4566' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1500); }
  return null;
}

// slot times: minute grid (demo setting) for the soon slot, :00 for the far ones
const at = (date) => { const d = new Date(date); d.setUTCSeconds(0, 0); return d.toISOString(); };
const daysAhead = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

// optional: EventBridge Scheduler check through the service's own AWS SDK
let scheduler = null;
try {
  const req = createRequire(path.join(serviceRoot, 'backend', 'package.json'));
  const { SchedulerClient, GetScheduleCommand } = req('@aws-sdk/client-scheduler');
  const client = new SchedulerClient({ region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  scheduler = async (bookingId) => {
    try { await client.send(new GetScheduleCommand({ Name: `visit-reminder-${bookingId}`, GroupName: 'shelter-visit-reminders' })); return 'exists'; }
    catch (e) { return e.name === 'ResourceNotFoundException' ? 'missing' : `error: ${e.name}`; }
  };
} catch { /* backend dependencies not installed */ }

const created = { animals: [], apps: [] };

async function main() {
  console.log(`${C.b}Visit Scheduling checks${C.x}  API ${API}`);

  // ---------- 0. setup
  await section(1, 'Setup: services up, sign in, a test animal',
    'Your service needs the Animals service (to check an animal is available) and the Applications service (to check an adopter applied).');
  const health = {};
  for (const s of ['visits', 'animals', 'applications']) {
    const r = await call('GET', `/api/health/${s}`);
    health[s] = r.status === 200;
    check(`${s} service health`, health[s], health[s] ? '' : `got ${r.status} (deploy it first)`);
  }
  if (!health.visits || !health.animals) { console.log('\nVisits and Animals must be deployed to continue.'); return; }
  const [staff, a1, a2] = await Promise.all(['staff', 'adopter1', 'adopter2'].map(signIn));
  check('signed in as staff, adopter1, adopter2 (Cognito)', true);
  const mk = async (name) => {
    const r = await call('POST', '/api/animals', { token: staff, body: { name, species: 'dog', sex: 'female', ageMonths: 20, size: 'medium', temperament: ['calm'], description: 'Visit test animal', vaccinated: true, neutered: true } });
    if (r.status === 201) created.animals.push(r.body.id);
    return r;
  };
  const A = await mk(`Visit Test A ${Date.now() % 10000}`);
  const B = await mk(`Visit Test B ${Date.now() % 10000}`);
  if (!check('created test animals A and B (Animals service)', A.status === 201 && B.status === 201, `${A.status}/${B.status}`)) return;
  const animalA = A.body.id; const animalB = B.body.id;

  // ---------- 1. open a slot
  await section(2, 'Function 1: staff open a visit slot  (POST /api/visits/slots)',
    'Rules: staff only, on the time grid, far enough ahead, no overlap, and the Animals service must say the animal is available.');
  const soonStart = at(Date.now() + 4 * 60000 + 60000);           // ~4-5 min ahead (demo lead time is 2 min)
  const far1 = daysAhead(3, 10); const far2 = daysAhead(4, 10); const farB = daysAhead(3, 12);
  const S1 = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: soonStart, durationMinutes: 30, capacity: 1 } });
  if (S1.status === 400) console.log(`  ${C.y}note${C.x}  ${S1.body.error.message}: deploy Visits with VISIT_LEAD_MINUTES=2 and SLOT_STEP_MINUTES=1 for the outcome test`);
  expect('open a slot starting in ~5 minutes (capacity 1)', S1, 201);
  check('response has a Location header', Boolean(S1.headers.get('location')), S1.headers.get('location') || 'missing');
  const S2 = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: far1, durationMinutes: 30, capacity: 1 } });
  expect('open a slot in 3 days (capacity 1)', S2, 201);
  const S3 = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: far2, durationMinutes: 60, capacity: 2 } });
  expect('open a 60-minute slot in 4 days (capacity 2)', S3, 201);
  const S4 = await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalB, startsAt: farB, durationMinutes: 30, capacity: 1 } });
  expect('open a slot for animal B in 3 days', S4, 201);
  expect('overlapping slot for the same animal', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: far1, durationMinutes: 30 } }), 409, 'SLOT_OVERLAP');
  expect('slot in the past', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: at(Date.now() - 3600e3) } }), 400, 'VALIDATION_ERROR');
  expect('start time not on the grid (seconds set)', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: daysAhead(5, 10).replace(':00.000Z', ':30.000Z') } }), 400, 'VALIDATION_ERROR');
  expect('invalid length (45 minutes)', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: daysAhead(6, 10), durationMinutes: 45 } }), 400, 'VALIDATION_ERROR');
  expect('unknown field (mass assignment: bookedCount)', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalA, startsAt: daysAhead(6, 11), bookedCount: 99 } }), 400, 'VALIDATION_ERROR');
  expect('no token', await call('POST', '/api/visits/slots', { body: { animalId: animalA, startsAt: daysAhead(7, 10) } }), 401, 'UNAUTHENTICATED');
  expect('adopter (wrong role)', await call('POST', '/api/visits/slots', { token: a1, body: { animalId: animalA, startsAt: daysAhead(7, 10) } }), 403, 'FORBIDDEN');
  expect('animal that does not exist', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: '00000000-0000-4000-8000-000000000000', startsAt: daysAhead(7, 10) } }), 404);
  const s1 = S1.body && S1.body.id; const s2 = S2.body && S2.body.id; const s3 = S3.body && S3.body.id; const s4 = S4.body && S4.body.id;

  // ---------- 2. list slots
  await section(3, 'Function 2: list open slots  (GET /api/visits/slots?animalId=)',
    'Anyone can see open future slots with places left; only staff see the internal booked counts.');
  const pub = await call('GET', `/api/visits/slots?animalId=${animalA}`);
  expect('public list for animal A', pub, 200);
  check('public list shows 3 open slots', pub.body && pub.body.total === 3, pub.body ? `total ${pub.body.total}` : '');
  check('public list hides bookedCount', pub.body && pub.body.items.every((s) => !('bookedCount' in s)));
  const st = await call('GET', `/api/visits/slots?animalId=${animalA}`, { token: staff });
  check('staff list includes bookedCount', st.body && st.body.items.every((s) => 'bookedCount' in s));
  expect('missing animalId', await call('GET', '/api/visits/slots'), 400, 'VALIDATION_ERROR');

  // ---------- 3. book
  await section(4, 'Function 4: adopters book a visit  (POST /api/visits/bookings)',
    'Rules: adopters only, must have an application for the animal (asked from the Applications service with the adopter\'s own token), one active booking per animal, capacity enforced in one DynamoDB transaction.');
  if (!health.applications) {
    soft('Applications service not deployed', 'skipping booking, cancel, outcome and event checks (sections 4–7)');
  } else {
    expect('adopter2 books animal B with no application', await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: s4 } }), 409, 'APPLICATION_REQUIRED');
    for (const [who, tok] of [['adopter1', a1], ['adopter2', a2]]) {
      const r = await call('POST', '/api/applications', { token: tok, body: { animalId: animalA, housingType: 'house', hasOtherPets: false } });
      if (r.status === 201) created.apps.push({ id: r.body.id, token: tok });
      check(`${who} applies for animal A (Applications service)`, r.status === 201, r.status === 201 ? '' : `got ${got(r)}${r.body && r.body.error ? `: ${r.body.error.message}` : ''}`);
    }
    const appA1 = created.apps[0] && created.apps[0].id;
    const b2 = await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: s2 } });
    expect('adopter1 books the 3-day slot', b2, 201);
    expect('adopter1 books a second slot of the same animal', await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: s3 } }), 409, 'ALREADY_BOOKED');
    expect('staff try to book (adopters only)', await call('POST', '/api/visits/bookings', { token: staff, body: { slotId: s3 } }), 403, 'FORBIDDEN');
    expect('booking a slot that does not exist', await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: '00000000-0000-4000-8000-000000000000' } }), 404);
    if (scheduler && b2.status === 201) {
      const s = await scheduler(b2.body.id);
      if (s === 'exists') check('EventBridge Scheduler reminder created for the booking', true, `visit-reminder-${b2.body.id.slice(0, 8)}…`);
      else soft('reminder schedule not found', `${s} (check the Floci UI → EventBridge Scheduler)`);
    }

    // ---------- 4. list / view
    await section(5, 'Functions 5 and 6: list and view bookings  (GET /api/visits/bookings[/:id])',
      'Adopters see only their own bookings; another adopter asking for the id gets 404 (ownership check), staff see everything.');
    const mine = await call('GET', '/api/visits/bookings', { token: a1 });
    check('adopter1 sees their booking', mine.body && mine.body.items.some((b) => b.id === b2.body.id));
    const theirs = await call('GET', '/api/visits/bookings', { token: a2 });
    check("adopter2's list does not contain adopter1's booking", theirs.body && !theirs.body.items.some((b) => b.id === b2.body.id));
    expect("adopter2 opens adopter1's booking by id", await call('GET', `/api/visits/bookings/${b2.body.id}`, { token: a2 }), 404, 'NOT_FOUND');
    const sv = await call('GET', `/api/visits/bookings/${b2.body.id}`, { token: staff });
    expect('staff open the booking', sv, 200);
    check('staff view includes the adopter name', sv.body && Boolean(sv.body.adopterName));
    expect('no token', await call('GET', '/api/visits/bookings'), 401, 'UNAUTHENTICATED');

    // ---------- 5. cancel
    await section(6, 'Function 7a: cancel a booking  (PATCH /api/visits/bookings/:id {status:"cancelled"})',
      'Adopters may cancel online up to 24 hours before; staff may cancel until the start. Cancelling frees the place and deletes the reminder.');
    expect('adopter1 cancels the 3-day booking', await call('PATCH', `/api/visits/bookings/${b2.body.id}`, { token: a1, body: { status: 'cancelled' } }), 200);
    expect('cancelling it again', await call('PATCH', `/api/visits/bookings/${b2.body.id}`, { token: a1, body: { status: 'cancelled' } }), 409, 'BOOKING_CLOSED');
    if (scheduler) {
      const s = await scheduler(b2.body.id);
      if (s === 'missing') check('reminder schedule deleted after cancelling', true);
      else soft('reminder schedule still present', s);
    }
    const b1 = await call('POST', '/api/visits/bookings', { token: a1, body: { slotId: s1 } });
    expect('adopter1 books the slot starting in ~5 minutes', b1, 201);
    expect('adopter2 tries the same slot (capacity 1)', await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: s1 } }), 409, 'SLOT_FULL');
    expect('adopter1 cancels less than 24 h before', await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: a1, body: { status: 'cancelled' } }), 409, 'CANCEL_WINDOW_CLOSED');
    expect('invalid status value', await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: staff, body: { status: 'approved' } }), 400, 'VALIDATION_ERROR');

    // ---------- 6. cancel a slot
    await section(7, 'Function 3: staff cancel a slot  (DELETE /api/visits/slots/:id)',
      'Cancelling a slot cancels every booking in it and emails those adopters.');
    const b3 = await call('POST', '/api/visits/bookings', { token: a2, body: { slotId: s3 } });
    expect('adopter2 books the 4-day slot', b3, 201);
    expect('adopter tries to cancel a slot', await call('DELETE', `/api/visits/slots/${s3}`, { token: a2 }), 403, 'FORBIDDEN');
    const cs = await call('DELETE', `/api/visits/slots/${s3}`, { token: staff });
    expect('staff cancel the slot', cs, 200);
    check('1 booking was cancelled with it', cs.body && cs.body.cancelledBookings === 1, cs.body ? `cancelledBookings ${cs.body.cancelledBookings}` : '');
    const b3now = await call('GET', `/api/visits/bookings/${b3.body.id}`, { token: a2 });
    check("adopter2's booking now shows cancelled", b3now.body && b3now.body.status === 'cancelled', b3now.body ? b3now.body.status : got(b3now));

    // ---------- 7. outcome + event
    await section(8, 'Function 7b: record the visit outcome  (PATCH … {status:"completed"})',
      'Staff only, and only once the visit has started. The outcome is published as VisitCompleted on EventBridge; the Applications service records it, which unlocks approval.');
    expect('adopter tries to record an outcome', await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: a1, body: { status: 'completed' } }), 403, 'FORBIDDEN');
    expect('staff record the outcome before the start', await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: staff, body: { status: 'completed' } }), 409, 'VISIT_NOT_STARTED');
    const wait = Date.parse(soonStart) - Date.now() + 3000;
    if (wait > 0) { console.log(`  ${C.d}waiting ${Math.ceil(wait / 1000)} s for the visit to start…${C.x}`); await sleep(wait); }
    expect('staff record "completed" after the start', await call('PATCH', `/api/visits/bookings/${b1.body.id}`, { token: staff, body: { status: 'completed', note: 'Calm and friendly' } }), 200);
    const seen = await waitFor(async () => { const r = await call('GET', `/api/applications/${appA1}`, { token: staff }); return r.body && r.body.visitCompletedAt ? r.body : null; });
    check('EventBridge: Applications service recorded the visit (VisitCompleted)', Boolean(seen), seen ? `application status ${seen.status}` : 'not seen within 30 s');
  }

  // ---------- 8. animal status consumer
  await section(9, 'Background job: animal no longer available  (AnimalStatusChanged event)',
    'When the Animals service puts an animal on hold (or it is adopted / archived), your service cancels its future slots automatically.');
  expect('staff put animal B on hold (Animals service)', await call('PATCH', `/api/animals/${animalB}`, { token: staff, body: { status: 'on_hold' } }), 200);
  const gone = await waitFor(async () => {
    const r = await call('GET', `/api/visits/slots?animalId=${animalB}&includePast=true`, { token: staff });
    const s = r.body && r.body.items.find((x) => x.id === s4);
    return s && s.status === 'cancelled' ? s : null;
  });
  check("EventBridge: animal B's slot was cancelled automatically", Boolean(gone), gone ? '' : 'still open after 30 s');
  expect('opening a slot for an animal on hold', await call('POST', '/api/visits/slots', { token: staff, body: { animalId: animalB, startsAt: daysAhead(8, 10) } }), 409, 'ANIMAL_NOT_AVAILABLE');

  console.log(`\n${C.d}Logs: Floci UI → CloudWatch Logs → /aws/lambda/shelter-visits-api shows one JSON line per request, and AUTH_DENIED lines for the 401/403 checks above.${C.x}`);
}

async function cleanup() {
  for (const a of created.apps) await call('PATCH', `/api/applications/${a.id}/status`, { token: a.token, body: { status: 'withdrawn' } }).catch(() => {});
  try {
    const staff = await signIn('staff');
    for (const id of created.animals) await call('DELETE', `/api/animals/${id}`, { token: staff }).catch(() => {});
  } catch { /* ignore */ }
}

main()
  .catch((e) => { fail += 1; console.error(`\n${C.r}Stopped:${C.x} ${e.message}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${C.b}${pass} passed, ${fail} failed${warn ? `, ${warn} warnings` : ''}${C.x}  ${C.d}(test animals archived, test applications withdrawn)${C.x}`);
    if (rl) rl.close();
    process.exit(fail ? 1 : 0);
  });
