// The clinic clock. The ONLY source of "now" / "today" for the whole app.
//
// Convention: a "clinic Date" is a JS Date whose UTC fields hold the clinic's
// wall-clock time (e.g. 09:00 in Johannesburg is stored as 09:00Z). Doing all
// arithmetic in UTC fields means the result never depends on the time zone of
// the PC, the database server or the CI machine.
//
// Pure module: no db/redis imports, safe for unit tests.
const { clinicTimezone } = require('../config/settings');

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return formatterCache.get(timeZone);
}

/**
 * Current clinic wall-clock time as a "clinic Date".
 * @param {Date} [instant=new Date()]  the real moment (injectable for tests)
 * @param {string} [timeZone=clinicTimezone()]
 * @returns {Date}
 */
function clinicNow(instant = new Date(), timeZone = clinicTimezone()) {
  const parts = {};
  for (const { type, value } of getFormatter(timeZone).formatToParts(instant)) {
    parts[type] = value;
  }
  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  );
}

// Builds a clinic Date and rejects impossible values (2027-02-30, 24:00, 12:60):
// Date.UTC silently rolls them over, so the fields must survive a round trip.
function buildClinicDate(year, month, day, hour = 0, minute = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const exact = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute;
  return exact ? date : null;
}

/**
 * Strict "YYYY-MM-DD HH:mm" (clinic time) -> clinic Date, or null if the text
 * has another shape (seconds, "T", missing zero) or is not a real date/time.
 */
function parseClinicDateTime(text) {
  const match = typeof text === 'string' ? DATETIME_PATTERN.exec(text) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return buildClinicDate(year, month, day, hour, minute);
}

/** Strict "YYYY-MM-DD" -> clinic Date at 00:00, or null. */
function parseClinicDate(text) {
  const match = typeof text === 'string' ? DATE_PATTERN.exec(text) : null;
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return buildClinicDate(year, month, day);
}

/** "YYYY-MM-DD HH:mm:ss", for DATETIME ? parameters. */
function toSqlDateTime(clinicDate) {
  return clinicDate.toISOString().slice(0, 19).replace('T', ' ');
}

/** "YYYY-MM-DD", for DATE ? parameters. */
function toSqlDate(clinicDate) {
  return clinicDate.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm", the API's appointment time format. */
function formatClinicDateTime(clinicDate) {
  return toSqlDateTime(clinicDate).slice(0, 16);
}

function addDays(clinicDate, days) {
  return new Date(clinicDate.getTime() + days * MS_PER_DAY);
}

/**
 * The calendar day containing clinicDate as a half-open range [start, end),
 * for sargable SQL: appt_datetime >= start AND appt_datetime < end.
 */
function dayRange(clinicDate) {
  const midnight = `${toSqlDate(clinicDate)} 00:00:00`;
  const nextMidnight = `${toSqlDate(addDays(clinicDate, 1))} 00:00:00`;
  return { start: midnight, end: nextMidnight };
}

module.exports = {
  MS_PER_HOUR,
  MS_PER_DAY,
  clinicNow,
  parseClinicDateTime,
  parseClinicDate,
  toSqlDateTime,
  toSqlDate,
  formatClinicDateTime,
  addDays,
  dayRange,
};
