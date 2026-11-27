/**
 * A municipality's slug and its Postgres schema, for the plain-node tools
 * (`provision.mjs`, `apps/backend/backups/dump-tenant.js`).
 *
 * The rule's home is `apps/backend/src/domain/value-objects/tenant-schema-name.ts`
 * (DRY-10). This file repeats its patterns because these tools run with no
 * build and cannot import TypeScript; the backend spec
 * `tenant-schema-name.spec.ts` reads this file and fails if the two drift.
 */

export const TENANT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TENANT_SLUG_MIN_LENGTH = 2;
export const TENANT_SLUG_MAX_LENGTH = 50;
export const TENANT_SCHEMA_NAME_PATTERN = /^tenant_[a-z0-9]+(_[a-z0-9]+)*$/;
const TENANT_SCHEMA_PREFIX = 'tenant_';

export function isTenantSlug(slug) {
  return (
    slug.length >= TENANT_SLUG_MIN_LENGTH &&
    slug.length <= TENANT_SLUG_MAX_LENGTH &&
    TENANT_SLUG_PATTERN.test(slug)
  );
}

export function tenantSchemaNameFor(slug) {
  return `${TENANT_SCHEMA_PREFIX}${slug.replace(/-/g, '_')}`;
}

export function isTenantSchemaName(name) {
  if (!TENANT_SCHEMA_NAME_PATTERN.test(name)) return false;
  const suffix = name.length - TENANT_SCHEMA_PREFIX.length;
  return suffix >= TENANT_SLUG_MIN_LENGTH && suffix <= TENANT_SLUG_MAX_LENGTH;
}
