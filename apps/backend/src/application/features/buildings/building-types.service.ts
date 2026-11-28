import { Injectable } from '@nestjs/common';
import {
  compareBuildingTypes,
  type BuildingTypeView,
  type CreateBuildingTypeInput,
  type StructureType,
  type UnitType,
  type UpdateBuildingTypeInput,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolationOn } from '../../../infrastructure/prisma/prisma-errors';
import { StaffActor } from '../../common/actor';

const TYPE_SELECT = {
  id: true,
  nameAr: true,
  nameEn: true,
  structureType: true,
  defaultUnitType: true,
  isSystem: true,
  isActive: true,
  sortOrder: true,
  _count: { select: { buildings: true } },
} as const;

type TypeRow = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  structureType: string;
  defaultUnitType: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  _count: { buildings: number };
};

/** What the audit row records of a type: its names and settings, never a person. */
function audited(row: TypeRow) {
  return {
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    structureType: row.structureType,
    defaultUnitType: row.defaultUnitType,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function toView(row: TypeRow): BuildingTypeView {
  return {
    id: row.id,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    structureType: row.structureType as StructureType,
    defaultUnitType: row.defaultUnitType as UnitType,
    isSystem: row.isSystem,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    buildingCount: row._count.buildings,
  };
}

/**
 * «أنواع المباني» — the municipality's own list of building types (migration
 * 0106; the user's request of 2026-11-16).
 *
 * Every type takes the behaviour of one `StructureType`; a building's
 * `structureType` is written from its type (`resolveBuildingType`). The system
 * types, one per `StructureType`, come from the migration: they can be renamed,
 * reordered or switched off, never moved to another structure
 * (`BUILDING_TYPE_SYSTEM_STRUCTURE`, and the trigger behind it). A custom type
 * moves only while no building has it (`BUILDING_TYPE_STRUCTURE_IN_USE`). No
 * type is deleted: the expense categories are the model, and the buildings'
 * key to a type is RESTRICT.
 *
 * Writes are the manager's (`BUILDING_TYPE_ADMIN_ROLES`), Tier 1: the audit
 * row is written in the transaction, filed as `BuildingType`.
 */
@Injectable()
export class BuildingTypesService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /** The list, system types first; switched-off ones only when asked (the screen that edits it). */
  async list(options: { includeInactive: boolean }): Promise<BuildingTypeView[]> {
    const rows = (await this.db.buildingType.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      select: TYPE_SELECT,
    })) as TypeRow[];
    return rows.map(toView).sort(compareBuildingTypes);
  }

  async create(input: CreateBuildingTypeInput, actor: StaffActor): Promise<BuildingTypeView> {
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        const created = (await this.db.buildingType.create({
          data: {
            nameAr: input.nameAr,
            nameEn: input.nameEn?.trim() || null,
            structureType: input.structureType as never,
            defaultUnitType: input.defaultUnitType as never,
            sortOrder: input.sortOrder ?? 100,
            createdById: actor.id,
          },
          select: TYPE_SELECT,
        })) as TypeRow;
        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role,
          action: 'BUILDING_TYPE_CREATED',
          entityType: 'BuildingType',
          entityId: created.id,
          after: audited(created),
        });
        return toView(created);
      });
    } catch (error) {
      throw this.nameTaken(error, input.nameAr);
    }
  }

  async update(id: string, input: UpdateBuildingTypeInput, actor: StaffActor): Promise<BuildingTypeView> {
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        // The row, locked: a building saved meanwhile reads the type it is given.
        await this.db.$queryRaw`SELECT 1 FROM ${this.S}"building_types" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const before = (await this.db.buildingType.findUnique({ where: { id }, select: TYPE_SELECT })) as TypeRow | null;
        if (!before) {
          throw new NotFoundError({ code: 'BUILDING_TYPE_NOT_FOUND', message: 'This building type does not exist.' });
        }
        const moves = input.structureType !== undefined && input.structureType !== before.structureType;
        if (moves && before.isSystem) {
          throw new ValidationError({
            code: 'BUILDING_TYPE_SYSTEM_STRUCTURE',
            message: 'A system building type keeps its structure type.',
          });
        }
        if (moves && before._count.buildings > 0) {
          throw new ConflictError({
            code: 'BUILDING_TYPE_STRUCTURE_IN_USE',
            message: 'Buildings are filed under this type, so its structure type cannot change.',
            params: { count: before._count.buildings },
          });
        }

        const updated = (await this.db.buildingType.update({
          where: { id },
          data: {
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn?.trim() || null } : {}),
            ...(moves ? { structureType: input.structureType as never } : {}),
            ...(input.defaultUnitType !== undefined ? { defaultUnitType: input.defaultUnitType as never } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          },
          select: TYPE_SELECT,
        })) as TypeRow;

        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role,
          action: 'BUILDING_TYPE_UPDATED',
          entityType: 'BuildingType',
          entityId: id,
          before: audited(before),
          after: audited(updated),
        });
        return toView(updated);
      });
    } catch (error) {
      throw this.nameTaken(error, input.nameAr ?? '');
    }
  }

  /** A name another type holds is the unique index's refusal, said with a code; anything else passes through. */
  private nameTaken(error: unknown, name: string): unknown {
    if (isUniqueViolationOn(error, 'nameAr')) {
      return new ConflictError({
        code: 'BUILDING_TYPE_NAME_TAKEN',
        message: 'Another building type has this name.',
        params: { name },
      });
    }
    return error;
  }
}
