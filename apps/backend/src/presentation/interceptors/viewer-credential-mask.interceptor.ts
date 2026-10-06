import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { map, type Observable } from 'rxjs';
import { ReferenceNumber } from '../../domain/value-objects/reference-number.vo';

/**
 * The response keys known to carry a citizen's login credential, the رقم
 * مرجعي. Their value is masked whole: one that does not fit the format (an
 * older or hand-typed reference) is hidden entirely rather than shown.
 *
 * `referenceNumber` is also a filing's own number on some rows (a
 * registration's), which is not a credential — masking it too costs the
 * leader nothing and keeps the rule simple.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'referenceNumber',
  'citizenReferenceNumber',
  'citizenReference',
  'landlordReferenceNumber',
]);

/**
 * Replaces every credential in a JSON response body with its masked hint
 * (`ReferenceNumber.mask`), walking plain objects and arrays only — a Date, a
 * Buffer or a stream passes through untouched.
 *
 * Two rules, because a list of keys alone leaks: the payment lists sent the
 * reference as `citizenReference`, which the first version of this list did
 * not name. So the named keys are masked whole, and every other string is
 * masked by the reference's own pattern wherever it appears in it
 * (`ReferenceNumber.maskWithin`) — a key nobody listed, a note, a reason.
 */
export function maskCredentials(value: unknown): unknown {
  if (typeof value === 'string') return ReferenceNumber.maskWithin(value);
  if (Array.isArray(value)) return value.map(maskCredentials);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const masked: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    masked[key] =
      CREDENTIAL_KEYS.has(key) && typeof inner === 'string' ? ReferenceNumber.mask(inner) : maskCredentials(inner);
  }
  return masked;
}

/**
 * «مشاهد فقط» reads citizens and their data, and never a citizen's login
 * credential.
 *
 * The VIEWER is the municipality leader's account (decision, 2026-10-05): it
 * reads the register, the census, cases and reports, and does nothing. A رقم
 * مرجعي is not data about a citizen; it is what signs them in to the portal
 * (docs/security.md), and the leader never hands one to anybody. So every
 * response to a VIEWER token carries the masked hint instead — one rule here,
 * rather than a role check in each of the thirty-odd reads that return one.
 * Every other role is unaffected.
 */
@Injectable()
export class ViewerCredentialMaskInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.user?.kind !== 'STAFF' || request.user.role !== 'VIEWER') return next.handle();
    return next.handle().pipe(map(maskCredentials));
  }
}
