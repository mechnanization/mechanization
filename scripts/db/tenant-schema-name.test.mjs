import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTenantSchemaName, isTenantSlug, tenantSchemaNameFor } from './tenant-schema-name.mjs';

test('a valid slug becomes the schema the backend would open', () => {
  assert.equal(tenantSchemaNameFor('albazourieh'), 'tenant_albazourieh');
  assert.equal(tenantSchemaNameFor('deir-el-qamar'), 'tenant_deir_el_qamar');
  for (const slug of ['albazourieh', 'deir-el-qamar', 'maarakeh', 'a1']) {
    assert.ok(isTenantSlug(slug), slug);
    assert.ok(isTenantSchemaName(tenantSchemaNameFor(slug)), slug);
  }
});

test('refuses what the system would never create', () => {
  for (const slug of ['a', 'Albazourieh', 'deir--el', '-deir', 'deir_el', 'x'.repeat(51), 'a b', "a';--"]) {
    assert.equal(isTenantSlug(slug), false, slug);
  }
  for (const name of [
    'public',
    'tenant_',
    'tenant_a',
    'tenant_UPPER',
    'tenant_with-hyphen',
    'tenant__double',
    'tenant_trailing_',
    'tenant_' + 'x'.repeat(51),
    'tenant_a; DROP SCHEMA public CASCADE',
  ]) {
    assert.equal(isTenantSchemaName(name), false, name);
  }
});
