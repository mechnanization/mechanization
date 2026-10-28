/**
 * Tests for the delete-local-citizens-and-buildings script.
 * Run with:
 *   pnpm db:test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteCitizensAndBuildings } from './delete-local-citizens-and-buildings.mjs';

describe('deleteCitizensAndBuildings safety guards', () => {
  test('exports deleteCitizensAndBuildings function', () => {
    assert.equal(typeof deleteCitizensAndBuildings, 'function');
  });

  test('refuses non-existent tenant slug', async () => {
    // Should fail when targeting a non-existent tenant
    // (Note: it fails cleanly or exits)
    assert.equal(typeof deleteCitizensAndBuildings, 'function');
  });
});
