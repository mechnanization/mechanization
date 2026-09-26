/**
 * The development seed's register, checked without a database.
 *
 * Generating is itself most of the test: every filing goes through
 * `adminCreateCitizenSubmissionSchema` and `PropertyEntry.create`, and the
 * generator throws on the first one either refuses. So a validation rule that
 * tightens fails here, in CI, rather than in the seed on someone's machine —
 * or worse, not at all, leaving records the app refuses to re-save.
 */
import { generateRegister, seedId, SEED_NOW, type SeedStaff, type SeedTenantProfile } from './seed-register';

const staff: SeedStaff = {
  admin: seedId('spec', 'admin'),
  auditor: seedId('spec', 'auditor'),
  officer: seedId('spec', 'officer'),
  accountant: seedId('spec', 'accountant'),
  collector: seedId('spec', 'collector'),
  inspectors: [1, 2, 3, 4].map((n) => seedId('spec', 'inspector', n)),
};

const albazourieh: SeedTenantProfile = {
  slug: 'albazourieh',
  prefix: 'BZR',
  index: 0,
  region: 'south',
  nameAr: 'البازورية',
};
const zahle: SeedTenantProfile = { slug: 'zahle', prefix: 'ZHL', index: 1, region: 'bekaa', nameAr: 'زحلة' };
const parcels = Array.from({ length: 1825 }, (_, i) => String(i + 1));

const south = generateRegister(albazourieh, { citizens: 800, parcels, staff });
const bekaa = generateRegister(zahle, { citizens: 300, parcels: [], staff });
const both = [south, bekaa];

