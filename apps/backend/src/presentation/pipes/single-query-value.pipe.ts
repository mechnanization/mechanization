import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ValidationError } from '../../application/common/exceptions';

/**
 * A named query value is one string, or absent — registered globally, so no
 * handler has to defend itself against anything else (task S11 of the
 * 2026-11-14 security audit; docs/security.md, the raw query values row).
 *
 * Express hands a repeated key over as an array (`?search=a&search=b`) and a
 * bracketed one as an object (`?search[x]=1`). A handler typed `string` then
 * called `.toLowerCase()` or `.split()` on it: a 500, a Sentry event, and the
 * URL with its query string in the proxy's log. Refused here instead, as the
 * malformed request it is, before any handler runs.
 *
 * Only a named value (`@Query('search')`): a whole query object
 * (`@Query()`) goes through its own zod schema, which may take arrays on
 * purpose. Every other argument — a body, a path id, the session — passes
 * through untouched.
 */
@Injectable()
export class SingleQueryValuePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'query' || metadata.data === undefined) return value;
    if (value === undefined || typeof value === 'string') return value;
    throw new ValidationError({
      code: 'INVALID_QUERY_VALUE',
      message: `The query value "${String(metadata.data)}" must be given once, as text`,
    });
  }
}
