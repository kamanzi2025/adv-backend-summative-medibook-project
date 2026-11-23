// Pure refund policy (README Part C.3). No DB, no Redis, no real clock:
// "now" is always passed in, so tests can use fixed dates.
const { REFUND_POLICY } = require('../config/constants');
const { CENTS_PER_UNIT, toCents } = require('./payment');
const { MS_PER_HOUR } = require('./clock');

const PERCENT_BASE = 100;
// hoursNotice is rounded to 2 decimals for display only; the tier is decided on exact ms.
const HOURS_DISPLAY_FACTOR = 100;

const FULL_REFUND_ABOVE_MS = REFUND_POLICY.FULL.moreThanHours * MS_PER_HOUR;
const PARTIAL_REFUND_FROM_MS = REFUND_POLICY.PARTIAL.atLeastHours * MS_PER_HOUR;

/**
 * Refund percentage for a notice period:
 *   notice  > 48h        -> 100
 *   24h <= notice <= 48h -> 50   (exactly 48h and exactly 24h are both 50)
 *   notice  < 24h        -> 0    (including 0 and negative notice)
 * @param {number} noticeMs  appointment time minus now, in milliseconds
 */
function refundPercentFor(noticeMs) {
  if (noticeMs > FULL_REFUND_ABOVE_MS) return REFUND_POLICY.FULL.percent;
  if (noticeMs >= PARTIAL_REFUND_FROM_MS) return REFUND_POLICY.PARTIAL.percent;
  return REFUND_POLICY.NONE.percent;
}

/**
 * Computes the refund for a cancellation in integer cents.
 * Math.round on a positive number rounds half up, which equals MySQL's
 * ROUND(amount_paid * refund_percent / 100, 2) (half away from zero) on
 * DECIMAL values, so chk_appt_refund_matches_percent always holds.
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
