import { adminUpdateCitizenSubmissionSchema } from '@mechanization/shared-schemas';

/**
 * Saving an edit of a record that was filed with gaps.
 *
 * The edit form is filled from the stored record, and a column nobody filled
 * comes back as `null`. Sent back unchanged, that `null` reached a
 * `z.string().optional()` — which takes a string or nothing — and the save
 * failed with Zod's English «Expected string, received null» under a field the
 * officer had not touched. Found live: a non-resident owner whose phone was
 * «غير مؤكَّد»; the officer filled the phone in, unticked «واتساب على الرقم نفسه»,
 * and could not save.
 */

const ownerEdit = (contact: Record<string, unknown>, personal: Record<string, unknown> = {}) =>
  adminUpdateCitizenSubmissionSchema.safeParse({
    residence: 'NON_RESIDENT_OWNER',
    personal: { firstName: 'يوسف', lastName: 'جفال', residencePlace: 'بيروت', ...personal },
    contact,
    properties: [],
    flags: [],
  });

const messages = (result: ReturnType<typeof ownerEdit>) =>
  result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

describe('an edit carrying the stored record’s nulls', () => {
  it('saves with WhatsApp null while «same as phone» is ticked', () => {
    const result = ownerEdit({ phone: '03406049', whatsappSameAsPhone: true, whatsapp: null });
    expect(messages(result)).toEqual([]);
    expect(result.success && result.data.contact.whatsapp).toBe('+9613406049');
  });

  it('asks for the WhatsApp number in Arabic — not Zod’s English — once the box is unticked', () => {
    const result = ownerEdit({ phone: '03406049', whatsappSameAsPhone: false, whatsapp: null });
    expect(messages(result)).toEqual(['contact.whatsapp: رقم الواتساب مطلوب']);
  });

  it('saves once the officer types the WhatsApp number', () => {
    const result = ownerEdit({ phone: '03406049', whatsappSameAsPhone: false, whatsapp: '70123456' });
    expect(messages(result)).toEqual([]);
    expect(result.success && result.data.contact.whatsapp).toBe('+96170123456');
  });

  it('treats null on any optional personal or contact field as not entered', () => {
    const result = ownerEdit(
      { phone: '03406049', whatsappSameAsPhone: true, whatsapp: null, localContactName: null, localContactPhone: null },
      { middleName: null },
    );
    expect(messages(result)).toEqual([]);
  });

  it('never shows Zod’s English type message for a phone', () => {
    const result = ownerEdit({ phone: 3406049, whatsappSameAsPhone: true });
    expect(messages(result).join(' ')).not.toMatch(/Expected/);
  });
});
