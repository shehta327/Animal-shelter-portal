// Adoption Applications controller.
// Business rules:
//   * only adopters apply; only for an animal the Animals service reports as available
//   * one active application per adopter per animal; at most 3 active applications per adopter
//   * a status workflow with fixed transitions and who may make each one
//   * approval needs a completed meet-and-greet visit (from the Visits service)
//     and the animal must still be available; only one approval per animal
//   * completing an adoption rejects every other open application for that animal
//   * approvals, completions and released approvals are published as events,
//     so the Animals service reserves / adopts / releases the animal
const store = require('../services/applicationStore');
const events = require('../lib/events');
const { sendEmail } = require('../lib/email');
const { callService } = require('../lib/serviceClient');
const v = require('../lib/validate');
const { isStaff } = require('../lib/auth');
const { notFound, conflict, forbidden, unavailable } = require('../lib/http');
const log = require('../lib/logger');

const HOUSING = ['apartment', 'house', 'house_with_garden', 'other'];
const STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'completed'];
const MAX_ACTIVE = 3;

// from -> to -> who may do it
const TRANSITIONS = {
  submitted: { under_review: 'staff', rejected: 'staff', withdrawn: 'owner' },
  under_review: { approved: 'staff', rejected: 'staff', withdrawn: 'owner' },
  approved: { completed: 'staff', rejected: 'staff', withdrawn: 'owner' }
};

const EMAIL_TEXT = {
  submitted: 'We received your application. Next step: book a meet-and-greet visit from the animal\'s page.',
  under_review: 'Your application is now under review by our staff.',
  approved: 'Good news: your application was approved. The animal is reserved for you; staff will contact you to arrange the adoption.',
  rejected: 'We are sorry: your application was not successful this time.',
  completed: 'The adoption is complete. Thank you for giving a home to a shelter animal!',
  withdrawn: 'Your application was withdrawn as requested.'
};

function notify(app, status, email = app.adopterEmail || app.adopter_email) {
  return sendEmail({
    to: email,
    subject: `Your application for ${app.animalName || app.animal_name}: ${status.replace('_', ' ')}`,
    text: `Hello ${app.adopterName || app.adopter_name},\n\n${EMAIL_TEXT[status]}\n\nAnimal Shelter Adoption Portal`,
    template: `application-${status}`
  });
}

async function fetchAnimal(animalId) {
  const { status, body } = await callService(`/api/animals/${animalId}`);
  if (status === 404) return null;
  if (status !== 200 || !body) throw unavailable('The Animals service did not answer. Try again shortly.');
  return body;
}

async function submit(req, res) {
  const body = req.body || {};
  v.onlyFields(body, ['animalId', 'housingType', 'hasOtherPets', 'hasChildren', 'experience', 'message']);
  const input = {
    animalId: v.uuid(body.animalId, 'animalId'),
    housingType: v.oneOf(body.housingType, 'housingType', HOUSING, { required: true }),
    hasOtherPets: v.bool(body.hasOtherPets, 'hasOtherPets', { required: true }),
    hasChildren: v.bool(body.hasChildren, 'hasChildren') ?? false,
    experience: v.text(body.experience, 'experience', { max: 1000 }) || '',
    message: v.text(body.message, 'message', { max: 1000 }) || ''
  };

  // Integration: ask the Animals service (not its database) whether the animal can be adopted
  const animal = await fetchAnimal(input.animalId);
  if (!animal) throw notFound('Animal');
  if (animal.status !== 'available') throw conflict('ANIMAL_NOT_AVAILABLE', 'This animal is not available for adoption.');
  if (await store.countActive(req.user.sub) >= MAX_ACTIVE) {
    throw conflict('TOO_MANY_ACTIVE', `You can have at most ${MAX_ACTIVE} active applications at a time.`);
  }

  let app;
  try {
    app = await store.create({ ...input, animalName: animal.name, adopterName: req.user.name || req.user.email }, req.user);
  } catch (e) {
    if (e.code === '23505') throw conflict('DUPLICATE_APPLICATION', 'You already have an active application for this animal.');
    throw e;
  }
  await notify({ ...app, adopterEmail: req.user.email }, 'submitted');
  res.status(201).location(`/api/applications/${app.id}`).json(app);
}

