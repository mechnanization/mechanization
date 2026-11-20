import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { NotFoundError, ValidationError } from '../../common/exceptions';

/** What a building is filed as: its type, and the `StructureType` every reader keys on. */
export interface TypedStructure {
  buildingTypeId: string | null;
  structureType: string;
}

/**
 * «نوع المبنى» on a building's create or edit (migration 0106; the user's
 * request of 2026-11-16). The type decides `structureType`, never the body
 * beside it, so a building cannot carry a type that says «مستوصف» and the
 * behaviour of a hangar.
 *
 * - A type sent: it must exist, and be active unless the building already has
 *   it (an inactive type is refused on a new building and kept on an old one,
 *   `BUILDING_TYPE_INACTIVE`). The building takes its `structureType`.
 * - Only a `structureType` sent — an older client, or a queued offline save: the
 *   building is filed under that structure's system type, unless its current
 *   type already has that structure.
 * - Neither, on an edit: a building with no type yet (created by the build
 *   before 0106 after it ran) is given its structure's system type; otherwise
 *   nothing changes (`null`).
 */
export async function resolveBuildingType(
  db: Pick<TenantPrismaClient, 'buildingType'>,
  input: { buildingTypeId?: string | null; structureType?: string },
  current: TypedStructure | null,
): Promise<TypedStructure | null> {
  if (input.buildingTypeId) {
    const type = await db.buildingType.findUnique({
      where: { id: input.buildingTypeId },
      select: { id: true, structureType: true, isActive: true, nameAr: true },
    });
    if (!type) {
      throw new NotFoundError({ code: 'BUILDING_TYPE_NOT_FOUND', message: 'This building type does not exist.' });
    }
    if (!type.isActive && current?.buildingTypeId !== type.id) {
      throw new ValidationError({
        code: 'BUILDING_TYPE_INACTIVE',
        message: 'This building type is no longer offered.',
        params: { name: type.nameAr },
      });
    }
    return { buildingTypeId: type.id, structureType: String(type.structureType) };
  }

  const structureType = input.structureType ?? (current && current.buildingTypeId === null ? current.structureType : undefined);
  if (structureType === undefined) return null;
  if (current && current.buildingTypeId !== null && current.structureType === structureType) return null;

  const system = await db.buildingType.findFirst({
    where: { isSystem: true, structureType: structureType as never },
    select: { id: true },
  });
  return { buildingTypeId: system?.id ?? null, structureType };
}
