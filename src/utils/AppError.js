// An error that carries its own HTTP status. The error handler sends an AppError
// to the client as it is; any other error becomes a 500.
const { HTTP_STATUS } = require('../config/constants');

class AppError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} message  a message that is safe to show the client
   * @param {Array<{field: string, message: string}>} [details]  one entry per bad field
   * @param {object} [extra]  more safe fields for the error body
   *                          (for example the waitlist offer on a 409)
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
