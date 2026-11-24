// The refund policy (brief Part C.3). No database, no Redis and no real clock:
// "now" is always passed in, so the tests can use fixed dates.
const { REFUND_POLICY } = require('../config/constants');
const { CENTS_PER_UNIT, toCents } = require('./payment');
const { MS_PER_HOUR } = require('./clock');

const PERCENT_BASE = 100;
// hoursNotice is rounded to 2 decimals only for the response. The tier is decided on the exact milliseconds.
const HOURS_DISPLAY_FACTOR = 100;

const FULL_REFUND_ABOVE_MS = REFUND_POLICY.FULL.moreThanHours * MS_PER_HOUR;
const PARTIAL_REFUND_FROM_MS = REFUND_POLICY.PARTIAL.atLeastHours * MS_PER_HOUR;

/**
 * Refund percentage for a notice period:
 *   notice  > 48h        -> 100
 *   24h <= notice <= 48h -> 50   (exactly 48h and exactly 24h both get 50)
 *   notice  < 24h        -> 0    (also for zero or negative notice)
 * @param {number} noticeMs  appointment time minus now, in milliseconds
 */
function refundPercentFor(noticeMs) {
  if (noticeMs > FULL_REFUND_ABOVE_MS) return REFUND_POLICY.FULL.percent;
  if (noticeMs >= PARTIAL_REFUND_FROM_MS) return REFUND_POLICY.PARTIAL.percent;
  return REFUND_POLICY.NONE.percent;
}

/**
 * Works out the refund for a cancellation, in whole cents.
 * Math.round on a positive number rounds halves up, which is what MySQL's
 * ROUND(amount_paid * refund_percent / 100, 2) does with DECIMAL values, so
 * chk_appt_refund_matches_percent always agrees with what we save.
 *
 * @param {number} amountPaid    what the patient paid (>= 0, at most 2 decimals)
 * @param {Date} appointmentDate clinic Date of the appointment
 * @param {Date} now             clinic Date of the cancellation
 * @returns {{ percent: number, amount: number, hoursNotice: number }}
 */
function calculateRefund(amountPaid, appointmentDate, now) {
  const noticeMs = appointmentDate.getTime() - now.getTime();
  const percent = refundPercentFor(noticeMs);
  const refundCents = Math.round((toCents(amountPaid) * percent) / PERCENT_BASE);
  return {
    percent,
    amount: refundCents / CENTS_PER_UNIT,
    hoursNotice: Math.round((noticeMs / MS_PER_HOUR) * HOURS_DISPLAY_FACTOR) / HOURS_DISPLAY_FACTOR,
  };
}

module.exports = { calculateRefund, refundPercentFor };
