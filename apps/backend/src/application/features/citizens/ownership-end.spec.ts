import { ConflictError, ForbiddenError, ValidationError } from '../../../domain/errors/domain-error';
import { TenancyService } from './tenancy.service';

/**
 * «إنهاء الملكية», and what the flat says once the last owner has gone.
 *
 * ## The defect these pin down
 *
 * `Unit.unitStatus` is answered when an owner is recorded, so a flat its owner
 * lived in carries «مشغولة من المالك» — a statement about a person. Ending the
 * spell released their file and stopped there: the register went on saying the
 * flat is occupied by an owner it no longer has one of, and billing reads the
 * unit. Every case below is one half of the rule that replaced that — when the
 * officer is asked, when they are not, and what is refused rather than offered.
 *
 * The decision is all that is faked here. What each answer *writes* — a
 * confirmation that exempts, a case, a released claim — is
 * `tenancy.integration.spec.ts`'s, against a real Postgres, because those are
 * facts that span tables.
 */

/*
  «بيع أو نقل ملكية» is an office decision (`mayTransferOwnership`), so the
  cases below that record one run as the role that may. The inspector is not a
  lesser fixture — they are the subject of «who may record a sale».
*/
const admin = { id: 'staff-1', role: 'ADMINISTRATIVE_OFFICER' };
const inspector = { id: 'staff-2', role: 'FIELD_INSPECTOR' };

