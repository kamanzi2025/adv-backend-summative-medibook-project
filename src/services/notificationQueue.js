// Adds "send-confirmation" jobs for the worker (src/workers/worker.js) to run.
// It never throws, so it can't fail a request.
const queues = require('./queues');
const { QUEUE } = require('../config/constants');

/** Everything the worker needs to write the message, so it doesn't have to query the database. */
function confirmationJobData(appointment, source) {
  return {
    appointmentId: appointment.id,
    apptRef: appointment.apptRef,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    appointmentDateTime: appointment.appointmentDateTime,
    amountPaid: appointment.amountPaid,
    source,
  };
}

/**
 * @param {object} appointment  the committed appointment (from appointmentModel.findById)
 * @param {{ source: 'api'|'waitlist' }} context
 * @returns {Promise<boolean>} true if a job was queued
 */
async function enqueueConfirmation(appointment, { source }) {
  try {
    await queues.addJob(QUEUE.SEND_CONFIRMATION, confirmationJobData(appointment, source));
    return true;
  } catch (err) {
    console.warn(`[queue] confirmation for appointment ${appointment.id} not queued: ${queues.redisErrorReason(err)}`);
    return false;
  }
}

module.exports = { enqueueConfirmation };
