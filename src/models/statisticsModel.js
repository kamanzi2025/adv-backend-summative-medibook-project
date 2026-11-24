// SQL for GET /api/doctors/:id/statistics. MySQL calculates every figure. Node only
// passes in the clinic's "now" and the business numbers as ? parameters, since the
// app never uses NOW() or CURDATE() (DESIGN_NOTES §4), and renames the columns.
const { pool } = require('../config/db');
const { APPOINTMENT_STATUS, DAILY_CAP, STATS_WINDOW_DAYS } = require('../config/constants');
const { REVENUE_COLLECTED } = require('./sqlFragments');

/**
 * Lifetime revenue, the upcoming count and utilization over the window for one doctor.
 * @param {object} args
 * @param {number} args.doctorId
 * @param {string} args.now          "YYYY-MM-DD HH:mm:ss" clinic time
 * @param {string} args.windowStart  "YYYY-MM-DD 00:00:00", first day of the window
 * @param {string} args.windowEnd    "YYYY-MM-DD 00:00:00", the day after the window
 * @returns {Promise<object|null>} null if the doctor doesn't exist
 */
async function findDoctorSummary({ doctorId, now, windowStart, windowEnd }) {
  const [rows] = await pool.execute(
    `SELECT s.doctor_id, s.doctor_name, s.revenue_collected, s.upcoming_appointments,
            s.booked_in_window, s.capacity_in_window,
            ROUND(s.booked_in_window / s.capacity_in_window * 100, 1) AS utilization_percent
       FROM (
             SELECT d.id        AS doctor_id,
                    d.full_name AS doctor_name,
                    ${REVENUE_COLLECTED} AS revenue_collected,
                    COUNT(CASE WHEN a.status = ? AND a.appt_datetime > ? THEN 1 END) AS upcoming_appointments,
                    COUNT(CASE WHEN a.status = ?
                                AND a.appt_datetime >= ? AND a.appt_datetime < ? THEN 1 END) AS booked_in_window,
                    ? * ? AS capacity_in_window
               FROM doctors d
               LEFT JOIN appointments a ON a.doctor_id = d.id
              WHERE d.id = ?
              GROUP BY d.id, d.full_name
            ) AS s`,
    [
      APPOINTMENT_STATUS.BOOKED, now,
      APPOINTMENT_STATUS.BOOKED, windowStart, windowEnd,
      DAILY_CAP, STATS_WINDOW_DAYS,
      doctorId,
    ],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    revenueCollected: row.revenue_collected,
    upcomingAppointments: row.upcoming_appointments,
    bookedInWindow: row.booked_in_window,
    capacityInWindow: row.capacity_in_window,
    utilizationPercent: row.utilization_percent,
  };
}

/**
 * One row per day for STATS_WINDOW_DAYS days from `from`, including days with
 * nothing booked. A recursive CTE builds the list of dates and the appointments
 * are LEFT JOINed onto it, so an empty day shows 0 instead of disappearing.
 * @param {number} doctorId
 * @param {string} from  "YYYY-MM-DD"
 * @returns {Promise<Array<{date: string, booked: number, utilizationPercent: number}>>}
 */
async function findAppointmentsPerDay(doctorId, from) {
  const [rows] = await pool.execute(
    `WITH RECURSIVE window_days (cal_date, n) AS (
             SELECT CAST(? AS DATE), 1
              UNION ALL
             SELECT cal_date + INTERVAL 1 DAY, n + 1 FROM window_days WHERE n < ?
           )
     SELECT w.cal_date,
            COUNT(a.id) AS booked,
            ROUND(COUNT(a.id) / ? * 100, 1) AS utilization_percent
       FROM window_days w
       LEFT JOIN appointments a
              ON a.doctor_id = ?
             AND a.status = ?
             AND a.appt_datetime >= w.cal_date
             AND a.appt_datetime <  w.cal_date + INTERVAL 1 DAY
      GROUP BY w.cal_date
      ORDER BY w.cal_date`,
    [from, STATS_WINDOW_DAYS, DAILY_CAP, doctorId, APPOINTMENT_STATUS.BOOKED],
  );
  return rows.map((row) => ({
    date: row.cal_date,
    booked: row.booked,
    utilizationPercent: row.utilization_percent,
  }));
}

module.exports = { findDoctorSummary, findAppointmentsPerDay };
