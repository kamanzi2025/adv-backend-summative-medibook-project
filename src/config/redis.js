// Creates Redis connections for the queues, the worker and the waitlist.
const IORedis = require('ioredis');
const env = require('./env');
const { REDIS_RETRY_STEP_MS, REDIS_RETRY_MAX_MS } = require('./constants');

// For the web server only: if Redis never answers a command (a half-open
// connection, say), give up after 2 seconds instead of leaving the HTTP request hanging.
const SERVER_COMMAND_TIMEOUT_MS = 2000;

/**
 * @param {object} options
 * @param {'server'|'worker'} options.role
 *   server: fail fast. With Redis down, commands fail straight away so a request
 *           never waits on Redis (booking and cancelling still work), and a command
 *           that gets no answer times out after SERVER_COMMAND_TIMEOUT_MS.
 *   worker: BullMQ needs blocking commands that can wait forever
 *           (maxRetriesPerRequest: null), so commands wait for Redis to come back.
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
