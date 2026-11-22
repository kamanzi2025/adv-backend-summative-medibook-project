const { Router } = require('express');
const healthController = require('../controllers/healthController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/')
  .get(healthController.getHealth)
  .all(methodNotAllowed(['GET']));

module.exports = router;
