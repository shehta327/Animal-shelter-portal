// Animal Listings controller: validation + business rules.
// Business rules (not just CRUD):
//   * the public only sees animals that are available (or reserved/adopted by id)
//   * reserved and adopted are set ONLY by adoption events from the Applications
//     service; staff can only put an animal on hold, release the hold, or archive it
//   * an animal that is reserved cannot be held or archived (an adoption is in progress)
//   * adopted and archived animals are read-only
//   * at most 5 photos; an upload counts only after S3 confirms type and size
const crypto = require('crypto');
const store = require('../services/animalStore');
const photos = require('../services/photoStore');
const events = require('../lib/events');
const v = require('../lib/validate');
const { isStaff } = require('../lib/auth');
const { notFound, conflict, badRequest } = require('../lib/http');

const SPECIES = ['dog', 'cat', 'rabbit', 'bird', 'other'];
const SIZES = ['small', 'medium', 'large'];
const SEXES = ['male', 'female', 'unknown'];
const STATUSES = ['available', 'on_hold', 'reserved', 'adopted', 'archived'];
const PUBLIC_DETAIL = ['available', 'reserved', 'adopted'];
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const FIELDS = ['name', 'species', 'breed', 'sex', 'ageMonths', 'size', 'temperament', 'description', 'vaccinated', 'neutered'];

function readTemperament(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 6 || !value.every((t) => typeof t === 'string' && /^[a-z_]{2,20}$/.test(t))) {
    throw badRequest('temperament must be up to 6 tags like "calm" or "kid_friendly".', { field: 'temperament' });
  }
  return [...new Set(value)];
}

function readAnimal(body, { partial }) {
  const required = !partial;
  return {
    name: v.text(body.name, 'name', { required, min: 1, max: 60 }),
    species: v.oneOf(body.species, 'species', SPECIES, { required }),
    breed: v.text(body.breed, 'breed', { max: 60 }),
    sex: v.oneOf(body.sex, 'sex', SEXES),
    ageMonths: v.int(body.ageMonths, 'ageMonths', { required, min: 0, max: 360 }),
    size: v.oneOf(body.size, 'size', SIZES, { required }),
    temperament: readTemperament(body.temperament),
    description: v.text(body.description, 'description', { max: 2000 }),
    vaccinated: v.bool(body.vaccinated, 'vaccinated'),
    neutered: v.bool(body.neutered, 'neutered')
  };
}

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, val]) => val !== undefined));

// Public shape: presigned photo URLs, internal fields hidden from non-staff
async function present(animal, user) {
  const ready = Object.values(animal.photos || {})
    .filter((p) => p.status === 'ready')
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  const out = {
    id: animal.id,
    name: animal.name,
    species: animal.species,
    breed: animal.breed || null,
    sex: animal.sex,
    ageMonths: animal.ageMonths,
    size: animal.size,
    temperament: animal.temperament || [],
    description: animal.description || '',
    vaccinated: animal.vaccinated,
    neutered: animal.neutered,
    status: animal.status,
    createdAt: animal.createdAt,
    photos: await Promise.all(ready.map(async (p) => ({ id: p.id, url: await photos.viewUrl(p.key) })))
  };
  if (isStaff(user)) {
    out.pendingPhotos = Object.values(animal.photos || {}).filter((p) => p.status === 'pending').map((p) => p.id);
    out.reservedForApplicationId = animal.reservedForApplicationId || null;
    out.createdBy = animal.createdBy;
    out.updatedAt = animal.updatedAt;
  }
  return out;
}

