import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A ratchet on refusals thrown as prose.
 *
 * `new ConflictError('نص عربي')` puts the words on the server, where the
 * frontend can only show them verbatim — Arabic on the English screens too.
 * The rule is a code from `ERROR_CODES` that the frontend translates (see
 * `domain-error.ts`). The sites not converted yet are counted here, and the
 * count may only go down: a new prose throw fails this test, and converting
 * one means lowering the number in the same change.
 *
 * A throw counts as prose when its first argument is not an object literal.
 */
const LEGACY_PROSE_THROWS = 206;

const BACKEND_ROOT = join(__dirname, '..', '..', '..');

function countProseThrows(): { count: number; sample: string[] } {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('/generated/'));

  const pattern = /new (Conflict|Validation|NotFound|Forbidden|Unauthorized)Error\(\s*(\{)?/g;
  const sample: string[] = [];
  let count = 0;
  for (const file of files) {
    const source = readFileSync(join(BACKEND_ROOT, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      if (match[2]) continue;
      count++;
      if (sample.length < 5) {
        sample.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  return { count, sample };
}

describe('error codes ratchet', () => {
  it('has no more prose throws than it had', () => {
    const { count, sample } = countProseThrows();
    if (count > LEGACY_PROSE_THROWS) {
      throw new Error(
        `${count} DomainErrors are thrown with a prose message, up from ${LEGACY_PROSE_THROWS}. ` +
          `Throw with a code from ERROR_CODES instead (domain-error.ts). First few: ${sample.join(', ')}`,
      );
    }
    expect(count).toBeLessThanOrEqual(LEGACY_PROSE_THROWS);
  });

  it('is lowered when sites are converted, so the ratchet keeps its grip', () => {
    const { count } = countProseThrows();
    // A conversion that leaves the constant above the real count lets the
    // next prose throw in unnoticed. Lower LEGACY_PROSE_THROWS to `count`.
    expect(LEGACY_PROSE_THROWS - count).toBe(0);
  });
});
