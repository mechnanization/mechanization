import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  DRY-12 (cleanup sprint, 2026-11-23): screens that copied a role list as a
  literal array drifted from the server's own set — `citizens/page.tsx`'s
  `CAN_WRITE` left out COLLECTOR, which `REGISTER_WRITE_ROLES` admits, and
  `nav.ts`'s «سجل العمليات» row left out ADMINISTRATIVE_OFFICER, which
  `FEE_READ_ROLES` admits. Every list named in the ticket is now an export of
  `lib/staff-roles.ts` (or, for `nav.ts`'s two rows already importing shared
  sets directly, the shared set itself), built from the shared role set the
  controller's `@Roles` uses.

  Read, not rendered: the runner only collects `lib/**`.
*/
const ROOT = join(__dirname, '..');
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), 'utf8');

describe('lib/staff-roles.ts', () => {
  const src = read('lib', 'staff-roles.ts');

  it('no longer has a bare array literal starting with SUPER_ADMIN anywhere in app or components', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components']) {
      const files = (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
      );
      for (const file of files) {
        const text = readFileSync(join(ROOT, dir, file), 'utf8');
        if (/\[\s*'SUPER_ADMIN'/.test(text)) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exports the lists this ticket named, each built from a shared or documented set', () => {
    expect(src).toMatch(/export const CITIZEN_RECORD_EDIT_ROLES: readonly string\[\] = REGISTER_WRITE_ROLES;/);
    expect(src).toMatch(/export const CITIZEN_EDITOR_ROLES = \[/);
    expect(src).toMatch(/export const LANDLORD_SUMMARY_READ_ROLES: readonly string\[\] = SHARED_LANDLORD_SUMMARY_READ_ROLES;/);
    expect(src).toMatch(/export const CITIZEN_EDIT_IN_QUALITY_ROLES: readonly string\[\] = QUALITY_REVIEWER_ROLES\.filter/);
    expect(src).toMatch(/export const AUDIT_READ_ROLES: readonly string\[\] = SHARED_AUDIT_READ_ROLES;/);
    expect(src).toMatch(/export const FEE_READ_ROLES: readonly string\[\] = SHARED_FEE_READ_ROLES;/);
    expect(src).toMatch(/export const FEE_ADMIN_ROLES: readonly string\[\] = SHARED_FEE_ADMIN_ROLES;/);
    expect(src).toMatch(/export const SETTINGS_ROLES: readonly string\[\] = \['SUPER_ADMIN'\]/);
    expect(src).toMatch(/export const STAFF_READ_ROLES: readonly string\[\] = \['SUPER_ADMIN'\]/);
  });
});

describe('the fixed sites read their list from lib/staff-roles.ts (or an already-imported shared set)', () => {
  it('citizens/page.tsx: canWrite (archive/restore/import) is the full write set; canOpenEditor is the narrower one', () => {
    const text = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'citizens', 'page.tsx');
    expect(text).toMatch(/const canWrite = hasRole\(CITIZEN_RECORD_EDIT_ROLES, role\);/);
    expect(text).toMatch(/const canOpenEditor = hasRole\(CITIZEN_EDITOR_ROLES, role\);/);
    expect(text).not.toMatch(/const CAN_WRITE/);
  });

  it('citizens/[citizenId]/properties/page.tsx: ending a card and unlinking a landlord are gated separately', () => {
    const text = read(
      'app',
      '[tenant]',
      '[locale]',
      '[adminPath]',
      '(protected)',
      'citizens',
      '[citizenId]',
      'properties',
      'page.tsx',
    );
    expect(text).toMatch(/canEdit: hasRole\(CITIZEN_RECORD_EDIT_ROLES, user\.role\)/);
    expect(text).toMatch(/canUnlink: hasRole\(LANDLORD_LINK_ANSWER_ROLES, user\.role\)/);
    expect(text).not.toMatch(/const EDIT_ROLES/);
  });

  it('citizens/[citizenId]/page.tsx: canEdit mirrors CitizenEditor, canManage is the money roles', () => {
    const text = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'citizens', '[citizenId]', 'page.tsx');
    expect(text).toMatch(/const canEdit = hasRole\(CITIZEN_EDITOR_ROLES, role\);/);
    expect(text).toMatch(/const canManage = hasRole\(PAYMENT_SETTLE_ROLES, role\);/);
  });

  it('citizens/landlord-links/page.tsx reads LANDLORD_SUMMARY_READ_ROLES', () => {
    const text = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'citizens', 'landlord-links', 'page.tsx');
    expect(text).toMatch(/hasRole\(LANDLORD_SUMMARY_READ_ROLES, user\?\.role\)/);
    expect(text).not.toMatch(/const SUMMARY_ROLES/);
  });

  it('quality/findings-list.tsx computes the intersection instead of re-typing it', () => {
    const text = read('components', 'admin', 'quality', 'findings-list.tsx');
    expect(text).toMatch(/hasRole\(CITIZEN_EDIT_IN_QUALITY_ROLES, role\)/);
    expect(text).not.toMatch(/const CITIZEN_EDIT_ROLES/);
  });

  it('fees/corrections/page.tsx reads FEE_ADMIN_ROLES, matching POST fees/payments/:id/basis-review', () => {
    const text = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'fees', 'corrections', 'page.tsx');
    expect(text).toMatch(/const canReview = hasRole\(FEE_ADMIN_ROLES, role\);/);
  });

  it('activity-trail.tsx reads AUDIT_READ_ROLES', () => {
    const text = read('components', 'admin', 'activity-trail.tsx');
    expect(text).toMatch(/const fullTrail = hasRole\(AUDIT_READ_ROLES, role\);/);
  });

  it('audit/page.tsx, settings/page.tsx and staff/page.tsx read a named set instead of a literal', () => {
    const audit = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'audit', 'page.tsx');
    expect(audit).toMatch(/hasRole\(AUDIT_READ_ROLES, existing\.user\.role\)/);
    const settings = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'settings', 'page.tsx');
    expect(settings).toMatch(/hasRole\(SETTINGS_ROLES, session\.user\.role\)/);
    const staff = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'staff', 'page.tsx');
    expect(staff).toMatch(/hasRole\(STAFF_READ_ROLES, session\.user\.role\)/);
  });

  it('citizen-editor.tsx reads CITIZEN_EDITOR_ROLES', () => {
    const text = read('components', 'admin', 'citizen-editor.tsx');
    expect(text).toMatch(/if \(!hasRole\(CITIZEN_EDITOR_ROLES, session\.user\.role\)\)/);
  });

  it("nav.ts's «تسجيل مواطن جديد» and «سجل العمليات» rows read a named set, not a re-typed array", () => {
    const text = read('components', 'admin', 'nav.ts');
    expect(text).toMatch(/roles: CITIZEN_EDITOR_ROLES,/);
    expect(text).toMatch(/roles: FEE_READ_ROLES,/);
    expect(text).toMatch(/roles: SETTINGS_ROLES,/);
    expect(text).toMatch(/roles: STAFF_READ_ROLES,/);
  });
});
