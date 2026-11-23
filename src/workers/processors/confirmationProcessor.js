// "send-confirmation" job: a SIMULATED SMS (nothing is really sent). The text is
// written to the audit log as NOTIFICATION_SENT. Dependencies are injected for tests.
const { AUDIT_EVENT } = require('../../config/constants');

const CHANNEL = 'sms';
const MONEY_DECIMALS = 2;

/** The confirmation text, built only from the job data. */
function buildConfirmationMessage(data) {
  return `SMS to patient ${data.patientId} (${data.patientName}): Your appointment ${data.apptRef} `
    + `with ${data.doctorName} is confirmed for ${data.appointmentDateTime}. `
    + `Amount paid: ${Number(data.amountPaid).toFixed(MONEY_DECIMALS)}.`;
}

/**
 * Writing the message to the audit log IS this job, so `audit` must reject when the
 * line can't be written (auditLogger.logStrict): the job then fails and BullMQ retries
 * it with backoff, instead of a lost confirmation being marked "completed".
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
