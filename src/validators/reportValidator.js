// Pure validation for the statistics and report endpoints (no DB, no Redis).
const AppError = require('../utils/AppError');
const { parseClinicDate } = require('../utils/clock');

/**
 * ?from=YYYY-MM-DD, the first day of the statistics window.
 * Missing -> `today`. Anything else that isn't one real "YYYY-MM-DD" date
 * (wrong shape, 2027-02-30, or an array from ?from=a&from=b) -> 400.
 * @param {unknown} raw   req.query.from
 * @param {Date} today    clinic Date (clinicNow())
 * @returns {Date} clinic Date; only its calendar day is used
 * @throws {AppError} 400
 */
function parseFromDate(raw, today) {
  if (raw === undefined) return today;
  const date = parseClinicDate(raw);
  if (!date) {
    throw AppError.badRequest('Invalid query: check from', [
      { field: 'from', message: 'must be one real date in the format "YYYY-MM-DD"' },
    ]);
  }
  return date;
}

module.exports = { parseFromDate };
