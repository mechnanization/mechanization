import { ArgumentMetadata, Injectable, ParseUUIDPipe } from '@nestjs/common';

/**
 * `ParseUUIDPipe`, returning the id in the one spelling the database returns
 * it in: lower case.
 *
 * Nest's pipe validates a UUID and passes it on as typed. Postgres reads an
 * upper-cased UUID as the same row, but every string comparison and every
 * lock key downstream does not: an upper-cased own id passed the staff
 * self-guards (a manager could demote, deactivate or delete himself), and an
 * upper-cased inspector id took a second advisory lock and spent one balance
 * twice (docs/security.md, the self-guard row; task S11 of the 2026-11-14
 * security audit, N-7). Canonical at the edge, a handler and the service
 * behind it only ever see one spelling.
 *
 * Every id a route takes from its path goes through it, as the class
 * (`@Param('id', UuidPipe)`), and an optional id from a query string as an
 * instance (`new UuidPipe({ optional: true })`). `route-inventory.spec.ts`
 * fails on any path id that does not.
 */
@Injectable()
export class UuidPipe extends ParseUUIDPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    const valid = await super.transform(value, metadata);
    // An optional id that was not sent comes back as it arrived: nothing to fold.
    return typeof valid === 'string' ? valid.toLowerCase() : valid;
  }
}
