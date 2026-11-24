// Mounted at /api/doctors/:id/waitlist. mergeParams makes req.params.id the doctor id.
const { Router } = require('express');
const waitlistController = require('../controllers/waitlistController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router({ mergeParams: true });

router.route('/')
  .get(waitlistController.getDoctorWaitlist)
  .all(methodNotAllowed(['GET']));

module.exports = router;
