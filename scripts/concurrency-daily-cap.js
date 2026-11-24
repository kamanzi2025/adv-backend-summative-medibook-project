// Demo 2: the doctor has room for 2 more bookings that day, and 6 requests for
// 6 different free slots arrive at once. Only 2 should get a 201, the other 4 get
// 409 "day full", and the day must end on exactly DAILY_CAP (12) bookings.
// Start the API first (npm start), then run: npm run demo:daily-cap
const { api, ensureDemoPatients, findEmptyDay, bookedCount, tally, BASE_URL } = require('./lib/demoClient');
const { DAILY_CAP } = require('../src/config/constants');
const { slotStartTimes } = require('../src/utils/slotRules');

const DOCTOR_ID = 2;
const START_SEARCH = '2027-07-01';
const ROOM_LEFT = 2;

(async () => {
  console.info(`API: ${BASE_URL}`);
  const times = slotStartTimes(); // 16 start times, 09:00 to 16:30
  const prefill = DAILY_CAP - ROOM_LEFT;
  const patients = await ensureDemoPatients(times.length);
  const day = await findEmptyDay(DOCTOR_ID, START_SEARCH);

  console.info(`Pre-filling doctor ${DOCTOR_ID} on ${day} with ${prefill} bookings (one at a time) ...`);
  for (let i = 0; i < prefill; i += 1) {
    const r = await api('POST', '/api/appointments', {
      patientId: patients[i], doctorId: DOCTOR_ID, appointmentDateTime: `${day} ${times[i]}`,
    });
    if (r.status !== 201) throw new Error(`Pre-fill failed at ${times[i]}: ${JSON.stringify(r.body)}`);
  }
  console.info(`Booked now: ${await bookedCount(DOCTOR_ID, day)} of ${DAILY_CAP}`);

  const freeTimes = times.slice(prefill);
  console.info(`Firing ${freeTimes.length} simultaneous bookings for DIFFERENT free slots: ${freeTimes.join(', ')} ...`);
  const responses = await Promise.all(
    freeTimes.map((time, i) => api('POST', '/api/appointments', {
      patientId: patients[prefill + i], doctorId: DOCTOR_ID, appointmentDateTime: `${day} ${time}`,
    })),
  );

  const counts = tally(responses);
  console.info('Status codes:', counts);
  responses.forEach((r, i) => {
    const note = r.status === 201 ? r.body.data.apptRef : `${r.body.error.message} (waitlistType: ${r.body.error.waitlistType})`;
    console.info(`  ${freeTimes[i]} -> ${r.status} ${note}`);
  });

  const booked = await bookedCount(DOCTOR_ID, day);
  console.info(`BOOKED rows for doctor ${DOCTOR_ID} on ${day}: ${booked} (cap ${DAILY_CAP})`);

  const pass = counts[201] === ROOM_LEFT && booked === DAILY_CAP;
  console.info(pass ? `PASS: the day stopped at exactly ${DAILY_CAP}` : 'FAIL: unexpected result');
  process.exitCode = pass ? 0 : 1;
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
