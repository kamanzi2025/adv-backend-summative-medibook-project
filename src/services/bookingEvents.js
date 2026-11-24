// What happens after a booking or a cancellation has been committed. The API and the
// waitlist worker both call these. Nothing in here throws: once a change is saved in
// MySQL, a logging or Redis problem shouldn't fail it or undo it.
const auditLogger = require('./auditLogger');
const notificationQueue = require('./notificationQueue');
const waitlistService = require('./waitlistService');
const { AUDIT_EVENT } = require('../config/constants');

/**
 * Writes the APPOINTMENT_BOOKED audit line and queues the confirmation job.
 * @param {object} appointment  the committed appointment (from appointmentModel)
 * @param {{ source: 'api'|'waitlist' }} context
 */
async function onAppointmentBooked(appointment, { source }) {
  await auditLogger.log(AUDIT_EVENT.APPOINTMENT_BOOKED, {
    appointmentId: appointment.id,
    apptRef: appointment.apptRef,
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
    appointmentDateTime: appointment.appointmentDateTime,
    amountPaid: appointment.amountPaid,
    source,
  });
  await notificationQueue.enqueueConfirmation(appointment, { source });
}

/**
 * Called only after the cancel transaction has committed. Writes the
 * APPOINTMENT_CANCELLED audit line, then queues a "slot-freed" job so the worker
 * can promote the first patient on the waitlist. Never throws.
 * @param {object} appointment  the cancelled appointment (from appointmentModel.findById),
 *   with status CANCELLED and refundPercent, refundAmount and cancelledAt filled in
 * @param {{ source: 'api', hoursNotice: number }} context
 */
async function onAppointmentCancelled(appointment, { source, hoursNotice }) {
  await auditLogger.log(AUDIT_EVENT.APPOINTMENT_CANCELLED, {
    appointmentId: appointment.id,
    apptRef: appointment.apptRef,
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
    appointmentDateTime: appointment.appointmentDateTime,
    amountPaid: appointment.amountPaid,
    refundPercent: appointment.refundPercent,
    refundAmount: appointment.refundAmount,
    hoursNotice,
    source,
  });
  await waitlistService.enqueueSlotFreed({
    doctorId: appointment.doctorId,
    appointmentDateTime: appointment.appointmentDateTime,
    freedByAppointmentId: appointment.id,
  });
}

module.exports = { onAppointmentBooked, onAppointmentCancelled };
