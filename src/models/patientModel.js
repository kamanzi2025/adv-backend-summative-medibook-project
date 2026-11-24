// All the SQL for the patients table. Every value goes in through a ? placeholder.
// Column names are snake_case in MySQL and camelCase in the API; the mapping happens here.
const { pool } = require('../config/db');
const { REMOVE_OUTCOME } = require('../config/constants');
const { isRowReferenced } = require('../utils/dbErrorMap');

function toPatient(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
  };
}

/** @returns {Promise<{items: object[], total: number}>} */
async function findAll({ limit, offset }) {
  // LIMIT and OFFSET are sent as strings because MySQL 8 rejects a JS number
  // (sent as a DOUBLE) for a LIMIT placeholder in a prepared statement.
  const [rows] = await pool.execute(
    'SELECT id, full_name, email, phone FROM patients ORDER BY id LIMIT ? OFFSET ?',
    [String(limit), String(offset)],
  );
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM patients');
  return { items: rows.map(toPatient), total };
}

/** @returns {Promise<object|null>} */
async function findById(id) {
  const [rows] = await pool.execute(
    'SELECT id, full_name, email, phone FROM patients WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? toPatient(rows[0]) : null;
}

/** @returns {Promise<object>} the stored patient */
async function create({ fullName, email, phone }) {
  const [result] = await pool.execute(
    'INSERT INTO patients (full_name, email, phone) VALUES (?, ?, ?)',
    [fullName, email, phone],
  );
  return findById(result.insertId);
}

/**
 * Partial update in one fixed statement. A field that wasn't sent is passed as NULL
 * and COALESCE keeps the current value. Every column is NOT NULL, so NULL can never
 * be a real new value. This avoids building SQL from strings, and there's no
 * separate read-then-write for another request to slip in between.
 * @returns {Promise<object|null>} the updated patient, or null if the id doesn't exist
 */
async function update(id, { fullName, email, phone }) {
  const [result] = await pool.execute(
    `UPDATE patients
        SET full_name = COALESCE(?, full_name),
            email     = COALESCE(?, email),
            phone     = COALESCE(?, phone)
      WHERE id = ?`,
    [fullName ?? null, email ?? null, phone ?? null, id],
  );
  // mysql2 sets CLIENT_FOUND_ROWS, so affectedRows counts matched rows, even when nothing changed.
  return result.affectedRows > 0 ? findById(id) : null;
}

/**
 * fk_appt_patient is ON DELETE RESTRICT, so MySQL won't delete a patient who has
 * appointments, even cancelled ones. That comes back as HAS_APPOINTMENTS.
 * @returns {Promise<string>} a REMOVE_OUTCOME value
 */
async function remove(id) {
  try {
    const [result] = await pool.execute('DELETE FROM patients WHERE id = ?', [id]);
    return result.affectedRows > 0 ? REMOVE_OUTCOME.DELETED : REMOVE_OUTCOME.NOT_FOUND;
  } catch (err) {
    if (isRowReferenced(err)) return REMOVE_OUTCOME.HAS_APPOINTMENTS;
    throw err;
  }
}

module.exports = { findAll, findById, create, update, remove };
