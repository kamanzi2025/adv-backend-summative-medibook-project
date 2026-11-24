// Database checks that don't touch any table.
const { pool } = require('../config/db');

/** Resolves if MySQL answers, rejects if it doesn't. */
async function ping() {
  await pool.query('SELECT 1');
}

/** Closes the pool's connections when the server shuts down. */
async function closePool() {
  await pool.end();
}

module.exports = { ping, closePool };