async function list(req, res) {
  const status = v.oneOf(req.query.status, 'status', STATUSES);
  const animalId = req.query.animalId ? v.uuid(req.query.animalId, 'animalId') : undefined;
  const items = await store.list({ adopterId: isStaff(req.user) ? undefined : req.user.sub, status, animalId });
  res.status(200).json({ items, total: items.length });
}

// Used by the Visits service (with the adopter's own token) before a booking
async function eligibility(req, res) {
  const animalId = v.uuid(req.query.animalId, 'animalId');
  const app = await store.activeFor(req.user.sub, animalId);
  res.status(200).json({
    eligible: Boolean(app),
    applicationId: app ? app.id : null,
    status: app ? app.status : null,
    visitCompleted: Boolean(app && app.visitCompletedAt)
  });
}

async function load(req) {
  if (!v.isUuid(req.params.id)) throw notFound('Application');
  // Ownership check in the query itself: another adopter's id looks like a missing one (no IDOR)
  const app = await store.get(req.params.id.toLowerCase(), { adopterId: isStaff(req.user) ? undefined : req.user.sub });
  if (!app) throw notFound('Application');
  return app;
}

async function getOne(req, res) {
  const app = await load(req);
  const { adopterEmail, ...visible } = app;
  res.status(200).json({ ...visible, history: await store.history(app.id) });
}

async function changeStatus(req, res) {
  const body = req.body || {};
  v.onlyFields(body, ['status', 'note']);
  const to = v.oneOf(body.status, 'status', STATUSES, { required: true });
  const note = v.text(body.note, 'note', { max: 500 });
  const app = await load(req);

  const who = (TRANSITIONS[app.status] || {})[to];
  if (!who) throw conflict('INVALID_TRANSITION', `An application cannot move from ${app.status} to ${to}.`);
  if (who === 'staff' && !isStaff(req.user)) throw forbidden('Only shelter staff can make this change.');
  if (who === 'owner' && app.adopterId !== req.user.sub) throw forbidden('Only the applicant can withdraw an application.');

  if (to === 'approved') {
    if (!app.visitCompletedAt) throw conflict('VISIT_REQUIRED', 'Approve only after a completed meet-and-greet visit.');
    const animal = await fetchAnimal(app.animalId);
    if (!animal || animal.status !== 'available') throw conflict('ANIMAL_NOT_AVAILABLE', 'The animal is no longer available.');
  }

  let result;
  try {
    result = await store.transition(app, to, req.user, note);
  } catch (e) {
    if (e.code === '23505') throw conflict('ANIMAL_ALREADY_APPROVED', 'Another application for this animal is already approved.');
    throw e;
  }
  if (!result.changed) throw conflict('APPLICATION_CHANGED', 'The application changed meanwhile; reload and try again.');

  const detail = { applicationId: app.id, animalId: app.animalId, adopterId: app.adopterId };
  if (to === 'approved') await events.publish('ApplicationApproved', detail);
  if (to === 'completed') await events.publish('ApplicationCompleted', detail);
  if (app.status === 'approved' && ['rejected', 'withdrawn'].includes(to)) {
    await events.publish('ApplicationReleased', { ...detail, reason: to });
  }
  await notify(app, to);
  for (const other of result.autoRejected) {
    await notify(other, 'rejected', other.adopter_email);
  }
  log.info('application status changed', { applicationId: app.id, from: app.status, to, autoRejected: result.autoRejected.length });

  const updated = await store.get(app.id);
  const { adopterEmail, ...visible } = updated;
  res.status(200).json({ ...visible, autoRejected: result.autoRejected.length });
}

async function addNote(req, res) {
  const body = req.body || {};
  v.onlyFields(body, ['note']);
  const note = v.text(body.note, 'note', { required: true, min: 1, max: 500 });
  const app = await load(req);
  const row = await store.addNote(app.id, req.user, note);
  res.status(201).json(row);
}

module.exports = { submit, list, eligibility, getOne, changeStatus, addNote };
