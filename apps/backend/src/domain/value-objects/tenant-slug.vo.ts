import {
  TENANT_SLUG_MAX_LENGTH,
  TENANT_SLUG_MIN_LENGTH,
  TENANT_SLUG_PATTERN,
  isTenantSlug,
  tenantSchemaNameFor,
} from './tenant-schema-name';
import { ValidationError } from '../errors/domain-error';

/**
 * The municipality identifier that appears in every URL path.
 *
 * Also the source of the Postgres schema name, which is why the character set is
 * this strict: `schemaName` is interpolated the slug into DDL that cannot be
 * parameterised, so anything outside [a-z0-9-] must be impossible to construct
 * rather than merely escaped later.
 */
export class TenantSlug {
  private constructor(readonly value: string) {}

  static parse(raw: string): TenantSlug {
    const normalised = raw.trim().toLowerCase();

    if (normalised.length < TENANT_SLUG_MIN_LENGTH || normalised.length > TENANT_SLUG_MAX_LENGTH) {
      throw new ValidationError(
        `Municipality slug must be ${TENANT_SLUG_MIN_LENGTH}–${TENANT_SLUG_MAX_LENGTH} characters`,
      );
    }
    if (!TENANT_SLUG_PATTERN.test(normalised)) {
      throw new ValidationError(
        'Municipality slug may contain only lowercase letters, digits and single hyphens',
      );
    }

    return new TenantSlug(normalised);
  }

  static isValid(raw: string): boolean {
    return isTenantSlug(raw.trim().toLowerCase());
  }

  /** Postgres schema name for this municipality (`tenantSchemaNameFor`). */
  get schemaName(): string {
    return tenantSchemaNameFor(this.value);
  }

  toString(): string {
    return this.value;
  }
}
