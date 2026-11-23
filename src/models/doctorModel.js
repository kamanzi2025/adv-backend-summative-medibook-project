// All SQL for the doctors table. Every value is a ? placeholder.
// Rows are mapped from snake_case columns to camelCase API objects here.
const { pool } = require('../config/db');
const { REMOVE_OUTCOME } = require('../config/constants');
const { isRowReferenced } = require('../utils/dbErrorMap');

function toDoctor(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    specialty: row.specialty,
    consultationFee: row.consultation_fee,
    room: row.room,
  };
}

/** @returns {Promise<{items: object[], total: number}>} */
async function findAll({ limit, offset }) {
  // LIMIT/OFFSET as strings: see patientModel.findAll.
  const [rows] = await pool.execute(
    `SELECT id, full_name, specialty, consultation_fee, room
       FROM doctors ORDER BY id LIMIT ? OFFSET ?`,
    [String(limit), String(offset)],
  );
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM doctors');
  return { items: rows.map(toDoctor), total };
}

/** @returns {Promise<object|null>} */
async function findById(id) {
  const [rows] = await pool.execute(
    'SELECT id, full_name, specialty, consultation_fee, room FROM doctors WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? toDoctor(rows[0]) : null;
}

/** @returns {Promise<object>} the stored doctor */
async function create({ fullName, specialty, consultationFee, room }) {
  const [result] = await pool.execute(
    'INSERT INTO doctors (full_name, specialty, consultation_fee, room) VALUES (?, ?, ?, ?)',
    [fullName, specialty, consultationFee, room],
  );
  return findById(result.insertId);
}

/**
 * Partial update in one fixed statement (COALESCE keeps fields that weren't sent).
 * @returns {Promise<object|null>} null if the id doesn't exist
 */
async function update(id, { fullName, specialty, consultationFee, room }) {
  const [result] = await pool.execute(
    `UPDATE doctors
        SET full_name        = COALESCE(?, full_name),
            specialty        = COALESCE(?, specialty),
            consultation_fee = COALESCE(?, consultation_fee),
            room             = COALESCE(?, room)
      WHERE id = ?`,
    [fullName ?? null, specialty ?? null, consultationFee ?? null, room ?? null, id],
  );
  return result.affectedRows > 0 ? findById(id) : null;
}

/**
 * fk_appt_doctor is ON DELETE RESTRICT, so MySQL refuses to delete a doctor who
 * has appointments (cancelled ones included); that is reported as HAS_APPOINTMENTS.
 * @returns {Promise<string>} a REMOVE_OUTCOME value
 */
async function remove(id) {
  try {
    const [result] = await pool.execute('DELETE FROM doctors WHERE id = ?', [id]);
    return result.affectedRows > 0 ? REMOVE_OUTCOME.DELETED : REMOVE_OUTCOME.NOT_FOUND;
  } catch (err) {
    if (isRowReferenced(err)) return REMOVE_OUTCOME.HAS_APPOINTMENTS;
    throw err;
  }
}

module.exports = { findAll, findById, create, update, remove };
