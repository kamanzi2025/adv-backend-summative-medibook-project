// Checks the body of doctor create and update requests.
const { text, money, validateBody } = require('./common');
const { FIELD_LIMITS } = require('../config/constants');

// Room codes like "R-12": 1 to 3 letters, a hyphen, 1 to 4 digits. Saved in capitals.
const ROOM_PATTERN = /^[A-Z]{1,3}-[0-9]{1,4}$/;

const DOCTOR_RULES = Object.freeze({
  fullName: text(FIELD_LIMITS.PERSON_NAME_MAX),
  specialty: text(FIELD_LIMITS.SPECIALTY_MAX),
  consultationFee: money(),
  room: text(FIELD_LIMITS.ROOM_MAX, {
    normalize: (s) => s.toUpperCase(),
    pattern: ROOM_PATTERN,
    patternMessage: 'must look like R-12 (1-3 letters, a hyphen, 1-4 digits)',
  }),
});

/** POST: every field is required. */
function validateDoctorCreate(body) {
  return validateBody(body, DOCTOR_RULES, { entity: 'doctor' });
}

/** PATCH: any of the fields, but at least one. */
function validateDoctorUpdate(body) {
  return validateBody(body, DOCTOR_RULES, { partial: true, entity: 'doctor' });
}

module.exports = { validateDoctorCreate, validateDoctorUpdate };
