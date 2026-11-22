// Pure validation for bookings: 400 for a malformed request, 422 for a
// well-formed request that breaks a clinic rule.
const AppError = require('../utils/AppError');
const { parseClinicDateTime, parseClinicDate } = require('../utils/clock');
const { slotRuleViolations } = require('../utils/slotRules');
const { positiveInteger, money, booleanValue, validateBody } = require('./common');

/** Field rule: strict "YYYY-MM-DD HH:mm" that is a real calendar date/time. */
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
 * POST /api/appointments body. patientId, doctorId and appointmentDateTime are
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
 * @throws {AppError} 422 listing every broken rule
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

/**
 * ?date=YYYY-MM-DD, defaulting to `today` when it isn't sent.
 * @throws {AppError} 400
 */
function parseDateQuery(raw, today) {
  if (raw === undefined) return today;
  const date = parseClinicDate(raw);
  if (!date) {
    throw AppError.badRequest('Invalid query: check date', [
      { field: 'date', message: 'must be a real date in the format "YYYY-MM-DD"' },
    ]);
  }
  return date;
}

module.exports = { validateBookingBody, assertSlotBookable, parseDateQuery };
