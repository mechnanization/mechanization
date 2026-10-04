import type { ErrorCode, ErrorKind, ErrorParams } from '@mechanization/shared-schemas';

/**
 * Domain errors are framework-free: no NestJS, no HTTP status codes. The
 * presentation layer's DomainExceptionFilter is the single place they become
 * HTTP responses.
 *
 * These live in `domain/` rather than `application/common/exceptions/` (where the
 * spec's tree sketches them) because domain entities throw them — putting the
 * definitions in `application/` would make `domain/` import from `application/`
 * and invert the layer rule the spec states two paragraphs later.
 * `application/common/exceptions/` re-exports everything here, so the documented
 * import path still resolves and the dependency arrow still points inward.
 *
 * ## Codes, not prose
 *
 * A refusal is thrown with a specific `code` from `ERROR_CODES` in
 * `@mechanization/shared-schemas`:
 *
 *     throw new ConflictError({
 *       code: 'PAYMENT_EXCEEDS_BALANCE',
 *       message: `Amount ${credit} exceeds the balance ${outstanding}`,
 *       params: { amount: credit, outstanding },
 *     });
 *
 * The frontend owns the words: it looks the code up in `messages/{ar,en}.json`
 * and fills in `params`. `message` is English, for logs, and never reaches a
 * screen, so it must not carry a name, a phone number or a رقم مرجعي — those go
 * in `params` if the screen needs them.
 *
 * The older form, `new ConflictError('نص عربي', details)`, still compiles: its
 * message is what the screen shows, and its code is the error's kind. It is
 * kept only for the sites not yet converted, and `error-codes.ratchet.spec.ts`
 * fails if their number grows.
 */
export interface DomainErrorInit {
  code: ErrorCode;
  /** English, for logs. Never shown to a user. */
  message: string;
  params?: ErrorParams;
  /** Data the client acts on: the fields that failed, the records it collided with. */
  details?: unknown;
}

export abstract class DomainError extends Error {
  /** What kind of refusal this is; decides the HTTP status. */
  abstract readonly kind: ErrorKind;
  private readonly specificCode?: ErrorCode;
  readonly params?: ErrorParams;
  readonly details?: unknown;

  constructor(messageOrInit: string | DomainErrorInit, details?: unknown) {
    const init = typeof messageOrInit === 'string' ? undefined : messageOrInit;
    super(init ? init.message : (messageOrInit as string));
    this.name = new.target.name;
    this.specificCode = init?.code;
    this.params = init?.params;
    this.details = init ? init.details : details;
  }

  /** The specific code, or the kind for a throw site that has not been given one. */
  get code(): ErrorCode | ErrorKind {
    return this.specificCode ?? this.kind;
  }
}

export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND' as const;

  constructor(entityOrInit: string | DomainErrorInit, id?: string) {
    super(
      typeof entityOrInit === 'string'
        ? id
          ? `${entityOrInit} '${id}' was not found`
          : `${entityOrInit} was not found`
        : entityOrInit,
    );
  }
}

export class ConflictError extends DomainError {
  readonly kind = 'CONFLICT' as const;

  /**
   * `details` is what the caller has to look at before it can decide.
   *
   * Carried for the same reason `ValidationError` carries its own: a refusal
   * the client can only re-read as prose is a refusal the client has to guess
   * its way out of. The building census's duplicate guard sends the structures
   * already standing on the parcel here, so the dialog that asks "is this a
   * different building?" can show them without a second request — which
   * matters most on exactly the offline phone least able to make one.
   */
  constructor(messageOrInit: string | DomainErrorInit, details?: unknown) {
    super(messageOrInit, details);
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'VALIDATION_FAILED' as const;

  constructor(messageOrInit: string | DomainErrorInit, details?: unknown) {
    super(messageOrInit, details);
  }
}

export class UnauthorizedError extends DomainError {
  readonly kind = 'UNAUTHORIZED' as const;

  constructor(messageOrInit: string | DomainErrorInit) {
    super(messageOrInit);
  }
}

export class ForbiddenError extends DomainError {
  readonly kind = 'FORBIDDEN' as const;

  constructor(messageOrInit: string | DomainErrorInit) {
    super(messageOrInit);
  }
}

/**
 * Raised when a request would cross a municipality boundary. The message is
 * deliberately uninformative — telling a caller whether the other tenant exists
 * is itself a leak.
 */
export class TenantMismatchError extends DomainError {
  readonly kind = 'TENANT_MISMATCH' as const;

  constructor() {
    super({ code: 'TENANT_MISMATCH', message: 'Request does not belong to this municipality' });
  }
}

/**
 * The tenant resolved, but its schema has not been provisioned yet. Distinct
 * from NotFoundError so an operator sees "you forgot to run provisioning"
 * rather than "that municipality does not exist".
 */
export class TenantNotProvisionedError extends DomainError {
  readonly kind = 'TENANT_NOT_PROVISIONED' as const;

  constructor(slug: string) {
    super({ code: 'TENANT_NOT_PROVISIONED', message: `Municipality '${slug}' has not been provisioned` });
  }
}
