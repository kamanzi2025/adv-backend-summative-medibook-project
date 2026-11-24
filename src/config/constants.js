// All the business numbers (daily cap, refund tiers, working hours...) are defined
// here and nowhere else. The file does no I/O, so the unit tests can import it.

const APPOINTMENT_STATUS = Object.freeze({
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
});

// Refund tiers (brief Part C.3). DESIGN_NOTES.md explains the boundaries:
//   notice  > 48h        -> 100%
//   24h <= notice <= 48h -> 50%   (exactly 48h and exactly 24h both get 50%)
//   notice  < 24h        -> 0%
const REFUND_POLICY = Object.freeze({
  FULL: Object.freeze({ moreThanHours: 48, percent: 100 }),
  PARTIAL: Object.freeze({ atLeastHours: 24, percent: 50 }),
  NONE: Object.freeze({ percent: 0 }),
});

// Results the booking model can return. The controller turns them into HTTP
// statuses and the waitlist worker uses them to decide what to do next.
const BOOKING_OUTCOME = Object.freeze({
  BOOKED: 'BOOKED',
  DOCTOR_NOT_FOUND: 'DOCTOR_NOT_FOUND',
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
  AMOUNT_EXCEEDS_FEE: 'AMOUNT_EXCEEDS_FEE',
  DAY_FULL: 'DAY_FULL',
  SLOT_TAKEN: 'SLOT_TAKEN',
  PATIENT_DOUBLE_BOOKED: 'PATIENT_DOUBLE_BOOKED',
});

// Results of patientModel.remove and doctorModel.remove.
const REMOVE_OUTCOME = Object.freeze({
  DELETED: 'DELETED',
  NOT_FOUND: 'NOT_FOUND',
  HAS_APPOINTMENTS: 'HAS_APPOINTMENTS',
});

// Status codes get names so the controllers don't contain bare numbers.
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
  // Used when CLINIC_TIMEZONE isn't set in .env (see config/settings.js).
  DEFAULT_CLINIC_TIMEZONE: 'Africa/Johannesburg',

  // The first slot starts at 09:00 and the last one starts 30 minutes before
  // closing, so at 16:30. The CHECK constraints chk_appt_slot_minutes and
  // chk_appt_working_hours in schema.sql say the same thing, so change both together.
  WORKING_HOURS_START: '09:00',
  WORKING_HOURS_END: '17:00',
  SLOT_MINUTES: 30,

  DAILY_CAP: 12,
  BUSY_THRESHOLD: 0.8,

  // Statistics cover the next 7 days, today included.
  STATS_WINDOW_DAYS: 7,

  APPOINTMENT_STATUS,
  REFUND_POLICY,
  BOOKING_OUTCOME,
  REMOVE_OUTCOME,
  HTTP_STATUS,
  WAITLIST_TYPE,
  AUDIT_EVENT,

  // Total tries for one booking transaction. Only deadlocks, lock timeouts and an
  // appt_ref collision are retried. Anything else fails straight away.
  BOOKING_MAX_ATTEMPTS: 3,

  // appt_ref looks like AP-20270315-K7Q2: prefix, appointment date, dash, 4 random
  // characters. If this changes, chk_appt_ref_format in schema.sql has to change too.
  APPT_REF: Object.freeze({
    PREFIX: 'AP-',
    CODE_LENGTH: 4,
    ALPHABET: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  }),

  // Each limit matches the column size in schema.sql, so a long value gets a clear
  // 400 from the validator instead of a database error.
  FIELD_LIMITS: Object.freeze({
    PERSON_NAME_MAX: 100, // full_name VARCHAR(100) in both tables
    EMAIL_MAX: 254, // VARCHAR(254)
    PHONE_MAX: 20, // VARCHAR(20)
    SPECIALTY_MAX: 80, // VARCHAR(80)
    ROOM_MAX: 10, // VARCHAR(10)
  }),
  MONEY_MAX: 99999999.99, // biggest value DECIMAL(10,2) can hold
  ID_MAX: 4294967295, // biggest value INT UNSIGNED can hold

  // Defaults for ?limit=&offset= on the list endpoints.
  PAGINATION: Object.freeze({ DEFAULT_LIMIT: 20, MAX_LIMIT: 100 }),

  // Audit log (Part D). LOG_DIR in .env can move the folder; otherwise it's "logs".
  AUDIT_LOG: Object.freeze({ DEFAULT_DIR: 'logs', FILE_NAME: 'audit.log' }),

  // BullMQ queues (Part E). The web server only adds jobs. The worker process
  // (src/workers/worker.js) is the one that runs them.
  QUEUE: Object.freeze({
    SLOT_FREED: 'slot-freed',
    SEND_CONFIRMATION: 'send-confirmation',
  }),
  // A failed job is retried up to 5 times with exponential backoff from 2 seconds.
  // Jobs that still fail are kept so I can inspect them.
  QUEUE_JOB_OPTIONS: Object.freeze({ ATTEMPTS: 5, BACKOFF_DELAY_MS: 2000 }),
  // Promotions run one at a time, so two of them can never compete for the same freed slot.
  WORKER_CONCURRENCY: Object.freeze({ SLOT_FREED: 1, SEND_CONFIRMATION: 5 }),
  // How often the worker repeats the waitlist sweep. This picks up a "slot-freed"
  // job that was lost while Redis was down, without restarting anything.
  WAITLIST_SWEEP_INTERVAL_MS: 60000,

  // Waitlist keys in Redis. Each one is a plain list used as a FIFO queue
  // (RPUSH to join, LMOVE ... LEFT to take the first patient):
  //   <PREFIX>:<doctorId>:slot:<YYYY-MM-DDTHH:mm>   waiting for one exact slot
  //   <PREFIX>:<doctorId>:day:<YYYY-MM-DD>          waiting for any slot that day
  //   <waitlist key><PROCESSING_SUFFIX>             entries being promoted right now
  //   FAILED                                        promotions that can never work, with the reason
  WAITLIST_KEYS: Object.freeze({
    PREFIX: 'waitlist:doctor',
    PROCESSING_SUFFIX: ':processing',
    FAILED: 'waitlist:failed',
  }),

  // Feedback page (Part G). ?lang picks the language; anything unsupported gets
  // English. Each language also has the Intl locale used to format the date.
  I18N: Object.freeze({
    DEFAULT_LANGUAGE: 'en',
    LOCALES: Object.freeze({ en: 'en-GB', fr: 'fr-FR' }),
  }),

  // Reconnect delays when Redis is unreachable.
  REDIS_RETRY_STEP_MS: 500,
  REDIS_RETRY_MAX_MS: 5000,

  DB_CONNECTION_LIMIT: 10,
});
