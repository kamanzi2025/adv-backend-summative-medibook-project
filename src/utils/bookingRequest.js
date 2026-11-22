// Builds the argument for appointmentModel.bookAppointment(). Shared by the
// booking controller (API) and the waitlist worker, so both book with exactly
// the same day range, cap, timestamps and reference format.
const { DAILY_CAP } = require('../config/constants');
const { generateApptRef } = require('./apptRef');
const { toSqlDateTime, dayRange } = require('./clock');

/**
 * @param {object} args
 * @param {number} args.patientId
 * @param {number} args.doctorId
 * @param {Date} args.slot            clinic Date of the appointment start
 * @param {number} [args.amountPaid]  omitted = the doctor's fee
 * @param {Date} args.now             clinic Date, from clinicNow()
 */
function buildBookingRequest({ patientId, doctorId, slot, amountPaid, now }) {
  const day = dayRange(slot);
  return {
    patientId,
    doctorId,
    appointmentDateTime: toSqlDateTime(slot),
    dayStart: day.start,
    dayEnd: day.end,
    amountPaid,
    bookedOn: toSqlDateTime(now),
    dailyCap: DAILY_CAP,
    generateRef: () => generateApptRef(slot),
  };
}

module.exports = { buildBookingRequest };
