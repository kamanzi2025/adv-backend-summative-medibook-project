// Catch-all for any URL/method that no route handled. Registered after all routes.
const AppError = require('../utils/AppError');

function notFound(req, res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

module.exports = notFound;
