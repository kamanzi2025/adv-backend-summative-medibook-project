// Booking, reading and cancelling appointments. There's no try/catch because
// Express 5 passes rejected promises to the error handler by itself.
const appointmentModel = require('../models/appointmentModel');
const doctorModel = require('../models/doctorModel');
const bookingEvents = require('../services/bookingEvents');
const waitlistService = require('../services/waitlistService');
const AppError = require('../utils/AppError');
const { buildBookingRequest } = require('../utils/bookingRequest');
const { clinicNow, toSqlDate, formatClinicDateTime, dayRange } = require('../utils/clock');
const { parseId, parseDateQuery } = require('../validators/common');
const { validateBookingBody, assertSlotBookable } = require('../validators/bookingValidator');
const { assertEmptyCancelBody } = require('../validators/cancelValidator');
const {
  APPOINTMENT_STATUS, BOOKING_OUTCOME, DAILY_CAP, HTTP_STATUS, WAITLIST_TYPE,
} = require('../config/constants');

const { CANCEL_OUTCOME } = appointmentModel;

// When the slot or the whole day is full, the 409 also offers the matching waitlist.
const WAITLIST_FOR_OUTCOME = Object.freeze({
  [BOOKING_OUTCOME.SLOT_TAKEN]: WAITLIST_TYPE.SLOT,
  [BOOKING_OUTCOME.DAY_FULL]: WAITLIST_TYPE.DAY,
});

function waitlistOffer(type) {
  return {
    waitlistAvailable: true,
    waitlistType: type,
    hint: type === WAITLIST_TYPE.SLOT
      ? 'Resend the same request with "joinWaitlist": true to join the waitlist for this slot.'
      : 'Resend the same request with "joinWaitlist": true to join the waitlist for this day; you will get the first slot that frees up.',
  };
}

/** Turns a failed booking result from the model into the right HTTP error. */
function bookingFailure(result, input) {
  const when = formatClinicDateTime(input.appointmentDateTime);
  switch (result.outcome) {
    case BOOKING_OUTCOME.DOCTOR_NOT_FOUND:
      return AppError.notFound(`Doctor ${input.doctorId} not found`);
    case BOOKING_OUTCOME.PATIENT_NOT_FOUND:
      return AppError.notFound(`Patient ${input.patientId} not found`);
    case BOOKING_OUTCOME.AMOUNT_EXCEEDS_FEE:
      return AppError.unprocessable(
        `amountPaid (${input.amountPaid}) cannot be more than the doctor's consultation fee (${result.fee})`,
        [{ field: 'amountPaid', message: `must be between 0 and ${result.fee}` }],
      );
    case BOOKING_OUTCOME.SLOT_TAKEN:
      return AppError.conflict(`Doctor ${input.doctorId} is already booked at ${when}`,
        undefined, waitlistOffer(WAITLIST_TYPE.SLOT));
    case BOOKING_OUTCOME.DAY_FULL:
      return AppError.conflict(
        `Doctor ${input.doctorId} is fully booked on ${toSqlDate(input.appointmentDateTime)} `
        + `(${result.bookedCount} of ${DAILY_CAP} appointments)`,
        undefined, waitlistOffer(WAITLIST_TYPE.DAY),
      );
    case BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED:
      return AppError.conflict(`Patient ${input.patientId} already has an appointment at ${when}`);
    default:
      return new Error(`Unknown booking outcome ${result.outcome}`);
  }
}

/** POST /api/appointments */
async function bookAppointment(req, res) {
  const input = validateBookingBody(req.body); // throws 400
  const now = clinicNow();
  assertSlotBookable(input.appointmentDateTime, now); // throws 422

  const slot = input.appointmentDateTime;
  const result = await appointmentModel.bookAppointment(buildBookingRequest({
    patientId: input.patientId,
    doctorId: input.doctorId,
    slot,
    amountPaid: input.amountPaid,
    now,
  }));

  if (result.outcome === BOOKING_OUTCOME.BOOKED) {
    // Only after the commit: write the audit line and queue the confirmation. Neither can throw.
    await bookingEvents.onAppointmentBooked(result.appointment, { source: 'api' });
    res.status(HTTP_STATUS.CREATED)
      .location(`/api/appointments/${result.appointment.id}`)
      .json({ data: result.appointment });
    return;
  }

  const waitlistType = WAITLIST_FOR_OUTCOME[result.outcome];
  if (waitlistType && input.joinWaitlist === true) {
    const entry = await waitlistService.joinWaitlist({
      type: waitlistType,
      patientId: input.patientId,
      doctorId: input.doctorId,
      appointmentDateTime: formatClinicDateTime(slot),
    });
    res.status(HTTP_STATUS.ACCEPTED).json({ data: entry });
    return;
  }

  throw bookingFailure(result, input);
}

/** GET /api/appointments/:id */
async function getAppointment(req, res) {
  const id = parseId(req.params.id);
  const appointment = await appointmentModel.findById(id);
  if (!appointment) throw AppError.notFound(`Appointment ${id} not found`);
  res.json({ data: appointment });
}

/** GET /api/doctors/:id/appointments?date=YYYY-MM-DD (today if no date) */
async function listDoctorDay(req, res) {
  const doctorId = parseId(req.params.id);
  const date = parseDateQuery(req.query.date, clinicNow(), 'date');
  const doctor = await doctorModel.findById(doctorId);
  if (!doctor) throw AppError.notFound(`Doctor ${doctorId} not found`);

  const day = dayRange(date);
  const appointments = await appointmentModel.findByDoctorBetween(doctorId, day.start, day.end);
  const booked = appointments.filter((a) => a.status === APPOINTMENT_STATUS.BOOKED).length;
  res.json({
    data: appointments,
    meta: { doctorId, date: toSqlDate(date), booked, dailyCap: DAILY_CAP, remaining: Math.max(DAILY_CAP - booked, 0) },
  });
}

/** Turns a failed cancellation result from the model into the right HTTP error. */
function cancelFailure(result, id) {
  switch (result.outcome) {
    case CANCEL_OUTCOME.NOT_FOUND:
      return AppError.notFound(`Appointment ${id} not found`);
    case CANCEL_OUTCOME.ALREADY_CANCELLED:
      return AppError.unprocessable(`Appointment ${id} is already cancelled (on ${result.cancelledAt})`);
    case CANCEL_OUTCOME.ALREADY_STARTED:
      return AppError.unprocessable(
        `Appointment ${id} was at ${result.appointmentDateTime}: `
        + 'cannot cancel an appointment that has already started',
      );
    default:
      return new Error(`Unknown cancel outcome ${result.outcome}`);
  }
}

/** PATCH /api/appointments/:id/cancel (no body: the server works out the refund) */
async function cancelAppointment(req, res) {
  const id = parseId(req.params.id); // throws 400
  assertEmptyCancelBody(req.body); // throws 400

  const result = await appointmentModel.cancelAppointment({ appointmentId: id, now: clinicNow() });
  if (result.outcome !== CANCEL_OUTCOME.CANCELLED) throw cancelFailure(result, id);

  // Only after the commit: write the audit line and queue the slot-freed job. Neither can throw.
  const { appointment, hoursNotice } = result;
  await bookingEvents.onAppointmentCancelled(appointment, { source: 'api', hoursNotice });
  res.json({ data: { ...appointment, hoursNotice } });
}

module.exports = {
  bookAppointment, getAppointment, listDoctorDay, cancelAppointment,
};
