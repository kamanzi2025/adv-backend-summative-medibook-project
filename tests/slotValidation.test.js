// Slot validation: parsing the date format (bad format -> 400) and the clinic rules (-> 422).
// Only pure functions, and "now" is always a fixed date, never the real clock.
const { parseClinicDateTime } = require('../src/utils/clock');
const { slotRuleViolations, slotStartTimes } = require('../src/utils/slotRules');

// A clinic Date keeps the clinic's wall-clock time in its UTC fields.
const NOW = new Date(Date.UTC(2027, 2, 10, 8, 0)); // 2027-03-10 08:00 clinic time

function slot(text) {
  const parsed = parseClinicDateTime(text);
  if (!parsed) throw new Error(`test setup: "${text}" did not parse`);
  return parsed;
}

describe('parseClinicDateTime: strict "YYYY-MM-DD HH:mm" format', () => {
  test('accepts a well-formed date/time', () => {
    expect(parseClinicDateTime('2027-03-10 09:00')).toEqual(new Date(Date.UTC(2027, 2, 10, 9, 0)));
  });

  test.each([
    ['seconds are not allowed', '2027-03-10 09:00:00'],
    ['ISO "T" separator', '2027-03-10T09:00'],
    ['missing leading zero', '2027-3-10 9:00'],
    ['trailing time zone', '2027-03-10 09:00Z'],
    ['not a date at all', 'abc'],
    ['empty string', ''],
  ])('rejects malformed input: %s', (_label, text) => {
    expect(parseClinicDateTime(text)).toBeNull();
  });

  test.each([
    ['30 February', '2027-02-30 10:00'],
    ['29 February in a non-leap year', '2027-02-29 10:00'],
    ['month 13', '2027-13-01 10:00'],
    ['hour 24', '2027-03-10 24:00'],
    ['minute 60', '2027-03-10 10:60'],
  ])('rejects an impossible calendar value: %s', (_label, text) => {
    expect(parseClinicDateTime(text)).toBeNull();
  });

  test('accepts 29 February in a leap year', () => {
    expect(parseClinicDateTime('2028-02-29 10:00')).not.toBeNull();
  });

  test('rejects non-strings', () => {
    expect(parseClinicDateTime(20270310)).toBeNull();
    expect(parseClinicDateTime(null)).toBeNull();
  });
});

describe('slotRuleViolations: clinic rules with a fixed now', () => {
  test('09:00 (first slot) is valid', () => {
    expect(slotRuleViolations(slot('2027-03-10 09:00'), NOW)).toEqual([]);
  });

  test('16:30 (last slot) is valid', () => {
    expect(slotRuleViolations(slot('2027-03-10 16:30'), NOW)).toEqual([]);
  });

  test('17:00 is rejected: the last slot starts at 16:30', () => {
    const violations = slotRuleViolations(slot('2027-03-10 17:00'), NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/between 09:00 and 16:30/);
  });

  test('08:30 is rejected: before working hours', () => {
    const violations = slotRuleViolations(slot('2027-03-11 08:30'), NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/between 09:00 and 16:30/);
  });

  test('09:15 is rejected: not on a 30-minute boundary', () => {
    const violations = slotRuleViolations(slot('2027-03-10 09:15'), NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/30-minute slot boundary/);
  });

  test('a past time is rejected', () => {
    const violations = slotRuleViolations(slot('2027-03-09 10:00'), NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/must be in the future/);
  });

  test('exactly now is rejected (must be strictly in the future)', () => {
    const nineAm = slot('2027-03-10 09:00');
    expect(slotRuleViolations(nineAm, nineAm)[0]).toMatch(/must be in the future/);
  });

  test('one minute after now is not "past" (09:00 with now = 08:59)', () => {
    const now = new Date(Date.UTC(2027, 2, 10, 8, 59));
    expect(slotRuleViolations(slot('2027-03-10 09:00'), now)).toEqual([]);
  });

  test('reports EVERY broken rule at once (past + outside hours + off-boundary)', () => {
    expect(slotRuleViolations(slot('2027-03-01 17:45'), NOW)).toHaveLength(3);
  });

  test('a working day has 16 bookable start times, 09:00 to 16:30', () => {
    const times = slotStartTimes();
    expect(times).toHaveLength(16);
    expect(times[0]).toBe('09:00');
    expect(times[times.length - 1]).toBe('16:30');
  });
});
