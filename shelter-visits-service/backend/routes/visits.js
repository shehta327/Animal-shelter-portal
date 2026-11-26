// Visit Scheduling routes.
const router = require('express').Router();
const { authenticate, optionalAuth, requireRole, ROLES, STAFF_ROLES } = require('../lib/auth');
const c = require('../controllers/visitsController');

const staffOnly = [authenticate, requireRole(...STAFF_ROLES)];

router.get('/slots', optionalAuth, c.listSlots);                              // open slots for an animal
router.post('/slots', ...staffOnly, c.createSlot);                            // 201
router.delete('/slots/:id', ...staffOnly, c.cancelSlot);                      // cancels its bookings too
router.post('/bookings', authenticate, requireRole(ROLES.ADOPTER), c.book);   // 201
router.get('/bookings', authenticate, c.listBookings);                        // adopter: own, staff: all
router.get('/bookings/:id', authenticate, c.getBooking);                      // owner or staff (else 404)
router.patch('/bookings/:id', authenticate, c.updateBooking);                 // cancel / outcome

module.exports = router;
