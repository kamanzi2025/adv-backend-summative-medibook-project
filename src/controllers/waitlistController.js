// Reading a doctor's waitlist. Express 5 forwards errors, so no try/catch.
const doctorModel = require('../models/doctorModel');
const waitlistService = require('../services/waitlistService');
const AppError = require('../utils/AppError');
const { parseId } = require('../validators/common');

/** GET /api/doctors/:id/waitlist */
async function getDoctorWaitlist(req, res) {
  const doctorId = parseId(req.params.id); // throws 400
  const doctor = await doctorModel.findById(doctorId);
  if (!doctor) throw AppError.notFound(`Doctor ${doctorId} not found`);
  res.json({ data: await waitlistService.getDoctorWaitlist(doctorId) }); // 503 when Redis is down
}

module.exports = { getDoctorWaitlist };
