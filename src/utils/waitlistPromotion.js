// How the worker decides what to do after a promotion attempt. No Redis or database here.
const { BOOKING_OUTCOME, APPOINTMENT_STATUS, DAILY_CAP, WAITLIST_TYPE } = require('../config/constants');
const { parseClinicDateTime } = require('./clock');
const { slotRuleViolations, slotStartTimes } = require('./slotRules');

// The four things that can happen to the entry the worker took off the list.
const PROMOTION = Object.freeze({
  BOOKED: 'BOOKED', // the patient got the slot: remove the entry (one freed slot, one promotion)
  PERMANENT: 'PERMANENT', // this patient can never get it: move them to waitlist:failed and try the next one
  SLOT_GONE: 'SLOT_GONE', // someone took the slot in the meantime: patient goes back to the front, stop here
  TRANSIENT: 'TRANSIENT', // a temporary problem (DB down, deadlock): back to the front and retry the job
});

const DECISION_BY_OUTCOME = Object.freeze({
  [BOOKING_OUTCOME.BOOKED]: PROMOTION.BOOKED,
  [BOOKING_OUTCOME.PATIENT_NOT_FOUND]: PROMOTION.PERMANENT,
  [BOOKING_OUTCOME.DOCTOR_NOT_FOUND]: PROMOTION.PERMANENT,
  [BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED]: PROMOTION.PERMANENT,
  [BOOKING_OUTCOME.AMOUNT_EXCEEDS_FEE]: PROMOTION.PERMANENT,
  [BOOKING_OUTCOME.SLOT_TAKEN]: PROMOTION.SLOT_GONE,
  [BOOKING_OUTCOME.DAY_FULL]: PROMOTION.SLOT_GONE,
});

const REASON_BY_OUTCOME = Object.freeze({
  [BOOKING_OUTCOME.PATIENT_NOT_FOUND]: 'patient no longer exists',
  [BOOKING_OUTCOME.DOCTOR_NOT_FOUND]: 'doctor no longer exists',
  [BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED]: 'patient already has another appointment at that time',
  [BOOKING_OUTCOME.AMOUNT_EXCEEDS_FEE]: 'amount paid exceeds the consultation fee',
  [BOOKING_OUTCOME.SLOT_TAKEN]: 'the freed slot was booked by someone else first',
  [BOOKING_OUTCOME.DAY_FULL]: 'the day filled up again before the promotion',
});

function isOutcome(value) {
  return value !== null && typeof value === 'object' && !(value instanceof Error)
    && typeof value.outcome === 'string';
}

/**
 * @param {object|Error} resultOrError  what bookAppointment() returned, or what it threw
 * @returns {'BOOKED'|'PERMANENT'|'SLOT_GONE'|'TRANSIENT'}
 *   Anything unexpected counts as TRANSIENT, so the patient keeps their place.
 */
function classifyPromotionResult(resultOrError) {
  if (!isOutcome(resultOrError)) return PROMOTION.TRANSIENT;
  return DECISION_BY_OUTCOME[resultOrError.outcome] || PROMOTION.TRANSIENT;
}

/** A readable reason for the audit log and for waitlist:failed. */
function promotionFailureReason(resultOrError) {
  if (isOutcome(resultOrError)) {
    return REASON_BY_OUTCOME[resultOrError.outcome] || `unexpected booking outcome ${resultOrError.outcome}`;
  }
  const detail = resultOrError && (resultOrError.code || resultOrError.message);
  return `temporary error: ${detail || 'unknown'}`;
}

/**
 * For the sweep: which slot, if any, should get a "slot-freed" job for this list?
 * This is how a promotion whose job got lost (say, a cancellation while Redis was
 * down) still happens.
 * @param {object} list  parseWaitlistKey() result for a waiting (not processing) list
 * @param {object[]} dayAppointments  the doctor's appointments that day (findByDoctorBetween)
 * @param {Date} now  clinic Date
 * @returns {string|null} "YYYY-MM-DD HH:mm" of a free slot that can be booked, or null
 */
function sweepSlotFor(list, dayAppointments, now) {
  const booked = new Set(dayAppointments
    .filter((a) => a.status === APPOINTMENT_STATUS.BOOKED)
    .map((a) => a.appointmentDateTime));
  const isFree = (dateTime) => {
    const slot = parseClinicDateTime(dateTime);
    return slot !== null && !booked.has(dateTime) && slotRuleViolations(slot, now).length === 0;
  };

  if (list.type === WAITLIST_TYPE.SLOT) {
    return isFree(list.appointmentDateTime) ? list.appointmentDateTime : null;
  }
  if (booked.size >= DAILY_CAP) return null;
  return slotStartTimes().map((time) => `${list.date} ${time}`).find(isFree) || null;
}

module.exports = {
  PROMOTION,
  classifyPromotionResult,
  promotionFailureReason,
  sweepSlotFor,
};
