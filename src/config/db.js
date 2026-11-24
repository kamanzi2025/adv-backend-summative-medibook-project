// One shared MySQL pool. Only the files in src/models/ import it, which keeps all
// the SQL in the models.
const mysql = require('mysql2/promise');
const env = require('./env');
const { DB_CONNECTION_LIMIT } = require('./constants');

const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  // Return DATETIME columns as plain text. They hold clinic wall-clock times, and
  // turning them into JS Dates would shift them by the server's time zone.
  dateStrings: true,
  // Return DECIMAL money columns as numbers instead of strings.
  decimalNumbers: true,
  // We only ever pass datetimes as strings, but I set this so nothing depends on a default.
  timezone: 'Z',
  // Only one statement per query, as an extra guard against injected SQL.
  multipleStatements: false,
});

module.exports = { pool };
