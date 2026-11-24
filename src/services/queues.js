// The BullMQ queues the web server adds jobs to, plus its Redis connection, which
// the waitlist uses too. Nothing connects until it's first used, so requiring this
// file opens no connection and the unit tests never need Redis.
const { Queue } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_JOB_OPTIONS } = require('../config/constants');

// The first command after start-up can wait this long for Redis to connect.
// After that, if Redis goes down, commands fail straight away.
const REDIS_READY_TIMEOUT_MS = 1500;
// How many finished jobs to keep per queue for checking. Failed jobs are always kept.
const COMPLETED_JOBS_KEPT = 1000;

// Connection states where waiting for 'ready' is pointless because the last
// attempt already failed or the client was closed. We fail fast instead.
const DOWN_STATES = new Set(['reconnecting', 'close', 'end']);

const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: QUEUE_JOB_OPTIONS.ATTEMPTS,
  backoff: { type: 'exponential', delay: QUEUE_JOB_OPTIONS.BACKOFF_DELAY_MS },
  removeOnComplete: { count: COMPLETED_JOBS_KEPT },
  removeOnFail: false,
});

let connection = null;
const queues = new Map();

/** The web server's shared Redis connection (fails fast), created the first time it's needed. */
function getRedis() {
  if (!connection) connection = createRedisConnection({ role: 'server' });
  return connection;
}

/**
 * Resolves once Redis can be used and rejects quickly if it can't. BullMQ's Queue
 * would wait for 'ready' forever, so this time limit is what stops a request hanging.
 */
function whenRedisReady() {
  const redis = getRedis();
  if (redis.status === 'ready') return Promise.resolve(redis);
  if (DOWN_STATES.has(redis.status)) {
    return Promise.reject(new Error(`Redis is not reachable (connection ${redis.status})`));
  }
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(redis);
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`Redis did not answer within ${REDIS_READY_TIMEOUT_MS} ms`));
    }, REDIS_READY_TIMEOUT_MS);
    redis.once('ready', onReady);
  });
}

function getQueue(name) {
  if (!queues.has(name)) {
    const queue = new Queue(name, { connection: getRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    // config/redis.js already reports connection problems once. The empty listener is
    // still needed, because an 'error' event with no listener crashes the process.
    queue.on('error', () => {});
    queues.set(name, queue);
  }
  return queues.get(name);
}

/**
 * Adds one job. Rejects quickly if Redis is unavailable; the caller decides what that means.
 * @returns {Promise<import('bullmq').Job>}
 */
async function addJob(queueName, data) {
  await whenRedisReady();
  return getQueue(queueName).add(queueName, data);
}

/** On shutdown: close every queue, then the shared connection. */
async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  if (connection) {
    const closing = connection;
    connection = null;
    try {
      await closing.quit();
    } catch {
      closing.disconnect();
    }
  }
}

/** A short reason to put in a log line. */
function redisErrorReason(err) {
  return err.code || err.message;
}

module.exports = { getRedis, whenRedisReady, addJob, closeQueues, redisErrorReason };
