/**
 * The application layer's view of the domain error vocabulary.
 *
 * Definitions live in `domain/errors/` (entities throw them, so they must sit at
 * the innermost layer). This re-export exists so application and presentation
 * code can import errors from the path the architecture doc names, without
 * reaching across into `domain/` for something that reads as a cross-cutting
 * concern.
 */
export {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  refusedBy,
  TenantMismatchError,
  TenantNotProvisionedError,
  UnauthorizedError,
  ValidationError,
} from '../../../domain/errors/domain-error';
