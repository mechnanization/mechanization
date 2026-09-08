import { Injectable } from '@nestjs/common';
import type {
  Case,
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
  }): Promise<Case> {
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
      },
      include: includeRelations,
    });
    return toDomain(row as unknown as CaseRow);
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
    },
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
      },
      include: includeRelations,
    });
    return toDomain(row as unknown as CaseRow);
  }

  async delete(id: string): Promise<void> {
    await this.db.case.delete({ where: { id } });
  }
}
