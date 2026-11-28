import { Injectable } from '@nestjs/common';
import {
  DEFAULT_UNIT_TYPE_BASE,
  compareUnitTypes,
  type CreateUnitTypeInput,
  type UnitType,
  type UnitTypeView,
  type UpdateUnitTypeInput,
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
  baseType: true,
  figureKey: true,
  isSystem: true,
  isActive: true,
  sortOrder: true,
  _count: { select: { units: true } },
} as const;

type TypeRow = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  baseType: string;
  figureKey: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  _count: { units: number };
};

/** What the audit row records of a type: its names and settings, never a person. */
function audited(row: TypeRow) {
  return {
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    baseType: row.baseType,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function toView(row: TypeRow): UnitTypeView {
  return {
    id: row.id,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    baseType: row.baseType as UnitType,
    figureKey: row.figureKey,
    isSystem: row.isSystem,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    unitCount: row._count.units,
  };
}

/**
 * «أنواع الوحدات» — the municipality's own list of unit types (migration 0109;
 * the user's request of 2026-11-21).
 *
 * Every type takes the behaviour of one base `UnitType`; a unit's `unitType` is
 * written from its type (`resolveUnitType`), so fees, brackets and the census
 * read what they always read. The system types, one per premises `UnitType`,
 * come from the migration: they can be renamed, reordered or switched off,
 * never moved to another base (`UNIT_TYPE_SYSTEM_BASE`, and the trigger behind
 * it). A custom type moves only while no unit has it (`UNIT_TYPE_BASE_IN_USE`).
 * No type is deleted: the building types and the expense categories are the
 * model, and the units' key to a type is RESTRICT.
 *
 * Writes are the manager's (`UNIT_TYPE_ADMIN_ROLES`), Tier 1: the audit row is
 * written in the transaction, filed as `UnitType`.
 */
@Injectable()
export class UnitTypesService {
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
  async list(options: { includeInactive: boolean }): Promise<UnitTypeView[]> {
    const rows = (await this.db.unitTypeEntry.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      select: TYPE_SELECT,
    })) as TypeRow[];
    return rows.map(toView).sort(compareUnitTypes);
  }

  async create(input: CreateUnitTypeInput, actor: StaffActor): Promise<UnitTypeView> {
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        const created = (await this.db.unitTypeEntry.create({
          data: {
            nameAr: input.nameAr,
            nameEn: input.nameEn?.trim() || null,
            baseType: (input.baseType ?? DEFAULT_UNIT_TYPE_BASE) as never,
            sortOrder: input.sortOrder ?? 100,
            createdById: actor.id,
          },
          select: TYPE_SELECT,
        })) as TypeRow;
        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role,
          action: 'UNIT_TYPE_CREATED',
          entityType: 'UnitType',
          entityId: created.id,
          after: audited(created),
        });
        return toView(created);
      });
    } catch (error) {
      throw this.nameTaken(error, input.nameAr);
    }
  }

  async update(id: string, input: UpdateUnitTypeInput, actor: StaffActor): Promise<UnitTypeView> {
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        // The row, locked: a unit saved meanwhile reads the type it is given.
        await this.db.$queryRaw`SELECT 1 FROM ${this.S}"unit_types" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const before = (await this.db.unitTypeEntry.findUnique({ where: { id }, select: TYPE_SELECT })) as TypeRow | null;
        if (!before) {
          throw new NotFoundError({ code: 'UNIT_TYPE_NOT_FOUND', message: 'This unit type does not exist.' });
        }
        const moves = input.baseType !== undefined && input.baseType !== before.baseType;
        if (moves && before.isSystem) {
          throw new ValidationError({
            code: 'UNIT_TYPE_SYSTEM_BASE',
            message: 'A system unit type keeps its base type.',
          });
        }
        if (moves && before._count.units > 0) {
          throw new ConflictError({
            code: 'UNIT_TYPE_BASE_IN_USE',
            message: 'Units are filed under this type, so its base type cannot change.',
            params: { count: before._count.units },
          });
        }

        const updated = (await this.db.unitTypeEntry.update({
          where: { id },
          data: {
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn?.trim() || null } : {}),
            ...(moves ? { baseType: input.baseType as never } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          },
          select: TYPE_SELECT,
        })) as TypeRow;

        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role,
          action: 'UNIT_TYPE_UPDATED',
          entityType: 'UnitType',
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
        code: 'UNIT_TYPE_NAME_TAKEN',
        message: 'Another unit type has this name.',
        params: { name },
      });
    }
    return error;
  }
}
