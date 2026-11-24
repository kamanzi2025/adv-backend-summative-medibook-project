// All the SQL for the appointments table. Every value goes in through a ? placeholder.
const { pool } = require('../config/db');
const { APPOINTMENT_STATUS, BOOKING_OUTCOME, BOOKING_MAX_ATTEMPTS } = require('../config/constants');
const { duplicateKeyName } = require('../utils/dbErrorMap');
const { resolveAmountPaid } = require('../utils/payment');
const { calculateRefund } = require('../utils/refund');
const { parseClinicDateTime, toSqlDateTime } = require('../utils/clock');

// Results cancelAppointment can return. The controller maps them to HTTP statuses.
const CANCEL_OUTCOME = Object.freeze({
  CANCELLED: 'CANCELLED',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  ALREADY_STARTED: 'ALREADY_STARTED',
});

// Lock errors that go away if you simply try again, so the whole transaction is retried.
const RETRYABLE_LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

// One appointment with the patient's and doctor's names, used by every read below.
// The SQL text is fixed; the WHERE values are always ? placeholders.
const APPOINTMENT_SELECT = `
  SELECT a.id, a.appt_ref, a.patient_id, p.full_name AS patient_name,
         a.doctor_id, d.full_name AS doctor_name, a.appt_datetime, a.amount_paid,
         a.status, a.booked_on, a.cancelled_at, a.refund_percent, a.refund_amount
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors  d ON d.id = a.doctor_id`;

function toAppointment(row) {
  return {
    id: row.id,
    apptRef: row.appt_ref,
    patientId: row.patient_id,
    patientName: row.patient_name,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    // DATETIME comes back as text (dateStrings: true), already in clinic time.
    appointmentDateTime: row.appt_datetime.slice(0, 16),
    amountPaid: row.amount_paid,
    status: row.status,
    bookedOn: row.booked_on,
    cancelledAt: row.cancelled_at,
    refundPercent: row.refund_percent,
    refundAmount: row.refund_amount,
  };
}

/** @returns {Promise<object|null>} one appointment with patient and doctor names */
async function findById(id) {
  const [rows] = await pool.execute(`${APPOINTMENT_SELECT} WHERE a.id = ?`, [id]);
  return rows.length > 0 ? toAppointment(rows[0]) : null;
}

/**
 * All of one doctor's appointments (booked and cancelled) from dayStart up to dayEnd.
 * Comparing the raw column with >= and < lets MySQL use idx_appt_doctor_datetime.
 */
async function findByDoctorBetween(doctorId, dayStart, dayEnd) {
  const [rows] = await pool.execute(
    `${APPOINTMENT_SELECT}
      WHERE a.doctor_id = ? AND a.appt_datetime >= ? AND a.appt_datetime < ?
      ORDER BY a.appt_datetime, a.id`,
    [doctorId, dayStart, dayEnd],
  );
  return rows.map(toAppointment);
}

/**
 * Is the patient already booked with any doctor at this time? The waitlist uses this
 * to refuse a join that could never succeed (it's the uq_appt_patient_active_slot rule).
 * @param {number} patientId
 * @param {string} appointmentDateTime  "YYYY-MM-DD HH:mm:ss" clinic time
 */
async function hasActiveAppointmentAt(patientId, appointmentDateTime) {
  const [rows] = await pool.execute(
    'SELECT 1 AS found FROM appointments WHERE patient_id = ? AND active_slot = ? LIMIT 1',
    [patientId, appointmentDateTime],
  );
  return rows.length > 0;
}

async function rollbackQuietly(conn) {
  try {
    await conn.rollback();
  } catch (err) {
    console.error(`[appointments] rollback failed: ${err.message}`);
  }
}

/**
 * One try at the booking transaction. Every business result comes back as an outcome;
 * it only throws for unexpected or temporary database errors.
 */
