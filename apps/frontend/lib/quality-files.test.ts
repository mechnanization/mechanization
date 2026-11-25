import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-13 (cleanup sprint, 2026-11-25): the quality screens' files over 600 lines are split one screen at a
  time. This holds the ones already done to that size; the comparison joins when its pull request reaches it.
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

describe('the files already split', () => {
  it.each([...QUEUE, ...FINDINGS])('%s is no more than 600 lines', (file) => {
    expect(lineCount(file), file).toBeLessThanOrEqual(600);
  });
});
