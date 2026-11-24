// Mounted at /feedback: the translated course feedback page (Part G).
const { Router } = require('express');
const feedbackController = require('../controllers/feedbackController');
const methodNotAllowed = require('../middleware/methodNotAllowed');

const router = Router();

router.route('/')
  .get(feedbackController.getFeedbackPage)
  .all(methodNotAllowed(['GET']));

module.exports = router;
