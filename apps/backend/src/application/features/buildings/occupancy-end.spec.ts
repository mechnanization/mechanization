import { BuildingsService } from './buildings.service';

/**
 * «إنهاء الإشغال» and «تأكيد الشغور», after the first week in the field.
 *
 * Inspectors pressed «إنهاء الإشغال» by mistake — and on purpose, because
 * «تأكيد الشغور» refused any unit with an owner on it and told them to end the
 * owner first, which erased the ownership. These pin the three rules that
 * replaced that: a reason is stored, an ended spell is not ended twice, and an
 * owner does not stand in the way of recording a vacancy — though a seasonal
 * home does, because its owners being away is what the state means.
 */

const actor = { id: 'staff-1', role: 'FIELD_INSPECTOR' };

function service(db: Record<string, unknown>) {
  return new BuildingsService(
    { prisma: db, tenantSlug: 'albazourieh' } as never,
    {
      resolveForUnit: jest.fn().mockResolvedValue(0),
      resolveVacancyCasesForUnit: jest.fn().mockResolvedValue(0),
    } as never,
    { emit: jest.fn() } as never,
  );
}

function occupancyDb(existing: Record<string, unknown>) {
  const update = jest.fn().mockResolvedValue({
    id: 'occ-1',
    unitId: 'unit-1',
    citizenId: 'citizen-1',
    role: 'OWNER',
    shares: null,
    fromDate: new Date('2026-01-01'),
    toDate: new Date('2026-09-12'),
    endReason: 'OWNERSHIP_TRANSFERRED',
    registrationId: null,
    citizen: { firstName: 'يوسف', lastName: 'جفال' },
  });
  return {
    update,
    db: {
      unitOccupancy: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occ-1',
          unitId: 'unit-1',
          citizenId: 'citizen-1',
          role: 'OWNER',
          fromDate: new Date('2026-01-01'),
          toDate: null,
          unit: { buildingId: 'building-1', unitCode: '0102' },
          ...existing,
        }),
        update,
      },
      buildingUnit: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      propertyEntry: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      unit: { count: jest.fn().mockResolvedValue(4) },
    },
  };
}

