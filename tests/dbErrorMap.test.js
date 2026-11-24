// MySQL error to HTTP status mapping. Uses fake error objects, so no MySQL needed.
const { mapDbError, duplicateKeyName, isRowReferenced } = require('../src/utils/dbErrorMap');
const { HTTP_STATUS } = require('../src/config/constants');

describe('isRowReferenced (deleting a patient/doctor who has appointments)', () => {
  test('ER_ROW_IS_REFERENCED_2 (privileged user, constraint name included) -> true', () => {
    expect(isRowReferenced({
      code: 'ER_ROW_IS_REFERENCED_2',
      sqlMessage: 'Cannot delete or update a parent row: a foreign key constraint fails (`medibook`.`appointments`, CONSTRAINT `fk_appt_patient` ...)',
    })).toBe(true);
  });

  test('ER_ROW_IS_REFERENCED (1217: least-privilege medibook_user, no constraint name) -> true', () => {
    expect(isRowReferenced({
      code: 'ER_ROW_IS_REFERENCED',
      sqlMessage: 'Cannot delete or update a parent row: a foreign key constraint fails',
    })).toBe(true);
  });

  test('other errors and missing errors -> false', () => {
    expect(isRowReferenced({ code: 'ER_DUP_ENTRY' })).toBe(false);
    expect(isRowReferenced(null)).toBe(false);
  });
});

describe('mapDbError', () => {
  test('duplicate email -> 409 with the field', () => {
    const err = { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry 'a@b.co' for key 'patients.uq_patient_email'" };
    expect(duplicateKeyName(err)).toBe('uq_patient_email');
    expect(mapDbError(err)).toEqual({
      status: HTTP_STATUS.CONFLICT,
      message: 'A patient with this email already exists',
      details: [{ field: 'email', message: 'A patient with this email already exists' }],
    });
  });

  test('a referenced row (either error code) -> 409', () => {
    expect(mapDbError({ code: 'ER_ROW_IS_REFERENCED' }).status).toBe(HTTP_STATUS.CONFLICT);
    expect(mapDbError({ code: 'ER_ROW_IS_REFERENCED_2' }).status).toBe(HTTP_STATUS.CONFLICT);
  });

  test('database unreachable or busy -> 503', () => {
    expect(mapDbError({ code: 'ECONNREFUSED' }).status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(mapDbError({ code: 'ER_LOCK_DEADLOCK' }).status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
  });

  test('a CHECK violation -> 400 naming the rule', () => {
    const err = { code: 'ER_CHECK_CONSTRAINT_VIOLATED', sqlMessage: "Check constraint 'chk_doctor_fee_positive' is violated." };
    expect(mapDbError(err)).toEqual({
      status: HTTP_STATUS.BAD_REQUEST, message: 'A value breaks the database rule chk_doctor_fee_positive',
    });
  });

  test('anything unknown -> null (the error handler answers 500)', () => {
    expect(mapDbError(new Error('boom'))).toBeNull();
    expect(mapDbError({ code: 'ER_SOMETHING_ELSE' })).toBeNull();
  });
});
