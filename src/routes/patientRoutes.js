const { Router } = require('express');
const patientController = require('../controllers/patientController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/')
  .get(patientController.listPatients)
  .post(patientController.createPatient)
  .all(methodNotAllowed(['GET', 'POST']));

router.route('/:id')
  .get(patientController.getPatient)
  .patch(patientController.updatePatient)
  .delete(patientController.deletePatient)
  .all(methodNotAllowed(['GET', 'PATCH', 'DELETE']));

module.exports = router;
