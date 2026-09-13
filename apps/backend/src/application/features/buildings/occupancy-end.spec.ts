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
    { resolveForUnit: jest.fn().mockResolvedValue(0) } as never,
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

describe('updateUnit — marking a unit vacant', () => {
  function unitDb(
    liveNonOwners: number,
    state: { unitStatus?: string | null; ownerCardStatus?: string | null } = {},
  ) {
    const count = jest.fn().mockResolvedValue(liveNonOwners);
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
    return {
      count,
      update,
      db: {
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
      },
    };
  }

  it('counts only a tenant or a شاغل بتسامح as somebody living there — never the owner', async () => {
    const { db, count, update } = unitDb(0);

    await service(db).updateUnit(
      'unit-1',
      { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
      actor,
    );

    expect(count).toHaveBeenCalledWith({
      where: { unitId: 'unit-1', toDate: null, role: { in: ['TENANT', 'FREE_OCCUPANT'] } },
    });
    expect(update).toHaveBeenCalled();
  });

  it('still refuses while a tenant is recorded in the unit', async () => {
    const { db, update } = unitDb(1);

    await expect(
      service(db).updateUnit('unit-1', { unitStatus: 'VACANT' }, actor),
    ).rejects.toThrow('كشاغرة');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a seasonal home — its owners being away is not a vacancy', async () => {
    const { db, update } = unitDb(0, { unitStatus: 'SEASONAL' });

    await expect(
      service(db).updateUnit(
        'unit-1',
        { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
        actor,
      ),
    ).rejects.toThrow('مسكن موسمي');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses where only the owner’s card says seasonal, because billing reads the card', async () => {
    const { db, update } = unitDb(0, { unitStatus: null, ownerCardStatus: 'SEASONAL' });

    await expect(
      service(db).updateUnit('unit-1', { surveyStatus: 'VACANT_CONFIRMED' }, actor),
    ).rejects.toThrow('مسكن موسمي');
    expect(update).not.toHaveBeenCalled();
  });

  it('still lets an owner-occupied card be overridden by a confirmed vacancy', async () => {
    const { db, update } = unitDb(0, { unitStatus: null, ownerCardStatus: 'OWNER_OCCUPIED' });

    await service(db).updateUnit(
      'unit-1',
      { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
      actor,
    );
    expect(update).toHaveBeenCalled();
  });

  it('leaves edits that do not call the unit empty alone', async () => {
    const { db, update } = unitDb(0, { unitStatus: 'SEASONAL' });

    await service(db).updateUnit('unit-1', { presenceMonths: [7, 8] }, actor);
    expect(update).toHaveBeenCalled();
  });
});
