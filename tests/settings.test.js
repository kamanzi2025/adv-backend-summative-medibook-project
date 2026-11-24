// Optional settings: the defaults from constants, overridden by process.env when called.
const { clinicTimezone, logDir } = require('../src/config/settings');
const { DEFAULT_CLINIC_TIMEZONE, AUDIT_LOG } = require('../src/config/constants');

const SAVED = { CLINIC_TIMEZONE: process.env.CLINIC_TIMEZONE, LOG_DIR: process.env.LOG_DIR };

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('settings', () => {
  test('defaults when the variables are not set', () => {
    delete process.env.CLINIC_TIMEZONE;
    delete process.env.LOG_DIR;
    expect(clinicTimezone()).toBe(DEFAULT_CLINIC_TIMEZONE);
    expect(logDir()).toBe(AUDIT_LOG.DEFAULT_DIR);
  });

  test('read at call time, so a value loaded later from .env is still used', () => {
    process.env.CLINIC_TIMEZONE = 'Africa/Accra';
    process.env.LOG_DIR = 'custom-logs';
    expect(clinicTimezone()).toBe('Africa/Accra');
    expect(logDir()).toBe('custom-logs');
  });
});
