// Visit Scheduling controller (owner: Abdelrahman Shehta).
// Business rules:
//   * staff open meet-and-greet slots: 30 or 60 minutes, on the hour or half hour,
//     1 hour (VISIT_LEAD_MINUTES) to 60 days ahead, capacity 1-4, never overlapping another open slot
//     for the same animal, and only for an animal the Animals service reports available
//   * only an adopter with an active application for that animal can book
//     (checked with the Applications service); one active booking per animal;
//     booking closes 1 hour before the start; capacity is enforced atomically
//   * adopters may cancel up to 24 hours before; staff may cancel until the start
//   * after the start, staff record the outcome (completed / no_show); this is
//     published as VisitCompleted and unlocks approval in the Applications service
const crypto = require('crypto');
const store = require('../services/visitStore');
const reminders = require('../services/reminders');
const events = require('../lib/events');
const { sendEmail } = require('../lib/email');
const { callService } = require('../lib/serviceClient');
const v = require('../lib/validate');
const { isStaff } = require('../lib/auth');
const { notFound, conflict, forbidden, badRequest, unavailable } = require('../lib/http');
const log = require('../lib/logger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Lead time before a slot (booking also closes this long before it) and the
// slot grid. Production: 60 min and :00/:30. For a live demo they can be set
// small (e.g. 2 and 1) so an outcome can be recorded without waiting an hour.
const LEAD = Number(process.env.VISIT_LEAD_MINUTES || 60) * 60 * 1000;
const STEP = Number(process.env.SLOT_STEP_MINUTES || 30);
const mins = (ms) => `${Math.round(ms / 60000)} minute${ms === 60000 ? '' : 's'}`;

const publicSlot = (s, user) => ({
  id: s.slotId,
  animalId: s.animalId,
  animalName: s.animalName,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  durationMinutes: s.durationMinutes,
  capacity: s.capacity,
  placesLeft: Math.max(0, s.capacity - s.bookedCount),
  status: s.status,
  ...(isStaff(user) ? { bookedCount: s.bookedCount, createdBy: s.createdBy } : {})
});

const publicBooking = (b, user) => ({
  id: b.bookingId,
  slotId: b.slotId,
  animalId: b.animalId,
  animalName: b.animalName,
  applicationId: b.applicationId,
  startsAt: b.startsAt,
  status: b.status,
  outcomeNote: b.outcomeNote || null,
  createdAt: b.createdAt,
  ...(isStaff(user) ? { adopterId: b.adopterId, adopterName: b.adopterName } : {})
});

function email(booking, subject, text, template) {
  return sendEmail({
    to: booking.adopterEmail,
    subject,
    text: `Hello ${booking.adopterName},\n\n${text}\n\nAnimal Shelter Adoption Portal`,
    template
  });
}

const when = (iso) => new Date(iso).toUTCString().replace(':00 GMT', ' UTC');

async function createSlot(req, res) {
  v.onlyFields(req.body, ['animalId', 'startsAt', 'durationMinutes', 'capacity']);
  const animalId = v.uuid(req.body.animalId, 'animalId');
  const startsAt = v.isoDate(req.body.startsAt, 'startsAt', { required: true });
  const durationMinutes = v.int(req.body.durationMinutes, 'durationMinutes', { min: 30, max: 60 }) || 30;
  const capacity = v.int(req.body.capacity, 'capacity', { min: 1, max: 4 }) || 1;
  if (![30, 60].includes(durationMinutes)) throw badRequest('durationMinutes must be 30 or 60.', { field: 'durationMinutes' });

  const start = Date.parse(startsAt);
  const d = new Date(start);
  if (d.getUTCSeconds() || d.getUTCMilliseconds() || d.getUTCMinutes() % STEP) {
    throw badRequest(STEP === 30 ? 'Slots start on the hour or half hour.' : `Slots start on a ${STEP}-minute boundary.`, { field: 'startsAt' });
  }
  if (start < Date.now() + LEAD) throw badRequest(`A slot must start at least ${mins(LEAD)} from now.`, { field: 'startsAt' });
  if (start > Date.now() + 60 * DAY) throw badRequest('A slot can be at most 60 days ahead.', { field: 'startsAt' });
  const endsAt = new Date(start + durationMinutes * 60 * 1000).toISOString();

  // Integration: the animal must exist and be available (Animals service)
  const { status, body: animal } = await callService(`/api/animals/${animalId}`, { token: req.user.token });
  if (status === 404) throw notFound('Animal');
  if (status !== 200 || !animal) throw unavailable('The Animals service did not answer. Try again shortly.');
  if (animal.status !== 'available') throw conflict('ANIMAL_NOT_AVAILABLE', 'Visits can only be scheduled for available animals.');

  // No two open slots for the same animal may overlap
  const nearby = await store.slotsForAnimal(animalId, new Date(start - 60 * 60 * 1000).toISOString(), endsAt);
  const overlap = nearby.find((s) => s.status === 'open' && s.startsAt < endsAt && s.endsAt > startsAt);
  if (overlap) throw conflict('SLOT_OVERLAP', `This animal already has a slot from ${when(overlap.startsAt)}.`);

  const slot = await store.createSlot({
    slotId: crypto.randomUUID(),
    animalId,
    animalName: animal.name,
    startsAt,
    endsAt,
    durationMinutes,
    capacity,
    bookedCount: 0,
    status: 'open',
    createdBy: req.user.sub,
    createdAt: new Date().toISOString()
  });
  res.status(201).location(`/api/visits/slots/${slot.slotId}`).json(publicSlot(slot, req.user));
}

async function listSlots(req, res) {
  const animalId = v.uuid(req.query.animalId, 'animalId');
  const staff = isStaff(req.user);
  const from = staff && req.query.includePast === 'true' ? '0000' : new Date().toISOString();
  const slots = (await store.slotsForAnimal(animalId, from, '9999'))
    .filter((s) => staff || (s.status === 'open' && s.bookedCount < s.capacity))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  res.status(200).json({ items: slots.map((s) => publicSlot(s, req.user)), total: slots.length });
}

async function cancelSlot(req, res) {
  if (!v.isUuid(req.params.id)) throw notFound('Slot');
  const slot = await store.getSlot(req.params.id.toLowerCase());
  if (!slot) throw notFound('Slot');
  if (slot.status !== 'open') throw conflict('SLOT_CLOSED', 'This slot is already cancelled.');
  if (Date.parse(slot.startsAt) <= Date.now()) throw conflict('VISIT_STARTED', 'A slot cannot be cancelled after it has started.');
  const cancelled = await cancelBookingsAndSlot(slot, req.user.sub, 'The shelter had to cancel this visit slot.');
  res.status(200).json({ ...publicSlot({ ...slot, status: 'cancelled' }, req.user), cancelledBookings: cancelled });
}

// Shared by DELETE /slots/:id and the AnimalStatusChanged consumer
async function cancelBookingsAndSlot(slot, by, reason) {
  await store.cancelSlot(slot.slotId, by);
  let count = 0;
  for (const b of await store.bookingsForSlot(slot.slotId)) {
    if (b.status !== 'booked') continue;
    if (await store.closeBooking(b, 'cancelled', { cancelledBy: by })) {
      count += 1;
      await reminders.cancelReminder(b.bookingId);
      await email(b, `Visit with ${b.animalName} cancelled`, `${reason} Your visit on ${when(b.startsAt)} is cancelled.`, 'visit-cancelled-by-shelter');
    }
  }
  return count;
}

async function book(req, res) {
  v.onlyFields(req.body, ['slotId']);
  const slotId = v.uuid(req.body.slotId, 'slotId');
  const slot = await store.getSlot(slotId);
  if (!slot) throw notFound('Slot');
  if (slot.status !== 'open') throw conflict('SLOT_CLOSED', 'This slot was cancelled.');
  if (Date.parse(slot.startsAt) < Date.now() + LEAD) throw conflict('BOOKING_CLOSED', `Booking closes ${mins(LEAD)} before the visit.`);

  // Integration: the adopter needs an active application for this animal
  // (Applications service, called with the adopter's own token)
  const { status, body: elig } = await callService(`/api/applications/eligibility?animalId=${slot.animalId}`, { token: req.user.token });
  if (status !== 200 || !elig) throw unavailable('The Applications service did not answer. Try again shortly.');
  if (!elig.eligible) throw conflict('APPLICATION_REQUIRED', 'Apply to adopt this animal before booking a visit.');
  if (elig.visitCompleted) throw conflict('VISIT_ALREADY_COMPLETED', 'You have already completed a visit with this animal.');

  const booking = {
    bookingId: crypto.randomUUID(),
    slotId: slot.slotId,
    animalId: slot.animalId,
    animalName: slot.animalName,
    applicationId: elig.applicationId,
    adopterId: req.user.sub,
    adopterName: req.user.name || req.user.email,
    adopterEmail: req.user.email,
    startsAt: slot.startsAt,
    status: 'booked',
    createdAt: new Date().toISOString()
  };
  const result = await store.book(slot, booking);
  if (!result.ok && result.reason === 'ALREADY_BOOKED') {
    throw conflict('ALREADY_BOOKED', 'You already have a visit booked with this animal. Cancel it first to choose another time.');
  }
  if (!result.ok) throw conflict('SLOT_FULL', 'This slot is full or no longer open. Choose another time.');

  await reminders.scheduleReminder(booking);
  await email(booking, `Visit booked with ${booking.animalName}`, `Your meet-and-greet visit is booked for ${when(booking.startsAt)}. Please arrive 10 minutes early.`, 'visit-booked');
  log.info('visit booked', { bookingId: booking.bookingId, slotId: slot.slotId });
  res.status(201).location(`/api/visits/bookings/${booking.bookingId}`).json(publicBooking(booking, req.user));
}

async function listBookings(req, res) {
  const status = v.oneOf(req.query.status, 'status', ['booked', 'cancelled', 'completed', 'no_show']);
  const animalId = req.query.animalId ? v.uuid(req.query.animalId, 'animalId') : undefined;
  const rows = isStaff(req.user) ? await store.allBookings() : await store.bookingsForAdopter(req.user.sub);
  const items = rows
    .filter((b) => (!status || b.status === status) && (!animalId || b.animalId === animalId))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  res.status(200).json({ items: items.map((b) => publicBooking(b, req.user)), total: items.length });
}

async function loadBooking(req) {
  if (!v.isUuid(req.params.id)) throw notFound('Booking');
  const b = await store.getBooking(req.params.id.toLowerCase());
  // Ownership: an adopter asking for someone else's booking gets the same 404
  if (!b || (!isStaff(req.user) && b.adopterId !== req.user.sub)) throw notFound('Booking');
  return b;
}

async function getBooking(req, res) {
  res.status(200).json(publicBooking(await loadBooking(req), req.user));
}

async function updateBooking(req, res) {
  v.onlyFields(req.body, ['status', 'note']);
  const to = v.oneOf(req.body.status, 'status', ['cancelled', 'completed', 'no_show'], { required: true });
  const note = v.text(req.body.note, 'note', { max: 500 });
  const b = await loadBooking(req);
  if (b.status !== 'booked') throw conflict('BOOKING_CLOSED', `This booking is already ${b.status}.`);
  const start = Date.parse(b.startsAt);
  const staff = isStaff(req.user);

  if (to === 'cancelled') {
    if (start <= Date.now()) throw conflict('VISIT_STARTED', 'A visit cannot be cancelled after it has started.');
    if (!staff && start - Date.now() < DAY) {
      throw conflict('CANCEL_WINDOW_CLOSED', 'Visits can be cancelled online up to 24 hours before. Please call the shelter.');
    }
    if (!(await store.closeBooking(b, 'cancelled', { cancelledBy: req.user.sub }))) {
      throw conflict('BOOKING_CHANGED', 'The booking changed meanwhile; reload and try again.');
    }
    await reminders.cancelReminder(b.bookingId);
    await email(b, `Visit with ${b.animalName} cancelled`, `Your visit on ${when(b.startsAt)} was cancelled.`, 'visit-cancelled');
  } else {
    // completed / no_show: staff only, and only once the visit has started
    if (!staff) throw forbidden('Only shelter staff can record a visit outcome.');
    if (start > Date.now()) throw conflict('VISIT_NOT_STARTED', 'Record the outcome after the visit has started.');
    if (!(await store.closeBooking(b, to, { outcomeNote: note || null, recordedBy: req.user.sub }))) {
      throw conflict('BOOKING_CHANGED', 'The booking changed meanwhile; reload and try again.');
    }
    await events.publish('VisitCompleted', {
      bookingId: b.bookingId, applicationId: b.applicationId, animalId: b.animalId, adopterId: b.adopterId, outcome: to, note: note || null
    });
  }
  res.status(200).json(publicBooking({ ...b, status: to, outcomeNote: to === 'cancelled' ? null : note }, req.user));
}

module.exports = { createSlot, listSlots, cancelSlot, book, listBookings, getBooking, updateBooking, cancelBookingsAndSlot, publicSlot };
