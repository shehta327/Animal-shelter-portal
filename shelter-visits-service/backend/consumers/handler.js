// Internal events (never reachable through API Gateway):
//   * EventBridge Scheduler {kind: "VisitReminder"} -> email the adopter
//   * AnimalStatusChanged to adopted / archived / on_hold -> cancel that
//     animal's future slots and notify the adopters who had booked them
const store = require('../services/visitStore');
const { sendEmail } = require('../lib/email');
const log = require('../lib/logger');
const { cancelBookingsAndSlot } = require('../controllers/visitsController');

async function reminder(bookingId) {
  const b = await store.getBooking(bookingId);
  if (!b || b.status !== 'booked') return { sent: false };
  await sendEmail({
    to: b.adopterEmail,
    subject: `Reminder: visit with ${b.animalName}`,
    text: `Hello ${b.adopterName},\n\nThis is a reminder of your meet-and-greet visit on ${new Date(b.startsAt).toUTCString()}.\n\nAnimal Shelter Adoption Portal`,
    template: 'visit-reminder'
  });
  log.info('visit reminder processed', { bookingId });
  return { sent: true };
}

async function animalChanged(detail) {
  if (!['adopted', 'archived', 'on_hold'].includes(detail.to)) return { ignored: true };
  const future = await store.slotsForAnimal(detail.animalId, new Date().toISOString(), '9999');
  let slots = 0;
  let bookings = 0;
  for (const slot of future.filter((s) => s.status === 'open')) {
    bookings += await cancelBookingsAndSlot(slot, 'system',
      detail.to === 'adopted' ? `${slot.animalName} has been adopted.` : `${slot.animalName} is no longer available for visits.`);
    slots += 1;
  }
  log.info('visits cancelled after animal status change', { animalId: detail.animalId, to: detail.to, slots, bookings });
  return { slots, bookings };
}

async function handleEvent(event) {
  if (event.kind === 'VisitReminder' && event.bookingId) return reminder(event.bookingId);
  if (event['detail-type'] === 'AnimalStatusChanged' && event.detail && event.detail.animalId) return animalChanged(event.detail);
  log.warn('event ignored', { detailType: event['detail-type'] || event.kind || 'unknown' });
  return { ignored: true };
}

module.exports = { handleEvent };
