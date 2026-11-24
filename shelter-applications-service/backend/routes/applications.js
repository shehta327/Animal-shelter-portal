// Adoption Applications routes: every route needs a signed-in user.
const router = require('express').Router();
const { authenticate, requireRole, ROLES, STAFF_ROLES } = require('../lib/auth');
const c = require('../controllers/applicationsController');

router.use(authenticate);
router.post('/', requireRole(ROLES.ADOPTER), c.submit);                 // 201
router.get('/', c.list);                                                // adopter: own, staff: all
router.get('/eligibility', requireRole(ROLES.ADOPTER), c.eligibility);  // used by Visits
router.get('/:id', c.getOne);                                           // owner or staff (else 404)
router.patch('/:id/status', c.changeStatus);                            // workflow decides who
router.post('/:id/notes', requireRole(...STAFF_ROLES), c.addNote);      // 201

module.exports = router;
