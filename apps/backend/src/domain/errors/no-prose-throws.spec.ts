import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No refusal is thrown as prose.
 *
 * A DomainError constructed with a string — Arabic words, or an English entity
 * name — puts the words on the server, where the frontend can only show them
 * verbatim: Arabic on the English screens too. The rule is a code from
 * `ERROR_CODES` that the frontend translates (see `domain-error.ts`).
 *
 * This was a ratchet (`LEGACY_PROSE_THROWS`, 199 on 2026-11-15) until ARCH-12,
 * ARCH-13 and ARCH-14 converted the last sites on 2026-11-28. A throw counts as
 * prose when its first argument is not an object literal.
 */
const BACKEND_ROOT = join(__dirname, '..', '..', '..');

function proseThrows(): string[] {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('/generated/'));

  const pattern = /new (Conflict|Validation|NotFound|Forbidden|Unauthorized)Error\(\s*(\{)?/g;
  const sites: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(BACKEND_ROOT, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      if (match[2]) continue;
      sites.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  return sites;
}

describe('domain errors', () => {
  it('are thrown with a code, never with prose', () => {
    // Throw `new ConflictError({ code, message, params })` with a code from ERROR_CODES (domain-error.ts).
    expect(proseThrows()).toEqual([]);
  });

  it('counts a prose throw, so the test above can fail', () => {
    // The detector itself, on a line of the kind it must catch and one it must let through.
    const pattern = /new (Conflict|Validation|NotFound|Forbidden|Unauthorized)Error\(\s*(\{)?/g;
    const prose = [...`throw new ConflictError('نص');`.matchAll(pattern)].filter((m) => !m[2]);
    const coded = [...`throw new ConflictError({ code: 'X', message: 'y' });`.matchAll(pattern)].filter((m) => !m[2]);
    expect([prose.length, coded.length]).toEqual([1, 0]);
  });
});
