// Refund policy: > 48h -> 100%, 24h..48h inclusive -> 50%, < 24h -> 0%.
// Pure function only, no MySQL/Redis. "now" is FIXED, never the real clock.
const { calculateRefund, refundPercentFor } = require('../src/utils/refund');

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// Clinic Date convention: UTC fields hold clinic wall-clock time.
const NOW = new Date(Date.UTC(2027, 2, 10, 9, 0)); // 2027-03-10 09:00 clinic time

function appointmentIn(hours, minutes = 0) {
  return new Date(NOW.getTime() + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE);
}

describe('calculateRefund: notice tiers', () => {
  test('72h notice (more than 48h) -> 100%, the full amount', () => {
    expect(calculateRefund(150, appointmentIn(72), NOW)).toEqual({ percent: 100, amount: 150, hoursNotice: 72 });
  });

  test('48h + 1 minute notice (just over 48h) -> 100%', () => {
    expect(calculateRefund(150, appointmentIn(48, 1), NOW).percent).toBe(100);
  });

  test('exactly 48h notice -> 50% (48h is inside the 24-48h band)', () => {
    expect(calculateRefund(150, appointmentIn(48), NOW)).toEqual({ percent: 50, amount: 75, hoursNotice: 48 });
  });

  test('36h notice -> 50%', () => {
    expect(calculateRefund(150, appointmentIn(36), NOW).percent).toBe(50);
  });

  test('exactly 24h notice -> 50% (24h is inside the 24-48h band)', () => {
    expect(calculateRefund(150, appointmentIn(24), NOW)).toEqual({ percent: 50, amount: 75, hoursNotice: 24 });
  });

  test('23h59m notice (less than 24h) -> 0%', () => {
    expect(calculateRefund(150, appointmentIn(23, 59), NOW)).toEqual({ percent: 0, amount: 0, hoursNotice: 23.98 });
  });

  test('0h notice (appointment time == now) -> 0%', () => {
    expect(calculateRefund(150, NOW, NOW)).toEqual({ percent: 0, amount: 0, hoursNotice: 0 });
  });

  test('appointment in the past (negative notice) -> 0%', () => {
    expect(calculateRefund(150, appointmentIn(-3), NOW)).toEqual({ percent: 0, amount: 0, hoursNotice: -3 });
  });

  test('works across a month boundary with parsed clinic dates', () => {
    const now = new Date(Date.UTC(2027, 1, 27, 10, 0)); // 2027-02-27 10:00
    const appt = new Date(Date.UTC(2027, 2, 1, 10, 0)); // 2027-03-01 10:00 = 48h later
    expect(calculateRefund(100, appt, now).percent).toBe(50);
  });
});

describe('refundPercentFor: boundaries on exact milliseconds', () => {
  test('1 ms above 48h -> 100%', () => {
    expect(refundPercentFor(48 * MS_PER_HOUR + 1)).toBe(100);
  });

  test('1 ms below 24h -> 0%', () => {
    expect(refundPercentFor(24 * MS_PER_HOUR - 1)).toBe(0);
  });
});

describe('calculateRefund: amounts in integer cents, matching MySQL ROUND(x, 2)', () => {
  test.each([
    // amountPaid, expected 50% refund, reason
    [99.99, 50, '9999 cents * 50% = 4999.5 -> 5000 (half rounds up, like MySQL ROUND)'],
    [150, 75, '15000 cents * 50% = 7500'],
    [120.01, 60.01, '12001 cents * 50% = 6000.5 -> 6001'],
    [0.01, 0.01, '1 cent * 50% = 0.5 -> 1'],
    [0.1, 0.05, '10 cents * 50% = 5 (no 0.1 floating-point noise)'],
  ])('%p at 50% -> %p (%s)', (amountPaid, expected) => {
    expect(calculateRefund(amountPaid, appointmentIn(36), NOW).amount).toBe(expected);
  });

  test('the full refund returns exactly what was paid', () => {
    expect(calculateRefund(99.99, appointmentIn(72), NOW).amount).toBe(99.99);
  });

  test('a free appointment (amount 0) refunds 0 at every tier', () => {
    expect(calculateRefund(0, appointmentIn(72), NOW)).toEqual({ percent: 100, amount: 0, hoursNotice: 72 });
    expect(calculateRefund(0, appointmentIn(36), NOW).amount).toBe(0);
    expect(calculateRefund(0, appointmentIn(1), NOW).amount).toBe(0);
  });
});

describe('calculateRefund: hoursNotice', () => {
  test('is rounded to 2 decimals for display (36h 20m -> 36.33)', () => {
    expect(calculateRefund(150, appointmentIn(36, 20), NOW).hoursNotice).toBe(36.33);
  });

  test('rounding for display never changes the tier (47h59m59s stays 50%)', () => {
    const appt = new Date(appointmentIn(48).getTime() - 1000);
    const result = calculateRefund(150, appt, NOW);
    expect(result.hoursNotice).toBe(48);
    expect(result.percent).toBe(50);
  });
});
