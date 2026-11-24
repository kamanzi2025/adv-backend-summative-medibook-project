const { Router } = require('express');
const doctorController = require('../controllers/doctorController');
const appointmentController = require('../controllers/appointmentController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/')
  .get(doctorController.listDoctors)
  .post(doctorController.createDoctor)
  .all(methodNotAllowed(['GET', 'POST']));

router.route('/:id')
  .get(doctorController.getDoctor)
  .patch(doctorController.updateDoctor)
  .delete(doctorController.deleteDoctor)
  .all(methodNotAllowed(['GET', 'PATCH', 'DELETE']));

// One doctor's appointments for a day: ?date=YYYY-MM-DD, today if left out.
router.route('/:id/appointments')
  .get(appointmentController.listDoctorDay)
  .all(methodNotAllowed(['GET']));

module.exports = router;
