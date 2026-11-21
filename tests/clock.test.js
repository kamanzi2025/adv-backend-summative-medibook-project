const { clinicNow, toSqlDateTime, toSqlDate } = require('../src/utils/clock');

const ZONE = 'Africa/Johannesburg'; // UTC+2, no daylight saving

describe('clinicNow', () => {
  test('converts a real instant to clinic wall-clock time', () => {
    const now = clinicNow(new Date('2027-03-10T07:00:00Z'), ZONE);
    expect(toSqlDateTime(now)).toBe('2027-03-10 09:00:00');
  });

  test('rolls the clinic date forward when UTC is still on the previous day', () => {
    const now = clinicNow(new Date('2027-03-09T23:30:00Z'), ZONE);
    expect(toSqlDateTime(now)).toBe('2027-03-10 01:30:00');
    expect(toSqlDate(now)).toBe('2027-03-10');
  });
});
