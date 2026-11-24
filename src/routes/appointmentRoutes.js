const { Router } = require('express');
const appointmentController = require('../controllers/appointmentController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/')
  .post(appointmentController.bookAppointment)
  .all(methodNotAllowed(['POST']));

router.route('/:id')
  .get(appointmentController.getAppointment)
  .all(methodNotAllowed(['GET']));

// PATCH, not DELETE: cancelling changes the appointment's status and refund
// columns, and the row is kept for refund history. DELETE would mean it's gone.
router.route('/:id/cancel')
  .patch(appointmentController.cancelAppointment)
  .all(methodNotAllowed(['PATCH']));

module.exports = router;
