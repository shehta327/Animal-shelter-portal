// Internal events from the shared EventBridge bus (never reachable through
// API Gateway). The Applications service decides adoptions; this service keeps
// each animal's status in step:
//   ApplicationApproved  available -> reserved   (reservedForApplicationId set)
//   ApplicationCompleted reserved  -> adopted    (only for the reserving application)
//   ApplicationReleased  reserved  -> available  (approval cancelled)
// Business conflicts are logged, not thrown: a throw would make EventBridge retry.
const store = require('../services/animalStore');
const events = require('../lib/events');
const log = require('../lib/logger');

const TRANSITIONS = {
  ApplicationApproved: { from: ['available'], to: 'reserved', pin: false },
  ApplicationCompleted: { from: ['reserved'], to: 'adopted', pin: true },
  ApplicationReleased: { from: ['reserved'], to: 'available', pin: true }
};

async function handleEvent(event) {
  const type = event['detail-type'];
  const rule = TRANSITIONS[type];
  const detail = event.detail || {};
  if (!rule || !detail.animalId || !detail.applicationId) {
    log.warn('event ignored', { detailType: type || event.kind || 'unknown' });
    return { ignored: true };
  }
  const options = rule.pin ? { requireReservation: detail.applicationId } : {};
  if (type === 'ApplicationApproved') options.extraSet = { reservedForApplicationId: detail.applicationId };
  if (type === 'ApplicationCompleted') options.extraSet = { adoptedAt: new Date().toISOString() };
  if (type === 'ApplicationReleased') options.remove = ['reservedForApplicationId'];

  const before = await store.get(detail.animalId);
  const changed = await store.changeStatus(detail.animalId, rule.from, rule.to, options);
  if (!changed) {
    log.warn('animal status not changed', { detailType: type, animalId: detail.animalId, currentStatus: before ? before.status : 'missing' });
    return { changed: false };
  }
  log.info('animal status changed by event', { detailType: type, animalId: changed.id, from: before.status, to: changed.status });
  await events.publish('AnimalStatusChanged', { animalId: changed.id, name: changed.name, from: before.status, to: changed.status });
  return { changed: true };
}

module.exports = { handleEvent };
