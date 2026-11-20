import { z } from 'zod';
import { isStructuralUnitType, structureTypeSchema, unitTypeSchema, type StructureType, type UnitType } from './enums';

/**
 * «أنواع المباني» — the building types a municipality picks from (migration
 * 0106; the user's request of 2026-11-16, decision 5: each municipality's own
 * list). Every type takes the behaviour of one `StructureType` value; a
 * building's `structureType` is set from its type by the server. One system
 * type per `StructureType`, made by the migration; the administrator adds the
 * rest (مدرسة, مستوصف, مبنى بلدي, …). A type is deactivated, never deleted.
 *
 * A building's type changes no fee: units keep their `UnitType`, and fees read
 * that. To exempt a public school, exempt its units («قائمة الإعفاء من الرسوم»).
 */

export const BUILDING_TYPE_NAME_MAX = 80;

const nameAr = z.string().trim().min(2, 'اكتب اسم النوع').max(BUILDING_TYPE_NAME_MAX, 'الاسم طويل جداً');
const nameEn = z.string().trim().max(BUILDING_TYPE_NAME_MAX, 'الاسم طويل جداً');
/** What a unit of a building of this type starts as: premises, never a structural floor. */
const defaultUnitType = unitTypeSchema.refine((value) => !isStructuralUnitType(value), 'اختر نوع وحدة');
const sortOrder = z.coerce.number().int().min(0).max(10_000);

/** `POST building-types` — a custom type. */
export const createBuildingTypeSchema = z.object({
  nameAr,
  /** Empty is none. */
  nameEn: nameEn.optional(),
  structureType: structureTypeSchema,
  defaultUnitType,
  sortOrder: sortOrder.optional(),
});
export type CreateBuildingTypeInput = z.infer<typeof createBuildingTypeSchema>;

/**
 * `PATCH building-types/:id` — only what is sent changes. Renaming changes the
 * label only. A system type's `structureType` never changes
 * (`BUILDING_TYPE_SYSTEM_STRUCTURE`); a custom type's only while no building
 * has it (`BUILDING_TYPE_STRUCTURE_IN_USE`), since a building's structure is
 * written from its type when it is saved.
 */
export const updateBuildingTypeSchema = z
  .object({
    nameAr: nameAr.optional(),
    /** `null` or empty clears it. */
    nameEn: nameEn.nullable().optional(),
    structureType: structureTypeSchema.optional(),
    defaultUnitType: defaultUnitType.optional(),
    isActive: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'لا تغيير');
export type UpdateBuildingTypeInput = z.infer<typeof updateBuildingTypeSchema>;

/** `GET building-types?includeInactive=true` — the screen that edits the list reads them all. */
export const listBuildingTypesQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type ListBuildingTypesQuery = z.infer<typeof listBuildingTypesQuerySchema>;

/** A building type as every screen reads it. Ordered: system types first, then by `sortOrder` and name. */
export interface BuildingTypeView {
  id: string;
  nameAr: string;
  nameEn: string | null;
  structureType: StructureType;
  defaultUnitType: UnitType;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  /** How many buildings are filed under it. */
  buildingCount: number;
}

/** A type's name in the page's language, the Arabic one when it has no English name. */
export function buildingTypeName(type: Pick<BuildingTypeView, 'nameAr' | 'nameEn'>, locale: string): string {
  return locale === 'en' && type.nameEn ? type.nameEn : type.nameAr;
}

/** The order every list of types is read in: system types first, then `sortOrder`, then the Arabic name. */
export function compareBuildingTypes(
  a: Pick<BuildingTypeView, 'isSystem' | 'sortOrder' | 'nameAr'>,
  b: Pick<BuildingTypeView, 'isSystem' | 'sortOrder' | 'nameAr'>,
): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.nameAr.localeCompare(b.nameAr, 'ar');
}
