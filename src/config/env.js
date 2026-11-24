// Loads .env and checks the database and Redis settings once at start-up, so a
// missing value fails immediately with a clear message. The server and the
// worker import this; the pure utils and the tests don't. The optional
// settings (CLINIC_TIMEZONE, LOG_DIR) live in config/settings.js.
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function toPort(name, fallback) {
  const raw = process.env[name] || fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer (got "${raw}").`);
  }
  return port;
}

const env = Object.freeze({
  port: toPort('PORT', '3000'),
  db: Object.freeze({
    host: process.env.DB_HOST || 'localhost',
    port: toPort('DB_PORT', '3306'),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME'),
  }),
  redis: Object.freeze({
    host: process.env.REDIS_HOST || 'localhost',
    port: toPort('REDIS_PORT', '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  }),
});

module.exports = env;
