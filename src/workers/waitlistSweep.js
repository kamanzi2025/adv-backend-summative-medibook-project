// Waitlist safety sweep (run by the worker at start-up and every
// WAITLIST_SWEEP_INTERVAL_MS): a "slot-freed" job lost while Redis was down (the
// cancellation still succeeded in MySQL) would leave patients waiting for a slot
// that is actually free. For every non-empty waiting list whose slot (or, for a
// day list, some slot that day) is free and in the future, queue a slot-freed job.
// A wrong guess is harmless: the processor answers SLOT_TAKEN / DAY_FULL by
// putting the patient back at the front. Dependencies are injected for tests.
const { allKeysPattern, parseWaitlistKey } = require('../utils/waitlistKeys');
const { sweepSlotFor } = require('../utils/waitlistPromotion');
const { parseClinicDate, dayRange } = require('../utils/clock');

/**
 * @param {object} deps
 * @param {object} deps.store  createWaitlistStore()
 * @param {(doctorId: number, dayStart: string, dayEnd: string) => Promise<object[]>} deps.findByDoctorBetween
 * @param {(data: object) => Promise<boolean>} deps.enqueueSlotFreed
 * @param {() => Date} deps.now  clinicNow
 * @returns {Promise<number>} how many jobs were queued
 */
async function sweepWaitlists({ store, findByDoctorBetween, enqueueSlotFreed, now }) {
  const lists = (await store.scanKeys(allKeysPattern()))
    .map(parseWaitlistKey)
    .filter((parts) => parts !== null && !parts.processing);

  const seen = new Set();
  let queued = 0;
  for (const list of lists) {
    const day = dayRange(parseClinicDate(list.date));
    const appointments = await findByDoctorBetween(list.doctorId, day.start, day.end);
    const appointmentDateTime = sweepSlotFor(list, appointments, now());
    const id = `${list.doctorId} ${appointmentDateTime}`;
    if (appointmentDateTime && !seen.has(id)) {
      seen.add(id);
      if (await enqueueSlotFreed({ doctorId: list.doctorId, appointmentDateTime, freedByAppointmentId: null })) {
        queued += 1;
      }
    }
  }
  return queued;
}

module.exports = { sweepWaitlists };
