import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  SUBMIT-03 and SUBMIT-04 (cleanup sprint, 2026-11-24): the ownership, merge and
  correction dialogs, and the staff, settings, account-security, import and
  quality writes, were guarded by React `busy` state alone — set asynchronously,
  so a double-click can pass its stale read before a re-render commits. Each
  write now checks and sets a ref synchronously, first, and releases it where
  the write settles (and, for a dialog that closes on success, where the dialog
  resets).

  Read, not rendered: the runner only collects `lib/**`, as
  `unit-matrix-guards.test.ts` does.

  A row is [file under components/admin, ref]. The test asks three things of
  every row: the ref is declared with `useRef`, it is *checked and then set*
  before any `await` can run, and it is released again somewhere.
*/
const ADMIN = join(__dirname, '..', 'components', 'admin');
const FRONTEND = join(__dirname, '..');
// A path starting `app/` is read from the frontend root; any other is under components/admin.
const read = (file: string): string =>
  readFileSync(file.startsWith('app/') ? join(FRONTEND, file) : join(ADMIN, file), 'utf8');

const GUARDS: ReadonlyArray<readonly [string, string]> = [
  // SUBMIT-03
  ['end-ownership-dialog.tsx', 'runningRef'],
  ['end-tenancy-dialog.tsx', 'runningRef'],
  ['landlord-unlink-dialog.tsx', 'runningRef'],
  ['merge-citizens-dialog.tsx', 'runningRef'],
  ['citizen-merges.tsx', 'runningRef'],
  ['duplex-merge-dialog.tsx', 'submittingRef'],
  ['parcel-correction-dialog.tsx', 'runningRef'],
  ['unit-correction-delete-dialog.tsx', 'submittingRef'],
  // SUBMIT-04: account security
  ['settings/security-section.tsx', 'emailChangeRef'],
  ['settings/security-section.tsx', 'enrollingRef'],
  ['settings/security-section.tsx', 'confirming2FARef'],
  ['settings/security-section.tsx', 'disablingRef'],
  ['settings/security-section.tsx', 'reconfiguringRef'],
  // SUBMIT-04: staff, citizens, settings
  ['staff/deleted-staff-section.tsx', 'restoringRef'],
  ['residence-change-dialog.tsx', 'deactivatingRef'],
  ['settings/cadastre-section.tsx', 'uploadingRef'],
  ['settings/users-section.tsx', 'creatingRef'],
  ['settings/finance-section.tsx', 'savingRef'],
  ['settings/finance-section.tsx', 'savingFactorsRef'],
  ['settings/numbering-section.tsx', 'savingRef'],
  ['settings/profile-section.tsx', 'savingRef'],
  ['settings/backup-section.tsx', 'backupRef'],
  ['settings/backup-section.tsx', 'snapshotRef'],
  ['settings/backup-section.tsx', 'restoreRef'],
  // SUBMIT-06: the request sheet and the corrections review
  ['requests/request-sheet.tsx', 'billInFlight'],
  ['requests/request-sheet.tsx', 'uploadingRef'],
  ['app/[tenant]/[locale]/[adminPath]/(protected)/fees/corrections/page.tsx', 'savingRef'],
  // SUBMIT-04: import and quality
  ['import-citizens-dialog.tsx', 'checkingRef'],
  ['import-citizens-dialog.tsx', 'importingRef'],
  ['quality/findings-list.tsx', 'workRef'],
  ['quality/findings-list.tsx', 'settleAllRef'],
  ['quality/finding-compare.tsx', 'savingRef'],
];

const CHECKED_APART = new Set(['disablingRef', 'reconfiguringRef']);

describe.each(GUARDS)('%s guards its write with %s', (file, ref) => {
  const source = read(file);

  it('declares the ref', () => {
    expect(source).toMatch(new RegExp(`const ${ref} = (React\\.)?useRef\\(false\\);`));
  });

  it('checks it and sets it before the write starts', () => {
    // The two password forms check at the top, say «password required» themselves, and set it just
    // before the call; the next describe block pins their order.
    if (CHECKED_APART.has(ref)) {
      expect(source).toMatch(new RegExp(`if \\(${ref}\\.current\\) return;`));
      expect(source).toMatch(new RegExp(`${ref}\\.current = true;`));
      return;
    }
    // `if (… ref.current …) return;` and then `ref.current = true;` with nothing awaited between.
    expect(source).toMatch(
      new RegExp(`if \\([^\\n]*\\b${ref}\\.current\\) (return|\\{\\s*return;)[^\\n]*\\n(?:[^\\n]*\\n){0,1}\\s*${ref}\\.current = true;`),
    );
  });

  it('releases it when the write settles', () => {
    expect(source).toMatch(new RegExp(`${ref}\\.current = false;`));
  });
});

describe('the ref is the first thing a handler does, before the state it also sets', () => {
  it('end-ownership-dialog sets the ref ahead of setBusy(true)', () => {
    expect(read('end-ownership-dialog.tsx')).toMatch(/runningRef\.current = true;\s*\n\s*setBusy\(true\)/);
  });

  it('backup-section sets each ref ahead of its busy state', () => {
    const source = read('settings/backup-section.tsx');
    expect(source).toMatch(/backupRef\.current = true;\s*\n\s*setBusy\(true\)/);
    expect(source).toMatch(/snapshotRef\.current = true;\s*\n\s*setSnapshotBusy\(true\)/);
    expect(source).toMatch(/restoreRef\.current = true;\s*\n\s*setRestoreBusy\(true\)/);
  });

  it('the disable and reconfigure forms return silently while a press is in flight, rather than saying «password required»', () => {
    const source = read('settings/security-section.tsx');
    expect(source).toMatch(/if \(disablingRef\.current\) return;\s*\n\s*if \(!disablePassword/);
    expect(source).toMatch(/if \(reconfiguringRef\.current\) return;\s*\n\s*if \(!reconfigurePassword/);
  });
});
