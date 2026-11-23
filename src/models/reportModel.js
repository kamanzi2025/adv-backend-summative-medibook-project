// All SQL for the clinic-wide reports (README Part C.5 and C.6). Each report is ONE
// query: the joins, counts, sums and percentages are produced by MySQL, and the rules
// (statuses, daily cap, busy threshold) are passed in as ? parameters.
const { pool } = require('../config/db');
const { APPOINTMENT_STATUS, DAILY_CAP, BUSY_THRESHOLD } = require('../config/constants');
const { REVENUE_COLLECTED } = require('./sqlFragments');

/**
 * Every doctor, including doctors with zero appointments (LEFT JOIN + COALESCE),
 * highest revenue first, ties by id.
 * @returns {Promise<object[]>}
 */
async function findDoctorsReport() {
  const [rows] = await pool.execute(
    `SELECT d.id        AS doctor_id,
            d.full_name AS doctor_name,
            d.specialty,
            COUNT(a.id)                                     AS total_appointments,
            COUNT(CASE WHEN a.status = ? THEN 1 END)        AS booked_appointments,
            COUNT(CASE WHEN a.status = ? THEN 1 END)        AS cancelled_appointments,
            ${REVENUE_COLLECTED}                            AS revenue_collected,
            COALESCE(SUM(a.refund_amount), 0)               AS total_refunded
       FROM doctors d
       LEFT JOIN appointments a ON a.doctor_id = d.id
      GROUP BY d.id, d.full_name, d.specialty
      ORDER BY revenue_collected DESC, d.id`,
    [APPOINTMENT_STATUS.BOOKED, APPOINTMENT_STATUS.CANCELLED],
  );
  return rows.map((row) => ({
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    specialty: row.specialty,
    totalAppointments: row.total_appointments,
    bookedAppointments: row.booked_appointments,
    cancelledAppointments: row.cancelled_appointments,
    revenueCollected: row.revenue_collected,
    totalRefunded: row.total_refunded,
  }));
}

/**
 * Every (doctor, date) whose BOOKED count is more than BUSY_THRESHOLD × DAILY_CAP,
 * in date order.
 * @returns {Promise<object[]>}
 */
async function findBusyDays() {
  const [rows] = await pool.execute(
    `SELECT d.id        AS doctor_id,
            d.full_name AS doctor_name,
            DATE(a.appt_datetime)            AS appt_date,
            COUNT(*)                         AS booked,
            ROUND(COUNT(*) / ? * 100, 1)     AS capacity_percent
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
      WHERE a.status = ?
      GROUP BY d.id, d.full_name, DATE(a.appt_datetime)
     HAVING COUNT(*) > ? * ?
      ORDER BY appt_date, d.id`,
    [DAILY_CAP, APPOINTMENT_STATUS.BOOKED, BUSY_THRESHOLD, DAILY_CAP],
  );
  return rows.map((row) => ({
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    date: row.appt_date,
    booked: row.booked,
    capacityPercent: row.capacity_percent,
  }));
}

module.exports = { findDoctorsReport, findBusyDays };
