// Factory for ioredis connections (BullMQ queues, worker, waitlist).
const IORedis = require('ioredis');
const env = require('./env');
const { REDIS_RETRY_STEP_MS, REDIS_RETRY_MAX_MS } = require('./constants');

// Server role only: a command that gets no answer at all (e.g. a half-open TCP
// connection) is rejected after this long, so it can never hold an HTTP request.
const SERVER_COMMAND_TIMEOUT_MS = 2000;

/**
 * @param {object} options
 * @param {'server'|'worker'} options.role
 *   server: fail fast. If Redis is down, commands reject immediately so an HTTP
 *           request never hangs waiting for Redis (booking/cancelling still succeed),
 *           and an unanswered command times out after SERVER_COMMAND_TIMEOUT_MS.
 *   worker: BullMQ workers need blocking commands that wait forever
 *           (maxRetriesPerRequest must be null); commands wait for a reconnect.
 */
function createRedisConnection({ role }) {
  const isWorker = role === 'worker';
  const connection = new IORedis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    maxRetriesPerRequest: isWorker ? null : 1,
    enableOfflineQueue: isWorker,
    ...(isWorker ? {} : { commandTimeout: SERVER_COMMAND_TIMEOUT_MS }),
    retryStrategy: (attempt) => Math.min(attempt * REDIS_RETRY_STEP_MS, REDIS_RETRY_MAX_MS),
  });

  let warnedDown = false;
  connection.on('error', (err) => {
    if (!warnedDown) {
      console.warn(`[redis:${role}] unavailable (${err.code || err.message}). Retrying in the background.`);
      warnedDown = true;
    }
  });
  connection.on('ready', () => {
    if (warnedDown) console.info(`[redis:${role}] reconnected`);
    warnedDown = false;
  });

  return connection;
}

module.exports = { createRedisConnection };
