import type { OwnerBillingRule } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { activeOwnerSpells, ownerBillingBlock } from '../buildings/owner-billing';
import { DataQualityService, ownerBillingBlockedFinding } from './data-quality.service';

/**
 * «توزيع على المالكين لا يُطبَّق» (`OWNER_BILLING_BLOCKED`) — the warning that
 * a co-owned flat's saved method is one billing cannot carry out, before the
 * first refused bill says so.
 *
 * The case that made it necessary: a «حسب الأسهم» shop gains a fifth owner
 * spell from a registration, which writes no أسهم. From that moment every
 * co-owner's bill is refused as unassessable, and nothing told the office.
 */

const rule = (over: Partial<OwnerBillingRule> = {}): OwnerBillingRule => ({
  mode: 'BY_SHARES',
  responsibleOwnerId: null,
  owners: [
    { citizenId: 'ali', shares: 1200 },
    { citizenId: 'maarouf', shares: 1200 },
  ],
  ...over,
});

describe('ownerBillingBlock — what stops a saved method', () => {
  it('is nothing while every owner has أسهم', () => {
    expect(ownerBillingBlock(rule())).toBeNull();
  });

  it('counts the owners «حسب الأسهم» is waiting on once a later owner is recorded without أسهم', () => {
    const later = rule({ owners: [...rule().owners, { citizenId: 'aref', shares: null }, { citizenId: 'hussein', shares: 0 }] });
    expect(ownerBillingBlock(later)).toEqual({ reason: 'SHARES_MISSING', owners: 4, missing: 2 });
  });

  it('reads one person with two spells as one owner, with the أسهم either spell holds', () => {
    const twice = rule({
      owners: [
        { citizenId: 'ali', shares: null },
        { citizenId: 'ali', shares: 1200 },
        { citizenId: 'maarouf', shares: 1200 },
      ],
    });
    expect(ownerBillingBlock(twice)).toBeNull();
  });

  it('names a responsible owner who no longer owns the flat — billing splits it equally instead', () => {
    expect(ownerBillingBlock(rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'gone' }))).toEqual({
      reason: 'RESPONSIBLE_NOT_OWNER',
      owners: 2,
    });
    expect(ownerBillingBlock(rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' }))).toBeNull();
  });

  it('has nothing to say about the equal split, or a flat one person owns', () => {
    expect(ownerBillingBlock(rule({ mode: null, owners: [{ citizenId: 'ali', shares: null }, { citizenId: 'maarouf', shares: null }] }))).toBeNull();
    expect(ownerBillingBlock(rule({ mode: 'EQUAL' }))).toBeNull();
    expect(ownerBillingBlock(rule({ owners: [{ citizenId: 'ali', shares: null }] }))).toBeNull();
  });
});

describe('ownerBillingBlockedFinding', () => {
  const building = { id: 'b-1', code: 'A2-420-A', name: null, parcelNumber: '420' };
  const unit = { unitId: 'u-1', unitCode: '0005', at: new Date('2026-10-08T09:00:00Z') };

  it('marks refused bills HIGH and keys the finding by the unit «الإجراء» opens', () => {
    const finding = ownerBillingBlockedFinding(unit, { reason: 'SHARES_MISSING', owners: 4, missing: 1 }, building);
    expect(finding).toMatchObject({
      kind: 'OWNER_BILLING_BLOCKED',
      subjectKey: 'u-1',
      severity: 'HIGH',
      subjects: [{ kind: 'building', id: 'b-1', label: 'A2-420-A', secondary: 'عقار 420' }],
      officerIds: [],
      at: '2026-10-08T09:00:00.000Z',
      dismissable: false,
    });
    expect(finding.detail).toContain('0005');
    expect(finding.detail).toContain('(1 من 4)');
    // The house's two-part sentence: the fact, then what billing does about it.
    expect(finding.detail.split(' — ')).toHaveLength(2);
  });

  it('marks a fallen-back responsible owner MEDIUM and says the flat is split equally meanwhile', () => {
    const finding = ownerBillingBlockedFinding(unit, { reason: 'RESPONSIBLE_NOT_OWNER', owners: 3 }, building);
    expect(finding.severity).toBe('MEDIUM');
    expect(finding.detail.split(' — ')[1]).toMatch(/بالتساوي/);
  });
});

describe('the OWNER_BILLING_BLOCKED scan', () => {
  function scanWith(units: unknown[]) {
    const context = new TenantContextService();
    const unitQueries: unknown[] = [];
    const db = {
      unit: {
        findMany: async (args: unknown) => {
          unitQueries.push(args);
          return units;
        },
      },
      building: {
        findMany: async () => [{ id: 'b-1', code: 'A2-420-A', name: 'سرور', parcelNumber: '420' }],
      },
    };
    const quality = new DataQualityService(context, {} as never, {} as never, {} as never, {} as never);
    const run = () =>
      context.run(
        { tenantId: 't-1', tenantSlug: 'albazourieh', schemaName: 'tenant_albazourieh', prisma: db as never },
        () => quality['ownerBillingBlocked'](),
      );
    return { run, unitQueries };
  }

  const shop = (over: Record<string, unknown>) => ({
    id: 'u-1',
    unitCode: '0005',
    buildingId: 'b-1',
    ownerBillingMode: 'BY_SHARES',
    responsibleOwnerId: null,
    updatedAt: new Date('2026-10-07T08:00:00Z'),
    occupancies: [
      { citizenId: 'ali', shares: 1200, createdAt: new Date('2026-10-01T08:00:00Z') },
      { citizenId: 'maarouf', shares: null, createdAt: new Date('2026-10-08T08:00:00Z') },
    ],
    ...over,
  });

  it('reads the owners billing reads — open files only — and only flats with a method that can be blocked', async () => {
    const { run, unitQueries } = scanWith([]);
    expect(await run()).toEqual([]);
    expect(unitQueries[0]).toMatchObject({
      where: { ownerBillingMode: { in: ['BY_SHARES', 'RESPONSIBLE_OWNER'] } },
      select: { occupancies: { where: activeOwnerSpells({}).where } },
    });
  });

  it('lists a blocked flat under its building, dated by the newest owner spell', async () => {
    const { run } = scanWith([shop({}), shop({ id: 'u-2', occupancies: shop({}).occupancies.map((spell) => ({ ...spell, shares: 1200 })) })]);
    const findings = await run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      subjectKey: 'u-1',
      severity: 'HIGH',
      subjects: [{ id: 'b-1', label: 'A2-420-A — سرور' }],
      at: '2026-10-08T08:00:00.000Z',
    });
  });
});
