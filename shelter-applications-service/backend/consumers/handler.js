// Internal events: VisitCompleted from the Visits service.
// A completed visit unlocks approval (and moves "submitted" into review);
// a no-show is recorded in the application history.
const store = require('../services/applicationStore');
const log = require('../lib/logger');

async function handleEvent(event) {
  const type = event['detail-type'];
  const d = event.detail || {};
  if (type !== 'VisitCompleted' || !d.applicationId || !['completed', 'no_show'].includes(d.outcome)) {
    log.warn('event ignored', { detailType: type || event.kind || 'unknown' });
    return { ignored: true };
  }
  const app = await store.recordVisit(d.applicationId, d.outcome, d.note);
  if (!app) {
    log.warn('visit result for a closed or unknown application', { applicationId: d.applicationId });
    return { changed: false };
  }
  log.info('visit recorded on application', { applicationId: d.applicationId, outcome: d.outcome, status: app.status });
  return { changed: true };
}

module.exports = { handleEvent };
