import {
  adminCreateCitizenSubmissionSchema,
  adminUpdateCitizenSubmissionSchema,
  isFlaggablePath,
} from '@mechanization/shared-schemas';
import { citizenColumnsForEdit } from './citizens.service';
import { SENSITIVE_FILE_FIELDS } from './file-changes';

/**
 * «لا يملك رقم هاتف» and «رقم للتواصل» — migration 0069.
 *
 * ## What is actually being protected
 *
 * A great many elderly citizens own no phone. The form required one, so
 * officers filed whoever brought them to the hall — a son, a daughter — into
 * `phone`. That number then *is* the citizen's as far as every reader of the
 * column is concerned, and three of them draw the wrong conclusion: citizen
 * sign-in offers the father's file to the son, «روابط المالكين» treats the
 * number as one the father answers on, and «شخص مسجَّل مرتين» scores the two
 * as one person.
 *
 * So the tests below are not "a checkbox works". Each one pins a property that
 * something downstream already depends on:
 *
 *  1. **The standard record is untouched.** The phone requirement is now
 *     expressed by a refinement instead of the field's own type, which is
 *     exactly the kind of change that silently makes a required field
 *     optional. The first block is there to fail if it ever does.
 *  2. **The flag is an absence, not an empty string.** `''` satisfies
 *     `phone IS NOT NULL`, is handed to `findCitizensByPhone`, and scores as a
 *     shared "number" against every other blank record. The column has to
 *     hold nothing at all.
 *  3. **«رقم للتواصل» is never an identity.** It is deliberately not unique
 *     and deliberately absent from sign-in and duplicate scoring — a father,
 *     a mother and a grandmother are commonly reached on one son's phone.
 *  4. **The correction frees the number.** The acceptance case: a file holding
 *     the son's number in `phone` ends with `phone` NULL and the son's number
 *     recorded as a relative's, which is what stops anything reading it as the
 *     father's.
 *
 * There is no uniqueness test here because there is no uniqueness rule: a
 * household sharing one phone is the designed case (`users`' own comment,
 * `docs/open-decisions.md` §4, and `verifyOtp`'s CHOOSE_PROFILE), and the
 * partial unique index the feature request asked for was deliberately not
 * added — see the migration's header.
 */

const household = (contact: Record<string, unknown> = {}) => ({
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    motherName: 'فاطمة خليل',
    gender: 'MALE',
    civilRecordNumber: '7',
    nationality: 'لبناني',
    isLebanese: true,
    residentStatus: 'VILLAGE_RESIDENT',
  } as Record<string, unknown>,
  contact: {
    maritalStatus: 'MARRIED',
    whatsappSameAsPhone: true,
    actualHouseholdMembers: '4',
    ...contact,
  } as Record<string, unknown>,
  properties: [] as Array<Record<string, unknown>>,
  flags: [] as Array<Record<string, unknown>>,
});

const create = (contact: Record<string, unknown> = {}) =>
  adminCreateCitizenSubmissionSchema.safeParse(household(contact));

const edit = (contact: Record<string, unknown> = {}) =>
  adminUpdateCitizenSubmissionSchema.safeParse({ residence: 'RESIDENT', ...household(contact) });

const messages = (result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);

const contactOf = (result: ReturnType<typeof create>) => {
  if (!result.success) throw new Error(JSON.stringify(messages(result)));
  return (result.data as { contact: Record<string, unknown> }).contact;
};

describe('a citizen who has a phone — unchanged by this release', () => {
  it('still requires the primary number, in Arabic and on its own path', () => {
    expect(messages(create({ phone: undefined }))).toEqual(['contact.phone: رقم الهاتف مطلوب']);
  });

  it('still refuses an empty primary number rather than storing a blank', () => {
    expect(messages(create({ phone: '' }))).toEqual(['contact.phone: رقم الهاتف مطلوب']);
  });

  it('still refuses a malformed number', () => {
    expect(messages(create({ phone: '12' })).join(' ')).toMatch(/رقم الهاتف غير صالح/);
  });

  it('still normalises to E.164 and copies the phone to WhatsApp', () => {
    const contact = contactOf(create({ phone: '70 123456' }));
    expect(contact.phone).toBe('+96170123456');
    expect(contact.whatsapp).toBe('+96170123456');
  });

  it('reads a submission that never mentions the flag as a citizen who has a phone', () => {
    /*
      `shapeSubmission` parses the sections through the *partial* schemas, and
      `.partial()` drops a `.default()` — so a client that does not send
      `hasNoPhone` produces no key at all rather than `false`. Every consumer
      therefore asks `=== true` and never `!== false`, which is what keeps an
      older build, an offline queue and an import writing exactly what they
      wrote before. This test is here so that stays true.
    */
    const result = edit({ phone: '70123456' });
    if (!result.success) throw new Error(JSON.stringify(messages(result)));
    expect((result.data as { contact: Record<string, unknown> }).contact.hasNoPhone).toBeUndefined();

    const columns = citizenColumnsForEdit(result.data as never);
    expect(columns.hasNoPhone).toBe(false);
    expect(columns.phone).toBe('+96170123456');
  });

  it('still asks for a WhatsApp number of its own once «نفس رقم الهاتف» is unticked', () => {
    expect(messages(create({ phone: '70123456', whatsappSameAsPhone: false }))).toEqual([
      'contact.whatsapp: رقم الواتساب مطلوب',
    ]);
  });

  it('offers the phone a «غير مؤكَّد» flag, as it always did', () => {
    expect(isFlaggablePath('contact.phone')).toBe(true);
  });
});

