// Single shared mysql2 promise pool. Only files in src/models/ may import this.
const mysql = require('mysql2/promise');
const env = require('./env');
const { DB_CONNECTION_LIMIT } = require('./constants');

const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  // DATETIME / DATE columns come back as plain "YYYY-MM-DD HH:mm:ss" strings.
  // They are clinic wall-clock times, so Node must never shift them by a time zone.
  dateStrings: true,
  // DECIMAL(10,2) money columns come back as JS numbers instead of strings.
  decimalNumbers: true,
  // Never used for app datetimes (we pass strings), set explicitly so nothing is implicit.
  timezone: 'Z',
  // One statement per call: a further guard against stacked-query injection.
  multipleStatements: false,
});

module.exports = { pool };
