// What happens AFTER a booking or a cancellation has COMMITTED. Called by the API
// controllers and by the waitlist worker. Nothing here throws, so a logging or
// Redis failure can never undo or fail a change that is already saved in MySQL.
const auditLogger = require('./auditLogger');
const notificationQueue = require('./notificationQueue');
const waitlistService = require('./waitlistService');
const { AUDIT_EVENT } = require('../config/constants');

/**
 * Writes the APPOINTMENT_BOOKED audit entry and queues the confirmation job.
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
 * Called by the cancellation controller ONLY after the cancel transaction COMMITTED.
 * Writes the APPOINTMENT_CANCELLED audit line, then queues the "slot-freed" job so
 * the worker can promote the first waitlisted patient. Never throws.
 * @param {object} appointment  the cancelled appointment (from appointmentModel.findById):
 *   status CANCELLED, refundPercent, refundAmount, cancelledAt set
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
