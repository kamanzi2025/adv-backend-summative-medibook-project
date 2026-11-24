// The waitlist safety sweep. The worker runs it at start-up and then every
// WAITLIST_SWEEP_INTERVAL_MS. If Redis was down when someone cancelled, the
// cancellation still succeeded in MySQL but the "slot-freed" job was never
// queued, so patients would keep waiting for a slot that's actually free.
// The sweep looks at every waiting list that isn't empty, and if its slot (or for a
// day list, any slot that day) is free and still in the future, it queues a job.
// Guessing wrong does no harm: if the slot or day turns out to be full, the
// processor puts the patient back at the front. Dependencies are passed in for the tests.
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
