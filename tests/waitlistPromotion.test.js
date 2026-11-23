const {
  PROMOTION, classifyPromotionResult, promotionFailureReason, sweepSlotFor,
} = require('../src/utils/waitlistPromotion');
const { parseWaitlistKey } = require('../src/utils/waitlistKeys');
const { parseClinicDateTime } = require('../src/utils/clock');
const { BOOKING_OUTCOME, DAILY_CAP } = require('../src/config/constants');

describe('classifyPromotionResult', () => {
  test.each([
    [BOOKING_OUTCOME.BOOKED, PROMOTION.BOOKED],
    [BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED, PROMOTION.PERMANENT],
    [BOOKING_OUTCOME.PATIENT_NOT_FOUND, PROMOTION.PERMANENT],
    [BOOKING_OUTCOME.DOCTOR_NOT_FOUND, PROMOTION.PERMANENT],
    [BOOKING_OUTCOME.AMOUNT_EXCEEDS_FEE, PROMOTION.PERMANENT],
    [BOOKING_OUTCOME.SLOT_TAKEN, PROMOTION.SLOT_GONE],
    [BOOKING_OUTCOME.DAY_FULL, PROMOTION.SLOT_GONE],
    ['SOMETHING_NEW', PROMOTION.TRANSIENT],
  ])('outcome %s -> %s', (outcome, expected) => {
    expect(classifyPromotionResult({ outcome })).toBe(expected);
  });

  test('thrown database errors are transient', () => {
    expect(classifyPromotionResult({ code: 'ECONNREFUSED' })).toBe(PROMOTION.TRANSIENT);
    expect(classifyPromotionResult(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })))
      .toBe(PROMOTION.TRANSIENT);
    expect(classifyPromotionResult(undefined)).toBe(PROMOTION.TRANSIENT);
  });

  test('readable reasons', () => {
    expect(promotionFailureReason({ outcome: BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED }))
      .toBe('patient already has another appointment at that time');
    expect(promotionFailureReason({ code: 'ECONNREFUSED' })).toBe('temporary error: ECONNREFUSED');
  });
});

describe('sweepSlotFor (waitlist sweep)', () => {
  const now = parseClinicDateTime('2027-05-01 12:00');
  const booked = (time) => ({ appointmentDateTime: `2027-05-03 ${time}`, status: 'BOOKED' });
  const slotList = parseWaitlistKey('waitlist:doctor:2:slot:2027-05-03T10:00');
  const dayList = parseWaitlistKey('waitlist:doctor:2:day:2027-05-03');

  test('slot list: the slot is free -> sweep it; booked -> nothing', () => {
    expect(sweepSlotFor(slotList, [booked('09:00')], now)).toBe('2027-05-03 10:00');
    expect(sweepSlotFor(slotList, [{ ...booked('10:00'), status: 'CANCELLED' }], now)).toBe('2027-05-03 10:00');
    expect(sweepSlotFor(slotList, [booked('10:00')], now)).toBeNull();
  });

  test('slot list in the past -> nothing', () => {
    expect(sweepSlotFor(slotList, [], parseClinicDateTime('2027-05-04 09:00'))).toBeNull();
  });

  test('day list: first free slot if the day is under the cap', () => {
    expect(sweepSlotFor(dayList, [booked('09:00'), booked('09:30')], now)).toBe('2027-05-03 10:00');
    const full = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30']
      .slice(0, DAILY_CAP).map(booked);
    expect(sweepSlotFor(dayList, full, now)).toBeNull();
  });
});
