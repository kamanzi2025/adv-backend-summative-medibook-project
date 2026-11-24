// Booking helpers: the amount paid, the appt_ref format and day ranges.
const { resolveAmountPaid } = require('../src/utils/payment');
const { generateApptRef } = require('../src/utils/apptRef');
const { dayRange, parseClinicDateTime } = require('../src/utils/clock');

describe('resolveAmountPaid', () => {
  test('defaults to the doctor fee when not sent', () => {
    expect(resolveAmountPaid(undefined, 150)).toEqual({ amount: 150 });
  });

  test('accepts a discount below the fee (AP-002: 120.00 on 150.00)', () => {
    expect(resolveAmountPaid(120, 150)).toEqual({ amount: 120 });
  });

  test('accepts 0 and exactly the fee', () => {
    expect(resolveAmountPaid(0, 150)).toEqual({ amount: 0 });
    expect(resolveAmountPaid(150, 150)).toEqual({ amount: 150 });
  });

  test('rejects more than the fee, even by one cent', () => {
    expect(resolveAmountPaid(150.01, 150)).toEqual({ error: 'EXCEEDS_FEE' });
  });
});

describe('generateApptRef', () => {
  const slot = parseClinicDateTime('2027-03-15 09:00');

  test('matches chk_appt_ref_format: AP-YYYYMMDD-XXXX', () => {
    expect(generateApptRef(slot)).toMatch(/^AP-20270315-[0-9A-Z]{4}$/);
  });

  test('uses the injected random source (deterministic in tests)', () => {
    expect(generateApptRef(slot, () => 10)).toBe('AP-20270315-AAAA');
  });
});

describe('dayRange', () => {
  test('is the half-open range [midnight, next midnight), across a month end', () => {
    expect(dayRange(parseClinicDateTime('2027-03-31 16:30'))).toEqual({
      start: '2027-03-31 00:00:00',
      end: '2027-04-01 00:00:00',
    });
  });
});
