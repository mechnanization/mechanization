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
