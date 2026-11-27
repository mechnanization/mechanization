/**
 * A municipality's slug and the Postgres schema it lives in — the one rule
 * (DRY-10).
 *
 * Tenancy is by schema, so this is the isolation boundary: a schema name cannot
 * be a bound parameter, and every place that interpolates one (the connection
 * string, `tenantSchemaRef`, the migrator's DDL, the backup script) refuses
 * anything that is not exactly the shape `tenantSchemaNameFor` produces.
 *
 * In the domain, with no imports, because the tenant migrator reaches it: the
 * production migration runs `migrate-all-tenants.ts` under ts-node before
 * anything is built, so this cannot live in `@mechanization/shared-schemas`
 * (read from `dist/`). `scripts/db/tenant-schema-name.mjs` repeats it for the
 * plain-node tools (`provision.mjs`, `backups/dump-tenant.js`);
 * `tenant-schema-name.spec.ts` fails if the two drift.
 */

/** Lower-case letters and digits in runs joined by single hyphens. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TENANT_SLUG_MIN_LENGTH = 2;
export const TENANT_SLUG_MAX_LENGTH = 50;

/** `tenant_` and a slug with its hyphens as underscores. */
export const TENANT_SCHEMA_NAME_PATTERN = /^tenant_[a-z0-9]+(_[a-z0-9]+)*$/;
const TENANT_SCHEMA_PREFIX = 'tenant_';

/** Is `slug` (already trimmed and lower-cased) a municipality slug this system would create? */
export function isTenantSlug(slug: string): boolean {
  return (
    slug.length >= TENANT_SLUG_MIN_LENGTH &&
    slug.length <= TENANT_SLUG_MAX_LENGTH &&
    TENANT_SLUG_PATTERN.test(slug)
  );
}

/**
 * The schema of a valid slug. Hyphens become underscores because an unquoted
 * identifier cannot contain a hyphen, and a name that is sometimes quoted and
 * sometimes not is how schema bugs start. Check the slug with `isTenantSlug` first.
 */
export function tenantSchemaNameFor(slug: string): string {
  return `${TENANT_SCHEMA_PREFIX}${slug.replace(/-/g, '_')}`;
}

/** Is `name` exactly what `tenantSchemaNameFor` makes of some valid slug? */
export function isTenantSchemaName(name: string): boolean {
  if (!TENANT_SCHEMA_NAME_PATTERN.test(name)) return false;
  const suffix = name.length - TENANT_SCHEMA_PREFIX.length;
  return suffix >= TENANT_SLUG_MIN_LENGTH && suffix <= TENANT_SLUG_MAX_LENGTH;
}
