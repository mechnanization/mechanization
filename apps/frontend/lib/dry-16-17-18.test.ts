import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPERTY_TYPE, normalizeArabic } from '@mechanization/shared-schemas';
import type { CitizenListItem } from '@/lib/api-client';
import {
  IDLE_CITIZEN_SEARCH,
  SEARCH_DEBOUNCE_MS,
  scheduleCitizenSearch,
  type CitizenSearchState,
} from '@/lib/use-citizen-search';

/*
  DRY-16, DRY-17 and DRY-18 (cleanup sprint, 2026-11-24): three copies of
  something that has a home — `normalizeArabic`, the citizen search, the list
  of property types. This reads the sources, so it fails when a copy comes back
  (the runner collects `lib/**` only and has no DOM).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

describe('normalizeArabic is imported, never copied (DRY-16)', () => {
  it('bill-type-select takes it from shared-schemas', () => {
    const source = read('components/admin/bill-type-select.tsx');
    expect(source).not.toMatch(/function normalizeArabic/);
    expect(source).toMatch(/import \{[^}]*\bnormalizeArabic\b[^}]*\} from '@mechanization\/shared-schemas'/);
  });

  it('ConfirmDialog compares requireText through it, on both sides', () => {
    const source = read('components/ui/confirm-dialog.tsx');
    expect(source).toMatch(/import \{[^}]*\bnormalizeArabic\b[^}]*\} from '@mechanization\/shared-schemas'/);
    expect(source).toMatch(/normalizeArabic\(entered\)\s*===\s*normalizeArabic\(requireText\)/);
    // The raw comparison is what DES-3 forbids.
    expect(source).not.toMatch(/entered\s*!==\s*requireText/);
  });

  it('what a clerk types for an Arabic name matches however it is spelled', () => {
    const subject = 'مدرسة الأمل';
    for (const typed of ['مدرسة الامل', ' مدرسه الأمل ', 'مدرسة  الإمل', 'مَدْرَسَة الأمل']) {
      expect(normalizeArabic(typed)).toBe(normalizeArabic(subject));
    }
    expect(normalizeArabic('مدرسة النور')).not.toBe(normalizeArabic(subject));
  });
});

describe("the command palette uses the register's one citizen search (DRY-17)", () => {
  it('has no search of its own', () => {
    const source = read('components/admin/command-palette.tsx');
    expect(source).not.toMatch(/\blistCitizens\b/);
    expect(source).not.toMatch(/setTimeout\(/);
    expect(source).toMatch(/useCitizenSearch\(/);
  });

  it('still offers the archived and the merged files to navigate to', () => {
    const source = read('components/admin/command-palette.tsx');
    expect(source).toMatch(/includeArchived:\s*true/);
    expect(source).toMatch(/includeMerged:\s*true/);
  });

  it('no other screen offers a merged file unless it says so', () => {
    const hook = read('lib/use-citizen-search.ts');
    // Off by default: `CitizenPicker` and the fee screens name a person, and a folded file is charged on the one that stays.
    expect(hook).toMatch(/includeMerged\s*=\s*false/);
  });

  function row(id: string, mergedIntoId: string | null = null, isActive = true): CitizenListItem {
    return { id, fullName: `Citizen ${id}`, mergedIntoId, isActive } as CitizenListItem;
  }

  describe('the filter', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function ids(options: { includeArchived?: boolean; includeMerged?: boolean }): Promise<string[]> {
      let state: CitizenSearchState = IDLE_CITIZEN_SEARCH;
      const search = vi.fn().mockResolvedValue({
        items: [row('active'), row('archived', null, false), row('folded', 'active')],
      });
      scheduleCitizenSearch('محمد', search, (patch) => (state = { ...state, ...patch }), options);
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      return state.results.map((r) => r.id);
    }

    it('a picker sees the active file only', async () => {
      expect(await ids({})).toEqual(['active']);
    });

    it('the palette sees all three', async () => {
      expect(await ids({ includeArchived: true, includeMerged: true })).toEqual(['active', 'archived', 'folded']);
    });

    it('the two options are independent', async () => {
      expect(await ids({ includeMerged: true })).toEqual(['active', 'folded']);
      expect(await ids({ includeArchived: true })).toEqual(['active', 'archived']);
    });
  });
});

describe('the offline tenant fallback takes its property types from the shared enum (DRY-18)', () => {
  it('api-client has no literal list', () => {
    const source = read('lib/api-client.ts');
    expect(source).not.toMatch(/'TENT'\]/);
    expect(source).toMatch(/enabledPropertyTypes:\s*\[\.\.\.PROPERTY_TYPE\]/);
  });

  it('nor does the citizen editor, which built the same fallback for a new file', () => {
    const source = read('components/admin/citizen-editor.tsx');
    expect(source).not.toMatch(/'TENT'\]/);
    expect(source).toMatch(/enabledPropertyTypes:\s*\[\.\.\.PROPERTY_TYPE\]/);
  });

  it('the enum still holds the four types the literal named', () => {
    expect([...PROPERTY_TYPE]).toEqual(['BUILDING', 'HOUSE', 'LAND', 'TENT']);
  });
});
