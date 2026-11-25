import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-13 (cleanup sprint, 2026-11-25): the quality screens' files over 600 lines are split one screen at a
  time. This holds the ones already done to that size; the findings list, its parts and the comparison join as
  their own pull requests reach them.
*/

const QUALITY = join(__dirname, '..', 'components', 'admin', 'quality');
const lineCount = (file: string) => readFileSync(join(QUALITY, file), 'utf8').split('\n').length - 1;

const DONE = ['review-queue.tsx', 'checks-panel.tsx', ...readdirSync(join(QUALITY, 'review')).map((file) => `review/${file}`)];

describe('the review queue after its split', () => {
  it('is the queue and the parts of a card', () => {
    expect([...DONE].sort()).toEqual([
      'checks-panel.tsx',
      'review-queue.tsx',
      'review/record-actions.tsx',
      'review/record-details.tsx',
      'review/record-history.tsx',
      'review/return-form.tsx',
    ]);
  });

  it.each(DONE)('%s is no more than 600 lines', (file) => {
    expect(lineCount(file), file).toBeLessThanOrEqual(600);
  });
});
