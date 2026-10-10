import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * «مناقلة جديدة» and the transfer register follow the treasury's client rules
 * (STA-1, STA-4) — the PR #111 review, 2026-10-10.
 *
 * The form arrived with the shape that moved money twice elsewhere: a key per
 * attempt (`crypto.randomUUID()` again after every failure, so a lost answer's
 * retry was a second transfer), held in a `useRef` that died with the form, a
 * button released after a 2xx, a replay announced as a fresh success, and a
 * shortage check that refused the very retry the server would have answered
 * from the key. Its pages swapped the form for an error panel when the re-read
 * after a press failed.
 *
 * The components are not rendered here (this suite collects `lib/**` and runs
 * without a DOM), so, as `commission-payout.test.ts` does for the payout
 * dialog, they are read.
 */
const FRONTEND = join(__dirname, '..');
const read = (...path: string[]): string => readFileSync(join(FRONTEND, ...path), 'utf8');

describe('the transfer form', () => {
  const source = read('components', 'admin', 'finance', 'record-transfer-form.tsx');

  it('sends the key held for the act, minted nowhere else', () => {
    expect(source).toMatch(/clientRequestId:\s*heldKey\(tenant,\s*TRANSFER_SCOPE\)/);
    expect(source).not.toMatch(/randomUUID|newRequestId|requestId\.current/);
  });

  it('spends the key only when the server says the act exists, and marks a lost answer in doubt', () => {
    expect(source).toMatch(/if \(keyIsSpent\(caught\)\)\s*\{[\s\S]*?spendKey\(tenant,\s*TRANSFER_SCOPE\)/);
    expect(source).toMatch(/outcomeInDoubt\(caught\)\)\s*\{[\s\S]*?markInDoubt\(tenant,\s*TRANSFER_SCOPE\)/);
  });

  it('stays locked after a 2xx, and announces a replay as already recorded', () => {
    expect(source).toMatch(/setDone\(true\)/);
    expect(source).toMatch(/disabled=\{busy \|\| done/);
    expect(source).toMatch(/if \(inFlight\.current \|\| done\) return;/);
    expect(source).toMatch(/result\.replayed[\s\S]*?toast\.warning\(t\('replayed'/);
  });

  it('never lets a check made here refuse the retry of a press whose answer was lost', () => {
    expect(source).toMatch(/const retrying = heldInDoubt\(tenant,\s*TRANSFER_SCOPE\)/);
    expect(source).toMatch(/short && !retrying && !next\.amount/);
    expect(source).toMatch(/beyondTolerance && !retrying/);
    expect(source).toMatch(/disabled=\{busy \|\| done \|\| \(short && !retrying\)\}/);
  });
});

describe('the transfer pages', () => {
  const pages = {
    register: read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'finance', 'transfers', 'page.tsx'),
    new: read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'finance', 'transfers', 'new', 'page.tsx'),
  };

  it.each(Object.entries(pages))('the %s page keeps what it shows when a re-read fails', (_name, source) => {
    expect(source).toMatch(/\breadView\(/);
    expect(source).toMatch(/<RefreshFailedAlert/);
    // `overview.error ? <ErrorState/> : …` — the shape that unmounted a form whose answer was lost.
    expect(source).not.toMatch(/\b\w+\.error\s*\?\s*\(/);
  });
});
