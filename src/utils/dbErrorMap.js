// Translates known MySQL errors into safe HTTP answers. Pure: it only reads
// err.code / err.sqlMessage. The constraint names come from database/schema.sql.

const CONSTRAINT_MESSAGES = Object.freeze({
  uq_patient_email: { field: 'email', message: 'A patient with this email already exists' },
  uq_doctor_room: { field: 'room', message: 'Another doctor is already assigned to this room' },
  uq_appt_doctor_active_slot: { field: 'datetime', message: 'This doctor already has an appointment at that time' },
  uq_appt_patient_active_slot: { field: 'datetime', message: 'This patient already has an appointment at that time' },
});

// Deleting a row that appointments still point to (ON DELETE RESTRICT).
const FOREIGN_KEY_MESSAGES = Object.freeze({
  fk_appt_patient: 'This patient has appointments and cannot be deleted. Appointments (including cancelled ones) are kept permanently as refund history.',
  fk_appt_doctor: 'This doctor has appointments and cannot be deleted. Appointments (including cancelled ones) are kept permanently as refund history.',
});

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

function constraintFromForeignKey(sqlMessage = '') {
  // "... CONSTRAINT `fk_appt_doctor` FOREIGN KEY ..."
  const match = sqlMessage.match(/CONSTRAINT `([^`]+)`/);
  return match ? match[1] : null;
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

  switch (err.code) {
    case 'ER_DUP_ENTRY': {
      return withDetails(409, CONSTRAINT_MESSAGES[duplicateKeyName(err)],
        'A record with the same unique value already exists');
    }
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2': {
      const name = constraintFromForeignKey(err.sqlMessage);
      return {
        status: 409,
        message: FOREIGN_KEY_MESSAGES[name] || 'This record is referenced by other records and cannot be deleted',
      };
    }
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return { status: 404, message: 'The referenced patient or doctor does not exist' };
    case 'ER_CHECK_CONSTRAINT_VIOLATED': {
      const name = constraintFromCheck(err.sqlMessage);
      return { status: 400, message: `A value breaks the database rule ${name || '(unknown)'}` };
    }
    case 'ER_DATA_TOO_LONG':
      return { status: 400, message: 'A value is too long for its field' };
    default:
      if (BUSY_CODES.has(err.code)) {
        return { status: 503, message: 'The clinic is very busy right now. Please try again in a moment.' };
      }
      if (UNAVAILABLE_CODES.has(err.code)) {
        return { status: 503, message: 'The database is temporarily unavailable. Please try again shortly.' };
      }
      return null;
  }
}

module.exports = { mapDbError, duplicateKeyName };