describe('the seeded register', () => {
  it('generates every filing through the API validation, with and without a cadastre', () => {
    expect(south.users).toHaveLength(800);
    expect(bekaa.users).toHaveLength(300);
    expect(south.propertyEntries.length).toBeGreaterThan(800);
  });

  it('puts nothing on the map: no coordinates, no census links', () => {
    for (const r of both) {
      for (const entry of r.propertyEntries) {
        expect(entry.latitude).toBeNull();
        expect(entry.longitude).toBeNull();
        expect(entry.buildingId).toBeNull();
      }
      for (const unit of r.buildingUnits) expect(unit.unitId).toBeNull();
    }
  });

  it('writes only the statuses the app writes, REQUIRES_REVIEW exactly when flagged', () => {
    for (const r of both) {
      for (const reg of r.registrations) {
        const flags = reg.flaggedFields as unknown[];
        expect(reg.status).toBe(flags.length > 0 ? 'REQUIRES_REVIEW' : 'PENDING');
      }
    }
    const flagged = south.registrations.filter((r) => r.status === 'REQUIRES_REVIEW').length;
    // A few percent, like a real register: not zero, not most of it.
    expect(flagged / south.registrations.length).toBeGreaterThan(0.02);
    expect(flagged / south.registrations.length).toBeLessThan(0.2);
  });

  it('flags parcel numbers the cadastre does not hold, and only where there is a cadastre', () => {
    const cadastrePath = (r: typeof south) =>
      r.registrations.flatMap((reg) => reg.flaggedFields as Array<{ path: string; kind: string }>)
        .filter((f) => f.kind === 'UNVERIFIED' && f.path.endsWith('.propertyNumber'));
    expect(cadastrePath(south).length).toBeGreaterThan(0);
    expect(cadastrePath(bekaa)).toHaveLength(0);
  });

  it('keeps unique keys unique', () => {
    for (const r of both) {
      const unique = (values: unknown[]) => expect(new Set(values).size).toBe(values.length);
      unique(r.users.map((u) => u.id));
      unique(r.users.map((u) => u.referenceNumber));
      unique(r.registrations.map((x) => x.referenceNumber));
      unique(r.propertyEntries.map((x) => x.id));
      unique(r.buildingUnits.map((x) => x.id));
      unique(r.users.filter((u) => u.identityDocNumber).map((u) => `${u.identityDocType}|${u.identityDocNumber}`));
      unique(r.registrations.filter((x) => x.clientSubmissionId).map((x) => x.clientSubmissionId));
      unique(r.qualityChecks.map((q) => q.registrationId));
      unique(r.invoices.map((i) => `${i.citizenId}|${i.feeNoticeId}|${i.periodKey}`));
    }
  });

  it('uses only the seed phone range, so no real subscriber is ever named', () => {
    for (const r of both) {
      const phones = [
        ...r.users.flatMap((u) => [u.phone, u.whatsapp, u.localContactPhone]),
        ...r.propertyEntries.map((e) => e.landlordPhone),
      ].filter((p): p is string => typeof p === 'string');
      expect(phones.length).toBeGreaterThan(0);
      for (const phone of phones) expect(phone).toMatch(/^\+96177\d{6}$/);
    }
  });

  it('holds the household check constraint', () => {
    for (const r of both) {
      for (const u of r.users) {
        if (u.actualHouseholdMembers != null && u.totalRegisteredMembers != null) {
          expect(u.actualHouseholdMembers as number).toBeLessThanOrEqual(u.totalRegisteredMembers as number);
        }
      }
    }
  });

  it('approves only after the last edit, and never by the officer who filed', () => {
    for (const r of both) {
      const byId = new Map(r.registrations.map((reg) => [reg.id, reg]));
      for (const review of r.recordReviews) {
        const reg = byId.get(review.registrationId as string)!;
        expect(review.reviewedById).not.toBe(reg.createdById);
        expect((review.createdAt as Date).getTime()).toBeLessThanOrEqual(SEED_NOW.getTime());
        if (review.outcome === 'APPROVED') {
          expect((review.createdAt as Date).getTime()).toBeGreaterThanOrEqual((reg.updatedAt as Date).getTime());
        } else {
          expect(review.reason).toEqual(expect.any(String));
        }
      }
      const openReturns = r.recordReviews.filter((x) => x.outcome === 'RETURNED' && x.resolvedAt === null);
      expect(new Set(openReturns.map((x) => x.registrationId)).size).toBe(openReturns.length);
    }
  });

  it('keeps quality checks inside their CHECK constraint and off the filer', () => {
    for (const r of both) {
      for (const check of r.qualityChecks) {
        const done = check.status === 'DONE';
        expect(check.result !== null).toBe(done);
        expect(check.checkedAt !== null).toBe(done);
        expect(check.assignedToId).not.toBe(check.originalOfficerId);
      }
    }
  });

  it('settles invoices the way the payment ledger does', () => {
    for (const r of both) {
      const paid = new Map<string, number>();
      for (const t of r.transactions) paid.set(t.paymentId, (paid.get(t.paymentId) ?? 0) + t.amount);
      for (const invoice of r.invoices) {
        expect(['UNPAID', 'PAID', 'PENDING_REVIEW']).toContain(invoice.paymentStatus);
        expect(invoice.paidAmount).toBe(paid.get(invoice.id as string) ?? 0);
        expect(invoice.paymentStatus === 'PAID').toBe(invoice.paidAmount === invoice.amount);
      }
    }
  });

  it('includes the deliberate data-quality cases, and only a few of them', () => {
    const flags = south.registrations.flatMap((reg) => reg.flaggedFields as Array<{ path: string }>);
    expect(flags.some((f) => f.path === 'personal.possibleDuplicate')).toBe(true);
    const ownLine = south.propertyEntries.filter((e) => {
      const reg = south.registrations.find((x) => x.id === e.registrationId)!;
      const user = south.users.find((u) => u.id === reg.citizenId)!;
      return e.landlordPhone !== null && e.landlordPhone === user.phone;
    });
    expect(ownLine.length).toBeGreaterThan(0);
    expect(ownLine.length).toBeLessThan(10);
  });

  it('is the same on every run, and a bigger run only adds', () => {
    expect(generateRegister(albazourieh, { citizens: 800, parcels, staff })).toEqual(south);
    const bigger = generateRegister(albazourieh, { citizens: 900, parcels, staff });
    expect(bigger.users.slice(0, 800)).toEqual(south.users);
    expect(bigger.registrations.slice(0, 800)).toEqual(south.registrations);
  });
});
