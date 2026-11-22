// Patients: validate input, call the model, choose the status code.
// No try/catch: Express 5 forwards rejected promises to the error middleware.
const patientModel = require('../models/patientModel');
const AppError = require('../utils/AppError');
const { parseId, parsePagination } = require('../validators/common');
const { validatePatientCreate, validatePatientUpdate } = require('../validators/patientValidator');
const { HTTP_STATUS, REMOVE_OUTCOME } = require('../config/constants');

/** GET /api/patients?limit=&offset= */
async function listPatients(req, res) {
  const page = parsePagination(req.query);
  const { items, total } = await patientModel.findAll(page);
  res.json({ data: items, meta: { ...page, total } });
}

/** GET /api/patients/:id */
async function getPatient(req, res) {
  const id = parseId(req.params.id);
  const patient = await patientModel.findById(id);
  if (!patient) throw AppError.notFound(`Patient ${id} not found`);
  res.json({ data: patient });
}

/** POST /api/patients */
async function createPatient(req, res) {
  const input = validatePatientCreate(req.body);
  const patient = await patientModel.create(input);
  res.status(HTTP_STATUS.CREATED).location(`/api/patients/${patient.id}`).json({ data: patient });
}

/** PATCH /api/patients/:id */
async function updatePatient(req, res) {
  const id = parseId(req.params.id);
  const changes = validatePatientUpdate(req.body);
  const patient = await patientModel.update(id, changes);
  if (!patient) throw AppError.notFound(`Patient ${id} not found`);
  res.json({ data: patient });
}

/** DELETE /api/patients/:id */
async function deletePatient(req, res) {
  const id = parseId(req.params.id);
  const outcome = await patientModel.remove(id);
  if (outcome === REMOVE_OUTCOME.NOT_FOUND) throw AppError.notFound(`Patient ${id} not found`);
  if (outcome === REMOVE_OUTCOME.HAS_APPOINTMENTS) {
    throw AppError.conflict(
      `Patient ${id} has appointments and cannot be deleted. `
      + 'Appointments (including cancelled ones) are kept permanently as refund history.',
    );
  }
  res.status(HTTP_STATUS.NO_CONTENT).end();
}

module.exports = { listPatients, getPatient, createPatient, updatePatient, deletePatient };
