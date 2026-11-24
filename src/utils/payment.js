// Money helpers. Amounts are compared in whole cents so floating-point noise
// (0.1 + 0.2) can never decide a business rule.
const CENTS_PER_UNIT = 100;

function toCents(amount) {
  return Math.round(amount * CENTS_PER_UNIT);
}

/**
 * How much the patient pays for a booking.
 * - not sent      -> the doctor's consultation fee
 * - 0 up to fee   -> that amount (a discount, like AP-002: 120.00 on a 150.00 fee)
 * - more than fee -> rejected, since the clinic never charges more than the fee
 * @param {number|undefined} requested  already checked to be >= 0 with at most 2 decimals
 * @param {number} fee
 * @returns {{ amount: number } | { error: 'EXCEEDS_FEE' }}
 */
function resolveAmountPaid(requested, fee) {
  if (requested === undefined) return { amount: fee };
  if (toCents(requested) > toCents(fee)) return { error: 'EXCEEDS_FEE' };
  return { amount: requested };
}

module.exports = { CENTS_PER_UNIT, toCents, resolveAmountPaid };
