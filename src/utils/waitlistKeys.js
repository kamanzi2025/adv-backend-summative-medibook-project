// Redis key names for the waitlist, built only from WAITLIST_KEYS.
// Pure module: no Redis import, safe for unit tests.
//   <PREFIX>:<doctorId>:slot:<YYYY-MM-DDTHH:mm>   waiting for one exact slot
//   <PREFIX>:<doctorId>:day:<YYYY-MM-DD>          waiting for any slot that day
//   <waitlist key><PROCESSING_SUFFIX>             entries being promoted right now
const { WAITLIST_KEYS, WAITLIST_TYPE } = require('../config/constants');

const { PREFIX, PROCESSING_SUFFIX } = WAITLIST_KEYS;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEY_PATTERN = new RegExp(
  `^${escapeRegExp(PREFIX)}:(\\d+):`
  + '(?:slot:(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2})|day:(\\d{4}-\\d{2}-\\d{2}))'
  + `(${escapeRegExp(PROCESSING_SUFFIX)})?$`,
);

/** "2027-05-03 10:00" -> "waitlist:doctor:2:slot:2027-05-03T10:00" */
function slotKey(doctorId, appointmentDateTime) {
  return `${PREFIX}:${doctorId}:slot:${appointmentDateTime.replace(' ', 'T')}`;
}

/** "2027-05-03" -> "waitlist:doctor:2:day:2027-05-03" */
function dayKey(doctorId, date) {
  return `${PREFIX}:${doctorId}:day:${date}`;
}

/**
 * The list a patient joins.
 * @param {'slot'|'day'} type
 * @param {number} doctorId
 * @param {string} appointmentDateTime  "YYYY-MM-DD HH:mm"
 */
function waitlistKey(type, doctorId, appointmentDateTime) {
  return type === WAITLIST_TYPE.SLOT
    ? slotKey(doctorId, appointmentDateTime)
    : dayKey(doctorId, appointmentDateTime.slice(0, 10));
}

function processingKey(listKey) {
  return `${listKey}${PROCESSING_SUFFIX}`;
}

/** SCAN pattern for every list (waiting and processing) of one doctor. */
function doctorKeyPattern(doctorId) {
  return `${PREFIX}:${doctorId}:*`;
}

/** SCAN pattern for every waiting and processing list of every doctor. */
function allKeysPattern() {
  return `${PREFIX}:*`;
}

/** SCAN pattern for every processing list. */
function processingKeyPattern() {
  return `${PREFIX}:*${PROCESSING_SUFFIX}`;
}

/**
 * Parses a waitlist key back into its parts, or null for any other key.
 * @returns {{ doctorId: number, type: 'slot'|'day', date: string,
 *   appointmentDateTime: string|null, processing: boolean, listKey: string }|null}
 *   listKey is always the waiting list (without the processing suffix).
 */
function parseWaitlistKey(key) {
  const match = typeof key === 'string' ? KEY_PATTERN.exec(key) : null;
  if (!match) return null;
  const [, doctorId, slotDate, slotTime, dayDate, processingSuffix] = match;
  const processing = processingSuffix !== undefined;
  return {
    doctorId: Number(doctorId),
    type: slotDate ? WAITLIST_TYPE.SLOT : WAITLIST_TYPE.DAY,
    date: slotDate || dayDate,
    appointmentDateTime: slotDate ? `${slotDate} ${slotTime}` : null,
    processing,
    listKey: processing ? key.slice(0, -PROCESSING_SUFFIX.length) : key,
  };
}

/** Human-readable name of a waiting list, e.g. "slot waitlist of doctor 2 for 2027-05-03 10:00". */
function describeWaitlist(listKey) {
  const parts = parseWaitlistKey(listKey);
  if (!parts) return listKey;
  return `${parts.type} waitlist of doctor ${parts.doctorId} for ${parts.appointmentDateTime || parts.date}`;
}

module.exports = {
  slotKey,
  dayKey,
  waitlistKey,
  processingKey,
  doctorKeyPattern,
  allKeysPattern,
  processingKeyPattern,
  parseWaitlistKey,
  describeWaitlist,
};
