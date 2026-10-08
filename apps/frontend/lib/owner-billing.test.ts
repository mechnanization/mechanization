import { describe, expect, it } from 'vitest';
import type { UnitOccupant, UnitWithOccupants } from './api-client';
import {
  archivedOwners,
  currentOwners,
  ownerBillingWording,
  ownerSpells,
  parseShares,
  showsOwnerBilling,
  type OwnerBillingView,
} from './owner-billing';

let seq = 0;
const spell = (citizenId: string, over: Partial<UnitOccupant> = {}): UnitOccupant => ({
  id: `spell-${(seq += 1)}`,
  unitId: 'u-1',
  citizenId,
  citizenName: citizenId,
  role: 'OWNER',
  shares: null,
  fromDate: '2026-01-01T00:00:00.000Z',
  toDate: null,
  registrationId: null,
  ...over,
});

type Unit = Pick<UnitWithOccupants, 'occupants' | 'ownerBillingMode' | 'unitType'>;
const unit = (occupants: UnitOccupant[], over: Partial<Unit> = {}): Unit => ({
  occupants,
  ownerBillingMode: null,
  unitType: 'SHOP',
  ...over,
});

describe('parseShares — أسهم as typed', () => {
  it('reads a whole number from 1 to 2400, and nothing else', () => {
    expect(parseShares('1200')).toBe(1200);
    expect(parseShares(' 600 ')).toBe(600);
    expect(parseShares('1')).toBe(1);
    expect(parseShares('2400')).toBe(2400);
    for (const wrong of ['', '0', '2401', '12.5', '-3', '1e3', '0x10', 'مئة']) expect(parseShares(wrong)).toBeNull();
  });

  it('reads Arabic-Indic and Persian digits as the numbers they are', () => {
    expect(parseShares('١٢٠٠')).toBe(1200);
    expect(parseShares('۶۰۰')).toBe(600);
    expect(parseShares('٢٤٠١')).toBeNull();
  });
});

describe('the owners of a flat', () => {
  const flat = [
    spell('maarouf', { fromDate: '2026-03-01T00:00:00.000Z' }),
    spell('ali', { fromDate: '2026-01-01T00:00:00.000Z', recordedAt: '2026-05-02T00:00:00.000Z' }),
    spell('aref', { fromDate: '2026-01-01T00:00:00.000Z', recordedAt: '2026-05-01T00:00:00.000Z' }),
    spell('ali', { fromDate: '2026-04-01T00:00:00.000Z' }),
    spell('hussein', { citizenActive: false, fromDate: '2026-02-01T00:00:00.000Z' }),
    spell('tenant', { role: 'TENANT' }),
    spell('sold', { toDate: '2026-06-01T00:00:00.000Z' }),
  ];

  it('lists current owners once each, in the order the server reads them, archived files included', () => {
    expect(ownerSpells(unit(flat)).map((owner) => owner.citizenId)).toEqual(['aref', 'ali', 'hussein', 'maarouf']);
  });

  it('divides between open files only; the archived are named apart', () => {
    expect(currentOwners(unit(flat)).map((owner) => owner.citizenId)).toEqual(['aref', 'ali', 'maarouf']);
    expect(archivedOwners(unit(flat)).map((owner) => owner.citizenId)).toEqual(['hussein']);
  });

  it('shows the panel for two open owners, or a saved choice to withdraw — never on a structural floor', () => {
    expect(showsOwnerBilling(unit([spell('ali'), spell('aref')]))).toBe(true);
    expect(showsOwnerBilling(unit([spell('ali'), spell('aref', { citizenActive: false })]))).toBe(false);
    expect(showsOwnerBilling(unit([spell('ali')], { ownerBillingMode: 'BY_SHARES' }))).toBe(true);
    expect(showsOwnerBilling(unit([spell('ali'), spell('aref')], { unitType: 'PILOTIS' }))).toBe(false);
  });
});

describe('ownerBillingWording — one wording for the staff file and «ملفّي»', () => {
  const billing = (over: Partial<OwnerBillingView>): OwnerBillingView => ({
    mode: 'RESPONSIBLE_OWNER',
    effectiveMode: 'RESPONSIBLE_OWNER',
    share: { numerator: 1, denominator: 1 },
    ...over,
  });

  it('decides «مالك مسؤول» from the part alone, the same way for both audiences', () => {
    const payer = billing({});
    const other = billing({ share: { numerator: 0, denominator: 1 } });
    expect(ownerBillingWording(payer, 'ar', 'file').part).toBe('يدفع الرسم عن جميع المالكين');
    expect(ownerBillingWording(payer, 'ar', 'mine').part).toBe('تدفع الرسم عن جميع المالكين');
    expect(ownerBillingWording(other, 'ar', 'file').part).toBe('لا يُفوتر عنها — يدفع المالك المسؤول');
    expect(ownerBillingWording(other, 'ar', 'mine').part).toBe('يدفع عنك مالك آخر');
  });

  it('says the default, a part and an unknown part, and joins them through the message, not by hand', () => {
    const equal = ownerBillingWording(
      billing({ mode: null, effectiveMode: 'EQUAL', share: { numerator: 1, denominator: 4 } }),
      'ar',
      'mine',
    );
    expect(equal).toMatchObject({ method: 'بالتساوي (لم تُختر طريقة)', part: 'حصّتك 1/4 من الرسم', fallback: null });
    expect(equal.line).toBe('بالتساوي (لم تُختر طريقة) — حصّتك 1/4 من الرسم');
    const unknown = ownerBillingWording(billing({ mode: 'BY_SHARES', effectiveMode: 'BY_SHARES', share: null }), 'en', 'file');
    expect(unknown.part).toBe('Part unknown — the owners’ shares are incomplete');
  });

  it('carries the fallback to the staff file only when the server says there is one', () => {
    const fallen = billing({ effectiveMode: 'EQUAL', fallback: 'RESPONSIBLE_NOT_OWNER', share: { numerator: 1, denominator: 3 } });
    expect(ownerBillingWording(fallen, 'en', 'file').fallback).toMatch(/split equally/);
    expect(ownerBillingWording(billing({}), 'en', 'file').fallback).toBeNull();
  });
});
