import type { OwnerBillingRule } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { activeOwnerSpells, checkResponsibleOwners, ownerBillingBlock } from '../buildings/owner-billing';
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

  it('names a responsible owner whose own file no longer claims the flat (F13), once billing has asked', () => {
    const responsible = rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    expect(ownerBillingBlock({ ...responsible, responsibleBilled: false })).toEqual({
      reason: 'RESPONSIBLE_NOT_BILLED',
      owners: 2,
    });
    expect(ownerBillingBlock({ ...responsible, responsibleBilled: true })).toBeNull();
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

  it('says of a responsible owner whose file stopped claiming the flat that he still owns it and is not billed for it', () => {
    const finding = ownerBillingBlockedFinding(unit, { reason: 'RESPONSIBLE_NOT_BILLED', owners: 3 }, building);
    expect(finding.severity).toBe('MEDIUM');
    const [fact, meanwhile] = finding.detail.split(' — ');
    expect(fact).toContain('ما زال مالكاً');
    expect(fact).toContain('ملفه');
    expect(meanwhile).toMatch(/بالتساوي/);
    expect(finding.detail).not.toBe(ownerBillingBlockedFinding(unit, { reason: 'RESPONSIBLE_NOT_OWNER', owners: 3 }, building).detail);
  });
});

describe('checkResponsibleOwners — the question billing asks of «مالك مسؤول» (F13)', () => {
  const responsible = (id: string, owner = 'ali') => [id, rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: owner })] as const;

  it('marks each flat by whether the responsible owner’s own file claims it, reading each owner once', async () => {
    const rules = new Map<string, OwnerBillingRule>([responsible('u-1'), responsible('u-2'), responsible('u-3', 'maarouf')]);
    const asked: string[] = [];
    await checkResponsibleOwners(rules, async (citizenId) => {
      asked.push(citizenId);
      return new Set(citizenId === 'ali' ? ['u-1'] : ['u-3']);
    });
    expect(asked.sort()).toEqual(['ali', 'maarouf']);
    expect(rules.get('u-1')!.responsibleBilled).toBe(true);
    expect(rules.get('u-2')!.responsibleBilled).toBe(false);
    expect(rules.get('u-3')!.responsibleBilled).toBe(true);
  });

  it('asks nothing of another method, or of a responsible owner who is no longer an owner', async () => {
    const rules = new Map<string, OwnerBillingRule>([
      ['u-1', rule()],
      ['u-2', rule({ mode: 'EQUAL' })],
      responsible('u-3', 'gone'),
    ]);
    const claimsOf = jest.fn(async () => new Set<string>());
    await checkResponsibleOwners(rules, claimsOf);
    expect(claimsOf).not.toHaveBeenCalled();
    for (const checked of rules.values()) expect(checked.responsibleBilled).toBeUndefined();
  });
});

describe('the OWNER_BILLING_BLOCKED scan', () => {
  function scanWith(units: unknown[], claims: Record<string, string[]> = {}) {
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
    const claimsAsked: string[] = [];
    const fees = {
      ownerClaims: async (citizenId: string) => {
        claimsAsked.push(citizenId);
        return new Set(claims[citizenId] ?? []);
      },
    };
    const quality = new DataQualityService(context, {} as never, {} as never, {} as never, {} as never, fees as never);
    const run = () =>
      context.run(
        { tenantId: 't-1', tenantSlug: 'albazourieh', schemaName: 'tenant_albazourieh', prisma: db as never },
        () => quality['ownerBillingBlocked'](),
      );
    return { run, unitQueries, claimsAsked };
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

  it('lists a flat whose أسهم are all recorded but short of 2400 as OWNER_SHARES_INCOMPLETE (A8)', async () => {
    const short = shop({
      occupancies: [
        { citizenId: 'ali', shares: 800, createdAt: new Date('2026-10-01T08:00:00Z') },
        { citizenId: 'maarouf', shares: 800, createdAt: new Date('2026-10-02T08:00:00Z') },
      ],
    });
    const findings = await scanWith([short]).run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'OWNER_SHARES_INCOMPLETE', subjectKey: 'u-1' });
  });

  it('reports a blocked flat as blocked only: a missing share is the finding, not the sum it leaves', async () => {
    // 1200 + nothing is short of 2400 too, but billing refuses it outright, and that is what the office must hear.
    const findings = await scanWith([shop({})]).run();
    expect(findings.map((finding) => finding.kind)).toEqual(['OWNER_BILLING_BLOCKED']);
  });

  it('reports a flat whose responsible owner’s own file stopped claiming it, through billing’s own reading of the file (F13)', async () => {
    const responsible = (id: string) => shop({ id, ownerBillingMode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    const scan = scanWith([responsible('u-1'), responsible('u-2')], { ali: ['u-2'] });
    const findings = await scan.run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'OWNER_BILLING_BLOCKED', subjectKey: 'u-1', severity: 'MEDIUM' });
    expect(findings[0]!.detail).toContain('ملفه');
    // One read of the responsible owner's file for both of his flats.
    expect(scan.claimsAsked).toEqual(['ali']);
  });
});
