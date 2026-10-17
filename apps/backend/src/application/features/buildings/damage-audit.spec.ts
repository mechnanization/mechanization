import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfigService } from '@nestjs/config';
import type { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import type { AuditRepository } from '../../../domain/interfaces/audit-repository.interface';
import type { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import type { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { AuditService, type DamageRecorded } from '../audit/audit.service';
import { DamageService } from './damage.service';

/*
  A damage reading leaves a row in the trail (2026-10-06). It was emitted as
  `damage.recorded` from the start and heard only by the dashboard cache; since
  a reading of «غير صالحة للسكن» exempts a flat from every fee (2026-10-05,
  2026-10-07), who read what and when is what a resident disputing an exempt or
  resumed bill asks.
*/

const BUILDING = '0b6f2c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
const UNIT = '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f';
const UNIT_CODE = 'Z-1-45-A-101';
const ACTOR = { id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', role: 'FIELD_INSPECTOR' };

function damageService(emit: jest.Mock) {
  const prisma = {
    building: { findUnique: jest.fn().mockResolvedValue({ id: BUILDING }) },
    unit: { findUnique: jest.fn().mockResolvedValue({ id: UNIT, buildingId: BUILDING, unitCode: UNIT_CODE }) },
    damageAssessment: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'a1',
          observations: null,
          assessedAt: new Date('2026-10-01T09:00:00.000Z'),
          createdAt: new Date('2026-10-01T09:00:00.000Z'),
          assessedBy: { firstName: 'سامي', lastName: 'خوري' },
          ...data,
        }),
      ),
    },
  };
  const tenantContext = { prisma, tenantSlug: 'test-town' } as unknown as TenantContextService;
  return new DamageService(tenantContext, { emit } as unknown as EventEmitter2);
}

describe('a damage reading is announced with what the trail needs', () => {
  it("files a unit's reading under the unit's building, with its code, the answer and the planned day", async () => {
    const emit = jest.fn();
    await damageService(emit).record(
      {
        unitId: UNIT,
        level: 'RESTRICTED_USE',
        source: 'FIELD_VISIT',
        habitable: false,
        reinspectAt: new Date('2026-11-15T00:00:00.000Z'),
      } as never,
      ACTOR,
    );

    expect(emit).toHaveBeenCalledWith(
      'damage.recorded',
      expect.objectContaining({
        buildingId: BUILDING,
        unitId: UNIT,
        unitCode: UNIT_CODE,
        level: 'RESTRICTED_USE',
        habitable: false,
        reinspectAt: '2026-11-15',
        source: 'FIELD_VISIT',
        actorId: ACTOR.id,
      }),
    );
  });

  it("files a building's own reading under that building, with no unit", async () => {
    const emit = jest.fn();
    await damageService(emit).record(
      { buildingId: BUILDING, level: 'TOTAL_COLLAPSE', source: 'FIELD_VISIT', habitable: false } as never,
      ACTOR,
    );

    expect(emit).toHaveBeenCalledWith(
      'damage.recorded',
      expect.objectContaining({ buildingId: BUILDING, unitId: null, unitCode: null, reinspectAt: null }),
    );
  });
});

describe('the audit trail hears it', () => {
  it('writes DAMAGE_RECORDED under the building, the reading in `after`', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const audit = new AuditService(
      { append } as unknown as AuditRepository,
      { peek: () => undefined } as unknown as TenantContextService,
      {} as RedisCacheService,
      {} as ConfigService,
    );
    const payload: DamageRecorded = {
      tenantSlug: 'test-town',
      assessmentId: 'a1',
      buildingId: BUILDING,
      unitId: UNIT,
      unitCode: UNIT_CODE,
      level: 'UNSAFE_EVACUATE',
      habitable: false,
      reinspectAt: '2026-11-15',
      source: 'FIELD_VISIT',
      actorId: ACTOR.id,
      actorRole: ACTOR.role,
    };

    await audit.onDamageRecorded(payload);

    expect(append).toHaveBeenCalledTimes(1);
    const entry = (append.mock.calls[0]![0] as AuditLogEntry).props;
    expect(entry).toMatchObject({
      action: 'DAMAGE_RECORDED',
      entityType: 'Building',
      entityId: BUILDING,
      actorId: ACTOR.id,
      actorType: 'STAFF',
    });
    expect(entry.after).toEqual({
      assessmentId: 'a1',
      unitId: UNIT,
      unitCode: UNIT_CODE,
      level: 'UNSAFE_EVACUATE',
      habitable: false,
      reinspectAt: '2026-11-15',
      source: 'FIELD_VISIT',
    });
  });
});
