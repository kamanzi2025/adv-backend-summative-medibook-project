// The JSON stored in a waitlist list. Pure module, safe for unit tests.
// Entry: { patientId, doctorId, requestedDateTime: "YYYY-MM-DD HH:mm", type, joinedAt: ISO instant }
// A day-list entry keeps the requested time for information only: it is promoted
// into whatever slot frees up that day.
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
 * Stored JSON -> entry, or null if it is not a readable waitlist entry.
 * Extra fields (reason, failedAt, sourceList on failed entries) are kept.
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
