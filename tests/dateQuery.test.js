// parseDateQuery: the shared ?date= / ?from= validator. Pure, no MySQL/Redis.
const { parseDateQuery } = require('../src/validators/common');
const { parseClinicDate, toSqlDate } = require('../src/utils/clock');
const AppError = require('../src/utils/AppError');

const TODAY = parseClinicDate('2026-11-21');

function expectBadDate(raw, field) {
  let caught;
  try {
    parseDateQuery(raw, TODAY, field);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught.status).toBe(400);
  expect(caught.message).toBe(`Invalid query: check ${field}`);
  expect(caught.details).toEqual([expect.objectContaining({ field })]);
}

describe('parseDateQuery (?from= for statistics, ?date= for a doctor\'s day)', () => {
  test('defaults to today when the parameter is not sent', () => {
    expect(parseDateQuery(undefined, TODAY, 'from')).toBe(TODAY);
  });

  test('accepts a real YYYY-MM-DD date', () => {
    expect(toSqlDate(parseDateQuery('2027-03-15', TODAY, 'from'))).toBe('2027-03-15');
  });

  test('accepts 29 February in a leap year', () => {
    expect(toSqlDate(parseDateQuery('2028-02-29', TODAY, 'date'))).toBe('2028-02-29');
  });

  test.each([
    ['missing zero padding', '2027-3-1'],
    ['impossible date', '2027-02-30'],
    ['29 February in a non-leap year', '2027-02-29'],
    ['a date-time instead of a date', '2027-03-15 09:00'],
    ['an empty string', ''],
    ['text', 'today'],
  ])('rejects %s with 400', (_label, raw) => {
    expectBadDate(raw, 'from');
  });

  test('rejects an array (?from=a&from=b) with 400', () => {
    expectBadDate(['2027-03-15', '2027-03-16'], 'from');
  });

  test('names the parameter it was given in the error', () => {
    expectBadDate('2027-02-30', 'date');
  });
});
