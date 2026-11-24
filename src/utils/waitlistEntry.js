// The JSON saved for each patient on a waitlist. Pure, so the tests can use it.
// Entry: { patientId, doctorId, requestedDateTime: "YYYY-MM-DD HH:mm", type, joinedAt: ISO instant }
// On a day list the requested time is just for information: the patient gets
// whichever slot frees up that day.
const { WAITLIST_TYPE } = require('../config/constants');

const WAITLIST_TYPES = new Set(Object.values(WAITLIST_TYPE));

/**
 * @param {object} args
 * @param {'slot'|'day'} args.type
 * @param {number} args.patientId
 * @param {number} args.doctorId
 * @param {string} args.appointmentDateTime  "YYYY-MM-DD HH:mm"
 * @param {string} args.joinedAt             ISO instant
 */
function buildEntry({ type, patientId, doctorId, appointmentDateTime, joinedAt }) {
  return { patientId, doctorId, requestedDateTime: appointmentDateTime, type, joinedAt };
}

/**
 * Parses the stored JSON back into an entry, or returns null if it isn't a valid one.
 * Extra fields (reason, failedAt and sourceList on failed entries) are kept.
 */
function parseEntry(raw) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  const valid = entry !== null && typeof entry === 'object'
    && Number.isInteger(entry.patientId) && entry.patientId > 0
    && Number.isInteger(entry.doctorId) && entry.doctorId > 0
    && WAITLIST_TYPES.has(entry.type)
    && typeof entry.requestedDateTime === 'string';
  return valid ? entry : null;
}

module.exports = { buildEntry, parseEntry };
