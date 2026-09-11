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
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';

  constructor(entity: string, id?: string) {
    super(id ? `${entity} '${id}' was not found` : `${entity} was not found`);
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';

  /**
   * What the caller has to look at before it can decide.
   *
   * Optional, and carried for the same reason `ValidationError` carries its
   * own: a refusal the client can only re-read as prose is a refusal the client
   * has to guess its way out of. The building census's duplicate guard sends
   * the structures already standing on the parcel here, so the dialog that asks
   * "is this a different building?" can show them without a second request —
   * which matters most on exactly the offline phone least able to make one.
   */
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

/**
 * Raised when a request would cross a municipality boundary. The message is
 * deliberately uninformative — telling a caller whether the other tenant exists
 * is itself a leak.
 */
export class TenantMismatchError extends DomainError {
  readonly code = 'TENANT_MISMATCH';

  constructor() {
    super('Request does not belong to this municipality');
  }
}

/**
 * The tenant resolved, but its schema has not been provisioned yet. Distinct
 * from NotFoundError so an operator sees "you forgot to run provisioning"
 * rather than "that municipality does not exist".
 */
export class TenantNotProvisionedError extends DomainError {
  readonly code = 'TENANT_NOT_PROVISIONED';

  constructor(slug: string) {
    super(`Municipality '${slug}' has not been provisioned`);
  }
}
