// Checks a booking request. A malformed request gets 400; a well-formed one that
// breaks a clinic rule (past time, 09:15, after hours) gets 422.
const AppError = require('../utils/AppError');
const { parseClinicDateTime } = require('../utils/clock');
const { slotRuleViolations } = require('../utils/slotRules');
const { positiveInteger, money, booleanValue, validateBody } = require('./common');

/** Field rule: exactly "YYYY-MM-DD HH:mm", and a date and time that really exist. */
function clinicDateTime() {
  return (raw) => {
    if (typeof raw !== 'string') return { error: 'must be a string in the format "YYYY-MM-DD HH:mm"' };
    const value = parseClinicDateTime(raw);
    if (!value) return { error: `"${raw}" is not a real date/time in the format "YYYY-MM-DD HH:mm"` };
    return { value };
  };
}

const BOOKING_RULES = Object.freeze({
  patientId: positiveInteger(),
  doctorId: positiveInteger(),
  appointmentDateTime: clinicDateTime(),
  amountPaid: money({ allowZero: true }),
  joinWaitlist: booleanValue(),
});

/**
 * The POST /api/appointments body. patientId, doctorId and appointmentDateTime are
 * required; amountPaid and joinWaitlist are optional.
 * @returns {{ patientId: number, doctorId: number, appointmentDateTime: Date,
 *            amountPaid?: number, joinWaitlist?: boolean }}
 * @throws {AppError} 400 listing every problem
 */
function validateBookingBody(body) {
  return validateBody(body, BOOKING_RULES, {
    entity: 'booking',
    optional: ['amountPaid', 'joinWaitlist'],
  });
}

/**
 * @param {Date} slot  clinic Date
 * @param {Date} now   clinic Date
 * @throws {AppError} 422 listing every rule that's broken
 */
function assertSlotBookable(slot, now) {
  const violations = slotRuleViolations(slot, now);
  if (violations.length > 0) {
    throw AppError.unprocessable(
      `This time cannot be booked: appointmentDateTime ${violations.join('; ')}`,
      violations.map((message) => ({ field: 'appointmentDateTime', message })),
    );
  }
}

module.exports = { validateBookingBody, assertSlotBookable };
