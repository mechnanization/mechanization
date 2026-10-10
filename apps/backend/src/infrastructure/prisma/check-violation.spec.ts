import { citizenPhoneRuleError, closedTreasuryDay, violatedCheckConstraint } from './check-violation';

/*
  The shape Prisma 5 really sends for a CHECK violation, read off a throwaway
  Postgres 17: an unknown-request error with no code, the constraint named
  inside the driver message, and the failing row — phone included — after it.
*/
function prismaCheckError(constraint: string): Error {
  const error = new Error(
    'Invalid `prisma.user.update()` invocation:\n\n\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", ' +
      `message: "new row for relation \\"users\\" violates check constraint \\"${constraint}\\"", severity: "ERROR", ` +
      'detail: Some("Failing row contains (c1, CITIZEN, p, +96170000000, t)."), column: None, hint: None }), transient: false })',
  );
  error.name = 'PrismaClientUnknownRequestError';
  return error;
}

describe('violatedCheckConstraint', () => {
  it('names the constraint a write broke', () => {
    expect(violatedCheckConstraint(prismaCheckError('users_no_phone_means_no_number'))).toBe('users_no_phone_means_no_number');
  });

  it('says nothing for any other failure', () => {
    expect(violatedCheckConstraint(new Error('connection reset'))).toBeNull();
    expect(violatedCheckConstraint('not an error')).toBeNull();
  });
});

describe('citizenPhoneRuleError', () => {
  it('turns each of 0072’s rules into its own coded refusal, carrying none of the row', () => {
    const noPhone = citizenPhoneRuleError(prismaCheckError('users_no_phone_means_no_number'));
    const ownContact = citizenPhoneRuleError(prismaCheckError('users_contact_phone_not_own'));
    expect(noPhone?.code).toBe('CITIZEN_NO_PHONE_HAS_NUMBER');
    expect(ownContact?.code).toBe('CITIZEN_CONTACT_PHONE_IS_OWN');
    expect(noPhone?.message).not.toMatch(/\+961|Failing row/);
  });

  it('leaves every other constraint to its own handler', () => {
    expect(citizenPhoneRuleError(prismaCheckError('users_household_counts'))).toBeNull();
    expect(citizenPhoneRuleError(new Error('boom'))).toBeNull();
  });
});

/*
  What Prisma 5 sends when the 0082 trigger refuses an entry dated on a closed
  day, read off a throwaway Postgres 17 by day-closing.integration.spec.ts.
*/
function closedDayError(day: string): Error {
  const error = new Error(
    'Invalid `.create()` invocation:\n\n\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", ' +
      `message: "treasury day ${day} is closed: no entry may be written on or before a closed day", severity: "ERROR", ` +
      'detail: None, column: None, hint: None }), transient: false })',
  );
  error.name = 'PrismaClientUnknownRequestError';
  return error;
}

describe('closedTreasuryDay', () => {
  it('reads back the day a 0082 trigger refused', () => {
    expect(closedTreasuryDay(closedDayError('2026-10-04'))).toBe('2026-10-04');
  });

  it('says nothing for a CHECK violation or any other failure', () => {
    expect(closedTreasuryDay(prismaCheckError('treasury_counts_variance_explained'))).toBeNull();
    expect(closedTreasuryDay(new Error('connection reset'))).toBeNull();
    expect(closedTreasuryDay(undefined)).toBeNull();
  });
});
