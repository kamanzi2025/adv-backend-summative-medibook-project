// Cancelling takes no input, because the server always works out the refund.
// No body or an empty {} is fine. Anything else, like a client trying to send its
// own refundPercent, gets a 400.
const AppError = require('../utils/AppError');
const { isPlainObject } = require('./common');

/** @throws {AppError} 400 unless the body is missing or {} */
function assertEmptyCancelBody(body) {
  if (body === undefined) return;
  if (!isPlainObject(body)) {
    throw AppError.badRequest('Cancellation takes no request body (send none, or {})', [
      { field: 'body', message: 'must be empty or {}' },
    ]);
  }
  const fields = Object.keys(body);
  if (fields.length > 0) {
    throw AppError.badRequest(
      `Cancellation takes no fields: the refund is computed by the server (check ${fields.join(', ')})`,
      fields.map((field) => ({ field, message: 'is not an allowed field (no fields are allowed)' })),
    );
  }
}

module.exports = { assertEmptyCancelBody };
