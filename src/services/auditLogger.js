// Audit log (Part D): one JSON line per event in <LOG_DIR>/audit.log.
// Contract: log() NEVER throws or rejects, so logging can never fail a request
// or a worker job. Only async fs calls (no *Sync), so the event loop never blocks.
//
// Does NOT import config/env.js (the worker and unit tests use it without a .env):
// the directory is process.env.LOG_DIR || AUDIT_LOG.DEFAULT_DIR. A relative path is
// resolved against process.cwd(), i.e. the project root for `npm start` / `npm run worker`.
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { AUDIT_LOG } = require('../config/constants');

/**
 * @param {object} [options]
 * @param {string} [options.dir]  log directory (default: LOG_DIR or "logs")
 * @param {{ mkdir: Function, appendFile: Function }} [options.fs]  injectable for tests
 */
function createAuditLogger({ dir = process.env.LOG_DIR || AUDIT_LOG.DEFAULT_DIR, fs = fsPromises } = {}) {
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
   * @returns {Promise<void>}
   */
  async function log(event, payload = {}) {
    try {
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...payload })}\n`;
      await ensureDir();
      // One appendFile = one write() on a file opened with O_APPEND: each line is
      // added at the end in a single write, so concurrent small lines don't interleave.
      await fs.appendFile(filePath, line, 'utf8');
    } catch (err) {
      console.error(`[audit] could not record ${event}: ${err.message}`);
    }
  }

  return { log, filePath };
}

// The shared instance is created on the first log() call, not at require time,
// so LOG_DIR is read after dotenv has loaded .env, whatever the require order.
let defaultLogger = null;

/** log(event, payload) on the shared logger. Never throws or rejects. */
function log(event, payload) {
  if (!defaultLogger) defaultLogger = createAuditLogger();
  return defaultLogger.log(event, payload);
}

module.exports = { createAuditLogger, log };
