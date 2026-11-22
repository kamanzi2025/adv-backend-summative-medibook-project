// The clinic's slot rules as one pure function (no DB, no Redis, `now` injected).
const { WORKING_HOURS_START, WORKING_HOURS_END, SLOT_MINUTES } = require('../config/constants');
const { formatClinicDateTime } = require('./clock');

const MINUTES_PER_HOUR = 60;

/** "09:00" -> 540 (minutes after midnight). */
function timeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

/** 990 -> "16:30". */
function minutesToTime(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / MINUTES_PER_HOUR)).padStart(2, '0');
  const minutes = String(totalMinutes % MINUTES_PER_HOUR).padStart(2, '0');
  return `${hours}:${minutes}`;
}

const FIRST_SLOT_START = timeToMinutes(WORKING_HOURS_START); // 09:00
const LAST_SLOT_START = timeToMinutes(WORKING_HOURS_END) - SLOT_MINUTES; // 16:30

/**
 * Every clinic rule the requested slot breaks (empty array = bookable).
 * @param {Date} slot  clinic Date of the requested start time
 * @param {Date} now   clinic Date for "now" (pass clinicNow(); tests pass a fixed value)
 * @returns {string[]}
 */
function slotRuleViolations(slot, now) {
  const violations = [];

  if (slot.getTime() <= now.getTime()) {
    violations.push(`must be in the future (clinic time is now ${formatClinicDateTime(now)})`);
  }

  const startMinute = slot.getUTCHours() * MINUTES_PER_HOUR + slot.getUTCMinutes();
  if (startMinute < FIRST_SLOT_START || startMinute > LAST_SLOT_START) {
    violations.push(
      `must start between ${minutesToTime(FIRST_SLOT_START)} and ${minutesToTime(LAST_SLOT_START)} `
      + `(working hours ${WORKING_HOURS_START}-${WORKING_HOURS_END})`,
    );
  }

  if ((startMinute - FIRST_SLOT_START) % SLOT_MINUTES !== 0) {
    violations.push(`must start on a ${SLOT_MINUTES}-minute slot boundary (e.g. 10:00 or 10:30)`);
  }

  return violations;
}

/** All bookable start times of a day, e.g. ["09:00", "09:30", ..., "16:30"]. */
function slotStartTimes() {
  const times = [];
  for (let minute = FIRST_SLOT_START; minute <= LAST_SLOT_START; minute += SLOT_MINUTES) {
    times.push(minutesToTime(minute));
  }
  return times;
}

module.exports = { slotRuleViolations, slotStartTimes };
