import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A page's way back is the header's (PRIM-2).
 *
 * A page declares it with `HeaderBackLink`, and `AdminHeader` draws it at the
 * start of the sticky bar, where it stays while the page scrolls. A `BackLink`
 * drawn in the page sat above the heading, scrolled away with it and pushed
 * the heading down — and the treasury pages written after the header took the
 * link kept drawing their own. An inline `BackLink` is allowed only inside a
 * page's own toolbar, beside other controls: the two below.
 *
 * Read, not rendered: the runner only collects `lib/**`.
 */
const ROOT = join(__dirname, '..');

/** Relative to the app root, with forward slashes, so a failure names the file the same way on every machine. */
const sources = ['app', 'components']
  .flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => `${dir}/${file.split(sep).join('/')}`),
  );

/** Where a `BackLink` is drawn on purpose: the header itself, and the two toolbars PRIM-2 names. */
const ALLOWED = [
  'components/admin/admin-header.tsx',
  'components/admin/building-editor.tsx',
  'components/admin/building-unit-matrix-view.tsx',
];

const drawsBackLink = (file: string): boolean =>
  /<BackLink\b/.test(readFileSync(join(ROOT, ...file.split('/')), 'utf8'));

describe('back navigation', () => {
  it('finds the pages that declare their way back, so the check below is about something', () => {
    const declaring = sources.filter((file) =>
      /<HeaderBackLink\b/.test(readFileSync(join(ROOT, ...file.split('/')), 'utf8')),
    );
    expect(declaring.length).toBeGreaterThanOrEqual(20);
  });

  it('the allowed places still draw a BackLink, so the list does not outlive them', () => {
    for (const file of ALLOWED) expect(drawsBackLink(file), file).toBe(true);
  });

  it('no other page or component draws a BackLink of its own', () => {
    const offenders = sources.filter((file) => !ALLOWED.includes(file) && drawsBackLink(file));
    expect(offenders).toEqual([]);
  });
});
