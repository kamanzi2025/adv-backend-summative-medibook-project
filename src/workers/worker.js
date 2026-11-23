// The background worker: a SEPARATE process (`npm run worker`), never imported by
// the web server. Consumes "slot-freed" (waitlist promotions) and
// "send-confirmation" (simulated SMS) jobs.
require('../config/env'); // loads .env first, like src/server.js
const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const appointmentModel = require('../models/appointmentModel');
const healthModel = require('../models/healthModel');
const auditLogger = require('../services/auditLogger');
const bookingEvents = require('../services/bookingEvents');
const waitlistService = require('../services/waitlistService');
const { closeQueues } = require('../services/queues');
const { createWaitlistStore } = require('../utils/waitlistStore');
const { clinicNow } = require('../utils/clock');
const { createSlotFreedProcessor } = require('./processors/slotFreedProcessor');
const { createConfirmationProcessor } = require('./processors/confirmationProcessor');
const { sweepWaitlists } = require('./waitlistSweep');
const { QUEUE, WORKER_CONCURRENCY, WAITLIST_SWEEP_INTERVAL_MS } = require('../config/constants');

const REDIS_CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);

const connections = [];
const workers = [];
let shuttingDown = false;
let sweepTimer = null;
let sweepRunning = false;

function workerConnection() {
  const connection = createRedisConnection({ role: 'worker' });
  connections.push(connection);
  return connection;
}

function startWorker(queueName, processor, concurrency, onCompleted) {
  // Each Worker gets its own connection; BullMQ duplicates it for the blocking one.
  const worker = new Worker(queueName, processor, { connection: workerConnection(), concurrency });
  worker.on('completed', onCompleted);
  worker.on('failed', (job, err) => {
    const attempts = job ? `${job.attemptsMade}/${job.opts.attempts}` : '?';
    console.error(`[worker] ${queueName} job ${job ? job.id : '?'} failed (attempt ${attempts}): ${err.message}`);
  });
  worker.on('error', (err) => {
    // Connection loss is already reported once by config/redis.js; don't repeat it per retry.
    if (!REDIS_CONNECTION_ERRORS.has(err.code)) {
      console.error(`[worker] ${queueName} error: ${err.message || err.code}`);
    }
  });
  workers.push(worker);
}

/**
 * Re-queues promotions whose slot-freed job was lost (e.g. a cancellation while Redis
 * was down). Runs at start-up and then every WAITLIST_SWEEP_INTERVAL_MS; never two at
 * once. A failed run is only logged: the next run tries again.
 */
async function runSweep(store, label) {
  if (sweepRunning || shuttingDown) return;
  sweepRunning = true;
  try {
    const queued = await sweepWaitlists({
      store,
      findByDoctorBetween: appointmentModel.findByDoctorBetween,
      enqueueSlotFreed: waitlistService.enqueueSlotFreed,
      now: clinicNow,
    });
    if (queued > 0 || label === 'start-up') {
      console.info(`[worker] ${label} sweep: ${queued} slot-freed job(s) queued for free slots with a waitlist`);
    }
  } catch (err) {
    console.warn(`[worker] ${label} sweep skipped (${err.code || err.message}); the next sweep will retry`);
  } finally {
    sweepRunning = false;
  }
}

async function main() {
  const store = createWaitlistStore(workerConnection());

  // 1. Recovery BEFORE any job runs: entries left in processing lists by a crash
  //    between LMOVE and LREM go back to the front of their waitlist.
  const recovered = await store.recoverProcessing();
  console.info(`[worker] recovery: ${recovered} waitlist entr${recovered === 1 ? 'y' : 'ies'} moved back from processing lists`);

  // 2. Sweep now, then periodically, so a lost slot-freed job never needs a restart.
  await runSweep(store, 'start-up');
  sweepTimer = setInterval(() => runSweep(store, 'periodic'), WAITLIST_SWEEP_INTERVAL_MS);

  startWorker(
    QUEUE.SLOT_FREED,
    createSlotFreedProcessor({
      store,
      bookAppointment: appointmentModel.bookAppointment,
      onAppointmentBooked: bookingEvents.onAppointmentBooked,
      audit: auditLogger.log,
      now: clinicNow,
    }),
    WORKER_CONCURRENCY.SLOT_FREED,
    (job, result) => {
      if (result.promoted) {
        console.info(`[worker] promoted patient ${result.patientId} from the ${result.fromList} waitlist `
          + `(appointment ${result.appointmentId}, doctor ${job.data.doctorId}, ${job.data.appointmentDateTime})`);
      } else {
        console.info(`[worker] slot-freed job ${job.id}: no promotion (${result.reason})`);
      }
    },
  );
  startWorker(
    QUEUE.SEND_CONFIRMATION,
    createConfirmationProcessor({ audit: auditLogger.logStrict }),
    WORKER_CONCURRENCY.SEND_CONFIRMATION,
    (job, result) => console.info(`[notify] ${result.message}`),
  );
  console.info(`[worker] listening on queues ${QUEUE.SLOT_FREED}, ${QUEUE.SEND_CONFIRMATION}`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received, shutting down the worker`);
  clearInterval(sweepTimer);
  // Lets running jobs finish, then stops taking new ones.
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
  await closeQueues(); // the worker produces confirmation jobs too
  await healthModel.closePool();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error(`[worker] could not start: ${err.message}`);
  process.exit(1);
});
