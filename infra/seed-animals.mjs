// Adds the shelter's demo animals, each with a real photo, through the public API
// exactly like a staff member would on the dashboard:
//   sign in as staff (Cognito) -> POST /api/animals -> ask for a presigned URL
//   -> PUT the photo straight into the private S3 bucket -> PATCH the photo to "ready"
//
//   node infra/seed-animals.mjs
//
// Safe to run again: an animal whose name already exists is skipped.
// Photos: WordPress Photo Directory, all CC0 (public domain, no attribution needed).
// They are downloaded once into infra/out/seed-photos/ (git-ignored).
// Reads infra/out/platform.env (IDs) and infra/out/seed-users.txt (local demo passwords);
// no password or token is ever printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'infra/out');
if (!fs.existsSync(path.join(outDir, 'platform.env'))) {
  console.error('infra/out/platform.env not found: run .\\infra\\run.ps1 platform.sh first.');
  process.exit(2);
}
const env = Object.fromEntries(fs.readFileSync(path.join(outDir, 'platform.env'), 'utf8')
  .split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const users = Object.fromEntries(fs.readFileSync(path.join(outDir, 'seed-users.txt'), 'utf8')
  .split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => { const [email, password] = l.split(/\s+/); return [email.split('@')[0], { email, password }]; }));
const API = env.API_URL;
const COGNITO = 'http://localhost:4566/';
const PHOTO_DIR = path.join(outDir, 'seed-photos');
const MAX_BYTES = 5 * 1024 * 1024;

const ANIMALS = [
  { name: 'Goldie', species: 'dog', breed: 'Golden Retriever', sex: 'female', ageMonths: 36, size: 'large', temperament: ['friendly', 'kid_friendly', 'playful'], vaccinated: true, neutered: true,
    description: 'Goldie loves people, parties and tennis balls. She is gentle with children and already knows sit, stay and paw.',
    photo: 'https://pd.w.org/2026/09/8076aacc72f477c22.71695681.jpeg' },
  { name: 'Shadow', species: 'dog', breed: 'German Shepherd', sex: 'male', ageMonths: 48, size: 'large', temperament: ['loyal', 'calm', 'trained'], vaccinated: true, neutered: true,
    description: 'Shadow is calm and very loyal. He walks well on a lead and would suit an experienced owner with a garden.',
    photo: 'https://pd.w.org/2026/09/3386aaa5643bd52a1.39671605.jpeg' },
  { name: 'Snowy', species: 'dog', breed: 'Mixed', sex: 'female', ageMonths: 18, size: 'small', temperament: ['cheerful', 'cuddly'], vaccinated: true, neutered: false,
    description: 'Snowy is a fluffy little dog who greets everyone with a smile. She is happy in an apartment as long as she gets her walks.',
    photo: 'https://pd.w.org/2026/10/6176abde0e015ba00.35441546.jpg' },
  { name: 'Bruno', species: 'dog', breed: 'French Bulldog', sex: 'male', ageMonths: 60, size: 'small', temperament: ['calm', 'lazy', 'good_with_dogs'], vaccinated: true, neutered: true,
    description: 'Bruno enjoys naps in the sun more than anything. A relaxed companion for a quiet home.',
    photo: 'https://pd.w.org/2026/08/5706a7a8533dfe798.06104791.jpg' },
  { name: 'Misty', species: 'cat', breed: 'Domestic Shorthair', sex: 'female', ageMonths: 24, size: 'small', temperament: ['curious', 'independent'], vaccinated: true, neutered: true,
    description: 'Misty has green eyes and loves watching the garden from a high spot. Independent but always comes back for a chin scratch.',
    photo: 'https://pd.w.org/2026/11/3116b04bdc983e107.61718976.jpeg' },
  { name: 'Ginger', species: 'cat', breed: 'Orange Tabby', sex: 'male', ageMonths: 30, size: 'medium', temperament: ['playful', 'curious', 'friendly'], vaccinated: true, neutered: true,
    description: 'Ginger explores everything and brings you "gifts" from the garden. Very social and good with visitors.',
    photo: 'https://pd.w.org/2026/11/936affa842ec93b7.58698680.jpeg' },
  { name: 'Oreo', species: 'cat', breed: 'Tuxedo', sex: 'male', ageMonths: 72, size: 'medium', temperament: ['calm', 'lap_cat'], vaccinated: true, neutered: true,
    description: 'Oreo is a gentle senior gentleman who wants a warm cushion and a person to sit with.',
    photo: 'https://pd.w.org/2026/11/8716aee28c4834031.17915440.jpg' },
  { name: 'Pebble', species: 'cat', breed: 'Tabby', sex: 'female', ageMonths: 4, size: 'small', temperament: ['playful', 'kid_friendly'], vaccinated: false, neutered: false,
    description: 'Pebble is a young kitten with blue-green eyes and endless energy. Her first vaccinations are booked.',
    photo: 'https://pd.w.org/2026/11/9586afa0b93d91e24.86932231.jpeg' },
  { name: 'Barb', species: 'rabbit', breed: 'Mixed', sex: 'female', ageMonths: 14, size: 'small', temperament: ['quiet', 'gentle'], vaccinated: true, neutered: true,
    description: 'Barb loves fresh hay and quiet company. She is litter-trained and happy indoors.',
    photo: 'https://pd.w.org/2023/07/98864b5bf173398e2.01282421-rotated.jpeg' },
  { name: 'Kiwi', species: 'bird', breed: 'Budgerigar', sex: 'male', ageMonths: 12, size: 'small', temperament: ['chatty', 'social'], vaccinated: false, neutered: false,
    description: 'Kiwi is a cheerful green budgie who chats every morning. Comes with his cage and toys.',
    photo: 'https://pd.w.org/2024/05/703665961a3b54da6.65063101.jpeg' }
];

