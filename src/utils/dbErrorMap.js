// Translates known MySQL errors into safe HTTP answers. Pure: it only reads
// err.code / err.sqlMessage. The constraint names come from database/schema.sql.
const { HTTP_STATUS } = require('../config/constants');

const CONSTRAINT_MESSAGES = Object.freeze({
  uq_patient_email: { field: 'email', message: 'A patient with this email already exists' },
  uq_doctor_room: { field: 'room', message: 'Another doctor is already assigned to this room' },
  uq_appt_doctor_active_slot: { field: 'datetime', message: 'This doctor already has an appointment at that time' },
  uq_appt_patient_active_slot: { field: 'datetime', message: 'This patient already has an appointment at that time' },
});

// Deleting a row that other rows still point to (ON DELETE RESTRICT). MySQL sends
// ER_ROW_IS_REFERENCED_2 (with the constraint name) to users who may read the child
// table's definition, and ER_ROW_IS_REFERENCED (1217, no name) to a least-privilege
// user like medibook_user. Both mean the same thing, so both are matched here.
const ROW_REFERENCED_CODES = new Set(['ER_ROW_IS_REFERENCED', 'ER_ROW_IS_REFERENCED_2']);

// Errors that mean "the database is unreachable", not "the request was wrong".
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_CON_COUNT_ERROR',
]);

// Lock conflicts that are already retried by the booking model; if they still
// happen after the retries, the client is asked to try again.
const BUSY_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Name of the UNIQUE key behind an ER_DUP_ENTRY error, e.g. "uq_patient_email".
 * MySQL's message: "Duplicate entry 'x' for key 'patients.uq_patient_email'"
 */
function duplicateKeyName(err) {
  const match = (err && err.sqlMessage ? err.sqlMessage : '').match(/for key '(?:[^.']+\.)?([^']+)'/);
  return match ? match[1] : null;
}

/** True if a DELETE failed because other rows still reference the row (FK RESTRICT). */
function isRowReferenced(err) {
  return Boolean(err) && ROW_REFERENCED_CODES.has(err.code);
}

function constraintFromCheck(sqlMessage = '') {
  // "Check constraint 'chk_doctor_fee_positive' is violated."
  const match = sqlMessage.match(/constraint '([^']+)'/i);
  return match ? match[1] : null;
}

function withDetails(status, known, fallbackMessage) {
  if (!known) return { status, message: fallbackMessage };
  return { status, message: known.message, details: [{ field: known.field, message: known.message }] };
}

/**
 * @param {Error & {code?: string, sqlMessage?: string}} err
 * @returns {{status: number, message: string, details?: Array} | null}  null = not a known DB error
 */
function mapDbError(err) {
  if (!err || typeof err.code !== 'string') return null;

  if (isRowReferenced(err)) {
    // Safety net only: the patient/doctor models already turn this into a specific 409.
    return { status: HTTP_STATUS.CONFLICT, message: 'This record is referenced by other records and cannot be deleted' };
  }

  switch (err.code) {
    case 'ER_DUP_ENTRY': {
      return withDetails(HTTP_STATUS.CONFLICT, CONSTRAINT_MESSAGES[duplicateKeyName(err)],
        'A record with the same unique value already exists');
    }
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return { status: HTTP_STATUS.NOT_FOUND, message: 'The referenced patient or doctor does not exist' };
    case 'ER_CHECK_CONSTRAINT_VIOLATED': {
      const name = constraintFromCheck(err.sqlMessage);
      return { status: HTTP_STATUS.BAD_REQUEST, message: `A value breaks the database rule ${name || '(unknown)'}` };
    }
    case 'ER_DATA_TOO_LONG':
      return { status: HTTP_STATUS.BAD_REQUEST, message: 'A value is too long for its field' };
    default:
      if (BUSY_CODES.has(err.code)) {
        return {
          status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          message: 'The clinic is very busy right now. Please try again in a moment.',
        };
      }
      if (UNAVAILABLE_CODES.has(err.code)) {
        return {
          status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          message: 'The database is temporarily unavailable. Please try again shortly.',
        };
      }
      return null;
  }
}

module.exports = { mapDbError, duplicateKeyName, isRowReferenced };
