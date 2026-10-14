import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every screen that mounts «صرف عمولة» keeps it mounted when a re-read fails (STA-1).
 *
 * After a payout with no answer the dialog re-reads the inspector's profile —
 * the very key its host page draws from. With the network still down that read
 * failed too, and a host that answered any error with `ErrorState` swapped the
 * whole page for it: the dialog, its amount and statement and its failure
 * message were unmounted, and «إعادة المحاولة» brought it back empty (review of
 * 2026-10-11). The rule is `readView` (lib/read-view.ts), which gives the page
 * to the error only while nothing has loaded.
 *
 * Here rather than beside the screens because the runner only collects
 * `lib/**`, and it does not render components; so it reads them, as
 * `print-pages.test.ts` does: every file under `app/` or `components/` that
 * mounts the dialog draws its error state through `readView`, and none returns
 * early on a query's error.
 */
const ROOT = join(__dirname, '..');

const hosts = ['app', 'components']
  .flatMap((dir) => (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).map((file) => `${dir}${sep}${file}`))
  .filter((file) => file.endsWith('.tsx') && !file.endsWith(`${sep}inspector-payout-dialog.tsx`))
  .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes('<InspectorPayoutDialog'))
  .map((file) => file.split(sep).join('/'))
  .sort();

describe('the screens that mount the commission payout dialog', () => {
  it('are found, so the checks below are about something', () => {
    // The payout history, the inspector's dashboard, the earnings roster and the staff directory.
    expect(hosts.length).toBeGreaterThanOrEqual(4);
  });

  it.each(hosts)('%s keeps the dialog mounted when a re-read fails', (file) => {
    const source = readFileSync(join(ROOT, ...file.split('/')), 'utf8');
    // A host that draws an error panel at all decides it through readView.
    if (/<ErrorState\b/.test(source)) expect(source).toMatch(/\breadView\(/);
    // The two shapes that swapped a page with data on it for the panel.
    expect(source).not.toMatch(/\bif \(error\)/);
    expect(source).not.toMatch(/\berror \|\| !data\b/);
  });
});
