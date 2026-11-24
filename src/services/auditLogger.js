// Audit log (Part D): one JSON line per event in <LOG_DIR>/audit.log.
//
// By default log() never throws or rejects, so a logging problem can't fail
// someone's booking. It only uses async fs calls, never *Sync, so it doesn't
// block the event loop. The one exception is the worker's confirmation "SMS",
// where writing the line is the whole job. It passes { strict: true }, so a
// failed write still gets printed but also rejects, and the queue retries the
// job instead of marking a lost message as done.
//
// This file doesn't import config/env.js, so the tests can use it without a .env.
// The folder comes from config/settings.js (LOG_DIR, "logs" by default). A relative
// path is resolved from where the process started, which is the project root for
// `npm start` and `npm run worker`.
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { AUDIT_LOG } = require('../config/constants');
const { logDir: configuredLogDir } = require('../config/settings');

/**
 * @param {object} [options]
 * @param {string} [options.dir]  log folder (default: LOG_DIR or "logs")
 * @param {{ mkdir: Function, appendFile: Function }} [options.fs]  the tests pass a fake here
 */
function createAuditLogger({ dir = configuredLogDir(), fs = fsPromises } = {}) {
  const logDir = path.resolve(dir);
  const filePath = path.join(logDir, AUDIT_LOG.FILE_NAME);
  let dirReady = null;

  // mkdir runs once, and calls that arrive at the same time share it. If it fails,
  // the saved promise is cleared so the next log() tries again.
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
   * @param {{ strict?: boolean }} [options]  strict: reject if the line can't be written
   * @returns {Promise<void>}
   */
  async function log(event, payload = {}, { strict = false } = {}) {
    try {
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...payload })}\n`;
      await ensureDir();
      // appendFile opens the file in append mode and adds the line in one write, so
      // two short lines written at the same time don't get mixed together.
      await fs.appendFile(filePath, line, 'utf8');
    } catch (err) {
      console.error(`[audit] could not record ${event}: ${err.message}`);
      if (strict) throw err;
    }
  }

  return { log, filePath };
}

// The shared logger is created on the first log() call rather than when the file
// is required, so LOG_DIR is read after dotenv has loaded .env.
let defaultLogger = null;

function sharedLogger() {
  if (!defaultLogger) defaultLogger = createAuditLogger();
  return defaultLogger;
}

/** log(event, payload) on the shared logger. Never throws or rejects. */
function log(event, payload) {
  return sharedLogger().log(event, payload);
}

/** Same as log(), but rejects if the line couldn't be written, so a queue job can retry. */
function logStrict(event, payload) {
  return sharedLogger().log(event, payload, { strict: true });
}

module.exports = { createAuditLogger, log, logStrict };
