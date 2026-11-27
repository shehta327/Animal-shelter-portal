// Animal Listings service: step-by-step functional + security checks through the real API Gateway.
//
// Run from the service folder after deploying (infra/run.ps1 deploy.sh):
//   node tests/animals-check.mjs              pauses between sections (press Enter)
//   node tests/animals-check.mjs --no-pause   runs straight through
// Needs: the shared platform and this service deployed on Floci. Nothing else.
// Reads the local, git-ignored infra/out/platform.env and infra/out/seed-users.txt of the shared repo.
// Never prints passwords or tokens. Archives its test animals at the end.
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

// Adoption events are normally sent by the Applications service. To test this service on its own,
// the script sends the same events to the shared bus with this service's own AWS SDK (Floci test keys).
let sendEvent = null;
try {
  const req = createRequire(path.join(serviceRoot, 'backend', 'package.json'));
  const { EventBridgeClient, PutEventsCommand } = req('@aws-sdk/client-eventbridge');
  const client = new EventBridgeClient({ region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  sendEvent = (detailType, animalId, applicationId) => client.send(new PutEventsCommand({
    Entries: [{ EventBusName: 'shelter-bus', Source: 'shelter.applications', DetailType: detailType, Detail: JSON.stringify({ animalId, applicationId }) }]
  }));
} catch { /* backend dependencies not installed */ }

// A tiny file that starts like a JPEG, enough for S3 and the HeadObject check.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('animals-check'), 0xff, 0xd9]);
async function putToS3(upload) {
  const tryPut = (url) => fetch(url, { method: 'PUT', headers: upload.headers, body: JPEG });
  try { return { res: await tryPut(upload.url), note: '' }; } catch {
    // Floci from Lab 7 signs URLs for the Docker name "floci"; a PC can reach the same Floci on localhost.
    const local = upload.url.replace(/^http:\/\/floci:4566/, 'http://localhost:4566');
    if (local === upload.url) throw new Error('upload URL not reachable');
    return { res: await tryPut(local), note: '(URL host "floci" replaced with localhost: a browser on this PC cannot upload)' };
  }
}

const created = [];
const APP = '11111111-2222-4333-8444-555555555555';
const OTHER_APP = '99999999-0000-4000-8000-000000000000';

async function main() {
  console.log(`${C.b}Animal Listings checks${C.x}  API ${API}`);

  // ---------- 1. setup
  await section(1, 'Setup: service up, sign in',
    'The service must answer through API Gateway, and the demo staff and adopter accounts must sign in with Cognito.');
  const h = await call('GET', '/api/health/animals');
  if (!check('animals service health', h.status === 200 && h.body && h.body.status === 'ok', h.status === 200 ? `runtime ${h.body.runtime}` : `got ${h.status} (deploy it first)`)) return;
  const [staff, adopter] = await Promise.all(['staff', 'adopter1'].map(signIn));
  check('signed in as staff and adopter1 (Cognito)', true);

  // ---------- 2. create
  await section(2, 'Function 1: staff add an animal  (POST /api/animals)',
    'Staff and Admin only. Every field is validated, unknown fields are refused (mass assignment), the status always starts as available.');
  const mk = async (name, extra = {}) => {
    const r = await call('POST', '/api/animals', { token: staff, body: { name, species: 'dog', sex: 'male', ageMonths: 24, size: 'medium', temperament: ['calm', 'kid_friendly'], description: 'Animals check test animal', vaccinated: true, ...extra } });
    if (r.status === 201) created.push(r.body.id);
    return r;
  };
  const A = await mk(`Check Dog ${Date.now() % 10000}`);
  expect('staff add a dog', A, 201);
  check('response has a Location header', A.headers.get('location') === `/api/animals/${A.body && A.body.id}`, A.headers.get('location') || 'missing');
  check('new animal starts as available', A.body && A.body.status === 'available');
  if (!A.body) return;
  const id = A.body.id;
  expect('no token', await call('POST', '/api/animals', { body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small' } }), 401, 'UNAUTHENTICATED');
  expect('adopter (wrong role)', await call('POST', '/api/animals', { token: adopter, body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small' } }), 403, 'FORBIDDEN');
  expect('missing required fields', await call('POST', '/api/animals', { token: staff, body: { name: 'X' } }), 400, 'VALIDATION_ERROR');
  expect('species not in the list', await call('POST', '/api/animals', { token: staff, body: { name: 'X', species: 'dragon', ageMonths: 1, size: 'small' } }), 400, 'VALIDATION_ERROR');
  expect('client sets status=adopted (mass assignment)', await call('POST', '/api/animals', { token: staff, body: { name: 'X', species: 'dog', ageMonths: 1, size: 'small', status: 'adopted' } }), 400, 'VALIDATION_ERROR');

  // ---------- 3. list and view
  await section(3, 'Functions 2 and 3: browse and view  (GET /api/animals, GET /api/animals/:id)',
    'Public. Visitors see available animals only (DynamoDB Query on status-createdAt-index); staff-only fields are hidden from them.');
  const list = await call('GET', '/api/animals?species=dog&limit=50');
  expect('public list of dogs', list, 200);
  check('the new dog is in the public list', list.body && list.body.items.some((a) => a.id === id));
  const cats = await call('GET', '/api/animals?species=cat&limit=50');
  check('filter species=cat does not return the dog', cats.body && !cats.body.items.some((a) => a.id === id));
  const search = await call('GET', `/api/animals?q=${encodeURIComponent(A.body.name)}`);
  check('text search finds it by name', search.body && search.body.items.some((a) => a.id === id));
  const pubView = await call('GET', `/api/animals/${id}`);
  expect('public view', pubView, 200);
  check('public view hides staff-only fields', pubView.body && !('createdBy' in pubView.body) && !('reservedForApplicationId' in pubView.body));
  const staffView = await call('GET', `/api/animals/${id}`, { token: staff });
  check('staff view includes createdBy', staffView.body && Boolean(staffView.body.createdBy));
  expect('id that is not a UUID', await call('GET', '/api/animals/not-an-id'), 404, 'NOT_FOUND');
  expect('public asks for on_hold animals (status filter is staff-only)', await call('GET', '/api/animals?status=on_hold'), 200);

  // ---------- 4. update and hold
  await section(4, 'Function 4: staff edit, hold and release  (PATCH /api/animals/:id)',
    'Staff may change details and move an animal between available and on_hold. On-hold animals are hidden from the public.');
  const ed = await call('PATCH', `/api/animals/${id}`, { token: staff, body: { description: 'Updated by animals-check' } });
  expect('staff edit the description', ed, 200);
  expect('staff put it on hold', await call('PATCH', `/api/animals/${id}`, { token: staff, body: { status: 'on_hold' } }), 200);
  expect('public view of an on-hold animal', await call('GET', `/api/animals/${id}`), 404, 'NOT_FOUND');
  const held = await call('GET', '/api/animals?status=on_hold&limit=50', { token: staff });
  check('staff list of on_hold includes it', held.body && held.body.items.some((a) => a.id === id));
  expect('staff release the hold', await call('PATCH', `/api/animals/${id}`, { token: staff, body: { status: 'available' } }), 200);
  expect('staff try to set reserved by hand', await call('PATCH', `/api/animals/${id}`, { token: staff, body: { status: 'reserved' } }), 400, 'VALIDATION_ERROR');
  expect('adopter tries to edit', await call('PATCH', `/api/animals/${id}`, { token: adopter, body: { name: 'Hacked' } }), 403, 'FORBIDDEN');

  // ---------- 5. photos
  await section(5, 'Functions 5-7: photos  (POST/PATCH/DELETE /api/animals/:id/photos)',
    'The bucket is private. The API returns a 5-minute presigned PUT URL, the file goes straight to S3, then the API checks it with HeadObject before it counts.');
  expect('photo type not allowed (gif)', await call('POST', `/api/animals/${id}/photos`, { token: staff, body: { contentType: 'image/gif' } }), 400, 'VALIDATION_ERROR');
  const slot = await call('POST', `/api/animals/${id}/photos`, { token: staff, body: { contentType: 'image/jpeg' } });
  expect('staff ask for an upload URL', slot, 201);
  if (slot.status === 201) {
    expect('confirm before uploading anything', await call('PATCH', `/api/animals/${id}/photos/${slot.body.photo.id}`, { token: staff, body: { status: 'ready' } }), 409, 'UPLOAD_MISSING');
    try {
      const { res, note } = await putToS3(slot.body.upload);
      check('upload the file to S3 with the presigned URL', res.ok, `HTTP ${res.status} ${note}`);
      const ok = await call('PATCH', `/api/animals/${id}/photos/${slot.body.photo.id}`, { token: staff, body: { status: 'ready' } });
      expect('API checks S3 (HeadObject) and marks it ready', ok, 200);
      const withPhoto = await call('GET', `/api/animals/${id}`);
      check('public view now has 1 photo with a presigned GET URL', withPhoto.body && withPhoto.body.photos.length === 1 && /X-Amz-Signature/.test(withPhoto.body.photos[0].url));
      expect('staff delete the photo', await call('DELETE', `/api/animals/${id}/photos/${slot.body.photo.id}`, { token: staff }), 204);
    } catch (e) { soft('S3 upload not reachable from this PC', e.message); }
  }

  // ---------- 6. events
  await section(6, 'Background job: adoption events  (EventBridge → consumers/handler.js)',
    'reserved and adopted are set ONLY by events from the Applications service. Each change is a conditional update pinned to the application id.');
  if (!sendEvent) {
    soft('backend dependencies not installed', 'run the deploy once (it runs npm install), then re-run this script');
  } else {
    const statusOf = async () => (await call('GET', `/api/animals/${id}`, { token: staff })).body.status;
    await sendEvent('ApplicationApproved', id, APP);
    check('ApplicationApproved → reserved', Boolean(await waitFor(async () => (await statusOf()) === 'reserved')));
    expect('staff try to hold a reserved animal', await call('PATCH', `/api/animals/${id}`, { token: staff, body: { status: 'on_hold' } }), 409, 'ANIMAL_RESERVED');
    expect('staff try to archive a reserved animal', await call('DELETE', `/api/animals/${id}`, { token: staff }), 409, 'ANIMAL_RESERVED');
    await sendEvent('ApplicationCompleted', id, OTHER_APP);
    await sleep(6000);
    check('ApplicationCompleted from ANOTHER application is ignored', (await statusOf()) === 'reserved');
    await sendEvent('ApplicationReleased', id, APP);
    check('ApplicationReleased → available again', Boolean(await waitFor(async () => (await statusOf()) === 'available')));
    await sendEvent('ApplicationApproved', id, APP);
    await waitFor(async () => (await statusOf()) === 'reserved');
    await sendEvent('ApplicationCompleted', id, APP);
    check('Approved then Completed → adopted', Boolean(await waitFor(async () => (await statusOf()) === 'adopted')));
    expect('staff try to edit an adopted animal', await call('PATCH', `/api/animals/${id}`, { token: staff, body: { name: 'New name' } }), 409, 'ANIMAL_ADOPTED');
    expect('staff try to archive an adopted animal', await call('DELETE', `/api/animals/${id}`, { token: staff }), 409, 'ANIMAL_ADOPTED');
  }

  // ---------- 7. archive
  await section(7, 'Function 8: staff archive an animal  (DELETE /api/animals/:id)',
    'A soft delete: the status becomes archived (204), the record stays, the public cannot see it, and it becomes read-only.');
  const B = await mk(`Check Cat ${Date.now() % 10000}`, { species: 'cat', size: 'small' });
  expect('staff add a second animal', B, 201);
  if (B.body) {
    expect('adopter tries to archive', await call('DELETE', `/api/animals/${B.body.id}`, { token: adopter }), 403, 'FORBIDDEN');
    expect('staff archive it', await call('DELETE', `/api/animals/${B.body.id}`, { token: staff }), 204);
    expect('public view of an archived animal', await call('GET', `/api/animals/${B.body.id}`), 404, 'NOT_FOUND');
    expect('staff try to edit an archived animal', await call('PATCH', `/api/animals/${B.body.id}`, { token: staff, body: { name: 'Y' } }), 409, 'ANIMAL_ARCHIVED');
  }

  console.log(`\n${C.d}Logs: Floci UI → CloudWatch Logs → /aws/lambda/shelter-animals-api shows one JSON line per request, and AUTH_DENIED lines for the 401/403 checks above.${C.x}`);
}

async function cleanup() {
  try {
    const staff = await signIn('staff');
    for (const id of created) await call('DELETE', `/api/animals/${id}`, { token: staff }).catch(() => {});
  } catch { /* ignore */ }
}

main()
  .catch((e) => { fail += 1; console.error(`\n${C.r}Stopped:${C.x} ${e.message}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${C.b}${pass} passed, ${fail} failed${warn ? `, ${warn} warnings` : ''}${C.x}  ${C.d}(test animals archived; an adopted test animal stays as a record)${C.x}`);
    if (rl) rl.close();
    process.exit(fail ? 1 : 0);
  });