async function list(req, res) {
  const q = req.query;
  const staff = isStaff(req.user);
  const status = staff ? (v.oneOf(q.status, 'status', STATUSES) || 'available') : 'available';
  if (!staff && q.status && q.status !== 'available') {
    req.authFailure = 'non-staff asked for hidden statuses';
  }
  const filters = {
    species: v.oneOf(q.species, 'species', SPECIES),
    size: v.oneOf(q.size, 'size', SIZES),
    sex: v.oneOf(q.sex, 'sex', SEXES),
    minAgeMonths: v.int(q.minAgeMonths, 'minAgeMonths', { min: 0, max: 360 }),
    maxAgeMonths: v.int(q.maxAgeMonths, 'maxAgeMonths', { min: 0, max: 360 }),
    temperament: q.temperament ? v.text(q.temperament, 'temperament', { max: 20 }) : undefined,
    q: v.text(q.q, 'q', { max: 50 })
  };
  const limit = v.int(q.limit, 'limit', { min: 1, max: 50 }) || 20;
  const page = v.int(q.page, 'page', { min: 1, max: 100 }) || 1;

  const term = filters.q ? filters.q.toLowerCase() : null;
  const matches = (await store.listByStatus(status)).filter((a) =>
    (!filters.species || a.species === filters.species)
    && (!filters.size || a.size === filters.size)
    && (!filters.sex || a.sex === filters.sex)
    && (filters.minAgeMonths === undefined || a.ageMonths >= filters.minAgeMonths)
    && (filters.maxAgeMonths === undefined || a.ageMonths <= filters.maxAgeMonths)
    && (!filters.temperament || (a.temperament || []).includes(filters.temperament))
    && (!term || `${a.name} ${a.breed || ''} ${a.description || ''}`.toLowerCase().includes(term)));

  const slice = matches.slice((page - 1) * limit, page * limit);
  res.status(200).json({
    items: await Promise.all(slice.map((a) => present(a, req.user))),
    total: matches.length,
    page,
    limit
  });
}

async function loadVisible(id, user) {
  if (!v.isUuid(id)) throw notFound('Animal');
  const animal = await store.get(id.toLowerCase());
  if (!animal) throw notFound('Animal');
  if (!isStaff(user) && !PUBLIC_DETAIL.includes(animal.status)) throw notFound('Animal');
  return animal;
}

async function getOne(req, res) {
  const animal = await loadVisible(req.params.id, req.user);
  res.status(200).json(await present(animal, req.user));
}

async function create(req, res) {
  v.onlyFields(req.body, FIELDS);
  const fields = readAnimal(req.body, { partial: false });
  const now = new Date().toISOString();
  const animal = await store.create({
    id: crypto.randomUUID(),
    ...fields,
    sex: fields.sex || 'unknown',
    temperament: fields.temperament || [],
    description: fields.description || '',
    vaccinated: fields.vaccinated ?? false,
    neutered: fields.neutered ?? false,
    status: 'available',
    photos: {},
    photoCount: 0,
    createdBy: req.user.sub,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now
  });
  await events.publish('AnimalStatusChanged', { animalId: animal.id, name: animal.name, from: null, to: 'available' });
  res.status(201).location(`/api/animals/${animal.id}`).json(await present(animal, req.user));
}

async function update(req, res) {
  v.onlyFields(req.body, [...FIELDS, 'status']);
  const current = await loadVisible(req.params.id, req.user);
  const fields = defined(readAnimal(req.body, { partial: true }));
  const wantStatus = v.oneOf(req.body.status, 'status', ['available', 'on_hold']);

  if (current.status === 'adopted') throw conflict('ANIMAL_ADOPTED', 'Adopted animals are read-only.');
  if (current.status === 'archived') throw conflict('ANIMAL_ARCHIVED', 'Archived animals are read-only.');
  if (!Object.keys(fields).length && !wantStatus) throw badRequest('Send at least one field to change.');

  let animal = current;
  if (Object.keys(fields).length) {
    animal = await store.updateDetails(current.id, fields);
    if (!animal) throw conflict('ANIMAL_CHANGED', 'The animal changed status meanwhile; reload and try again.');
  }
  if (wantStatus && wantStatus !== animal.status) {
    if (animal.status === 'reserved') {
      throw conflict('ANIMAL_RESERVED', 'This animal is reserved by an approved application; its status follows the adoption.');
    }
    const changed = await store.changeStatus(animal.id, [animal.status], wantStatus);
    if (!changed) throw conflict('ANIMAL_CHANGED', 'The animal changed status meanwhile; reload and try again.');
    await events.publish('AnimalStatusChanged', { animalId: animal.id, name: animal.name, from: animal.status, to: wantStatus });
    animal = changed;
  }
  res.status(200).json(await present(animal, req.user));
}

