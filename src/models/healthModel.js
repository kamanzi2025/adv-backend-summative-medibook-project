// Connection-level database operations (no table access).
const { pool } = require('../config/db');

/** Resolves if MySQL answers, rejects otherwise. */
async function ping() {
  await pool.query('SELECT 1');
}

/** Closes every pooled connection (graceful shutdown). */
async function closePool() {
  await pool.end();
}

module.exports = { ping, closePool };
