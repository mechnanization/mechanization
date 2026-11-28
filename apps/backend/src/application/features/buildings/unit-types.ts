import { isStructuralUnitType, type UnitType } from '@mechanization/shared-schemas';
import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { NotFoundError, ValidationError } from '../../common/exceptions';

/** What a unit is filed as: its type, and the base `UnitType` every reader keys on. */
export interface TypedUnit {
  unitTypeId: string | null;
  unitType: UnitType;
}

/** What `resolve` needs of a type row. */
export interface UnitTypeRow {
  id: string;
  nameAr: string;
  baseType: UnitType;
  isSystem: boolean;
  isActive: boolean;
}

export interface UnitTypeIndex {
  /**
   * «نوع الوحدة» on a unit's create or edit (migration 0109; the user's request
   * of 2026-11-21). The type decides `unitType`, never the value beside it, so
   * a unit cannot carry a type that says «مدرسة» and the behaviour of a shop.
   *
   * - A type sent: it must exist, and be active unless the unit already has it
   *   (`UNIT_TYPE_INACTIVE`: refused on a new unit, kept on an old one). The
   *   unit takes the type's base as its `unitType`.
   * - Only a `unitType` sent — an older client, or a queued offline save: the
   *   unit is filed under that base's system type, unless it already has a type
   *   with that base (a school stays a school when its base is re-sent). A
   *   structural type (`PILOTIS`, `EMPTY_FLOOR`) has no type row and no id.
   * - Neither, on an edit: a unit with no type yet (created by the build before
   *   0109 after it ran) is given its base's system type; otherwise nothing
   *   changes (`null`).
   */
  resolve(input: { unitTypeId?: string | null; unitType?: UnitType }, current: TypedUnit | null): TypedUnit | null;
}

/** The pure half: an index over the municipality's types, which are a handful of rows. */
export function indexUnitTypes(rows: readonly UnitTypeRow[]): UnitTypeIndex {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const systemByBase = new Map(rows.filter((row) => row.isSystem).map((row) => [row.baseType, row.id]));

  return {
    resolve(input, current) {
      if (input.unitTypeId) {
        const type = byId.get(input.unitTypeId);
        if (!type) {
          throw new NotFoundError({ code: 'UNIT_TYPE_NOT_FOUND', message: 'This unit type does not exist.' });
        }
        if (!type.isActive && current?.unitTypeId !== type.id) {
          throw new ValidationError({
            code: 'UNIT_TYPE_INACTIVE',
            message: 'This unit type is no longer offered.',
            params: { name: type.nameAr },
          });
        }
        return { unitTypeId: type.id, unitType: type.baseType };
      }

      const unitType = input.unitType ?? current?.unitType;
      if (unitType === undefined) return null;
      if (isStructuralUnitType(unitType)) {
        return current && current.unitTypeId === null && current.unitType === unitType ? null : { unitTypeId: null, unitType };
      }
      // Already filed under a type with this base: keep it, custom or not.
      if (current && current.unitTypeId !== null && current.unitType === unitType) return null;

      return { unitTypeId: systemByBase.get(unitType) ?? null, unitType };
    },
  };
}

/** Reads the municipality's types once; a batch of units resolves against it without a query each. */
export async function loadUnitTypes(db: Pick<TenantPrismaClient, 'unitTypeEntry'>): Promise<UnitTypeIndex> {
  const rows = await db.unitTypeEntry.findMany({
    select: { id: true, nameAr: true, baseType: true, isSystem: true, isActive: true },
  });
  return indexUnitTypes(rows);
}
