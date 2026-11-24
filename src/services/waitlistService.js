// The web server's side of the Redis waitlist: joining, reading, and queueing the
// "slot-freed" job. The lists are plain FIFO lists; the worker does the promotions.
const appointmentModel = require('../models/appointmentModel');
const auditLogger = require('./auditLogger');
const queues = require('./queues');
const AppError = require('../utils/AppError');
const { createWaitlistStore } = require('../utils/waitlistStore');
const { waitlistKey, doctorKeyPattern, describeWaitlist } = require('../utils/waitlistKeys');
const { buildEntry } = require('../utils/waitlistEntry');
const { buildDoctorWaitlistView } = require('../utils/waitlistView');
const { parseClinicDateTime, toSqlDateTime } = require('../utils/clock');
const { AUDIT_EVENT, QUEUE, WAITLIST_KEYS, WAITLIST_TYPE } = require('../config/constants');

const REDIS_DOWN_MESSAGE = 'The waitlist is temporarily unavailable (Redis is down). Please try again shortly.';

let store = null;

/**
 * Runs Redis-only work and turns any Redis failure into a 503. MySQL calls stay outside
 * this wrapper, so a database error is never reported as "Redis is down".
 */
async function withRedis(work) {
  try {
    const redis = await queues.whenRedisReady();
    if (!store) store = createWaitlistStore(redis);
    return await work(store);
  } catch (err) {
    console.warn(`[waitlist] Redis unavailable: ${queues.redisErrorReason(err)}`);
    throw AppError.serviceUnavailable(REDIS_DOWN_MESSAGE);
  }
}

/**
 * Adds a patient to the waitlist for a full slot or a full day.
 * @param {{ type: 'slot'|'day', patientId: number, doctorId: number, appointmentDateTime: string }} input
 *   appointmentDateTime is "YYYY-MM-DD HH:mm" (clinic time)
 * @returns {Promise<object>} the entry, its position (starting at 1) and the list it joined
 * @throws {AppError} 409 if already on that list or already booked at that time, 503 if Redis is down
 */
async function joinWaitlist({ type, patientId, doctorId, appointmentDateTime }) {
  if (type === WAITLIST_TYPE.SLOT) {
    const slot = parseClinicDateTime(appointmentDateTime);
    if (await appointmentModel.hasActiveAppointmentAt(patientId, toSqlDateTime(slot))) {
      throw AppError.conflict(
        `Patient ${patientId} already has an appointment at ${appointmentDateTime}, so waiting for this slot would not help`,
      );
    }
  }

  const listKey = waitlistKey(type, doctorId, appointmentDateTime);
  const listName = describeWaitlist(listKey);
  const entry = buildEntry({ type, patientId, doctorId, appointmentDateTime, joinedAt: new Date().toISOString() });
  const position = await withRedis((waitlist) => waitlist.join(listKey, entry));
  if (position === null) {
    throw AppError.conflict(`Patient ${patientId} is already on the ${listName}`);
  }

  await auditLogger.log(AUDIT_EVENT.WAITLIST_JOINED, {
    patientId, doctorId, type, appointmentDateTime, position, listKey,
  });
  return {
    ...entry,
    position,
    listKey,
    message: `Patient ${patientId} is number ${position} on the ${listName}. `
      + 'They will be booked automatically when a slot frees up.',
  };
}

/** Every waiting, processing and failed entry for one doctor. The caller checks the doctor exists. */
function getDoctorWaitlist(doctorId) {
  return withRedis(async (waitlist) => {
    const keys = await waitlist.scanKeys(doctorKeyPattern(doctorId));
    const lists = await Promise.all(keys.map(async (key) => ({ key, raws: await waitlist.readList(key) })));
    const failedRaws = await waitlist.readList(WAITLIST_KEYS.FAILED);
    return buildDoctorWaitlistView(doctorId, lists, failedRaws);
  });
}

/**
 * Queues a "slot-freed" job so the worker can promote the first patient waiting.
 * Never throws. If Redis is down the cancellation still goes through, and the
 * worker's sweep picks the slot up later.
 * @param {{ doctorId: number, appointmentDateTime: string, freedByAppointmentId: number|null }} data
 * @returns {Promise<boolean>} true if a job was queued
 */
async function enqueueSlotFreed({ doctorId, appointmentDateTime, freedByAppointmentId }) {
  try {
    await queues.addJob(QUEUE.SLOT_FREED, { doctorId, appointmentDateTime, freedByAppointmentId });
    return true;
  } catch (err) {
    console.warn(
      `[queue] slot-freed for doctor ${doctorId} at ${appointmentDateTime} not queued: ${queues.redisErrorReason(err)}`,
    );
    return false;
  }
}

module.exports = { joinWaitlist, getDoctorWaitlist, enqueueSlotFreed };
