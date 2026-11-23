// Every business rule number lives here, and only here.
// This file is pure (no I/O, no dotenv), so unit tests can import it safely.

const APPOINTMENT_STATUS = Object.freeze({
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
});

// Refund policy (README Part C.3). Boundaries are documented in DESIGN_NOTES.md:
//   notice  > 48h        -> 100%
//   24h <= notice <= 48h -> 50%   (exactly 48h and exactly 24h are both 50%)
//   notice  < 24h        -> 0%
const REFUND_POLICY = Object.freeze({
  FULL: Object.freeze({ moreThanHours: 48, percent: 100 }),
  PARTIAL: Object.freeze({ atLeastHours: 24, percent: 50 }),
  NONE: Object.freeze({ percent: 0 }),
});

// What the booking model reports back. The controller turns these into HTTP
// statuses; the waitlist worker turns them into promotion decisions.
const BOOKING_OUTCOME = Object.freeze({
  BOOKED: 'BOOKED',
  DOCTOR_NOT_FOUND: 'DOCTOR_NOT_FOUND',
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
  AMOUNT_EXCEEDS_FEE: 'AMOUNT_EXCEEDS_FEE',
  DAY_FULL: 'DAY_FULL',
  SLOT_TAKEN: 'SLOT_TAKEN',
  PATIENT_DOUBLE_BOOKED: 'PATIENT_DOUBLE_BOOKED',
});

// What patientModel.remove / doctorModel.remove report back.
const REMOVE_OUTCOME = Object.freeze({
  DELETED: 'DELETED',
  NOT_FOUND: 'NOT_FOUND',
  HAS_APPOINTMENTS: 'HAS_APPOINTMENTS',
});

// Every HTTP status code the API sends, named once.
const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
});

const WAITLIST_TYPE = Object.freeze({ SLOT: 'slot', DAY: 'day' });

const AUDIT_EVENT = Object.freeze({
  APPOINTMENT_BOOKED: 'APPOINTMENT_BOOKED',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  WAITLIST_JOINED: 'WAITLIST_JOINED',
  WAITLIST_PROMOTED: 'WAITLIST_PROMOTED',
  WAITLIST_PROMOTION_FAILED: 'WAITLIST_PROMOTION_FAILED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
});

module.exports = Object.freeze({
  // The clinic's IANA time zone when CLINIC_TIMEZONE is not set (see config/settings.js).
  DEFAULT_CLINIC_TIMEZONE: 'Africa/Johannesburg',

  // Working day: slots start at WORKING_HOURS_START, the last one starts
  // SLOT_MINUTES before WORKING_HOURS_END (i.e. 16:30).
  // Mirrored by chk_appt_slot_minutes / chk_appt_working_hours in database/schema.sql:
  // change both together.
  WORKING_HOURS_START: '09:00',
  WORKING_HOURS_END: '17:00',
  SLOT_MINUTES: 30,

  // Capacity rules.
  DAILY_CAP: 12,
  BUSY_THRESHOLD: 0.8,

  // Doctor statistics: "next N days" window (today included).
  STATS_WINDOW_DAYS: 7,

  APPOINTMENT_STATUS,
  REFUND_POLICY,
  BOOKING_OUTCOME,
  REMOVE_OUTCOME,
  HTTP_STATUS,
  WAITLIST_TYPE,
  AUDIT_EVENT,

  // A booking transaction is retried at most this many times in total, and only
  // for transient errors (deadlock, lock wait timeout, appt_ref collision).
  BOOKING_MAX_ATTEMPTS: 3,

  // appt_ref = PREFIX + YYYYMMDD + "-" + CODE_LENGTH random characters from ALPHABET,
  // e.g. AP-20270315-K7Q2. Must match chk_appt_ref_format in database/schema.sql.
  APPT_REF: Object.freeze({
    PREFIX: 'AP-',
    CODE_LENGTH: 4,
    ALPHABET: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  }),

  // Input limits. Each one mirrors a column size in database/schema.sql.
  FIELD_LIMITS: Object.freeze({
    PERSON_NAME_MAX: 100, // patients.full_name, doctors.full_name VARCHAR(100)
    EMAIL_MAX: 254, // patients.email VARCHAR(254)
    PHONE_MAX: 20, // patients.phone VARCHAR(20)
    SPECIALTY_MAX: 80, // doctors.specialty VARCHAR(80)
    ROOM_MAX: 10, // doctors.room VARCHAR(10)
  }),
  MONEY_MAX: 99999999.99, // largest DECIMAL(10,2) value
  ID_MAX: 4294967295, // largest INT UNSIGNED value

  // GET-all pagination (?limit=&offset=).
  PAGINATION: Object.freeze({ DEFAULT_LIMIT: 20, MAX_LIMIT: 100 }),

  // Audit log (Part D): one JSON line per event in <LOG_DIR>/<FILE_NAME>.
  // LOG_DIR is read by config/settings.js, falling back to DEFAULT_DIR.
  AUDIT_LOG: Object.freeze({ DEFAULT_DIR: 'logs', FILE_NAME: 'audit.log' }),

  // BullMQ queue names (Part E). The web server only produces jobs;
  // src/workers/worker.js (a separate process) consumes them.
  QUEUE: Object.freeze({
    SLOT_FREED: 'slot-freed',
    SEND_CONFIRMATION: 'send-confirmation',
  }),
  // Every job: up to ATTEMPTS tries, exponential backoff starting at
  // BACKOFF_DELAY_MS, failed jobs kept (not removed) for inspection.
  QUEUE_JOB_OPTIONS: Object.freeze({ ATTEMPTS: 5, BACKOFF_DELAY_MS: 2000 }),
  // slot-freed runs one job at a time so two promotions never race for one slot.
  WORKER_CONCURRENCY: Object.freeze({ SLOT_FREED: 1, SEND_CONFIRMATION: 5 }),
  // The worker re-runs the waitlist sweep this often (not only at start-up), so a
  // "slot-freed" job lost while Redis was down is recovered without a restart.
  WAITLIST_SWEEP_INTERVAL_MS: 60000,

  // Redis waitlist keys (plain Redis lists, FIFO: RPUSH to join, LMOVE ... LEFT to promote):
  //   <PREFIX>:<doctorId>:slot:<YYYY-MM-DDTHH:mm>   waiting for one exact slot
  //   <PREFIX>:<doctorId>:day:<YYYY-MM-DD>          waiting for any slot that day
  //   <waitlist key><PROCESSING_SUFFIX>             entries being promoted right now
  //   FAILED                                        permanently failed promotions + reason
  WAITLIST_KEYS: Object.freeze({
    PREFIX: 'waitlist:doctor',
    PROCESSING_SUFFIX: ':processing',
    FAILED: 'waitlist:failed',
  }),

  // GET /feedback (Part G): ?lang=<key>; unsupported values fall back to DEFAULT_LANGUAGE.
  // Each language maps to the Intl locale used to format today's date.
  I18N: Object.freeze({
    DEFAULT_LANGUAGE: 'en',
    LOCALES: Object.freeze({ en: 'en-GB', fr: 'fr-FR' }),
  }),

  // Redis client behaviour when Redis is unreachable.
  REDIS_RETRY_STEP_MS: 500,
  REDIS_RETRY_MAX_MS: 5000,

  // mysql2 pool size.
  DB_CONNECTION_LIMIT: 10,
});
