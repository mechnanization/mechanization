import { describe, expect, it } from 'vitest';
import type { CitizenFormValues } from '@/components/admin/citizen-form';
import { applyResidenceMove, planResidenceMove } from './residence-move';

const file = (properties: CitizenFormValues['properties'], personal: Record<string, unknown> = { firstName: 'علي', lastName: 'تجربة' }): CitizenFormValues => ({
  residence: 'RESIDENT',
  personal,
  contact: { phone: '+96170000001', whatsappSameAsPhone: true },
  properties,
  flags: new Map(),
  unverified: new Map(),
});

const rentsFlat = { id: 'rent-flat', occupancyType: 'TENANT', propertyType: 'BUILDING', propertyNumber: '45', units: [{ id: 'r1', unitType: 'APARTMENT', floor: '2' }] } as const;
const rentsShop = { id: 'rent-shop', occupancyType: 'TENANT', propertyType: 'BUILDING', propertyNumber: '46', units: [{ id: 'r2', unitType: 'SHOP', floor: '0' }] } as const;
const ownsHouseLivesThere = { id: 'own-house', occupancyType: 'OWNER', propertyType: 'HOUSE', propertyNumber: '47', unitStatus: 'OWNER_OCCUPIED' } as const;

describe('planResidenceMove — moving out of the town', () => {
  it('ends the flat they rent, keeps the shop, and asks about the home they lived in', () => {
    const plan = planResidenceMove(file([rentsFlat, rentsShop, ownsHouseLivesThere] as never), 'NON_RESIDENT_OWNER');
    expect(plan.tenancies).toEqual([{ cardIndex: 0, cardId: 'rent-flat', propertyNumber: '45', propertyType: 'BUILDING' }]);
    expect(plan.needsUnitType).toEqual([]);
    expect(plan.homes.map((home) => [home.key, home.status])).toEqual([['card:2', 'OWNER_OCCUPIED']]);
    expect(plan.nothingLeft).toBe(false);
  });

  it('someone who only rented a home here has nothing left: deactivate, do not switch', () => {
    const rentsHouse = { id: 'h', occupancyType: 'TENANT', propertyType: 'HOUSE', propertyNumber: '50' };
    expect(planResidenceMove(file([rentsHouse] as never), 'NON_RESIDENT_OWNER')).toMatchObject({
      tenancies: [{ cardId: 'h' }],
      nothingLeft: true,
    });
    expect(planResidenceMove(file([]), 'NON_RESIDENT_OWNER').nothingLeft).toBe(true);
  });

  it('a rental of unknown type has to be named first', () => {
    const unknown = { id: 'u', occupancyType: 'TENANT', propertyType: 'BUILDING', propertyNumber: '51', units: [{ id: 'r', floor: '1' }] };
    const plan = planResidenceMove(file([unknown, ownsHouseLivesThere] as never), 'NON_RESIDENT_OWNER');
    expect(plan.needsUnitType).toEqual([{ cardIndex: 0, propertyNumber: '51' }]);
    expect(plan.tenancies).toEqual([]);
  });

  it('applies the answers to the form, and nothing else', () => {
    const owner = { id: 'own-b', occupancyType: 'OWNER', propertyType: 'BUILDING', propertyNumber: '52', units: [{ id: 'f', unitType: 'APARTMENT', floor: '1', unitStatus: 'OWNER_OCCUPIED' }, { id: 'g', unitType: 'SHOP', floor: '0', unitStatus: 'RENTED' }] };
    const values = file([owner, ownsHouseLivesThere] as never);
    const plan = planResidenceMove(values, 'NON_RESIDENT_OWNER');
    expect(plan.homes.map((home) => home.key)).toEqual(['row:0:0', 'card:1']);
    const next = applyResidenceMove(values, plan, {
      movedOn: '2026-09-01',
      reason: 'انتقل للسكن في بيروت',
      residencePlace: ' بيروت ',
      homeStatuses: { 'row:0:0': 'RENTED', 'card:1': 'SEASONAL' },
    });
    expect(next.residence).toBe('NON_RESIDENT_OWNER');
    expect(next.personal.residencePlace).toBe('بيروت');
    expect(next.properties[0]!.units!.map((unit) => unit.unitStatus)).toEqual(['RENTED', 'RENTED']);
    expect(next.properties[1]!.unitStatus).toBe('SEASONAL');
    expect(next.residenceMove).toEqual({ movedOn: '2026-09-01', reason: 'انتقل للسكن في بيروت' });
    // The form it came from is untouched.
    expect(values.properties[1]!.unitStatus).toBe('OWNER_OCCUPIED');
  });
});

describe('planResidenceMove — coming to live in the town', () => {
  it('offers their own homes nobody else is in, and names the household questions still open', () => {
    const owner = {
      id: 'own-b',
      occupancyType: 'OWNER',
      propertyType: 'BUILDING',
      propertyNumber: '52',
      units: [
        { id: 'f', unitType: 'APARTMENT', floor: '1', unitStatus: 'VACANT' },
        { id: 'g', unitType: 'APARTMENT', floor: '2', unitStatus: 'RENTED' },
        { id: 'h', unitType: 'SHOP', floor: '0' },
      ],
    };
    const seasonal = { ...ownsHouseLivesThere, unitStatus: 'SEASONAL' };
    const values = { ...file([owner, seasonal] as never), residence: 'NON_RESIDENT_OWNER' as const };
    values.flags.set('personal.motherName', 'لا يعرفها المجيب');
    const plan = planResidenceMove(values, 'RESIDENT');
    expect(plan.homes.map((home) => home.key)).toEqual(['row:0:0', 'card:1']);
    expect(plan.householdMissing.length).toBeGreaterThan(0);
    expect(plan.householdMissing).not.toContain('motherName');
    expect(plan.householdMissing).not.toContain('firstName');

    const next = applyResidenceMove(values, plan, { movedOn: '2026-09-01', reason: 'عاد للسكن في البلدة', livesIn: 'card:1' });
    expect(next.residence).toBe('RESIDENT');
    expect(next.properties[1]!.unitStatus).toBe('OWNER_OCCUPIED');
    expect(next.properties[0]!.units![0]!.unitStatus).toBe('VACANT');

    const elsewhere = applyResidenceMove(values, plan, { movedOn: '2026-09-01', reason: 'عاد', livesIn: null });
    expect(elsewhere.properties).toEqual(values.properties);
  });
});
