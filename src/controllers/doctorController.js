// Doctors: validate the input, call the model, pick the status code.
// Express 5 forwards rejected promises to the error handler, so no try/catch.
const doctorModel = require('../models/doctorModel');
const AppError = require('../utils/AppError');
const { parseId, parsePagination } = require('../validators/common');
const { validateDoctorCreate, validateDoctorUpdate } = require('../validators/doctorValidator');
const { HTTP_STATUS, REMOVE_OUTCOME } = require('../config/constants');

/** GET /api/doctors?limit=&offset= */
async function listDoctors(req, res) {
  const page = parsePagination(req.query);
  const { items, total } = await doctorModel.findAll(page);
  res.json({ data: items, meta: { ...page, total } });
}

/** GET /api/doctors/:id */
async function getDoctor(req, res) {
  const id = parseId(req.params.id);
  const doctor = await doctorModel.findById(id);
  if (!doctor) throw AppError.notFound(`Doctor ${id} not found`);
  res.json({ data: doctor });
}

/** POST /api/doctors */
async function createDoctor(req, res) {
  const input = validateDoctorCreate(req.body);
  const doctor = await doctorModel.create(input);
  res.status(HTTP_STATUS.CREATED).location(`/api/doctors/${doctor.id}`).json({ data: doctor });
}

/** PATCH /api/doctors/:id */
async function updateDoctor(req, res) {
  const id = parseId(req.params.id);
  const changes = validateDoctorUpdate(req.body);
  const doctor = await doctorModel.update(id, changes);
  if (!doctor) throw AppError.notFound(`Doctor ${id} not found`);
  res.json({ data: doctor });
}

/** DELETE /api/doctors/:id */
async function deleteDoctor(req, res) {
  const id = parseId(req.params.id);
  const outcome = await doctorModel.remove(id);
  if (outcome === REMOVE_OUTCOME.NOT_FOUND) throw AppError.notFound(`Doctor ${id} not found`);
  if (outcome === REMOVE_OUTCOME.HAS_APPOINTMENTS) {
    throw AppError.conflict(
      `Doctor ${id} has appointments and cannot be deleted. `
      + 'Appointments (including cancelled ones) are kept permanently as refund history.',
    );
  }
  res.status(HTTP_STATUS.NO_CONTENT).end();
}

module.exports = { listDoctors, getDoctor, createDoctor, updateDoctor, deleteDoctor };
