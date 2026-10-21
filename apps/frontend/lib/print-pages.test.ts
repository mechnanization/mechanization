import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A print page keeps its document when a background re-read fails (STA-1).
 *
 * A clerk opens «أمر الصرف» or «سند القبض», spends half a minute in the
 * browser's print dialog, and comes back: the refocus re-read fails on a flaky
 * line, and a page that branched on the query's error first swapped the
 * document it was printing for an error panel, though the voucher was still
 * cached. The rule is `readView` (lib/read-view.ts), which gives the page to
 * the error only while nothing has loaded.
 *
 * Here rather than beside the pages because the runner only collects
 * `lib/**`; the pages are components, which this suite does not render. So it
 * reads them: every `print/page.tsx` under `app/` draws through `readView`, and
 * none branches on a query's `.error` directly.
 */
const APP = join(__dirname, '..', 'app');

/** Relative to `app/`, with forward slashes, so a failure names the page the same way on every machine. */
const printPages = (readdirSync(APP, { recursive: true }) as string[])
  .filter((file) => file.endsWith(`${sep}print${sep}page.tsx`))
  .map((file) => file.split(sep).join('/'));

describe('the print pages', () => {
  it('are found, so the checks below are about something', () => {
    // The expense and the income voucher, at least.
    expect(printPages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(printPages)('app/%s draws through readView, keeping the document on a failed re-read', (file) => {
    const source = readFileSync(join(APP, ...file.split('/')), 'utf8');
    expect(source).toMatch(/\breadView\(/);
    // `voucher.error ? <ErrorState/> : …` — the shape that dropped a cached document.
    expect(source).not.toMatch(/\b\w+\.error\s*\?\s*\(/);
  });
});
