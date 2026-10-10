import { ValidationError } from '../../domain/errors/domain-error';

/**
 * The CHECK constraint a write broke, by name, or null.
 *
 * Prisma 5 gives a check violation no code of its own: it arrives as a
 * `PrismaClientUnknownRequestError` whose message carries the Postgres error —
 * SQLSTATE 23514, `violates check constraint "<name>"`, and the whole failing
 * row, phone numbers included. So the name is read out of the message, and a
 * caller maps only the rules it knows how to explain; the row never travels
 * further than this function.
 */
export function violatedCheckConstraint(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /violates check constraint \\?"([A-Za-z0-9_]+)\\?"/.exec(error.message);
  return match ? match[1]! : null;
}

/**
 * The closed day a write was refused for by the 0082 triggers, as `YYYY-MM-DD`,
 * or null when the error is anything else.
 *
 * The triggers raise «treasury day 2026-10-08 is closed: …» — on a ledger entry
 * dated on or before a closed day, or on a closed day's count. The application
 * refuses both itself first; this is for the write that reaches the database
 * anyway (a close committing between the check and the insert), so that it
 * still answers with the day rather than a 500.
 */
export function closedTreasuryDay(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /treasury day (\d{4}-\d{2}-\d{2}) is closed/.exec(error.message);
  return match ? match[1]! : null;
}

/**
 * The two rules migration 0072 keeps on a citizen's numbers, as the refusal a
 * person can read — or null when the error is anything else.
 *
 * No writer the application has can break them: the forms, the import and the
 * merge plan all keep both (`planFields`, `citizenColumnsForEdit`, the shared
 * schemas). This is the backstop for the next writer, so that a rule broken
 * says which rule, rather than a 500 carrying the row to Sentry.
 */
export function citizenPhoneRuleError(error: unknown): ValidationError | null {
  switch (violatedCheckConstraint(error)) {
    case 'users_no_phone_means_no_number':
      return new ValidationError({
        code: 'CITIZEN_NO_PHONE_HAS_NUMBER',
        message: 'A citizen marked as having no phone holds a phone or WhatsApp number of their own',
      });
    case 'users_contact_phone_not_own':
      return new ValidationError({
        code: 'CITIZEN_CONTACT_PHONE_IS_OWN',
        message: "A citizen's contact number equals their own phone",
      });
    default:
      return null;
  }
}
