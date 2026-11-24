// Runs when no route matched the request. It's registered after all the routes.
const AppError = require('../utils/AppError');

function notFound(req, res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

module.exports = notFound;