describe('«لا يملك رقم هاتف» — an elderly citizen with no number', () => {
  it('saves with no phone at all', () => {
    const result = create({ hasNoPhone: true, phone: undefined });
    expect(messages(result)).toEqual([]);
    expect(contactOf(result).hasNoPhone).toBe(true);
  });

  it('clears a number the client sent anyway — the flag decides, not the field', () => {
    /*
      Not hypothetical: a record queued offline on an inspector's phone before
      this shipped, a replayed submission, or a stale draft can all arrive with
      the box ticked and the old number still in the payload. Trusting the
      field would leave a relative's number in the identity column while the
      file claimed to have none, which is the exact state this feature exists
      to end.
    */
    const contact = contactOf(create({ hasNoPhone: true, phone: '70 123456' }));
    expect(contact.phone).toBeUndefined();
    expect(contact.whatsapp).toBeUndefined();
    expect(contact.hasNoPhone).toBe(true);
  });

  it('never asks for a WhatsApp number it has nowhere to copy from', () => {
    expect(messages(create({ hasNoPhone: true, whatsappSameAsPhone: false }))).toEqual([]);
  });

  it('writes both columns as NULL, not as an empty string', () => {
    /*
      The property the rest of the system rests on. `''` would satisfy
      `phone IS NOT NULL`, reach `findCitizensByPhone`, and match every other
      blank record as a "shared" number.
    */
    const result = edit({ hasNoPhone: true, phone: '70123456' });
    if (!result.success) throw new Error(JSON.stringify(messages(result)));
    const columns = citizenColumnsForEdit(result.data as never);
    expect(columns.phone).toBeNull();
    expect(columns.whatsapp).toBeNull();
    expect(columns.hasNoPhone).toBe(true);
  });
});

describe('«رقم للتواصل» — a relative’s number, recorded as a relative’s', () => {
  it('is accepted and normalised beside a phone the citizen does have', () => {
    const contact = contactOf(create({ phone: '70123456', contactPhone: '03 999888' }));
    expect(contact.phone).toBe('+96170123456');
    expect(contact.contactPhone).toBe('+9613999888');
  });

  it('is optional even with no phone — a citizen with nobody to name is a real record', () => {
    /*
      Refusing to save would send the officer back to typing a relative's
      number into `phone`, which is the habit being removed.
    */
    expect(messages(create({ hasNoPhone: true }))).toEqual([]);
  });

  it('is still refused when it is not a phone number at all', () => {
    expect(messages(create({ phone: '70123456', contactPhone: '12' })).join(' ')).toMatch(
      /رقم الهاتف غير صالح/,
    );
  });

  it('may be the very same number on two different files', () => {
    /*
      A father and a grandmother both reached on one son's phone. Nothing in
      the schema or the database objects, and that is deliberate — the column
      carries no unique index for this reason.
    */
    const father = contactOf(create({ hasNoPhone: true, contactPhone: '70999888' }));
    const grandmother = contactOf(create({ hasNoPhone: true, contactPhone: '70 999 888' }));
    expect(father.contactPhone).toBe('+96170999888');
    expect(grandmother.contactPhone).toBe(father.contactPhone);
  });

  it('is never written into the audit trail as a value', () => {
    /*
      It is somebody else's number — a son's, a neighbour's — and they never
      dealt with the municipality. The trail records that the field changed
      and nothing more (Law 81/2018 minimisation).
    */
    expect(SENSITIVE_FILE_FIELDS.has('contactPhone')).toBe(true);
    // The flag itself carries nothing about anybody and stays readable, so the
    // trail can say the file was corrected rather than that numbers moved.
    expect(SENSITIVE_FILE_FIELDS.has('hasNoPhone')).toBe(false);
  });
});

