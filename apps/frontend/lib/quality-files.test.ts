import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-13 (cleanup sprint, 2026-11-25): the quality screens' files over 600 lines were split one screen at a
  time. This holds every one of them to that size.
*/

const QUALITY = join(__dirname, '..', 'components', 'admin', 'quality');
const lineCount = (file: string) => readFileSync(join(QUALITY, file), 'utf8').split('\n').length - 1;
const folder = (name: string) => readdirSync(join(QUALITY, name)).map((file) => `${name}/${file}`);

const QUEUE = ['review-queue.tsx', 'checks-panel.tsx', ...folder('review')];
const FINDINGS = [
  'findings-list.tsx',
  'finding-parts.tsx',
  'finding-actions.tsx',
  'finding-details.tsx',
  'resolve-dialog.tsx',
  ...folder('findings'),
];
const COMPARE = ['finding-compare.tsx', ...folder('compare')];

describe('the review queue after its split', () => {
  it('is the queue and the parts of a card', () => {
    expect([...QUEUE].sort()).toEqual([
      'checks-panel.tsx',
      'review-queue.tsx',
      'review/record-actions.tsx',
      'review/record-details.tsx',
      'review/record-history.tsx',
      'review/return-form.tsx',
    ]);
  });
});

describe('the findings after their split', () => {
  it('are the list, its pieces, the parts shared with the comparison, the actions and the dialog', () => {
    expect([...FINDINGS].sort()).toEqual([
      'finding-actions.tsx',
      'finding-details.tsx',
      'finding-parts.tsx',
      'findings-list.tsx',
      'findings/finding-address.ts',
      'findings/finding-filters.tsx',
      'findings/finding-gone.tsx',
      'findings/table-labels.ts',
      'findings/unit-status-review.tsx',
      'findings/use-finding-columns.tsx',
      'resolve-dialog.tsx',
    ]);
  });
});

describe('the comparison after its split', () => {
  it('is the entry, the two comparisons, the grid and its chrome, the rows, the cell and the correction', () => {
    expect([...COMPARE].sort()).toEqual([
      'compare/building-compare.tsx',
      'compare/citizen-compare.tsx',
      'compare/citizen-rows.ts',
      'compare/compare-shell.tsx',
      'compare/compare-table.tsx',
      'compare/edit-cell.tsx',
      'compare/use-citizen-correction.ts',
      'finding-compare.tsx',
    ]);
  });

  it('writes a citizen’s file from the correction hook alone', () => {
    for (const file of COMPARE) {
      const writes = readFileSync(join(QUALITY, file), 'utf8').includes('updateCitizen(');
      expect(writes, file).toBe(file === 'compare/use-citizen-correction.ts');
    }
  });
});

describe('the files already split', () => {
  it.each([...QUEUE, ...FINDINGS, ...COMPARE])('%s is no more than 600 lines', (file) => {
    expect(lineCount(file), file).toBeLessThanOrEqual(600);
  });
});
