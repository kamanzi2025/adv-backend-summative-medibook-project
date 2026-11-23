// PATCH /api/appointments/:id/cancel takes no input: the refund is always computed
// by the server. No body or an empty JSON object {} is accepted; anything else
// (e.g. a client trying to send refundPercent) is a 400. Pure: no DB, no Redis.
const AppError = require('../utils/AppError');
const { isPlainObject } = require('./common');

/** @throws {AppError} 400 if the body is not absent or {} */
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
