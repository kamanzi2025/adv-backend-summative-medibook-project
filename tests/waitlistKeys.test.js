const {
  slotKey, dayKey, waitlistKey, processingKey, doctorKeyPattern, processingKeyPattern,
  parseWaitlistKey, describeWaitlist,
} = require('../src/utils/waitlistKeys');
const { buildEntry, parseEntry } = require('../src/utils/waitlistEntry');
const { buildDoctorWaitlistView } = require('../src/utils/waitlistView');

describe('waitlist keys', () => {
  test('slot key uses YYYY-MM-DDTHH:mm, day key YYYY-MM-DD', () => {
    expect(slotKey(2, '2027-05-03 10:00')).toBe('waitlist:doctor:2:slot:2027-05-03T10:00');
    expect(dayKey(2, '2027-05-03')).toBe('waitlist:doctor:2:day:2027-05-03');
    expect(waitlistKey('slot', 2, '2027-05-03 10:00')).toBe('waitlist:doctor:2:slot:2027-05-03T10:00');
    expect(waitlistKey('day', 2, '2027-05-03 10:00')).toBe('waitlist:doctor:2:day:2027-05-03');
  });

  test('processing key adds the suffix; SCAN patterns', () => {
    expect(processingKey('waitlist:doctor:2:day:2027-05-03')).toBe('waitlist:doctor:2:day:2027-05-03:processing');
    expect(doctorKeyPattern(2)).toBe('waitlist:doctor:2:*');
    expect(processingKeyPattern()).toBe('waitlist:doctor:*:processing');
  });

  test('parses slot, day and processing keys back', () => {
    expect(parseWaitlistKey('waitlist:doctor:2:slot:2027-05-03T10:00')).toEqual({
      doctorId: 2, type: 'slot', date: '2027-05-03', appointmentDateTime: '2027-05-03 10:00',
      processing: false, listKey: 'waitlist:doctor:2:slot:2027-05-03T10:00',
    });
    expect(parseWaitlistKey('waitlist:doctor:12:day:2027-05-03:processing')).toEqual({
      doctorId: 12, type: 'day', date: '2027-05-03', appointmentDateTime: null,
      processing: true, listKey: 'waitlist:doctor:12:day:2027-05-03',
    });
  });

  test('rejects keys that are not waitlist lists', () => {
    expect(parseWaitlistKey('waitlist:failed')).toBeNull();
    expect(parseWaitlistKey('waitlist:doctor:2:slot:2027-05-03 10:00')).toBeNull();
    expect(parseWaitlistKey('waitlist:doctor:x:day:2027-05-03')).toBeNull();
    expect(parseWaitlistKey('bull:slot-freed:1')).toBeNull();
  });

  test('readable list name', () => {
    expect(describeWaitlist('waitlist:doctor:2:slot:2027-05-03T10:00'))
      .toBe('slot waitlist of doctor 2 for 2027-05-03 10:00');
    expect(describeWaitlist('waitlist:doctor:2:day:2027-05-03')).toBe('day waitlist of doctor 2 for 2027-05-03');
  });
});

describe('waitlist entries', () => {
  const entry = buildEntry({
    type: 'slot', patientId: 5, doctorId: 2, appointmentDateTime: '2027-05-03 10:00', joinedAt: '2026-11-21T08:00:00.000Z',
  });

  test('round trip', () => {
    expect(entry).toEqual({
      patientId: 5, doctorId: 2, requestedDateTime: '2027-05-03 10:00', type: 'slot', joinedAt: '2026-11-21T08:00:00.000Z',
    });
    expect(parseEntry(JSON.stringify(entry))).toEqual(entry);
  });

  test('unreadable entries are null', () => {
    expect(parseEntry('not json')).toBeNull();
    expect(parseEntry('null')).toBeNull();
    expect(parseEntry(JSON.stringify({ ...entry, patientId: '5' }))).toBeNull();
    expect(parseEntry(JSON.stringify({ ...entry, type: 'week' }))).toBeNull();
  });
});

describe('GET waitlist view', () => {
  const raw = (patientId, type, requestedDateTime, extra = {}) => JSON.stringify({
    patientId, doctorId: 2, requestedDateTime, type, joinedAt: `2026-11-21T08:0${patientId}:00.000Z`, ...extra,
  });

  test('splits slot, day and processing lists, sorts them and filters failed entries by doctor', () => {
    const view = buildDoctorWaitlistView(2, [
      { key: 'waitlist:doctor:2:slot:2027-05-03T11:00', raws: [raw(3, 'slot', '2027-05-03 11:00')] },
      { key: 'waitlist:doctor:2:slot:2027-05-03T10:00', raws: [raw(1, 'slot', '2027-05-03 10:00'), raw(2, 'slot', '2027-05-03 10:00')] },
      { key: 'waitlist:doctor:2:day:2027-05-04', raws: [raw(4, 'day', '2027-05-04 09:00')] },
      { key: 'waitlist:doctor:2:day:2027-05-04:processing', raws: [raw(5, 'day', '2027-05-04 09:30')] },
    ], [
      raw(6, 'slot', '2027-05-03 10:00', { reason: 'patient no longer exists', failedAt: 'x', sourceList: 'k' }),
      JSON.stringify({ patientId: 7, doctorId: 3, requestedDateTime: '2027-05-03 10:00', type: 'slot' }),
    ]);

    expect(view.doctorId).toBe(2);
    expect(view.slotWaitlists.map((l) => l.appointmentDateTime)).toEqual(['2027-05-03 10:00', '2027-05-03 11:00']);
    expect(view.slotWaitlists[0].entries.map((e) => [e.position, e.patientId])).toEqual([[1, 1], [2, 2]]);
    expect(view.dayWaitlists).toEqual([{
      date: '2027-05-04',
      listKey: 'waitlist:doctor:2:day:2027-05-04',
      entries: [{ position: 1, patientId: 4, requestedDateTime: '2027-05-04 09:00', joinedAt: '2026-11-21T08:04:00.000Z' }],
    }]);
    expect(view.processing).toEqual([expect.objectContaining({ patientId: 5, listKey: 'waitlist:doctor:2:day:2027-05-04' })]);
    expect(view.failed).toEqual([expect.objectContaining({ patientId: 6, reason: 'patient no longer exists' })]);
  });
});
