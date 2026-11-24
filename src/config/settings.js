// Optional settings that have a default. They're read from process.env when the
// function is called, not when the file loads. That way .env is always applied
// whatever order files are required in, and the tests can use the clock, i18n
// and audit logger without a .env file. Nothing else in the app reads process.env.
const { DEFAULT_CLINIC_TIMEZONE, AUDIT_LOG } = require('./constants');

/** The clinic's IANA time zone, from CLINIC_TIMEZONE. */
function clinicTimezone() {
  return process.env.CLINIC_TIMEZONE || DEFAULT_CLINIC_TIMEZONE;
}

/** Folder for audit.log, from LOG_DIR. A relative path starts at the project root. */
function logDir() {
  return process.env.LOG_DIR || AUDIT_LOG.DEFAULT_DIR;
}

module.exports = { clinicTimezone, logDir };