async function signIn(who) {
  const r = await fetch(COGNITO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: env.COGNITO_CLIENT_ID, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: users[who].email, PASSWORD: users[who].password } })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.AuthenticationResult) throw new Error(`sign-in failed for ${who}@shelter.test`);
  return j.AuthenticationResult.IdToken;
}

async function call(method, p, token, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json && json.error ? json.error.code : ''}`);
  return json;
}

// Download a photo once. A resized copy (1200 px wide) is tried first through the
// WordPress image CDN; the original file is the fallback. Must be a JPEG of at most 5 MB.
async function getPhoto(name, url) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = path.join(PHOTO_DIR, `${name.toLowerCase()}.jpg`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const candidates = [`https://i0.wp.com/${url.replace(/^https:\/\//, '')}?w=1200&quality=85`, url];
  for (const u of candidates) {
    try {
      const res = await fetch(u);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      if (!isJpeg || buf.length > MAX_BYTES) continue;
      fs.writeFileSync(file, buf);
      return buf;
    } catch { /* try the next source */ }
  }
  return null;
}

async function main() {
  console.log(`Seeding animals  API ${API}\n`);
  const staff = await signIn('staff');
  const existing = new Set();
  for (const status of ['available', 'on_hold', 'reserved', 'adopted']) {
    const list = await call('GET', `/api/animals?status=${status}&limit=50`, staff);
    list.items.forEach((a) => existing.add(a.name.toLowerCase()));
  }

  let added = 0; let photos = 0;
  for (const { photo, ...fields } of ANIMALS) {
    if (existing.has(fields.name.toLowerCase())) { console.log(`  skip  ${fields.name} (already there)`); continue; }
    const animal = await call('POST', '/api/animals', staff, fields);
    added++;
    const img = await getPhoto(fields.name, photo);
    if (!img) { console.log(`  added ${fields.name}  (photo could not be downloaded - upload one from the staff dashboard)`); continue; }
    const up = await call('POST', `/api/animals/${animal.id}/photos`, staff, { contentType: 'image/jpeg' });
    const put = await fetch(up.upload.url, { method: 'PUT', headers: up.upload.headers, body: img });
    if (!put.ok) { console.log(`  added ${fields.name}  (photo upload to S3 failed: ${put.status})`); continue; }
    await call('PATCH', `/api/animals/${animal.id}/photos/${up.photo.id}`, staff, { status: 'ready' });
    photos++;
    console.log(`  added ${fields.name.padEnd(7)} ${fields.species.padEnd(6)} with photo (${Math.round(img.length / 1024)} KB)`);
  }
  console.log(`\nDone: ${added} animal(s) added, ${photos} photo(s) uploaded. Open the website and press Ctrl+F5.`);
}

main().catch((e) => { console.error(`Seeding stopped: ${e.message}`); process.exit(1); });
