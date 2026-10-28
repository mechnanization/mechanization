import { describe, expect, it } from 'vitest';
import { defaultPayer } from './shared-bill-payer';

const A = { citizenId: 'a', responsible: true };
const B = { citizenId: 'b', responsible: false };
const C = { citizenId: 'c' };

describe('defaultPayer', () => {
  it('starts on the citizen whose file the bill was opened from, the responsible owner or not', () => {
    expect(defaultPayer([A, B], 'b')).toBe('b');
    expect(defaultPayer([A, B], 'a')).toBe('a');
  });

  it('starts on the responsible owner with no file, or a file that is not a debtor', () => {
    expect(defaultPayer([B, A])).toBe('a');
    expect(defaultPayer([B, A], 'someone-else')).toBe('a');
  });

  it('starts on nobody when the unit names no responsible owner, so the clerk chooses', () => {
    expect(defaultPayer([B, C])).toBe('');
    expect(defaultPayer([])).toBe('');
  });
});
