// Audit log (Part D): one JSON line per event in <LOG_DIR>/audit.log.
// Contract: by default log() NEVER throws or rejects, so logging can never fail a
// user's request. Only async fs calls (no *Sync), so the event loop never blocks.
// A caller whose whole job IS the log line (the worker's confirmation "SMS") passes
// { strict: true }: the failure is still printed, and then rejected, so the queue
// retries the job instead of marking a lost line as done.
//
// Does NOT import config/env.js (unit tests use it without a .env): the directory
// comes from config/settings.js (LOG_DIR, default "logs"). A relative path is resolved
// against process.cwd(), i.e. the project root for `npm start` / `npm run worker`.
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { AUDIT_LOG } = require('../config/constants');
const { logDir: configuredLogDir } = require('../config/settings');

/**
 * @param {object} [options]
 * @param {string} [options.dir]  log directory (default: LOG_DIR or "logs")
 * @param {{ mkdir: Function, appendFile: Function }} [options.fs]  injectable for tests
 */
function createAuditLogger({ dir = configuredLogDir(), fs = fsPromises } = {}) {
  const logDir = path.resolve(dir);
  const filePath = path.join(logDir, AUDIT_LOG.FILE_NAME);
  let dirReady = null;

  // mkdir runs once and is shared by concurrent callers; on failure the memo is
  // cleared so the next log() tries again.
  function ensureDir() {
    if (!dirReady) {
      dirReady = fs.mkdir(logDir, { recursive: true }).catch((err) => {
        dirReady = null;
        throw err;
      });
    }
    return dirReady;
  }

  /**
   * @param {string} event    usually one of AUDIT_EVENT in config/constants.js
   * @param {object} payload  appointmentId, patientId, doctorId, ...
   * @param {{ strict?: boolean }} [options]  strict: reject when the line can't be written
   * @returns {Promise<void>}
   */
  async function log(event, payload = {}, { strict = false } = {}) {
    try {
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...payload })}\n`;
      await ensureDir();
      // One appendFile = one write() on a file opened with O_APPEND: each line is
      // added at the end in a single write, so concurrent small lines don't interleave.
      await fs.appendFile(filePath, line, 'utf8');
    } catch (err) {
      console.error(`[audit] could not record ${event}: ${err.message}`);
      if (strict) throw err;
    }
  }

  return { log, filePath };
}

// The shared instance is created on the first log() call, not at require time,
// so LOG_DIR is read after dotenv has loaded .env, whatever the require order.
let defaultLogger = null;

function sharedLogger() {
  if (!defaultLogger) defaultLogger = createAuditLogger();
  return defaultLogger;
}

/** log(event, payload) on the shared logger. Never throws or rejects. */
function log(event, payload) {
  return sharedLogger().log(event, payload);
}

/** Like log(), but rejects if the line could not be written (for queue jobs, so they retry). */
function logStrict(event, payload) {
  return sharedLogger().log(event, payload, { strict: true });
}

module.exports = { createAuditLogger, log, logStrict };
