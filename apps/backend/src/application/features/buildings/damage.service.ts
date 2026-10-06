import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DAMAGE_LEVEL, calendarDayOf, type CreateDamageAssessmentInput } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { NotFoundError } from '../../common/exceptions';
import type { DamageRecorded } from '../audit/audit.service';
import type { DamageRow } from './building.types';

/**
 * War-damage assessments — an append-only log, never a column.
 *
 * The whole service is shaped by D3, and the rejected alternative is worth
 * stating because it is the obvious one: a `warDamageStatus` enum on the
 * building, overwritten on each visit. It cannot answer any of the questions a
 * reconstruction file is actually made of. A building that was unsafe in
 * October 2024 and repaired in 2026 is *two* facts, and the first one is what a
 * compensation claim, a displacement figure and an engineering audit all rest
 * on. Overwriting it destroys the record at the moment it becomes evidence.
 *
 * So nothing here updates or deletes. `record` appends; `currentLevel` reads
 * the latest row; `history` reads all of them.
 */

/*
 * The severity ladder (`DAMAGE_SEVERITY`, `damageSeverity`, `worstDamage`) and
 * the habitability rules live in `@mechanization/shared-schemas`
 * (`damage-rule.ts`): the map draws its rings from the same ladder the server
 * rolls up with, and the biller holds a fee on the same predicate the screens
 * show.
 */

@Injectable()
export class DamageService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Appends one observation.
   *
   * The target is checked to exist rather than trusted, because the CHECK
   * constraint in migration 0030 only guarantees that *exactly one* of the two
   * columns is set — not that it names a row. A dangling FK would fail at the
   * database as a 500; this fails as a 404 that says which one is missing.
   */
  async record(
    input: CreateDamageAssessmentInput,
    actor: { id: string; role: string },
  ): Promise<DamageRow> {
    // The building the reading is filed under in the trail: its own, or the unit's.
    let buildingId = input.buildingId ?? null;
    let unitCode: string | null = null;
    if (input.buildingId) {
      const building = await this.db.building.findUnique({
        where: { id: input.buildingId },
        select: { id: true },
      });
      if (!building) {
        throw new NotFoundError({ code: 'BUILDING_NOT_FOUND', message: `Building ${input.buildingId} was not found` });
      }
    } else if (input.unitId) {
      const unit = await this.db.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true, buildingId: true, unitCode: true },
      });
      if (!unit) {
        throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: `Unit ${input.unitId} was not found` });
      }
      buildingId = unit.buildingId;
      unitCode = unit.unitCode;
    }

    const created = await this.db.damageAssessment.create({
      data: {
        buildingId: input.buildingId ?? null,
        unitId: input.unitId ?? null,
        level: input.level,
        source: input.source,
        observations: input.observations?.trim() || null,
        ...(input.assessedAt ? { assessedAt: input.assessedAt } : {}),
        // The schema has already filled it from the level where the level decides it.
        habitable: input.habitable ?? null,
        // Only on a «غير صالحة للسكن» reading — the schema and a CHECK refuse it on any other.
        reinspectAt: input.reinspectAt ?? null,
        assessedById: actor.id,
      },
      include: { assessedBy: { select: { firstName: true, lastName: true } } },
    });

    /*
      Heard by the dashboard cache, and by the audit trail: a reading can hold
      or resume a flat's fees, so it is a row a resident can be shown.
    */
    this.events.emit('damage.recorded', {
      tenantSlug: this.tenantContext.tenantSlug,
      assessmentId: created.id,
      buildingId: buildingId!,
      unitId: created.unitId,
      unitCode,
      level: created.level,
      habitable: created.habitable,
      reinspectAt: created.reinspectAt ? calendarDayOf(created.reinspectAt) : null,
      source: created.source,
      actorId: actor.id,
      actorRole: actor.role,
    } satisfies DamageRecorded);

    return toDamageRow(created);
  }

  /**
   * What this building's condition is *now* — the latest reading on the
   * building itself or on any of its units, whichever was observed last.
   *
   * Latest by `assessedAt`, not by `createdAt`: an assessment entered a week
   * late from a paper form describes the day of the visit, and ordering by when
   * the paperwork was typed would let it overwrite a newer observation.
   */
  async currentLevel(buildingId: string): Promise<string | null> {
    const rows = await withConnectionRetry(() =>
      this.db.damageAssessment.findMany({
        where: { OR: [{ buildingId }, { unit: { buildingId } }] },
        orderBy: [{ assessedAt: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { level: true },
      }),
    );
    return rows[0]?.level ?? null;
  }

  /**
   * Everything ever observed about this building, newest first.
   *
   * Includes its units' own readings — the "top three floors gone, ground floor
   * shop still trading" case is two rows about one structure, and a history
   * that showed only the building-level ones would be missing the half that
   * explains it.
   */
  async history(buildingId: string): Promise<DamageRow[]> {
    const rows = await withConnectionRetry(() =>
      this.db.damageAssessment.findMany({
        where: { OR: [{ buildingId }, { unit: { buildingId } }] },
        orderBy: [{ assessedAt: 'desc' }, { createdAt: 'desc' }],
        include: { assessedBy: { select: { firstName: true, lastName: true } } },
      }),
    );
    return rows.map(toDamageRow);
  }

  /** The damage levels this municipality has recorded, and how many of each. */
  async levelCounts(): Promise<Record<string, number>> {
    const grouped = await this.db.damageAssessment.groupBy({
      by: ['level'],
      _count: { _all: true },
    });

    const counts: Record<string, number> = Object.fromEntries(
      DAMAGE_LEVEL.map((level) => [level, 0]),
    );
    for (const row of grouped) counts[row.level] = row._count._all;
    return counts;
  }
}

function toDamageRow(row: {
  id: string;
  buildingId: string | null;
  unitId: string | null;
  level: string;
  source: string;
  observations: string | null;
  assessedAt: Date;
  habitable: boolean | null;
  reinspectAt: Date | null;
  assessedById: string | null;
  assessedBy?: { firstName: string; lastName: string } | null;
  createdAt: Date;
}): DamageRow {
  return {
    id: row.id,
    buildingId: row.buildingId,
    unitId: row.unitId,
    level: row.level,
    source: row.source,
    observations: row.observations,
    assessedAt: row.assessedAt,
    habitable: row.habitable,
    reinspectAt: row.reinspectAt,
    assessedById: row.assessedById,
    assessedByName: row.assessedBy
      ? `${row.assessedBy.firstName} ${row.assessedBy.lastName}`
      : null,
    createdAt: row.createdAt,
  };
}
