// Doctor statistics. The controller validates the input and supplies "now" from
// the clinic clock. Every figure is calculated by the SQL in the model.
const statisticsModel = require('../models/statisticsModel');
const AppError = require('../utils/AppError');
const {
  clinicNow, toSqlDate, toSqlDateTime, formatClinicDateTime, addDays,
} = require('../utils/clock');
const { parseId, parseDateQuery } = require('../validators/common');
const { DAILY_CAP, STATS_WINDOW_DAYS } = require('../config/constants');

/** GET /api/doctors/:id/statistics?from=YYYY-MM-DD (today in clinic time if left out) */
async function getDoctorStatistics(req, res) {
  const doctorId = parseId(req.params.id);
  const now = clinicNow();
  const from = parseDateQuery(req.query.from, now, 'from');

  // The window runs from 00:00 on the first day up to, but not including, 00:00
  // after the last day. Comparing the raw column like that lets MySQL use the index.
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
