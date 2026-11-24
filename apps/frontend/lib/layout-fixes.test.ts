import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-18, UX-19 and UX-20 (cleanup sprint, 2026-11-24): three layout rules at the
  kit's seams that no screen showed until a phone or a wide figure met them.

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

describe('a large CurrencyInput figure keeps its size from 640px up (UX-18, PRIM-25)', () => {
  // `Input` carries `text-base sm:text-sm`; a bare `text-lg` loses to it at `sm:`, and the figure shrank to 14px.
  it('every inputClassName that names a large size names its sm: twin', () => {
    const bare: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const file of tsxUnder(join(FRONTEND, dir))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/inputClassName="([^"]*)"/g)) {
          const classes = match[1].split(/\s+/);
          for (const size of ['text-lg', 'text-xl', 'text-2xl']) {
            if (classes.includes(size) && !classes.includes(`sm:${size}`)) {
              bare.push(`${relative(FRONTEND, file).replace(/\\/g, '/')}: ${size}`);
            }
          }
        }
      }
    }
    expect(bare).toEqual([]);
  });
});

describe('DataTable’s phone-card buttons have a floor, not a size (UX-19, LAY-6)', () => {
  it('uses min-h-9 and min-w-9 on the footer’s buttons', () => {
    const source = read('components', 'ui', 'data-table.tsx');
    expect(source).toMatch(/\[&_button\]:min-h-9 \[&_button\]:min-w-9/);
    expect(source).not.toMatch(/\[&_button\]:size-9/);
  });
});

describe('PageHeader’s actions wrap instead of scrolling sideways (UX-20, LAY-5)', () => {
  it('wraps, never overflows, and leaves the title a floor', () => {
    const source = read('components', 'ui', 'page-header.tsx');
    expect(source).toMatch(/flex-wrap/);
    expect(source).not.toMatch(/overflow-x-auto/);
    expect(source).toMatch(/sm:min-w-40/);
  });
});
