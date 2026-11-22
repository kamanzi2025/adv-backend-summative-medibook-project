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

// A doctor's appointments on one day: ?date=YYYY-MM-DD (default: today).
router.route('/:id/appointments')
  .get(appointmentController.listDoctorDay)
  .all(methodNotAllowed(['GET']));

module.exports = router;
