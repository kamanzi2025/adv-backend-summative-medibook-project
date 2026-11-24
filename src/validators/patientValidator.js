// Checks the body of patient create and update requests.
const { text, validateBody } = require('./common');
const { FIELD_LIMITS } = require('../config/constants');

// These match the CHECK constraints in database/schema.sql, so bad input gets a
// clear 400 here before MySQL would reject it.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;

const PATIENT_RULES = Object.freeze({
  fullName: text(FIELD_LIMITS.PERSON_NAME_MAX),
  email: text(FIELD_LIMITS.EMAIL_MAX, {
    normalize: (s) => s.toLowerCase(),
    pattern: EMAIL_PATTERN,
    patternMessage: 'must be a valid email address, e.g. name@example.com',
  }),
  phone: text(FIELD_LIMITS.PHONE_MAX, {
    pattern: PHONE_PATTERN,
    patternMessage: 'must be 7-20 characters of digits, spaces, hyphens or brackets, optionally starting with +',
  }),
});

/** POST: every field is required. */
function validatePatientCreate(body) {
  return validateBody(body, PATIENT_RULES, { entity: 'patient' });
}

/** PATCH: any of the fields, but at least one. */
function validatePatientUpdate(body) {
  return validateBody(body, PATIENT_RULES, { partial: true, entity: 'patient' });
}

module.exports = { validatePatientCreate, validatePatientUpdate };
