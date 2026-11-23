// For a URL that exists but doesn't support the HTTP method used (e.g. PUT on
// /api/patients/1): 405 + an Allow header listing the methods that do work.
const AppError = require('../utils/AppError');
const { HTTP_STATUS } = require('../config/constants');

function methodNotAllowed(allowedMethods) {
  const allow = allowedMethods.join(', ');
  return (req, res, next) => {
    res.set('Allow', allow);
    const path = req.originalUrl.split('?')[0];
    next(new AppError(HTTP_STATUS.METHOD_NOT_ALLOWED,`Method ${req.method} not allowed on ${path}. Allowed: ${allow}`));
  };
}

module.exports = methodNotAllowed;
