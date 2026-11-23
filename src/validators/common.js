// Generic, pure validation building blocks (no DB, no Redis).
// A "field rule" is a function raw => { value } | { error }.
const AppError = require('../utils/AppError');
const { parseClinicDate } = require('../utils/clock');
const { ID_MAX, MONEY_MAX, PAGINATION } = require('../config/constants');

const POSITIVE_INT = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;
const MONEY_FORMAT = /^[0-9]+(\.[0-9]{1,2})?$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Counts characters the way MySQL's CHAR_LENGTH does for utf8mb4
// (an emoji is 1 character, not 2 UTF-16 code units).
function charLength(text) {
  return [...text].length;
}

/**
 * Trimmed, non-blank string of at most maxLength characters.
 * @param {number} maxLength
 * @param {object} [options]
 * @param {(s: string) => string} [options.normalize]  e.g. lower-case an email
 * @param {RegExp} [options.pattern]   checked after normalizing
 * @param {string} [options.patternMessage]
 */
function text(maxLength, { normalize, pattern, patternMessage } = {}) {
  return (raw) => {
    if (typeof raw !== 'string') return { error: 'must be a string' };
    const trimmed = raw.trim();
    if (trimmed === '') return { error: 'must not be blank' };
    if (charLength(trimmed) > maxLength) return { error: `must be at most ${maxLength} characters` };
    const value = normalize ? normalize(trimmed) : trimmed;
    if (pattern && !pattern.test(value)) return { error: patternMessage };
    return { value };
  };
}

/**
 * A JSON number with at most 2 decimal places that fits DECIMAL(10,2).
 * @param {object} [options]
 * @param {boolean} [options.allowZero=false]  true: >= 0 (a free visit); false: > 0
 */
function money({ allowZero = false } = {}) {
  return (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return { error: 'must be a number' };
    if (allowZero ? raw < 0 : raw <= 0) {
      return { error: allowZero ? 'must be 0 or more' : 'must be greater than 0' };
    }
    if (!MONEY_FORMAT.test(String(raw))) return { error: 'must have at most 2 decimal places' };
    if (raw > MONEY_MAX) return { error: `must be at most ${MONEY_MAX}` };
    return { value: raw };
  };
}

/** A JSON integer id (a number, not a string) that fits INT UNSIGNED. */
function positiveInteger() {
  return (raw) => {
    if (!Number.isInteger(raw) || raw < 1 || raw > ID_MAX) return { error: 'must be a positive integer' };
    return { value: raw };
  };
}

/** A JSON true/false. */
function booleanValue() {
  return (raw) => (typeof raw === 'boolean' ? { value: raw } : { error: 'must be true or false' });
}

/**
 * Validates a request body against a map of field rules.
 * - rejects anything that isn't a JSON object
 * - rejects unknown fields
 * - partial=false: every field is required (create), except those in `optional`
 * - partial=true:  fields are optional but at least one is required (PATCH)
 * Collects EVERY problem before failing, so the client can fix them all at once.
 * @returns {object} the cleaned values (only the fields that were sent)
 * @throws {AppError} 400 with details [{ field, message }]
 */
function validateBody(body, rules, { partial = false, optional = [], entity = 'request body' } = {}) {
  if (!isPlainObject(body)) {
    throw AppError.badRequest(
      'Request body must be a JSON object (send Content-Type: application/json)',
      [{ field: 'body', message: 'must be a JSON object' }],
    );
  }

  const allowed = Object.keys(rules);
  const errors = [];
  const value = {};

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: `is not an allowed field (allowed: ${allowed.join(', ')})` });
    }
  }

  for (const field of allowed) {
    if (body[field] === undefined) {
      if (!partial && !optional.includes(field)) errors.push({ field, message: 'is required' });
      continue;
    }
    const result = rules[field](body[field]);
    if (result.error) errors.push({ field, message: result.error });
    else value[field] = result.value;
  }

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({ field: 'body', message: `must contain at least one of: ${allowed.join(', ')}` });
  }

  if (errors.length > 0) {
    const fields = [...new Set(errors.map((e) => e.field))].join(', ');
    throw AppError.badRequest(`Invalid ${entity}: check ${fields}`, errors);
  }
  return value;
}

/**
 * Route/query id: a positive integer that fits INT UNSIGNED.
 * @throws {AppError} 400
 */
function parseId(raw, name = 'id') {
  const valid = typeof raw === 'string' && POSITIVE_INT.test(raw) && Number(raw) <= ID_MAX;
  if (!valid) {
    throw AppError.badRequest(`Invalid ${name}: must be a positive integer`, [
      { field: name, message: `"${raw}" is not a positive integer` },
    ]);
  }
  return Number(raw);
}

/**
 * ?limit=&offset= with safe defaults and a hard maximum.
 * @throws {AppError} 400 listing every bad parameter
 */
function parsePagination(query = {}) {
  const errors = [];
  let limit = PAGINATION.DEFAULT_LIMIT;
  let offset = 0;

  if (query.limit !== undefined) {
    const ok = typeof query.limit === 'string' && POSITIVE_INT.test(query.limit)
      && Number(query.limit) <= PAGINATION.MAX_LIMIT;
    if (ok) limit = Number(query.limit);
    else errors.push({ field: 'limit', message: `must be an integer from 1 to ${PAGINATION.MAX_LIMIT}` });
  }
  if (query.offset !== undefined) {
    const ok = typeof query.offset === 'string' && NON_NEGATIVE_INT.test(query.offset)
      && Number(query.offset) <= ID_MAX;
    if (ok) offset = Number(query.offset);
    else errors.push({ field: 'offset', message: 'must be an integer of 0 or more' });
  }

  if (errors.length > 0) {
    throw AppError.badRequest(`Invalid query: check ${errors.map((e) => e.field).join(', ')}`, errors);
  }
  return { limit, offset };
}

/**
 * An optional ?<field>=YYYY-MM-DD query value (e.g. ?date= for a doctor's day,
 * ?from= for statistics). Missing -> `today`. Anything else that isn't one real
 * "YYYY-MM-DD" date (wrong shape, 2027-02-30, or an array from ?from=a&from=b) -> 400.
 * @param {unknown} raw   req.query[field]
 * @param {Date} today    clinic Date (clinicNow())
 * @param {string} field  query parameter name, for the error message
 * @returns {Date} clinic Date; only its calendar day is used
 * @throws {AppError} 400
 */
function parseDateQuery(raw, today, field) {
  if (raw === undefined) return today;
  const date = parseClinicDate(raw);
  if (!date) {
    throw AppError.badRequest(`Invalid query: check ${field}`, [
      { field, message: 'must be one real date in the format "YYYY-MM-DD"' },
    ]);
  }
  return date;
}

module.exports = {
  isPlainObject,
  text,
  money,
  positiveInteger,
  booleanValue,
  validateBody,
  parseId,
  parsePagination,
  parseDateQuery,
};
