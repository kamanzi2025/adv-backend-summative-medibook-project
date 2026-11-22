// Waitlist reads. No try/catch: Express 5 forwards errors to the error middleware.
const doctorModel = require('../models/doctorModel');
const waitlistService = require('../services/waitlistService');
const AppError = require('../utils/AppError');
const { parseId } = require('../validators/common');

/** GET /api/doctors/:id/waitlist */
async function getDoctorWaitlist(req, res) {
  const doctorId = parseId(req.params.id); // 400
  const doctor = await doctorModel.findById(doctorId);
  if (!doctor) throw AppError.notFound(`Doctor ${doctorId} not found`);
  res.json({ data: await waitlistService.getDoctorWaitlist(doctorId) }); // 503 if Redis is down
}

module.exports = { getDoctorWaitlist };
