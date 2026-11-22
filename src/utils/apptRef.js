// Human-readable appointment reference, generated in Node BEFORE the insert:
// AP-20270315-K7Q2 = prefix + appointment date + random code.
const { randomInt } = require('node:crypto');
const { APPT_REF } = require('../config/constants');
const { toSqlDate } = require('./clock');

/**
 * @param {Date} slot  clinic Date of the appointment
 * @param {(max: number) => number} [random=randomInt]  injectable for tests
 * @returns {string}
 */
function generateApptRef(slot, random = randomInt) {
  let code = '';
  for (let i = 0; i < APPT_REF.CODE_LENGTH; i += 1) {
    code += APPT_REF.ALPHABET[random(APPT_REF.ALPHABET.length)];
  }
  return `${APPT_REF.PREFIX}${toSqlDate(slot).replaceAll('-', '')}-${code}`;
}

module.exports = { generateApptRef };
