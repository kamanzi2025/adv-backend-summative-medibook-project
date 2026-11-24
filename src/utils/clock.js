// The clinic clock. Everything in the app gets "now" and "today" from here.
//
// A "clinic Date" is a JS Date whose UTC fields hold the clinic's wall-clock time,
// so 09:00 in Johannesburg is stored as 09:00Z. Doing all the date math on the UTC
// fields means the result never depends on the time zone of my laptop, the MySQL
// server or whatever machine runs the tests.
//
// No database or Redis imports, so the unit tests can use it.
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
 * The clinic's current wall-clock time, as a clinic Date.
 * @param {Date} [instant=new Date()]  the real moment (tests pass a fixed one)
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

// Builds a clinic Date and refuses impossible values like 2027-02-30, 24:00 or 12:60.
// Date.UTC quietly rolls those over to the next day or hour, so the fields have
// to come back out unchanged.
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
 * Parses exactly "YYYY-MM-DD HH:mm" (clinic time) into a clinic Date. Returns null for
 * any other shape (seconds, a "T", a missing zero) or a date that doesn't exist.
 */
function parseClinicDateTime(text) {
  const match = typeof text === 'string' ? DATETIME_PATTERN.exec(text) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return buildClinicDate(year, month, day, hour, minute);
}

/** Parses exactly "YYYY-MM-DD" into a clinic Date at 00:00, or returns null. */
function parseClinicDate(text) {
  const match = typeof text === 'string' ? DATE_PATTERN.exec(text) : null;
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return buildClinicDate(year, month, day);
}

/** "YYYY-MM-DD HH:mm:ss", the format for DATETIME ? parameters. */
function toSqlDateTime(clinicDate) {
  return clinicDate.toISOString().slice(0, 19).replace('T', ' ');
}

/** "YYYY-MM-DD", the format for DATE ? parameters. */
function toSqlDate(clinicDate) {
  return clinicDate.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm", the format the API uses for appointment times. */
function formatClinicDateTime(clinicDate) {
  return toSqlDateTime(clinicDate).slice(0, 16);
}

function addDays(clinicDate, days) {
  return new Date(clinicDate.getTime() + days * MS_PER_DAY);
}

/**
 * The day containing clinicDate, as a start and an end (the next midnight, not included).
 * The SQL then compares appt_datetime >= start AND appt_datetime < end, which can use the index.
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
