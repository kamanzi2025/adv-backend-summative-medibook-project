// Doctor statistics. Validates input, takes "now"/"today" from the clinic clock,
// and lets the model's SQL compute every figure. No try/catch: Express 5 forwards errors.
const statisticsModel = require('../models/statisticsModel');
const AppError = require('../utils/AppError');
const {
  clinicNow, toSqlDate, toSqlDateTime, formatClinicDateTime, addDays,
} = require('../utils/clock');
const { parseId, parseDateQuery } = require('../validators/common');
const { DAILY_CAP, STATS_WINDOW_DAYS } = require('../config/constants');

/** GET /api/doctors/:id/statistics?from=YYYY-MM-DD (default: today, clinic time) */
async function getDoctorStatistics(req, res) {
  const doctorId = parseId(req.params.id);
  const now = clinicNow();
  const from = parseDateQuery(req.query.from, now, 'from');

  // Half-open window [from 00:00, from + STATS_WINDOW_DAYS 00:00): sargable in SQL.
  const fromDate = toSqlDate(from);
  const summary = await statisticsModel.findDoctorSummary({
    doctorId,
    now: toSqlDateTime(now),
    windowStart: `${fromDate} 00:00:00`,
    windowEnd: `${toSqlDate(addDays(from, STATS_WINDOW_DAYS))} 00:00:00`,
  });
  if (!summary) throw AppError.notFound(`Doctor ${doctorId} not found`);

  const appointmentsPerDay = await statisticsModel.findAppointmentsPerDay(doctorId, fromDate);
  res.json({
    data: {
      doctorId: summary.doctorId,
      doctorName: summary.doctorName,
      from: fromDate,
      to: toSqlDate(addDays(from, STATS_WINDOW_DAYS - 1)),
      revenueCollected: summary.revenueCollected,
      upcomingAppointments: summary.upcomingAppointments,
      appointmentsPerDay,
      utilization: {
        bookedInWindow: summary.bookedInWindow,
        capacityInWindow: summary.capacityInWindow,
        percent: summary.utilizationPercent,
      },
      dailyCap: DAILY_CAP,
    },
    meta: { windowDays: STATS_WINDOW_DAYS, upcomingAfter: formatClinicDateTime(now) },
  });
}

module.exports = { getDoctorStatistics };
