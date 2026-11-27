// Animal Listings routes. Reads are public; every write needs Staff or Admin.
const router = require('express').Router();
const { authenticate, optionalAuth, requireRole, STAFF_ROLES } = require('../lib/auth');
const c = require('../controllers/animalsController');

const staffOnly = [authenticate, requireRole(...STAFF_ROLES)];

router.get('/', optionalAuth, c.list);                                    // search + filter
router.get('/:id', optionalAuth, c.getOne);                               // profile with photos
router.post('/', ...staffOnly, c.create);                                 // 201
router.patch('/:id', ...staffOnly, c.update);                             // details / hold
router.delete('/:id', ...staffOnly, c.archive);                           // soft delete, 204
router.post('/:id/photos', ...staffOnly, c.createPhotoUpload);            // 201 + presigned S3 URL
router.patch('/:id/photos/:photoId', ...staffOnly, c.confirmPhoto);       // verify upload, 200
router.delete('/:id/photos/:photoId', ...staffOnly, c.deletePhoto);       // 204

module.exports = router;
