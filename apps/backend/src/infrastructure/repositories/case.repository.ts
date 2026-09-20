import { Injectable } from '@nestjs/common';
import type {
  Case,
  CaseCensusLinks,
  CaseListFilter,
  CaseRepository,
} from '../../domain/interfaces/case-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { withConnectionRetry } from '../prisma/with-connection-retry';

type CaseRow = {
  id: string;
  notes: string;
  propertyNumber: string | null;
  neighborhood: string | null;
  propertyType: string | null;
  buildingName: string | null;
  floor: string | null;
  side: string | null;
  landType: string | null;
  tentLocation: string | null;
  status: string;
  caseType: string;
  buildingId: string | null;
  building: { code: string } | null;
  unitId: string | null;
  unit: { unitCode: string } | null;
  damageAssessmentId: string | null;
  scheduledRevisitAt: Date | null;
  resolvedCitizenId: string | null;
  resolvedCitizen: { firstName: string; lastName: string } | null;
  resolvedAt: Date | null;
  createdById: string | null;
  createdBy: { firstName: string; lastName: string } | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDomain(row: CaseRow): Case {
  return {
    id: row.id,
    notes: row.notes,
    propertyNumber: row.propertyNumber,
    neighborhood: row.neighborhood,
    propertyType: row.propertyType,
    buildingName: row.buildingName,
    floor: row.floor,
    side: row.side,
    landType: row.landType,
    tentLocation: row.tentLocation,
    status: row.status as Case['status'],
    caseType: row.caseType,
    buildingId: row.buildingId,
    buildingCode: row.building?.code ?? null,
    unitId: row.unitId,
    unitCode: row.unit?.unitCode ?? null,
    damageAssessmentId: row.damageAssessmentId,
    scheduledRevisitAt: row.scheduledRevisitAt,
    resolvedCitizenId: row.resolvedCitizenId,
    resolvedCitizenName: row.resolvedCitizen
      ? `${row.resolvedCitizen.firstName} ${row.resolvedCitizen.lastName}`
      : null,
    resolvedAt: row.resolvedAt,
    createdById: row.createdById,
    createdByName: row.createdBy ? `${row.createdBy.firstName} ${row.createdBy.lastName}` : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const includeRelations = {
  createdBy: { select: { firstName: true, lastName: true } },
  resolvedCitizen: { select: { firstName: true, lastName: true } },
  // Codes rather than whole rows: a case list shows «A-1042-B · 0304» and
  // nothing else about the structure, and joining the full building onto every
  // case would carry a unit matrix into a table that never draws one.
  building: { select: { code: true } },
  unit: { select: { unitCode: true } },
} as const;

@Injectable()
export class PrismaCaseRepository implements CaseRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  async findAll(filter?: CaseListFilter): Promise<Case[]> {
    const rows = await withConnectionRetry(() =>
      this.db.case.findMany({
        where: {
          ...(filter?.propertyNumber ? { propertyNumber: filter.propertyNumber } : {}),
          ...(filter?.status ? { status: filter.status as never } : {}),
          ...(filter?.caseType ? { caseType: filter.caseType as never } : {}),
          ...(filter?.buildingId ? { buildingId: filter.buildingId } : {}),
          ...(filter?.unitId ? { unitId: filter.unitId } : {}),
          ...(filter?.from || filter?.to
            ? {
                createdAt: {
                  ...(filter.from ? { gte: filter.from } : {}),
                  ...(filter.to ? { lte: filter.to } : {}),
                },
              }
            : {}),
        },
        include: includeRelations,
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((row) => toDomain(row as unknown as CaseRow));
  }

  async findById(id: string): Promise<Case | null> {
    const row = await withConnectionRetry(() =>
      this.db.case.findUnique({ where: { id }, include: includeRelations }),
    );
    return row ? toDomain(row as unknown as CaseRow) : null;
  }

  async create(input: {
    notes: string;
    propertyNumber?: string;
    neighborhood?: string;
    propertyType?: string;
    buildingName?: string;
    floor?: string;
    side?: string;
    landType?: string;
    tentLocation?: string;
    createdById?: string;
  } & CaseCensusLinks): Promise<Case> {
    const row = await this.db.case.create({
      data: {
        notes: input.notes,
        propertyNumber: input.propertyNumber ?? null,
        neighborhood: input.neighborhood ?? null,
        propertyType: (input.propertyType as never) ?? null,
        buildingName: input.buildingName ?? null,
        floor: input.floor ?? null,
        side: input.side ?? null,
        landType: (input.landType as never) ?? null,
        tentLocation: input.tentLocation ?? null,
        createdById: input.createdById ?? null,
        ...(input.caseType ? { caseType: input.caseType as never } : {}),
        buildingId: input.buildingId ?? null,
        unitId: input.unitId ?? null,
        damageAssessmentId: input.damageAssessmentId ?? null,
        scheduledRevisitAt: input.scheduledRevisitAt ?? null,
      },
      include: includeRelations,
    });
    return toDomain(row as unknown as CaseRow);
  }

  /**
   * Closes every case still open against a unit.
   *
   * `updateMany` in one statement rather than read-then-write per row: this
   * runs on the occupancy path, which is already doing several writes, and the
   * set it targets is "whatever is still open right now" — a value that a
   * separate read could only make stale.
   *
   * `SCHEDULED` is included in the target set on purpose. A revisit that was
   * arranged for a flat somebody has since been recorded in is a visit nobody
   * needs to make; leaving it would put an officer back at a door the
   * municipality has already been through.
   */
  async resolveOpenForUnit(unitId: string, citizenId: string): Promise<number> {
    const result = await this.db.case.updateMany({
      where: { unitId, status: { in: ['OPEN', 'SCHEDULED'] as never } },
      data: {
        status: 'RESOLVED',
        resolvedCitizenId: citizenId,
        resolvedAt: new Date(),
        // The arrangement is void either way; leaving the date would have the
        // cases page still listing a revisit for a closed case.
        scheduledRevisitAt: null,
      },
    });
    return result.count;
  }

  /**
   * Closes the «شاغرة قيد التحقق» items a confirmed vacancy has just answered.
   *
   * The sibling of `resolveOpenForUnit`, narrowed in the one way that matters:
   * by case *type*. That one is called when a person is recorded in a flat,
   * which answers every open question about it; this one is called when the
   * flat is confirmed empty, which answers exactly one — «شاغرة قيد التحقق» —
   * and says nothing about a refused entry, an ownership dispute or a note
   * somebody left for the next officer.
   *
   * No `resolvedCitizenId`: there is no citizen. A vacancy is resolved by the
   * absence of one, and writing somebody's id into that column to satisfy the
   * shape would put a name on a case they had nothing to do with.
   */
  async resolveVacancyCasesForUnit(unitId: string): Promise<number> {
    const result = await this.db.case.updateMany({
      where: {
        unitId,
        caseType: 'VACANT_UNCONFIRMED' as never,
        status: { in: ['OPEN', 'SCHEDULED'] as never },
      },
      data: { status: 'RESOLVED', resolvedAt: new Date(), scheduledRevisitAt: null },
    });
    return result.count;
  }

  async update(
    id: string,
    input: {
      notes?: string;
      propertyNumber?: string | null;
      neighborhood?: string | null;
      propertyType?: string;
      buildingName?: string | null;
      floor?: string | null;
      side?: string | null;
      landType?: string;
      tentLocation?: string | null;
      status?: string;
      resolvedCitizenId?: string | null;
      resolvedAt?: Date | null;
    } & CaseCensusLinks,
  ): Promise<Case> {
    const row = await this.db.case.update({
      where: { id },
      data: {
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.propertyNumber !== undefined ? { propertyNumber: input.propertyNumber } : {}),
        ...(input.neighborhood !== undefined ? { neighborhood: input.neighborhood } : {}),
        ...(input.propertyType !== undefined ? { propertyType: input.propertyType as never } : {}),
        ...(input.buildingName !== undefined ? { buildingName: input.buildingName } : {}),
        ...(input.floor !== undefined ? { floor: input.floor } : {}),
        ...(input.side !== undefined ? { side: input.side } : {}),
        ...(input.landType !== undefined ? { landType: input.landType as never } : {}),
        ...(input.tentLocation !== undefined ? { tentLocation: input.tentLocation } : {}),
        ...(input.status !== undefined ? { status: input.status as never } : {}),
        ...(input.resolvedCitizenId !== undefined
          ? { resolvedCitizenId: input.resolvedCitizenId }
          : {}),
        ...(input.resolvedAt !== undefined ? { resolvedAt: input.resolvedAt } : {}),
        ...(input.caseType !== undefined ? { caseType: input.caseType as never } : {}),
        ...(input.buildingId !== undefined ? { buildingId: input.buildingId } : {}),
        ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
        ...(input.damageAssessmentId !== undefined
          ? { damageAssessmentId: input.damageAssessmentId }
          : {}),
        ...(input.scheduledRevisitAt !== undefined
          ? { scheduledRevisitAt: input.scheduledRevisitAt }
          : {}),
      },
      include: includeRelations,
    });
    return toDomain(row as unknown as CaseRow);
  }

  async delete(id: string): Promise<void> {
    await this.db.case.delete({ where: { id } });
  }
}
