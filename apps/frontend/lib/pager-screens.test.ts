import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-11 (cleanup sprint, 2026-11-24): `Pager` worded itself inline on `locale`
  and had no way to be held, so the audit and corrections pagers stayed live
  while the next page was still on its way. Its words now come in as `labels`
  (`usePagerLabels`, from `messages.pager`) and every screen holds it with
  `disabled` while its read is in flight.

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

/** Every `<Pager … />` in the app, as the text of its opening tag. */
function pagers(): Array<{ where: string; tag: string }> {
  const found: Array<{ where: string; tag: string }> = [];
  for (const dir of ['app', 'components']) {
    for (const file of tsxUnder(join(FRONTEND, dir))) {
      if (file.endsWith('pager.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      let from = 0;
      for (;;) {
        const start = source.indexOf('<Pager', from);
        if (start < 0) break;
        const end = source.indexOf('/>', start);
        found.push({ where: relative(FRONTEND, file).replace(/\\/g, '/'), tag: source.slice(start, end + 2) });
        from = end + 2;
      }
    }
  }
  return found;
}

describe('every Pager is worded by the messages and held while its list is read', () => {
  const all = pagers();

  it('finds the screens that page a list', () => {
    expect(all.length).toBeGreaterThanOrEqual(5);
  });

  it.each(all.map((entry) => [entry.where, entry.tag] as const))('%s passes labels and disabled', (_where, tag) => {
    expect(tag).toMatch(/labels=\{pagerLabels\}/);
    expect(tag).toMatch(/disabled=\{[\w.]+\.fetching\}/);
    // The words are the messages', not a `locale` the Pager words itself from.
    expect(tag).not.toMatch(/locale=/);
  });

  it('the kit holds both buttons when disabled', () => {
    const source = readFileSync(join(FRONTEND, 'components', 'ui', 'pager.tsx'), 'utf8');
    expect(source).toMatch(/disabled=\{disabled \|\| page <= 0\}/);
    expect(source).toMatch(/disabled=\{disabled \|\| page >= pageCount - 1\}/);
  });

  it('the hook reads every word from messages.pager', () => {
    const hook = readFileSync(join(FRONTEND, 'lib', 'use-pager-labels.ts'), 'utf8');
    expect(hook).toMatch(/useTranslations\('pager'\)/);
    for (const key of ['pages', 'previous', 'next', 'position', 'range']) {
      expect(hook).toContain(`t('${key}'`);
    }
  });
});
