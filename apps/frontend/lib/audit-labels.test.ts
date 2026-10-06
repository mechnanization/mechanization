import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditEntityLabel } from './audit-labels';

describe('auditActionLabel', () => {
  it('names an action in the page’s language, and falls back to the code for an unknown one', () => {
    expect(auditActionLabel('LANDLORD_LINKED', 'ar')).toBe('ربط مالك بمستأجر');
    expect(auditActionLabel('LANDLORD_LINKED', 'en')).toBe('Owner linked');
    expect(auditActionLabel('SOMETHING_NEW', 'ar')).toBe('SOMETHING_NEW');
  });

  // Decision 3 (2026-10-05): a citizen file is archived and restored, never deleted.
  it('calls a deactivated citizen file archived, in the words the register screens use', () => {
    expect(auditActionLabel('CITIZEN_DEACTIVATED', 'ar')).toMatch(/أرشفة/);
    expect(auditActionLabel('CITIZEN_REACTIVATED', 'ar')).toMatch(/الأرشيف/);
  });

  it('names the damage reading’s row', () => {
    expect(auditActionLabel('DAMAGE_RECORDED', 'ar')).not.toBe('DAMAGE_RECORDED');
    expect(auditActionLabel('DAMAGE_RECORDED', 'en')).not.toBe('DAMAGE_RECORDED');
  });
});

describe('auditEntityLabel', () => {
  it('names a citizen’s trail by the table it is filed under', () => {
    expect(auditEntityLabel('User', 'ar')).toBe('مواطن أو موظف');
    expect(auditEntityLabel('Mystery', 'en')).toBe('Mystery');
  });
});
