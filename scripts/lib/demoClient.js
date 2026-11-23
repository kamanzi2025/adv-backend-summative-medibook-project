// Small HTTP helpers shared by the demo scripts. They talk to the RUNNING API
// (start it first with `npm start`); they never touch the database directly.
require('dotenv').config();

const BASE_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
const DEMO_EMAIL_PREFIX = 'demo.patient.';
const DEMO_EMAIL_DOMAIN = '@medibook.test';
const PAGE_SIZE = 100;

async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(BASE_URL + path, options);
  } catch (err) {
    throw new Error(`Cannot reach ${BASE_URL} (${err.cause ? err.cause.code : err.message}). Start the API first: npm start`);
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Returns `count` patient ids, creating demo patients that don't exist yet. */
async function ensureDemoPatients(count) {
  const existing = new Map();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await api('GET', `/api/patients?limit=${PAGE_SIZE}&offset=${offset}`);
    for (const p of page.body.data) existing.set(p.email, p.id);
    if (offset + PAGE_SIZE >= page.body.meta.total) break;
  }

  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const email = `${DEMO_EMAIL_PREFIX}${String(i).padStart(2, '0')}${DEMO_EMAIL_DOMAIN}`;
    if (existing.has(email)) {
      ids.push(existing.get(email));
    } else {
      const created = await api('POST', '/api/patients', {
        fullName: `Demo Patient ${i}`,
        email,
        phone: `0200-000-${String(i).padStart(3, '0')}`,
      });
      if (created.status !== 201) throw new Error(`Could not create demo patient: ${JSON.stringify(created.body)}`);
      ids.push(created.body.data.id);
    }
  }
  return ids;
}

/** First date on/after `fromDate` where the doctor has no appointments at all. */
async function findEmptyDay(doctorId, fromDate) {
  const date = new Date(`${fromDate}T00:00:00Z`);
  for (;;) {
    const day = date.toISOString().slice(0, 10);
    const result = await api('GET', `/api/doctors/${doctorId}/appointments?date=${day}`);
    if (result.status !== 200) throw new Error(`GET appointments failed: ${JSON.stringify(result.body)}`);
    if (result.body.data.length === 0) return day;
    date.setUTCDate(date.getUTCDate() + 1);
  }
}

async function bookedCount(doctorId, day) {
  const result = await api('GET', `/api/doctors/${doctorId}/appointments?date=${day}`);
  return result.body.meta.booked;
}

function tally(responses) {
  const counts = {};
  for (const r of responses) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

module.exports = { api, ensureDemoPatients, findEmptyDay, bookedCount, tally, BASE_URL };
