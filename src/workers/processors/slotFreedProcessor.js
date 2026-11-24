// The "slot-freed" job: move the first patient on the waitlist into the freed slot.
// Everything it uses is passed in, so the tests can run the whole thing with a fake
// in-memory Redis and a scripted bookAppointment.
const { AUDIT_EVENT, WAITLIST_TYPE } = require('../../config/constants');
const { parseClinicDateTime, toSqlDate } = require('../../utils/clock');
const { slotRuleViolations } = require('../../utils/slotRules');
const { buildBookingRequest } = require('../../utils/bookingRequest');
const { slotKey, dayKey } = require('../../utils/waitlistKeys');
const { parseEntry } = require('../../utils/waitlistEntry');
const { PROMOTION, classifyPromotionResult, promotionFailureReason } = require('../../utils/waitlistPromotion');

/**
 * @param {object} deps
 * @param {ReturnType<import('../../utils/waitlistStore').createWaitlistStore>} deps.store
 * @param {(request: object) => Promise<object>} deps.bookAppointment  appointmentModel.bookAppointment
 * @param {(appointment: object, context: object) => Promise<void>} deps.onAppointmentBooked
 * @param {(event: string, details: object) => Promise<void>} deps.audit  auditLogger.log
 * @param {() => Date} deps.now  clinicNow
 * @returns {(job: { id?: string, data: object }) => Promise<object>}
 */
function createSlotFreedProcessor({ store, bookAppointment, onAppointmentBooked, audit, now }) {
  async function moveToFailed(list, raw, entry, reason, appointmentDateTime) {
    const failedEntry = {
      ...(entry || { raw }),
      reason,
      failedAt: new Date().toISOString(),
      sourceList: list.key,
    };
    await store.markFailed(list.key, raw, failedEntry);
    await audit(AUDIT_EVENT.WAITLIST_PROMOTION_FAILED, {
      patientId: entry ? entry.patientId : null,
      doctorId: entry ? entry.doctorId : null,
      appointmentDateTime,
      reason,
      permanent: true,
    });
  }

  /** The slot itself can't be booked any more (it's in the past or breaks a rule), so its whole list fails. */
  async function failWholeList(list, reason, appointmentDateTime) {
    let failed = 0;
    for (let raw = await store.takeNext(list.key); raw !== null; raw = await store.takeNext(list.key)) {
      await moveToFailed(list, raw, parseEntry(raw), reason, appointmentDateTime);
      failed += 1;
    }
    return failed;
  }

  return async function processSlotFreed(job) {
    const { doctorId, appointmentDateTime, freedByAppointmentId } = job.data;
    const slot = parseClinicDateTime(appointmentDateTime);
    if (!slot || !Number.isInteger(doctorId)) {
      return { promoted: false, reason: `invalid job data: ${JSON.stringify(job.data)}` };
    }

    const slotList = { key: slotKey(doctorId, appointmentDateTime), type: WAITLIST_TYPE.SLOT };
    const dayList = { key: dayKey(doctorId, toSqlDate(slot)), type: WAITLIST_TYPE.DAY };

    const violations = slotRuleViolations(slot, now());
    if (violations.length > 0) {
      // Nobody can ever get this exact slot, so its own list is failed. The day list is
      // left alone, since another slot that day might still free up for those patients.
      const reason = `freed slot is not bookable: ${violations.join('; ')}`;
      const failed = await failWholeList(slotList, reason, appointmentDateTime);
      return { promoted: false, reason, failed };
    }

    for (const list of [slotList, dayList]) {
      for (let raw = await store.takeNext(list.key); raw !== null; raw = await store.takeNext(list.key)) {
        const entry = parseEntry(raw);
        if (!entry) {
          await moveToFailed(list, raw, null, 'unreadable waitlist entry', appointmentDateTime);
          continue;
        }

        let result;
        try {
          result = await bookAppointment(buildBookingRequest({
            patientId: entry.patientId, doctorId, slot, now: now(),
          }));
        } catch (err) {
          result = err;
        }

        const decision = classifyPromotionResult(result);
        if (decision === PROMOTION.BOOKED) {
          // Only remove the entry now that the booking has committed.
          await store.complete(list.key, raw);
          const { appointment } = result;
          await audit(AUDIT_EVENT.WAITLIST_PROMOTED, {
            appointmentId: appointment.id,
            apptRef: appointment.apptRef,
            patientId: entry.patientId,
            doctorId,
            appointmentDateTime,
            fromList: list.type,
            waitedSince: entry.joinedAt,
            freedByAppointmentId,
          });
          await onAppointmentBooked(appointment, { source: 'waitlist' });
          return { promoted: true, appointmentId: appointment.id, patientId: entry.patientId, fromList: list.type };
        }

        const reason = promotionFailureReason(result);
        if (decision === PROMOTION.PERMANENT) {
          await moveToFailed(list, raw, entry, reason, appointmentDateTime);
          continue;
        }

        // SLOT_GONE or TRANSIENT: not the patient's fault, so they keep their place.
        await store.returnToFront(list.key, raw);
        if (decision === PROMOTION.SLOT_GONE) {
          return { promoted: false, reason, patientId: entry.patientId };
        }
        await audit(AUDIT_EVENT.WAITLIST_PROMOTION_FAILED, {
          patientId: entry.patientId, doctorId, appointmentDateTime, reason, permanent: false,
        });
        throw result instanceof Error ? result : new Error(reason);
      }
    }
    return { promoted: false, reason: 'nobody is waiting for this slot or day' };
  };
}

module.exports = { createSlotFreedProcessor };
