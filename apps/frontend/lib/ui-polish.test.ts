import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-05, UX-15 and UX-21 (cleanup sprint, 2026-11-24): three small rules that
  nothing else enforced, so they had crept back before.

  Read, not rendered (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');
const read = (...path: string[]): string => readFileSync(join(FRONTEND, ...path), 'utf8');

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsxUnder(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('BAN-11: no text below the 12px floor, outside the illustrations (UX-05)', () => {
  it('has no text-[Npx] class', () => {
    const found: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const file of tsxUnder(join(FRONTEND, dir))) {
        if (file.endsWith('property-illustrations.tsx')) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (/text-\[\d+px\]/.test(line)) found.push(`${relative(FRONTEND, file).replace(/\\/g, '/')}:${index + 1}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});

describe('Field says «(optional)» in the page’s language (UX-15)', () => {
  it('falls back to the page locale, not to Arabic, when no flagging context names one', () => {
    const source = read('components', 'ui', 'field.tsx');
    expect(source).toMatch(/useLocale\(\)/);
    expect(source).toMatch(/flagging\?\.locale \?\? pageLocale/);
    expect(source).not.toMatch(/flagging\?\.locale \?\? 'ar'/);
  });
});

describe('a calendar day is shown with formatDay, not formatDate (UX-21, PRIM-12)', () => {
  it.each([
    ['components/admin/damage/damage-history.tsx', /formatDay\(row\.reinspectAt\.slice\(0, 10\)\)/, /formatDate\(row\.reinspectAt/],
    ['components/admin/end-ownership-dialog.tsx', /formatDay\(endedAt \|\| today\(\)\)/, /formatDate\(endedAt/],
    [
      'app/[tenant]/[locale]/[adminPath]/(protected)/citizens/[citizenId]/payments/[paymentId]/page.tsx',
      /formatDay\(paidOn\)/,
      /formatDate\(paidOn\)/,
    ],
  ])('%s', (file, uses, avoids) => {
    const source = read(...file.split('/'));
    expect(source).toMatch(uses);
    expect(source).not.toMatch(avoids);
  });
});
