import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TENANT_SCHEMA_NAME_PATTERN,
  TENANT_SLUG_MAX_LENGTH,
  TENANT_SLUG_MIN_LENGTH,
  TENANT_SLUG_PATTERN,
  isTenantSchemaName,
  isTenantSlug,
  tenantSchemaNameFor,
} from './tenant-schema-name';
import { TenantSlug } from './tenant-slug.vo';

/**
 * The tenant schema name is the isolation boundary, interpolated wherever it
 * is used. One rule (DRY-10); these pin what it admits, and that the plain-node
 * copy the database tools import has not drifted from it.
 */
describe('tenant schema names', () => {
  it('admits exactly the names TenantSlug generates', () => {
    for (const slug of ['albazourieh', 'deir-el-qamar', 'maarakeh', 'a1']) {
      expect(isTenantSlug(slug)).toBe(true);
      expect(tenantSchemaNameFor(slug)).toBe(TenantSlug.parse(slug).schemaName);
      expect(isTenantSchemaName(TenantSlug.parse(slug).schemaName)).toBe(true);
    }
  });

  it.each([
    'public',
    '',
    'tenant_',
    'tenant_a',
    'tenant_UPPER',
    'tenant_with-hyphen',
    'tenant__double',
    'tenant_trailing_',
    '_tenant_x',
    'tenant_' + 'x'.repeat(51),
    'tenant_a; DROP SCHEMA public CASCADE',
    '../../etc',
  ])('refuses %s', (name) => {
    expect(isTenantSchemaName(name)).toBe(false);
  });

  it('is the rule scripts/db/tenant-schema-name.mjs repeats for the database tools', () => {
    const copy = readFileSync(join(__dirname, '../../../../../scripts/db/tenant-schema-name.mjs'), 'utf8');
    const constant = (name: string) => {
      const match = new RegExp(`export const ${name} = (.+);`).exec(copy);
      if (!match) throw new Error(`${name} is missing from scripts/db/tenant-schema-name.mjs`);
      return match[1];
    };

    expect(constant('TENANT_SLUG_PATTERN')).toBe(String(TENANT_SLUG_PATTERN));
    expect(constant('TENANT_SCHEMA_NAME_PATTERN')).toBe(String(TENANT_SCHEMA_NAME_PATTERN));
    expect(constant('TENANT_SLUG_MIN_LENGTH')).toBe(String(TENANT_SLUG_MIN_LENGTH));
    expect(constant('TENANT_SLUG_MAX_LENGTH')).toBe(String(TENANT_SLUG_MAX_LENGTH));
  });
});
