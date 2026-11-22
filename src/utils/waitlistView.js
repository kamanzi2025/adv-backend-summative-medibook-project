// Builds the GET /api/doctors/:id/waitlist body from raw Redis lists. Pure module.
const { WAITLIST_TYPE } = require('../config/constants');
const { parseWaitlistKey } = require('./waitlistKeys');
const { parseEntry } = require('./waitlistEntry');

function toEntries(raws) {
  return raws.map((raw, index) => {
    const entry = parseEntry(raw);
    if (!entry) return { position: index + 1, unreadable: true };
    return {
      position: index + 1,
      patientId: entry.patientId,
      requestedDateTime: entry.requestedDateTime,
      joinedAt: entry.joinedAt,
    };
  });
}

/**
 * @param {number} doctorId
 * @param {{ key: string, raws: string[] }[]} lists  every key of this doctor + its contents
 * @param {string[]} failedRaws  the whole WAITLIST_KEYS.FAILED list
 */
function buildDoctorWaitlistView(doctorId, lists, failedRaws) {
  const slotWaitlists = [];
  const dayWaitlists = [];
  const processing = [];

  for (const { key, raws } of lists) {
    const parts = parseWaitlistKey(key);
    if (parts && parts.doctorId === doctorId && raws.length > 0) {
      if (parts.processing) {
        processing.push(...toEntries(raws).map((entry) => ({ ...entry, listKey: parts.listKey })));
      } else if (parts.type === WAITLIST_TYPE.SLOT) {
        slotWaitlists.push({ appointmentDateTime: parts.appointmentDateTime, listKey: key, entries: toEntries(raws) });
      } else {
        dayWaitlists.push({ date: parts.date, listKey: key, entries: toEntries(raws) });
      }
    }
  }

  slotWaitlists.sort((a, b) => a.appointmentDateTime.localeCompare(b.appointmentDateTime));
  dayWaitlists.sort((a, b) => a.date.localeCompare(b.date));

  const failed = failedRaws
    .map(parseEntry)
    .filter((entry) => entry !== null && entry.doctorId === doctorId)
    .map(({ patientId, type, requestedDateTime, joinedAt, reason, failedAt, sourceList }) => ({
      patientId, type, requestedDateTime, joinedAt, reason, failedAt, sourceList,
    }));

  return { doctorId, slotWaitlists, dayWaitlists, processing, failed };
}

module.exports = { buildDoctorWaitlistView };
