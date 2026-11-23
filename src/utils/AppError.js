// An error that already knows its HTTP status. Anything thrown as an AppError is
// sent to the client as-is by the error middleware; anything else is a 500.
const { HTTP_STATUS } = require('../config/constants');

class AppError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} message  safe, human-readable message for the client
   * @param {Array<{field: string, message: string}>} [details]  per-field problems
   * @param {object} [extra]  additional safe fields for the error body
   *                          (e.g. the waitlist offer on a 409)
   */
  constructor(status, message, details, extra) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (details && details.length > 0) this.details = details;
    if (extra) this.extra = extra;
  }

  static badRequest(message, details) {
    return new AppError(HTTP_STATUS.BAD_REQUEST, message, details);
  }

  static notFound(message) {
    return new AppError(HTTP_STATUS.NOT_FOUND, message);
  }

  static conflict(message, details, extra) {
    return new AppError(HTTP_STATUS.CONFLICT, message, details, extra);
  }

  static unprocessable(message, details) {
    return new AppError(HTTP_STATUS.UNPROCESSABLE, message, details);
  }

  static serviceUnavailable(message) {
    return new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, message);
  }
}

module.exports = AppError;