describe('endOccupancy', () => {
  it('stores why the spell ended', async () => {
    const { db, update } = occupancyDb({});

    const row = await service(db).endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endReason: 'OWNERSHIP_TRANSFERRED' }),
      }),
    );
    expect(row.endReason).toBe('OWNERSHIP_TRANSFERRED');
  });

  it('refuses a spell that has already ended instead of re-dating it', async () => {
    const { db, update } = occupancyDb({ toDate: new Date('2026-09-12') });

    await expect(
      service(db).endOccupancy('occ-1', { reason: 'MOVED_OUT' }, actor),
    ).rejects.toThrow('منتهٍ مسبقاً');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a reason that does not fit the capacity — an owner does not «move out»', async () => {
    const { db, update } = occupancyDb({});

    await expect(
      service(db).endOccupancy('occ-1', { reason: 'MOVED_OUT' }, actor),
    ).rejects.toThrow('بيع أو نقل ملكية');
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts «سُجِّل بالخطأ» for any capacity', async () => {
    const { db, update } = occupancyDb({ role: 'TENANT' });

    await service(db).endOccupancy('occ-1', { reason: 'RECORDED_IN_ERROR' }, actor);
    expect(update).toHaveBeenCalled();
  });

  it('refuses an end date before the spell began', async () => {
    const { db, update } = occupancyDb({});

    await expect(
      service(db).endOccupancy(
        'occ-1',
        { reason: 'OWNERSHIP_TRANSFERRED', toDate: new Date('2025-06-01') },
        actor,
      ),
    ).rejects.toThrow('قبل تاريخ بدء');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('confirmVacancy / updateUnit — calling a unit empty', () => {
  function unitDb(
    liveNonOwners: number,
    state: {
      unitStatus?: string | null;
      ownerCardStatus?: string | null;
      /** A confirmation already standing on the unit. */
      standing?: { id: string; observedAt: Date } | null;
    } = {},
  ) {
    const count = jest.fn().mockResolvedValue(liveNonOwners);
    const createVacancy = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'vac-1',
        unitId: 'unit-1',
        basis: data.basis ?? null,
        observedAt: (data.observedAt as Date) ?? new Date('2026-09-13'),
        notes: data.notes ?? null,
        confirmedById: data.confirmedById ?? null,
        confirmedBy: null,
        previousUnitStatus: data.previousUnitStatus ?? null,
        previousSurveyStatus: data.previousSurveyStatus ?? null,
        endedAt: null,
        endReason: null,
        endNotes: null,
        endedById: null,
        endedBy: null,
        createdAt: new Date(),
      }),
    );
    const update = jest.fn().mockResolvedValue({
      id: 'unit-1',
      buildingId: 'building-1',
      floor: 1,
      sequence: 2,
      startCol: null,
      endCol: null,
      unitCode: '0102',
      postedNumber: null,
      unitType: 'APARTMENT',
      side: null,
      unitArea: null,
      unitStatus: 'VACANT',
      surveyStatus: 'VACANT_CONFIRMED',
      presenceMonths: [],
      ownerLastStayAt: null,
      vacancyDeclaredAt: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db: Record<string, unknown> = {
      // Every transaction in these paths is "the row and its effect", and the
      // mock runs the callback against the same delegates.
      $transaction: (run: (tx: unknown) => unknown) => run(db),
      unitVacancyConfirmation: {
        findFirst: jest.fn().mockResolvedValue(state.standing ?? null),
        create: createVacancy,
        update: jest.fn().mockResolvedValue({ id: 'vac-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'vac-1',
          unitId: 'unit-1',
          basis: 'FIELD_INSPECTION',
          observedAt: new Date('2026-09-01'),
          notes: null,
          confirmedById: 'staff-1',
          confirmedBy: null,
          previousUnitStatus: null,
          previousSurveyStatus: null,
          endedAt: new Date('2026-09-13'),
          endReason: 'RECORDED_IN_ERROR',
          endNotes: null,
          endedById: 'staff-1',
          endedBy: null,
          createdAt: new Date(),
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      unitVisit: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    return {
      count,
      update,
      createVacancy,
      db: Object.assign(db, {
        unit: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'unit-1',
            buildingId: 'building-1',
            floor: 1,
            sequence: 2,
            unitCode: '0102',
            surveyStatus: 'COMPLETE',
            unitStatus: state.unitStatus ?? null,
          }),
          // A two-flat block, so the منزل-card inference never applies.
          findMany: jest.fn().mockResolvedValue([
            { id: 'unit-1', unitStatus: state.unitStatus ?? null },
            { id: 'unit-2', unitStatus: null },
          ]),
          update,
        },
        unitOccupancy: { count },
        buildingUnit: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              state.ownerCardStatus ? [{ unitId: 'unit-1', unitStatus: state.ownerCardStatus }] : [],
            ),
        },
        propertyEntry: { findMany: jest.fn().mockResolvedValue([]) },
      }),
    };
  }

  it('counts only a tenant or a شاغل بتسامح as somebody living there — never the owner', async () => {
    const { db, count, update } = unitDb(0);

    await service(db).confirmVacancy('unit-1', { basis: 'FIELD_INSPECTION' }, actor);

    expect(count).toHaveBeenCalledWith({
      where: { unitId: 'unit-1', toDate: null, role: { in: ['TENANT', 'FREE_OCCUPANT'] } },
    });
    expect(update).toHaveBeenCalled();
  });

  it('still refuses while a tenant is recorded in the unit', async () => {
    const { db, update } = unitDb(1);

    await expect(
      service(db).confirmVacancy('unit-1', { basis: 'FIELD_INSPECTION' }, actor),
    ).rejects.toThrow('كشاغرة');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a seasonal home — its owners being away is not a vacancy', async () => {
    const { db, update } = unitDb(0, { unitStatus: 'SEASONAL' });

    await expect(
      service(db).confirmVacancy('unit-1', { basis: 'FIELD_INSPECTION' }, actor),
    ).rejects.toThrow('مسكن موسمي');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses where only the owner’s card says seasonal, because billing reads the card', async () => {
    const { db, update } = unitDb(0, { unitStatus: null, ownerCardStatus: 'SEASONAL' });

    await expect(
      service(db).confirmVacancy('unit-1', { basis: 'OWNER_STATEMENT' }, actor),
    ).rejects.toThrow('مسكن موسمي');
    expect(update).not.toHaveBeenCalled();
  });

  it('still lets an owner-occupied card be overridden by a confirmed vacancy', async () => {
    const { db, update } = unitDb(0, { unitStatus: null, ownerCardStatus: 'OWNER_OCCUPIED' });

    await service(db).confirmVacancy('unit-1', { basis: 'FIELD_INSPECTION' }, actor);
    expect(update).toHaveBeenCalled();
  });

  /*
    The snapshot is the whole of the undo. Without it, lifting a confirmation
    recorded in error could only guess what the flat said before — which is how
    a مؤجرة flat wrongly marked empty came back as «غير محدد» and was billed to
    its owner instead of its tenant.
  */
  it('stores what the unit said before, so the undo has something to restore', async () => {
    const { db, createVacancy } = unitDb(0, { unitStatus: 'RENTED' });

    await service(db).confirmVacancy('unit-1', { basis: 'DECLARATION_FILED' }, actor);

    expect(createVacancy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          basis: 'DECLARATION_FILED',
          previousUnitStatus: 'RENTED',
          previousSurveyStatus: 'COMPLETE',
          confirmedById: 'staff-1',
        }),
      }),
    );
  });

  it('refuses a second confirmation on a unit that already has one standing', async () => {
    const { db, update } = unitDb(0, {
      standing: { id: 'vac-0', observedAt: new Date('2026-08-01') },
    });

    await expect(
      service(db).confirmVacancy('unit-1', { basis: 'FIELD_INSPECTION' }, actor),
    ).rejects.toThrow('مؤكَّد شغورها مسبقاً');
    expect(update).not.toHaveBeenCalled();
  });

  /*
    The old door, now closed. A PATCH carrying the pair «شاغرة» + «مؤكَّدة
    الشغور» is the exact request the button used to send, and letting it through
    would keep a second way of confirming a vacancy that records no basis and
    cannot be lifted.
  */
  it('refuses the old status-edit route into a vacancy and names the action', async () => {
    const { db, update } = unitDb(0);

    await expect(
      service(db).updateUnit(
        'unit-1',
        { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
        actor,
      ),
    ).rejects.toThrow('«تأكيد الشغور»');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a status edit while a confirmation is standing', async () => {
    const { db, update } = unitDb(0, {
      standing: { id: 'vac-0', observedAt: new Date('2026-08-01') },
    });

    await expect(
      service(db).updateUnit('unit-1', { unitStatus: 'RENTED' }, actor),
    ).rejects.toThrow('ألغِ تأكيد الشغور');
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves edits that touch neither status alone, standing vacancy or not', async () => {
    const { db, update } = unitDb(0, {
      unitStatus: 'SEASONAL',
      standing: { id: 'vac-0', observedAt: new Date('2026-08-01') },
    });

    await service(db).updateUnit('unit-1', { presenceMonths: [7, 8] }, actor);
    expect(update).toHaveBeenCalled();
  });

  it('still refuses a plain «شاغرة» status edit while a tenant is recorded', async () => {
    const { db, update } = unitDb(1);

    await expect(
      service(db).updateUnit('unit-1', { unitStatus: 'VACANT' }, actor),
    ).rejects.toThrow('كشاغرة');
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * The undo, which is the half «تأكيد الشغور» never had.
 *
 * What it restores is decided by `vacancyReversal` — covered field by field in
 * `unit-vacancy.spec.ts`. These pin the two rules the service itself owns: a
 * vacancy that is not standing cannot be lifted, and a date before the
 * confirmation is refused rather than quietly rounded.
 */
describe('endVacancy', () => {
  function db(standing: Record<string, unknown> | null) {
    const store: Record<string, unknown> = {
      $transaction: (run: (tx: unknown) => unknown) => run(store),
      unitVacancyConfirmation: {
        findFirst: jest.fn().mockResolvedValue(standing),
        update: jest.fn().mockResolvedValue({ id: 'vac-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...(standing ?? {}),
          id: 'vac-1',
          unitId: 'unit-1',
          basis: 'FIELD_INSPECTION',
          notes: null,
          confirmedById: 'staff-1',
          confirmedBy: null,
          endedAt: new Date('2026-09-13'),
          endReason: 'RECORDED_IN_ERROR',
          endNotes: null,
          endedById: 'staff-1',
          endedBy: null,
          createdAt: new Date(),
        }),
      },
      unitVisit: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    return Object.assign(store, {
      unit: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'unit-1',
          buildingId: 'building-1',
          unitCode: '0102',
          unitStatus: 'VACANT',
          surveyStatus: 'VACANT_CONFIRMED',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'unit-1',
          buildingId: 'building-1',
          floor: 1,
          sequence: 2,
          startCol: null,
          endCol: null,
          unitCode: '0102',
          postedNumber: null,
          unitType: 'APARTMENT',
          side: null,
          unitArea: null,
          unitStatus: 'RENTED',
          surveyStatus: 'COMPLETE',
          presenceMonths: [],
          ownerLastStayAt: null,
          vacancyDeclaredAt: null,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    });
  }

  const standing = {
    id: 'vac-1',
    unitId: 'unit-1',
    observedAt: new Date('2026-09-01'),
    previousUnitStatus: 'RENTED',
    previousSurveyStatus: 'COMPLETE',
  };

  it('puts the unit back to what the confirmation replaced', async () => {
    const store = db(standing);

    const result = await service(store).endVacancy(
      'unit-1',
      { reason: 'RECORDED_IN_ERROR' },
      actor,
    );

    expect(store.unit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unitStatus: 'RENTED', surveyStatus: 'COMPLETE' } }),
    );
    expect(result.unit.unitStatus).toBe('RENTED');
  });

  it('leaves the flat occupied-by-someone-unrecorded when it is simply no longer vacant', async () => {
    const store = db(standing);

    await service(store).endVacancy('unit-1', { reason: 'NO_LONGER_VACANT' }, actor);

    expect(store.unit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unitStatus: null, surveyStatus: 'PARTIAL' } }),
    );
  });

  it('refuses when nothing is standing', async () => {
    const store = db(null);

    await expect(
      service(store).endVacancy('unit-1', { reason: 'RECORDED_IN_ERROR' }, actor),
    ).rejects.toThrow('لا يوجد تأكيد شغور قائم');
    expect(store.unit.update).not.toHaveBeenCalled();
  });

  it('refuses a date before the vacancy was observed', async () => {
    const store = db(standing);

    await expect(
      service(store).endVacancy(
        'unit-1',
        { reason: 'NO_LONGER_VACANT', endedAt: new Date('2026-08-01') },
        actor,
      ),
    ).rejects.toThrow('قبل تاريخ تأكيد الشغور');
    expect(store.unit.update).not.toHaveBeenCalled();
  });
});
