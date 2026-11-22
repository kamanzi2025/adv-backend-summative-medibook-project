// Producer side of BullMQ plus the web server's Redis connection (also used by
// the waitlist). Everything is created lazily: requiring this module opens no
// connection, so a server that never touches Redis stays quiet and unit tests
// stay free of Redis.
const { Queue } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_JOB_OPTIONS } = require('../config/constants');

// The first command after start-up may wait this long for the connection to come
// up; afterwards a Redis outage makes commands fail immediately.
const REDIS_READY_TIMEOUT_MS = 1500;
// Completed jobs kept per queue for inspection (failed jobs are always kept).
const COMPLETED_JOBS_KEPT = 1000;

// ioredis connection states in which waiting for 'ready' is pointless: the last
// attempt already failed (or the client was closed), so fail fast instead.
const DOWN_STATES = new Set(['reconnecting', 'close', 'end']);

const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: QUEUE_JOB_OPTIONS.ATTEMPTS,
  backoff: { type: 'exponential', delay: QUEUE_JOB_OPTIONS.BACKOFF_DELAY_MS },
  removeOnComplete: { count: COMPLETED_JOBS_KEPT },
  removeOnFail: false,
});

let connection = null;
const queues = new Map();

/** The shared server-role connection (fail-fast), created on first use. */
function getRedis() {
  if (!connection) connection = createRedisConnection({ role: 'server' });
  return connection;
}

/**
 * Resolves once Redis is usable, rejects fast if it is not. BullMQ's Queue waits
 * for 'ready' without any limit, so this bound is what keeps a request from hanging.
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
    // Connection problems are already reported once by config/redis.js; without a
    // listener an 'error' event would crash the process.
    queue.on('error', () => {});
    queues.set(name, queue);
  }
  return queues.get(name);
}

/**
 * Adds one job. Rejects (fast) if Redis is unavailable; callers decide what that means.
 * @returns {Promise<import('bullmq').Job>}
 */
async function addJob(queueName, data) {
  await whenRedisReady();
  return getQueue(queueName).add(queueName, data);
}

/** Graceful shutdown: closes every producer queue, then the shared connection. */
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

/** Short reason for a log line. */
function redisErrorReason(err) {
  return err.code || err.message;
}

module.exports = { getRedis, whenRedisReady, addJob, closeQueues, redisErrorReason };