describe('the correction that frees the son’s number', () => {
  /*
    The acceptance case, end to end through the two pure functions the save is
    made of. The father's file holds +96170555444 — the son's number, typed
    into `phone` because the form demanded one. The officer ticks the box and
    moves it to «رقم للتواصل».
  */
  const SON = '+96170555444';

  it('leaves the father with no phone and the son’s number as a relative’s', () => {
    const result = edit({ hasNoPhone: true, phone: SON, contactPhone: SON });
    if (!result.success) throw new Error(JSON.stringify(messages(result)));

    const columns = citizenColumnsForEdit(result.data as never);
    expect(columns.phone).toBeNull();
    expect(columns.whatsapp).toBeNull();
    expect(columns.hasNoPhone).toBe(true);
    expect(columns.contactPhone).toBe(SON);
  });

  it('keeps the relative’s number when the officer unticks the box again', () => {
    /*
      Two true facts, not a contradiction: an officer who establishes that the
      citizen does have a phone after all has not withdrawn the son's number.
    */
    const result = edit({ hasNoPhone: false, phone: '03111222', contactPhone: SON });
    if (!result.success) throw new Error(JSON.stringify(messages(result)));

    const columns = citizenColumnsForEdit(result.data as never);
    expect(columns.phone).toBe('+9613111222');
    expect(columns.hasNoPhone).toBe(false);
    expect(columns.contactPhone).toBe(SON);
  });
});

/*
  The requirement used to live only in the contact schema's refinement, which
  zod runs once the rest of the section is valid — so a flag on any other
  contact field, or «حفظ سريع», let a household file save with no phone, no flag
  and no answer. These pin that it no longer depends on the rest of the section.
*/
describe('the phone requirement stands whatever else in the section is missing', () => {
  it('still refuses a blank phone when another contact field is flagged', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...household({ phone: '', maritalStatus: undefined }),
      flags: [{ path: 'contact.maritalStatus', reason: 'لم يُسأل', kind: 'UNESTABLISHED' }],
    });
    expect(messages(result)).toEqual(['contact.phone: رقم الهاتف مطلوب']);
  });

  it('reports the phone beside the other gaps, not only after they are fixed', () => {
    expect(messages(create({ phone: '', maritalStatus: undefined }))).toEqual(
      expect.arrayContaining(['contact.phone: رقم الهاتف مطلوب']),
    );
  });

  it('lets «حفظ سريع» flag a blank phone like any other blank field', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...household({ phone: '' }),
      blanketFlagReason: 'المواطن لم يحضر أوراقه',
    });
    expect(messages(result)).toEqual([]);
    const flags = (result.data as { flags: Array<{ path: string }> }).flags.map((flag) => flag.path);
    expect(flags).toContain('contact.phone');
  });

  it('still asks for a WhatsApp number of its own when another field is flagged', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...household({ phone: '70123456', whatsappSameAsPhone: false, maritalStatus: undefined }),
      flags: [{ path: 'contact.maritalStatus', reason: 'لم يُسأل', kind: 'UNESTABLISHED' }],
    });
    expect(messages(result)).toEqual(['contact.whatsapp: رقم الواتساب مطلوب']);
  });

  it('accepts «لا يملك رقم هاتف» with another field flagged', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...household({ hasNoPhone: true, phone: '', maritalStatus: undefined }),
      flags: [{ path: 'contact.maritalStatus', reason: 'لم يُسأل', kind: 'UNESTABLISHED' }],
    });
    expect(messages(result)).toEqual([]);
  });
});

describe('«لا يملك رقم هاتف» is a complete answer', () => {
  it('drops a «غير مؤكَّد» flag on the phone or WhatsApp sent beside it', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...household({ hasNoPhone: true }),
      flags: [
        { path: 'contact.phone', reason: 'مسودة قديمة', kind: 'UNESTABLISHED' },
        { path: 'contact.whatsapp', reason: 'مسودة قديمة', kind: 'UNESTABLISHED' },
      ],
    });
    expect(messages(result)).toEqual([]);
    expect((result.data as { flags: unknown[] }).flags).toEqual([]);
  });

  it('refuses «رقم للتواصل» that is the citizen’s own phone, however it is written', () => {
    expect(messages(create({ phone: '70 123456', contactPhone: '+96170123456' }))).toEqual([
      'contact.contactPhone: رقم للتواصل هو رقم المواطن نفسه — اتركه فارغاً أو أدخل رقم أحد أقاربه',
    ]);
  });
});