async function attemptBooking(request) {
  const conn = await pool.getConnection();
  try {
    // READ COMMITTED: once we hold the doctor lock, every read after it sees the
    // latest committed bookings instead of an older snapshot.
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();

    // 1. Lock the doctor row. Bookings for the same doctor wait here and go through
    //    one at a time, so two of them can't both pass the count in step 4.
    const [doctorRows] = await conn.execute(
      'SELECT consultation_fee FROM doctors WHERE id = ? FOR UPDATE',
      [request.doctorId],
    );
    if (doctorRows.length === 0) {
      await conn.rollback();
      return { outcome: BOOKING_OUTCOME.DOCTOR_NOT_FOUND };
    }

    // 2. Check the patient exists.
    const [patientRows] = await conn.execute('SELECT id FROM patients WHERE id = ?', [request.patientId]);
    if (patientRows.length === 0) {
      await conn.rollback();
      return { outcome: BOOKING_OUTCOME.PATIENT_NOT_FOUND };
    }

    // 3. Work out the amount paid: the fee by default, a discount allowed, never more than the fee.
    const fee = doctorRows[0].consultation_fee;
    const payment = resolveAmountPaid(request.amountPaid, fee);
    if (payment.error) {
      await conn.rollback();
      return { outcome: BOOKING_OUTCOME.AMOUNT_EXCEEDS_FEE, fee };
    }

    // 4. Daily cap: how many BOOKED appointments does the doctor already have that day?
    const [[{ bookedCount }]] = await conn.execute(
      `SELECT COUNT(*) AS bookedCount
         FROM appointments
        WHERE doctor_id = ? AND status = ? AND appt_datetime >= ? AND appt_datetime < ?`,
      [request.doctorId, APPOINTMENT_STATUS.BOOKED, request.dayStart, request.dayEnd],
    );
    if (bookedCount >= request.dailyCap) {
      await conn.rollback();
      return { outcome: BOOKING_OUTCOME.DAY_FULL, bookedCount };
    }

    // 5. Insert. If the lock were ever missing, the unique indexes on active_slot
    //    would still reject a double booking with ER_DUP_ENTRY.
    const [result] = await conn.execute(
      `INSERT INTO appointments
         (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        request.apptRef,
        request.patientId,
        request.doctorId,
        request.appointmentDateTime,
        payment.amount,
        APPOINTMENT_STATUS.BOOKED,
        request.bookedOn,
      ],
    );

    await conn.commit();
    return { outcome: BOOKING_OUTCOME.BOOKED, appointmentId: result.insertId };
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Books one appointment, with every rule checked inside a transaction.
 * Both the API and the waitlist worker book through this function.
 *
 * @param {object} request
 * @param {number} request.patientId
 * @param {number} request.doctorId
 * @param {string} request.appointmentDateTime  "YYYY-MM-DD HH:mm:ss" clinic time
 * @param {string} request.dayStart             "YYYY-MM-DD 00:00:00" of that day
 * @param {string} request.dayEnd               "YYYY-MM-DD 00:00:00" of the next day
 * @param {number} [request.amountPaid]         defaults to the doctor's fee
 * @param {string} request.bookedOn             clinic "now", "YYYY-MM-DD HH:mm:ss"
 * @param {number} request.dailyCap
 * @param {() => string} request.generateRef    makes a fresh appt_ref for each try
 * @returns {Promise<{ outcome: string, appointment?: object, fee?: number, bookedCount?: number }>}
 */
async function bookAppointment(request) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await attemptBooking({ ...request, apptRef: request.generateRef() });
      if (result.outcome !== BOOKING_OUTCOME.BOOKED) return result;
      return { outcome: BOOKING_OUTCOME.BOOKED, appointment: await findById(result.appointmentId) };
    } catch (err) {
      const key = err.code === 'ER_DUP_ENTRY' ? duplicateKeyName(err) : null;
      if (key === 'uq_appt_doctor_active_slot') return { outcome: BOOKING_OUTCOME.SLOT_TAKEN };
      if (key === 'uq_appt_patient_active_slot') return { outcome: BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED };
      // The patient was deleted between step 2 and the insert, so the foreign key refused it.
      if (err.code === 'ER_NO_REFERENCED_ROW_2') return { outcome: BOOKING_OUTCOME.PATIENT_NOT_FOUND };

      const retryable = key === 'uq_appt_ref' || RETRYABLE_LOCK_ERRORS.has(err.code);
      if (!retryable || attempt >= BOOKING_MAX_ATTEMPTS) throw err;
      console.warn(`[booking] attempt ${attempt} failed with ${key || err.code}, retrying`);
    }
  }
}

/**
 * Cancels one appointment and records the refund in a single transaction.
 * The row is locked and its status checked again under the lock, so if two
 * cancels arrive together only one succeeds. The row itself is kept; active_slot
 * turns NULL, which frees the slot for someone else straight away.
 *
 * @param {object} params
 * @param {number} params.appointmentId
 * @param {Date} params.now  clinic Date from clinicNow(), never the database clock
 * @returns {Promise<{ outcome: string, appointment?: object, hoursNotice?: number,
 *   cancelledAt?: string, appointmentDateTime?: string }>}
 */
async function cancelAppointment({ appointmentId, now }) {
  const conn = await pool.getConnection();
  try {
    // READ COMMITTED so the locked read below sees the latest committed row.
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();

    // 1. Lock the row. A second cancel of the same appointment waits here.
    const [rows] = await conn.execute(
      `SELECT id, status, appt_datetime, amount_paid, cancelled_at
         FROM appointments
        WHERE id = ?
          FOR UPDATE`,
      [appointmentId],
    );
    if (rows.length === 0) {
      await conn.rollback();
      return { outcome: CANCEL_OUTCOME.NOT_FOUND };
    }

    // 2. Check the status again now that we hold the lock. Whoever loses a race sees CANCELLED.
    const row = rows[0];
    if (row.status === APPOINTMENT_STATUS.CANCELLED) {
      await conn.rollback();
      return { outcome: CANCEL_OUTCOME.ALREADY_CANCELLED, cancelledAt: row.cancelled_at };
    }

    // 3. You can't cancel an appointment that has already started.
    const appointmentDateTime = row.appt_datetime.slice(0, 16);
    const appointmentDate = parseClinicDateTime(appointmentDateTime);
    if (appointmentDate.getTime() <= now.getTime()) {
      await conn.rollback();
      return { outcome: CANCEL_OUTCOME.ALREADY_STARTED, appointmentDateTime };
    }

    // 4. Work out the refund here on the server and save it together with the status in
    //    one UPDATE, so chk_appt_status_consistency sees all four columns change at once.
    const refund = calculateRefund(row.amount_paid, appointmentDate, now);
    const [result] = await conn.execute(
      `UPDATE appointments
          SET status = ?, cancelled_at = ?, refund_percent = ?, refund_amount = ?
        WHERE id = ? AND status = ?`,
      [
        APPOINTMENT_STATUS.CANCELLED,
        toSqlDateTime(now),
        refund.percent,
        refund.amount,
        appointmentId,
        APPOINTMENT_STATUS.BOOKED,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error(`Cancelling appointment ${appointmentId} updated ${result.affectedRows} rows`);
    }

    await conn.commit();
    return {
      outcome: CANCEL_OUTCOME.CANCELLED,
      appointment: await findById(appointmentId),
      hoursNotice: refund.hoursNotice,
    };
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  CANCEL_OUTCOME,
  findById,
  findByDoctorBetween,
  hasActiveAppointmentAt,
  bookAppointment,
  cancelAppointment,
};
