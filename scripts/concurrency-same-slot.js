// Demo 1: 20 different patients try to book the same doctor slot at the same moment.
// Exactly one should get 201 Created and the other nineteen 409 Conflict.
// Start the API first (npm start), then run: npm run demo:same-slot
const { api, ensureDemoPatients, findEmptyDay, bookedCount, tally, BASE_URL } = require('./lib/demoClient');

const DOCTOR_ID = 2;
const START_SEARCH = '2027-06-01';
const SLOT_TIME = '10:00';
const PARALLEL_REQUESTS = 20;

(async () => {
  console.info(`API: ${BASE_URL}`);
  const patients = await ensureDemoPatients(PARALLEL_REQUESTS);
  const day = await findEmptyDay(DOCTOR_ID, START_SEARCH);
  const slot = `${day} ${SLOT_TIME}`;
  console.info(`Firing ${PARALLEL_REQUESTS} simultaneous bookings for doctor ${DOCTOR_ID} at ${slot} ...`);

  const responses = await Promise.all(
    patients.map((patientId) => api('POST', '/api/appointments', {
      patientId, doctorId: DOCTOR_ID, appointmentDateTime: slot,
    })),
  );

  const counts = tally(responses);
  const winner = responses.find((r) => r.status === 201);
  const conflict = responses.find((r) => r.status === 409);
  console.info('Status codes:', counts);
  if (winner) console.info(`Winner: patient ${winner.body.data.patientId}, ${winner.body.data.apptRef}`);
  if (conflict) console.info(`A 409 said: "${conflict.body.error.message}" (waitlistType: ${conflict.body.error.waitlistType})`);

  const booked = await bookedCount(DOCTOR_ID, day);
  console.info(`BOOKED rows for doctor ${DOCTOR_ID} on ${day}: ${booked}`);

  const pass = counts[201] === 1 && counts[409] === PARALLEL_REQUESTS - 1 && booked === 1;
  console.info(pass ? 'PASS: exactly one booking won the slot' : 'FAIL: unexpected result');
  process.exitCode = pass ? 0 : 1;
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
