import { describe, expect, it } from 'vitest';
import type { CitizenFormValues } from '@/components/admin/citizen-form';
import { withResidence, withSeededSearch } from './citizen-seed';

const blank = (): CitizenFormValues => ({
  residence: 'RESIDENT',
  personal: { isLebanese: true },
  contact: { whatsappSameAsPhone: true, hasNoPhone: false },
  properties: [],
  flags: new Map(),
  unverified: new Map(),
});

/*
  «ملف جديد» from a search that found nobody: the term seeds the form, and the
  kind the link asked for is applied after (`citizen-editor.tsx`).
*/
describe('seeding a new file from a search', () => {
  it('keeps an institution’s whole name when the kind is applied after the seed (0076)', () => {
    const opened = withResidence(withSeededSearch(blank(), 'وقف مسجد البلدة', 'INSTITUTION'), 'INSTITUTION');
    expect(opened.personal).toMatchObject({ firstName: 'وقف مسجد البلدة', middleName: '', lastName: '' });
    // Without the kind, the same order still joins the three boxes back into one line.
    expect(withResidence(withSeededSearch(blank(), 'وقف مسجد البلدة'), 'INSTITUTION').personal.firstName).toBe(
      'وقف مسجد البلدة',
    );
  });

  it('seeds an institution’s name holding a digit, which is never a person’s', () => {
    const opened = withResidence(withSeededSearch(blank(), 'مدرسة رسمية 2', 'INSTITUTION'), 'INSTITUTION');
    expect(opened.personal.firstName).toBe('مدرسة رسمية 2');
    expect(withSeededSearch(blank(), 'مدرسة رسمية 2').personal.firstName).toBeUndefined();
  });
});
