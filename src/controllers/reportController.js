// Clinic-wide reports. The SQL in reportModel produces the results; this layer only
// wraps them in the response envelope. No try/catch: Express 5 forwards errors.
const reportModel = require('../models/reportModel');
const { clinicNow, formatClinicDateTime } = require('../utils/clock');
const { DAILY_CAP, BUSY_THRESHOLD } = require('../config/constants');

/** GET /api/reports/doctors */
async function getDoctorsReport(req, res) {
  const doctors = await reportModel.findDoctorsReport();
  res.json({ data: doctors, meta: { generatedAt: formatClinicDateTime(clinicNow()) } });
}

/** GET /api/reports/busy-days */
async function getBusyDays(req, res) {
  const busyDays = await reportModel.findBusyDays();
  res.json({
    data: busyDays,
    meta: {
      dailyCap: DAILY_CAP,
      busyThreshold: BUSY_THRESHOLD,
      rule: 'booked > busyThreshold × dailyCap (BOOKED appointments only)',
      generatedAt: formatClinicDateTime(clinicNow()),
    },
  });
}

module.exports = { getDoctorsReport, getBusyDays };
