// Mounted at /api/reports. Read-only reports: GET only, 405 for anything else.
const { Router } = require('express');
const reportController = require('../controllers/reportController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/doctors')
  .get(reportController.getDoctorsReport)
  .all(methodNotAllowed(['GET']));

router.route('/busy-days')
  .get(reportController.getBusyDays)
  .all(methodNotAllowed(['GET']));

module.exports = router;