function harness(
  options: { others?: number; toDate?: Date | null; as?: { id: string; role: string } } = {},
) {
  const actor = options.as ?? admin;
  const db = {
    unitOccupancy: {
      findUnique: jest.fn().mockResolvedValue({
        unitId: 'unit-1',
        toDate: options.toDate ?? null,
        unit: { unitCode: '0102', buildingId: 'building-1' },
      }),
      count: jest.fn().mockResolvedValue(options.others ?? 0),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    building: { findUnique: jest.fn().mockResolvedValue({ parcelNumber: '١٢٣' }) },
  };
  const buildings = {
    endOccupancy: jest.fn().mockResolvedValue({}),
    confirmVacancy: jest.fn().mockResolvedValue({}),
  };
  const cases = { openUnlessStanding: jest.fn().mockResolvedValue({ opened: true }) };
  /*
    `require()` answers with a scope that is already in a transaction, so
    `runInTenantTransaction` joins it and runs the work directly — there is no
    `$transaction` to fake, and the rules under test are the same either way.
  */
  const scope = { prisma: db, transaction: { afterCommit: [] } };
  const context = { prisma: db, require: () => scope, run: (_s: unknown, work: () => unknown) => work() };

  const service = new TenancyService(
    context as never,
    buildings as never,
    cases as never,
    { emitAll: jest.fn() } as never,
    { emit: jest.fn() } as never,
  );
  const owner = (input: Record<string, unknown>) =>
    service.endOccupancy('occ-1', input as never, actor);

  return { db, buildings, cases, owner };
}

/**
 * `endOccupancy` reads the role first and dispatches, then `endOwnership`
 * reads the spell — two `findUnique` calls, answered in that order.
 */
function asOwner(db: { unitOccupancy: { findUnique: jest.Mock } }) {
  db.unitOccupancy.findUnique
    .mockResolvedValueOnce({ role: 'OWNER' })
    .mockResolvedValueOnce({
      unitId: 'unit-1',
      toDate: null,
      unit: { unitCode: '0102', buildingId: 'building-1' },
    });
}

describe('ending an ownership', () => {
  describe('when it is the last spell on the flat, and a sale', () => {
    it('refuses without an answer, naming the unit the question is about', async () => {
      const { db, owner, buildings } = harness();
      asOwner(db);

      await expect(owner({ reason: 'OWNERSHIP_TRANSFERRED' })).rejects.toThrow(ValidationError);
      // Nothing written: the refusal is before the spell, not a half-done end.
      expect(buildings.endOccupancy).not.toHaveBeenCalled();
    });

    it('refuses an answer that cannot be true of a flat nobody is in', async () => {
      const { db, owner } = harness();
      asOwner(db);

      // There is no owner left to live there — the option is not even offered.
      await expect(
        owner({ reason: 'OWNERSHIP_TRANSFERRED', afterStatus: 'OWNER_OCCUPIED' }),
      ).rejects.toThrow(/شاغرة/);
    });

    it('refuses «شاغرة» with nothing behind it', async () => {
      const { db, owner } = harness();
      asOwner(db);

      await expect(
        owner({ reason: 'OWNERSHIP_TRANSFERRED', afterStatus: 'VACANT' }),
      ).rejects.toThrow(ValidationError);
    });

    it('records «شاغرة» as a confirmation, not a status write', async () => {
      const { db, owner, buildings, cases } = harness();
      asOwner(db);

      const result = await owner({
        reason: 'OWNERSHIP_TRANSFERRED',
        afterStatus: 'VACANT',
        vacancyBasis: 'OFFICER_OBSERVATION',
      });

      expect(buildings.endOccupancy).toHaveBeenCalled();
      expect(buildings.confirmVacancy).toHaveBeenCalledWith(
        'unit-1',
        expect.objectContaining({ basis: 'OFFICER_OBSERVATION' }),
        admin,
      );
      // A vacancy is liftable and exempts; it must not also clear the status.
      expect(db.unit.updateMany).not.toHaveBeenCalled();
      expect(cases.openUnlessStanding).not.toHaveBeenCalled();
      expect(result).toMatchObject({ statusApplied: 'VACANT', vacanciesConfirmed: 1 });
    });

    it('clears the owner’s use and opens a check on «لا أعرف»', async () => {
      const { db, owner, buildings, cases } = harness();
      asOwner(db);

      const result = await owner({ reason: 'OWNERSHIP_TRANSFERRED', afterStatus: 'UNKNOWN' });

      expect(db.unit.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            unitStatus: { in: ['OWNER_OCCUPIED', 'SEASONAL'] },
          }),
          data: expect.objectContaining({ unitStatus: null }),
        }),
      );
      expect(cases.openUnlessStanding).toHaveBeenCalled();
      expect(buildings.confirmVacancy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ statusApplied: 'UNKNOWN', casesOpened: 1, statusCleared: true });
    });
  });

  it('asks nothing when somebody is still recorded on the flat', async () => {
    const { db, owner, buildings, cases } = harness({ others: 1 });
    asOwner(db);

    // A sale over a sitting tenant: the flat's status is the tenant's to speak
    // for, so it is neither asked about nor touched.
    const result = await owner({ reason: 'OWNERSHIP_TRANSFERRED' });

    expect(buildings.endOccupancy).toHaveBeenCalled();
    expect(db.unit.updateMany).not.toHaveBeenCalled();
    expect(cases.openUnlessStanding).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusApplied: null, statusCleared: false });
  });

  it('asks nothing on a correction, and takes back what it asserted', async () => {
    const { db, owner, cases } = harness();
    asOwner(db);

    const result = await owner({ reason: 'RECORDED_IN_ERROR' });

    // The ownership never stood, so neither does «مشغولة من المالك» — but there
    // is nobody to go and check on, so no case is opened either.
    expect(db.unit.updateMany).toHaveBeenCalled();
    expect(cases.openUnlessStanding).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusApplied: null, statusCleared: true, casesOpened: 0 });
  });

  describe('who may record a sale', () => {
    it('refuses «بيع أو نقل ملكية» from the field, before anything is read', async () => {
      const { db, owner, buildings } = harness({ as: inspector });
      asOwner(db);

      await expect(owner({ reason: 'OWNERSHIP_TRANSFERRED' })).rejects.toThrow(ForbiddenError);
      /*
        Not a validation message about the unit: the refusal is about the
        caller, and it is made before the spell is even looked up — so a
        request naming a flat the inspector cannot see learns nothing from it.
      */
      expect(buildings.endOccupancy).not.toHaveBeenCalled();
      expect(db.unitOccupancy.count).not.toHaveBeenCalled();
    });

    it('leaves the correction path open to them', async () => {
      const { db, owner, buildings, cases } = harness({ as: inspector });
      asOwner(db);

      // What an inspector at the door is there for: taking back their own entry.
      const result = await owner({ reason: 'RECORDED_IN_ERROR' });

      expect(buildings.endOccupancy).toHaveBeenCalled();
      expect(cases.openUnlessStanding).not.toHaveBeenCalled();
      expect(result).toMatchObject({ statusCleared: true });
    });

    it('refuses a role the allowlist has never heard of', async () => {
      const { db, owner, buildings } = harness({ as: { id: 'staff-9', role: 'VOLUNTEER' } });
      asOwner(db);

      // Fails closed: a role added later does not acquire this by being new.
      await expect(owner({ reason: 'OWNERSHIP_TRANSFERRED' })).rejects.toThrow(ForbiddenError);
      expect(buildings.endOccupancy).not.toHaveBeenCalled();
    });
  });

  it('refuses a spell that has already ended', async () => {
    const { db, owner, buildings } = harness();
    db.unitOccupancy.findUnique
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce({
        unitId: 'unit-1',
        toDate: new Date('2026-03-01'),
        unit: { unitCode: '0102', buildingId: 'building-1' },
      });

    await expect(owner({ reason: 'OWNERSHIP_TRANSFERRED' })).rejects.toThrow(ConflictError);
    expect(buildings.endOccupancy).not.toHaveBeenCalled();
  });
});
