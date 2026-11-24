import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-07 (cleanup sprint, 2026-11-24): `DialogContent` drew its built-in close
  button labelled «Close» whatever the page's language, unless the caller passed
  `closeLabel`; eight callers did not. The kit's default is now Arabic, like its
  other labels (KIT-6), and every caller passes the page's own words.

  Read, not rendered (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsxUnder(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** The opening tags `<DialogContent …>` of a source, each as the text up to its closing `>` (not a `=>`). */
function openingTags(source: string): Array<{ tag: string; line: number }> {
  const found: Array<{ tag: string; line: number }> = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<DialogContent', from);
    if (start < 0) return found;
    let end = start;
    let depth = 0;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0 && source[end - 1] !== '=') break;
    }
    found.push({ tag: source.slice(start, end + 1), line: source.slice(0, start).split('\n').length });
    from = end + 1;
  }
}

describe('every DialogContent names its close button in the page’s language', () => {
  it('passes closeLabel (or forwards props that do)', () => {
    const missing: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const file of tsxUnder(join(FRONTEND, dir))) {
        for (const { tag, line } of openingTags(readFileSync(file, 'utf8'))) {
          if (!/closeLabel/.test(tag) && !/\{\.\.\.props\}/.test(tag)) {
            missing.push(`${relative(FRONTEND, file).replace(/\\/g, '/')}:${line}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('defaults the kit’s own label to Arabic, and keeps its ring on :focus-visible', () => {
    const dialog = readFileSync(join(FRONTEND, 'components', 'ui', 'dialog.tsx'), 'utf8');
    expect(dialog).toMatch(/closeLabel = 'إغلاق'/);
    expect(dialog).not.toMatch(/closeLabel = 'Close'/);
    expect(dialog).not.toMatch(/[\s"']focus:ring/);
  });
});
