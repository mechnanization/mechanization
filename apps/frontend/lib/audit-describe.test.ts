import { describe, expect, it } from 'vitest';
import { describeAudit } from './audit-describe';
import type { AuditEntry } from './api-client';

const entry = (before: unknown, after: unknown): AuditEntry => ({
  id: 'a1',
  actorId: null,
  actorType: 'STAFF',
  actorRole: 'FIELD_INSPECTOR',
  actorEmail: null,
  action: 'CITIZEN_UPDATED',
  entityType: 'User',
  entityId: 'c1',
  before,
  after,
  ipAddress: null,
  createdAt: '2026-09-28T10:00:00.000Z',
});

describe('describeAudit — a citizen edit, field by field', () => {
  it('shows ordinary fields as before → after and names sensitive ones without values', () => {
    const described = describeAudit(
      entry(
        { maritalStatus: 'MARRIED' },
        { maritalStatus: 'SINGLE', changed: ['maritalStatus', 'civilRecordNumber', 'phone'] },
      ),
      'ar',
    );
    expect(described.changes).toHaveLength(1);
    expect(described.changes[0]!.before).not.toBe(described.changes[0]!.after);
    const sensitive = described.facts.find((fact) => /لا تُحفظ القيمة/.test(fact.label));
    expect(sensitive?.value).toMatch(/السجل/);
    // Not listed twice: a field with values is not named again as merely changed.
    expect(described.facts.some((fact) => fact.label === 'الحقول المعدَّلة')).toBe(false);
  });

  it('writes one line per card change', () => {
    const described = describeAudit(
      entry(null, {
        cards: [
          {
            cardId: 'k1',
            kind: 'changed',
            propertyType: 'BUILDING',
            propertyNumber: '45',
            occupancyType: 'OWNER',
            fields: [{ field: 'unitArea', before: 100, after: 120 }],
            sensitive: ['landlordPhone'],
            rows: { added: 1, removed: 0, changed: 2 },
          },
          { cardId: 'k2', kind: 'removed', propertyType: 'HOUSE', propertyNumber: '46', occupancyType: 'TENANT' },
        ],
      }),
      'ar',
    );
    const area = described.changes.find((change) => /عقار 45/.test(change.label));
    // Digits follow the runtime's locale data; either form is the right number.
    expect(area?.before).toMatch(/^(100|١٠٠)$/);
    expect(area?.after).toMatch(/^(120|١٢٠)$/);
    expect(described.facts.some((fact) => /عقار 45/.test(fact.label) && /عُدِّل دون حفظ القيمة/.test(fact.label))).toBe(true);
    expect(described.facts.some((fact) => /الوحدات/.test(fact.label) && /أُضيفت 1/.test(fact.value))).toBe(true);
    expect(described.facts.some((fact) => fact.label === 'حُذفت بطاقة' && /46/.test(fact.value))).toBe(true);
  });
});

describe('describeAudit — reasons', () => {
  it('reads an ending’s reason code as words, and leaves a written reason as written', () => {
    const ended = describeAudit(
      { ...entry(null, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: '2026-08-15T00:00:00.000Z' }), action: 'OWNERSHIP_ENDED' },
      'ar',
    );
    const quote = ended.quotes.find((line) => line.label === 'السبب');
    expect(quote?.value).not.toBe('OWNERSHIP_TRANSFERRED');
    expect(quote?.value).toMatch(/[؀-ۿ]/);

    const written = describeAudit(entry(null, { reason: 'المحل الثاني سُجّل خطأً', cards: [] }), 'ar');
    expect(written.quotes.find((line) => line.label === 'السبب')?.value).toBe('المحل الثاني سُجّل خطأً');
  });
});

describe('describeAudit — the archive, the relative’s number, and damage readings', () => {
  it('quotes who asked for a file to be archived, beside the reason', () => {
    const archived = describeAudit(
      { ...entry(null, { reason: 'ملف مكرّر لنفس الشخص', requestedBy: 'المختار' }), action: 'CITIZEN_DEACTIVATED' },
      'ar',
    );
    expect(archived.quotes).toEqual(
      expect.arrayContaining([
        { label: 'السبب', value: 'ملف مكرّر لنفس الشخص' },
        { label: 'بطلب من', value: 'المختار' },
      ]),
    );
    // Said once, as a quote — not again as a raw field.
    expect([...archived.facts, ...archived.details].some((line) => /requested/i.test(line.label))).toBe(false);
  });

  it('names a relative’s number as changed without ever valuing it', () => {
    const described = describeAudit(entry(null, { changed: ['contactPhone', 'hasNoPhone'], hasNoPhone: true }), 'ar');
    const sensitive = described.facts.find((fact) => /لا تُحفظ القيمة/.test(fact.label));
    expect(sensitive?.value).toMatch(/رقم للتواصل/);
    expect(described.facts.some((fact) => fact.label === 'لا يملك رقم هاتف' && fact.value === 'نعم')).toBe(true);
  });

  it('says a link was made through a relative’s number', () => {
    const linked = describeAudit({ ...entry(null, { matchedBy: 'CONTACT' }), action: 'LANDLORD_LINKED' }, 'ar');
    expect(linked.facts).toContainEqual({ label: 'طريقة المطابقة', value: expect.stringMatching(/أحد أقاربه/) });
  });

  it('reads a damage reading in words, its re-inspection as a calendar day', () => {
    const reading = describeAudit(
      {
        ...entry(null, {
          level: 'UNSAFE_EVACUATE',
          unitCode: 'Z-1-45-A-101',
          habitable: false,
          reinspectAt: '2026-11-15',
          source: 'FIELD_VISIT',
        }),
        action: 'DAMAGE_RECORDED',
        entityType: 'Building',
      },
      'ar',
    );
    const value = (label: string) => reading.facts.find((fact) => fact.label === label)?.value;
    expect(value('الوحدة')).toBe('Z-1-45-A-101');
    expect(value('مستوى الضرر')).not.toBe('UNSAFE_EVACUATE');
    expect(value('صالحة للسكن')).toBe('لا');
    expect(value('مصدر التقييم')).not.toBe('FIELD_VISIT');
    expect(value('موعد إعادة الكشف')).toMatch(/15/);
    expect(value('موعد إعادة الكشف')).not.toMatch(/:/);
  });

  it('writes the English page in English, separators included', () => {
    const described = describeAudit(entry(null, { changed: ['fatherName', 'motherName', 'phone'] }), 'en');
    const all = [...described.facts, ...described.quotes, ...described.details, ...described.changes]
      .flatMap((line) => Object.values(line))
      .join(' ');
    expect(all).not.toMatch(/[؀-ۿ]/);
  });
});