async function archive(req, res) {
  const animal = await loadVisible(req.params.id, req.user);
  if (animal.status === 'reserved') throw conflict('ANIMAL_RESERVED', 'A reserved animal cannot be archived while its adoption is in progress.');
  if (animal.status === 'adopted') throw conflict('ANIMAL_ADOPTED', 'Adopted animals are kept as a record and cannot be archived.');
  if (animal.status !== 'archived') {
    const changed = await store.changeStatus(animal.id, ['available', 'on_hold'], 'archived');
    if (!changed) throw conflict('ANIMAL_CHANGED', 'The animal changed status meanwhile; reload and try again.');
    await events.publish('AnimalStatusChanged', { animalId: animal.id, name: animal.name, from: animal.status, to: 'archived' });
  }
  res.status(204).end();
}

async function createPhotoUpload(req, res) {
  v.onlyFields(req.body, ['contentType']);
  const contentType = v.oneOf(req.body.contentType, 'contentType', Object.keys(IMAGE_TYPES), { required: true });
  const animal = await loadVisible(req.params.id, req.user);
  const photo = {
    id: crypto.randomUUID(),
    key: `animals/${animal.id}/${crypto.randomUUID()}.${IMAGE_TYPES[contentType]}`,
    contentType,
    status: 'pending',
    uploadedBy: req.user.sub,
    uploadedAt: new Date().toISOString()
  };
  const updated = await store.addPhoto(animal.id, photo, MAX_PHOTOS);
  if (!updated) {
    throw conflict('PHOTO_LIMIT', `An animal can have at most ${MAX_PHOTOS} photos, and adopted or archived animals cannot get new ones.`);
  }
  res.status(201).location(`/api/animals/${animal.id}/photos/${photo.id}`).json({
    photo: { id: photo.id, status: photo.status },
    upload: { method: 'PUT', url: await photos.uploadUrl(photo.key, contentType), headers: { 'Content-Type': contentType }, expiresIn: 300, maxBytes: MAX_PHOTO_BYTES }
  });
}

// The browser says "I uploaded it"; we check S3 ourselves before trusting it.
async function confirmPhoto(req, res) {
  v.onlyFields(req.body, ['status']);
  v.oneOf(req.body.status, 'status', ['ready'], { required: true });
  const animal = await loadVisible(req.params.id, req.user);
  const photo = (animal.photos || {})[req.params.photoId];
  if (!photo) throw notFound('Photo');
  if (photo.status === 'ready') return res.status(200).json({ id: photo.id, status: 'ready', url: await photos.viewUrl(photo.key) });

  const object = await photos.head(photo.key);
  if (!object) throw conflict('UPLOAD_MISSING', 'No file was uploaded for this photo yet.');
  if (object.size > MAX_PHOTO_BYTES || object.contentType !== photo.contentType) {
    await photos.remove(photo.key);
    await store.removePhoto(animal.id, photo.id);
    throw badRequest(`The uploaded file must be ${photo.contentType} and at most 5 MB. It was rejected and deleted.`);
  }
  await store.markPhotoReady(animal.id, photo.id, object.size);
  res.status(200).json({ id: photo.id, status: 'ready', url: await photos.viewUrl(photo.key) });
}

async function deletePhoto(req, res) {
  const animal = await loadVisible(req.params.id, req.user);
  const photo = (animal.photos || {})[req.params.photoId];
  if (!photo) throw notFound('Photo');
  await store.removePhoto(animal.id, photo.id);
  await photos.remove(photo.key);
  res.status(204).end();
}

module.exports = { list, getOne, create, update, archive, createPhotoUpload, confirmPhoto, deletePhoto };
