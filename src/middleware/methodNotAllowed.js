// For a URL that exists but not with this method, like PUT /api/patients/1.
// Returns 405 and an Allow header listing the methods that do work.
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
