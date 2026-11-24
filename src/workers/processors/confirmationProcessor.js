// The "send-confirmation" job. It pretends to send an SMS: nothing is really sent,
// the message is written to the audit log as NOTIFICATION_SENT. Its dependencies
// are passed in so the tests can replace them.
const { AUDIT_EVENT } = require('../../config/constants');

const CHANNEL = 'sms';
const MONEY_DECIMALS = 2;

/** Builds the confirmation text from the job data alone. */
function buildConfirmationMessage(data) {
  return `SMS to patient ${data.patientId} (${data.patientName}): Your appointment ${data.apptRef} `
    + `with ${data.doctorName} is confirmed for ${data.appointmentDateTime}. `
    + `Amount paid: ${Number(data.amountPaid).toFixed(MONEY_DECIMALS)}.`;
}

/**
 * Writing the message to the audit log is the whole job, so `audit` has to reject
 * when the line can't be written (auditLogger.logStrict). The job then fails and
 * BullMQ retries it, instead of marking a lost confirmation as "completed".
 * @param {object} deps
 * @param {(event: string, details: object) => Promise<void>} deps.audit  auditLogger.logStrict
 * @returns {(job: { id?: string, data: object }) => Promise<{ message: string }>}
 */
function createConfirmationProcessor({ audit }) {
  return async function processConfirmation(job) {
    const message = buildConfirmationMessage(job.data);
    await audit(AUDIT_EVENT.NOTIFICATION_SENT, {
      appointmentId: job.data.appointmentId,
      patientId: job.data.patientId,
      channel: CHANNEL,
      message,
      jobId: job.id,
    });
    return { message };
  };
}

module.exports = { createConfirmationProcessor, buildConfirmationMessage };
