// Optional settings with safe defaults, read from process.env at CALL time.
// config/env.js owns the required connection settings and loads .env; this module
// owns the optional ones that pure modules need (clock, i18n, audit logger).
// Reading lazily means .env is always applied whatever the require order, and unit
// tests can import those modules without any .env file. Nothing else reads process.env.
const { DEFAULT_CLINIC_TIMEZONE, AUDIT_LOG } = require('./constants');

/** IANA time zone of the clinic's wall clock (CLINIC_TIMEZONE). */
function clinicTimezone() {
  return process.env.CLINIC_TIMEZONE || DEFAULT_CLINIC_TIMEZONE;
}

/** Directory of audit.log (LOG_DIR), relative to the project root unless absolute. */
function logDir() {
  return process.env.LOG_DIR || AUDIT_LOG.DEFAULT_DIR;
}

module.exports = { clinicTimezone, logDir };
