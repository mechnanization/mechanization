import { describe, expect, it } from 'vitest';
import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import {
  carryHeldPhone,
  namesAnotherRelative,
  samePhone,
  withoutUnusedWhatsapp,
} from './citizen-contact';

describe('samePhone', () => {
  it('reads one number however it was typed', () => {
    expect(samePhone('03 123 456', '+9613123456')).toBe(true);
    expect(samePhone('٠٣١٢٣٤٥٦', '3123456')).toBe(true);
    expect(samePhone('03123456', '71123456')).toBe(false);
  });

  it('compares a half-typed number as typed', () => {
    expect(samePhone('0312', '0312')).toBe(true);
    expect(samePhone('0312', '03123456')).toBe(false);
  });
});

describe('carryHeldPhone — «لا يملك رقم هاتف» keeps the number on the file', () => {
  const before = { phone: '03123456', hasNoPhone: false };

  it('moves the number into «رقم للتواصل» on the tick', () => {
    expect(carryHeldPhone(before, { phone: '', hasNoPhone: true })).toEqual({
      phone: '',
      hasNoPhone: true,
      contactPhone: '03123456',
    });
  });

  it('never writes over a relative the officer already named', () => {
    const next = { phone: '', hasNoPhone: true, contactPhone: '71123456' };
    expect(carryHeldPhone(before, next)).toBe(next);
  });

  it('does nothing when there was no number, or on any change but the tick', () => {
    const blank = { phone: '  ', hasNoPhone: false };
    const ticked = { phone: '', hasNoPhone: true };
    expect(carryHeldPhone(blank, ticked)).toBe(ticked);
    const typing = { phone: '0312345', hasNoPhone: false };
    expect(carryHeldPhone(before, typing)).toBe(typing);
  });

  it('does not move it back when the box is unticked', () => {
    const unticked = { phone: '', hasNoPhone: false, contactPhone: '03123456' };
    expect(carryHeldPhone({ phone: '', hasNoPhone: true, contactPhone: '03123456' }, unticked)).toBe(unticked);
  });
});

describe('namesAnotherRelative', () => {
  it('is false with no «رقم للتواصل», or when it is the typed phone', () => {
    expect(namesAnotherRelative({ phone: '03123456' })).toBe(false);
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: ' ' })).toBe(false);
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: '+961 3 123 456' })).toBe(false);
  });

  it('is true when the file names a different relative', () => {
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: '71123456' })).toBe(true);
    expect(namesAnotherRelative({ phone: '', contactPhone: '71123456' })).toBe(true);
  });
});

describe('withoutUnusedWhatsapp — a WhatsApp number nobody is using is not sent', () => {
  it('drops it while «نفس رقم الهاتف» is ticked, whatever the box still holds', () => {
    expect(withoutUnusedWhatsapp({ phone: '03123456', whatsappSameAsPhone: true, whatsapp: '12' })).toEqual({
      phone: '03123456',
      whatsappSameAsPhone: true,
    });
    // An absent flag reads as ticked, exactly as `ContactStep` reads it.
    expect(withoutUnusedWhatsapp({ phone: '03123456', whatsapp: '12' })).toEqual({ phone: '03123456' });
  });

  it('drops it under «لا يملك رقم هاتف», even beside a stale «ليس نفس الرقم»', () => {
    expect(withoutUnusedWhatsapp({ hasNoPhone: true, whatsappSameAsPhone: false, whatsapp: '' })).toEqual({
      hasNoPhone: true,
      whatsappSameAsPhone: false,
    });
  });

  it('keeps the number of a person who has a phone and says WhatsApp is another one', () => {
    const contact = { phone: '03123456', whatsappSameAsPhone: false, whatsapp: '71123456' };
    expect(withoutUnusedWhatsapp(contact)).toEqual(contact);
  });

  it('leaves a section with no WhatsApp number as it was', () => {
    const contact = { phone: '03123456', whatsappSameAsPhone: true };
    expect(withoutUnusedWhatsapp(contact)).toEqual(contact);
  });

  it('leaves the form’s own values alone, so unticking brings back what was typed', () => {
    const contact = { phone: '03123456', whatsappSameAsPhone: true, whatsapp: '71123' };
    withoutUnusedWhatsapp(contact);
    expect(contact.whatsapp).toBe('71123');
  });
});

/*
  What the function is for, against the schema the save applies. «لا يملك رقم
  هاتف» and «نفس رقم الهاتف» both hide the WhatsApp box, and a value left in a
  hidden box used to reach validation — a red step with no message.
*/
describe('a hidden WhatsApp box cannot fail the save', () => {
  const personal = {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    motherName: 'فاطمة خليل',
    gender: 'MALE',
    civilRecordNumber: '7',
    nationality: 'لبناني',
    isLebanese: true,
    residentStatus: 'VILLAGE_RESIDENT',
  };

  const issues = (contact: Record<string, unknown>): string[] => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      residence: 'RESIDENT',
      personal,
      contact: { maritalStatus: 'MARRIED', actualHouseholdMembers: '3', ...contact },
      properties: [],
      flags: [],
      unitStatusAsked: true,
    });
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('saves after half a number was typed into WhatsApp and «نفس رقم الهاتف» ticked again', () => {
    const contact = { phone: '03111222', whatsappSameAsPhone: true, whatsapp: '12' };
    expect(issues(withoutUnusedWhatsapp(contact))).toEqual([]);
  });

  it('saves a file marked «لا يملك رقم هاتف» whatever the hidden boxes hold', () => {
    const contact = { hasNoPhone: true, phone: '', whatsapp: '12', whatsappSameAsPhone: false, contactPhone: '81023433' };
    expect(issues(withoutUnusedWhatsapp(contact))).toEqual([]);
  });

  it('still refuses a malformed number that is in use', () => {
    const contact = { phone: '03111222', whatsappSameAsPhone: false, whatsapp: '12' };
    expect(issues(withoutUnusedWhatsapp(contact))).toEqual(['contact.whatsapp: رقم الهاتف غير صالح']);
  });

  it('still asks for the number when the box is open and empty', () => {
    const contact = { phone: '03111222', whatsappSameAsPhone: false, whatsapp: '' };
    expect(issues(withoutUnusedWhatsapp(contact))).toEqual(['contact.whatsapp: رقم الواتساب مطلوب']);
  });
});
