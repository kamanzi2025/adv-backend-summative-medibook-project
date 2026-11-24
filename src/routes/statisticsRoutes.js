// Mounted at /api/doctors/:id/statistics. mergeParams lets this router see :id.
const { Router } = require('express');
const statisticsController = require('../controllers/statisticsController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router({ mergeParams: true });

router.route('/')
  .get(statisticsController.getDoctorStatistics)
  .all(methodNotAllowed(['GET']));

module.exports = router;
