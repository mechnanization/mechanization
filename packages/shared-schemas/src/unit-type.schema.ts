import { z } from 'zod';
import { isStructuralUnitType, unitTypeSchema, type UnitType } from './enums';

/**
 * «أنواع الوحدات» — the unit types a municipality picks from (migration 0109;
 * the user's request of 2026-11-21: the manager adds مدرسة, شركة كهرباء, شركة
 * مياه … as he adds building types). Every type takes the behaviour of one base
 * `UnitType` value (`baseType`); a unit's `unitType` is set from its type by the
 * server, and fees, brackets and the census read that. One system type per
 * premises `UnitType`, made by the migration; the manager adds the rest. A type
 * is deactivated, never deleted.
 *
 * A custom type bills as its base type. A fee of its own is a later phase, set
 * on the fee notice, and needs nothing from this contract.
 *
 * `PILOTIS` and `EMPTY_FLOOR` describe a floor, not premises: they are not
 * types, and a unit of either keeps no `unitTypeId`.
 */

export const UNIT_TYPE_NAME_MAX = 80;

const nameAr = z.string().trim().min(2, 'اكتب اسم النوع').max(UNIT_TYPE_NAME_MAX, 'الاسم طويل جداً');
const nameEn = z.string().trim().max(UNIT_TYPE_NAME_MAX, 'الاسم طويل جداً');
/** The behaviour a type takes: premises, never a structural floor. */
const baseType = unitTypeSchema.refine((value) => !isStructuralUnitType(value), 'اختر نوع وحدة');
const sortOrder = z.coerce.number().int().min(0).max(10_000);

/**
 * The front a unit type is drawn with in the building elevation, beside the
 * base's own (migration 0111; the user's request of 2026-11-21: «implement their
 * figures» — a drawing of its own per default type, none for a type the manager
 * adds). One key per default type of 0110, in the order of its migration. A
 * type with no key, or one this build does not know, is drawn with its base's
 * front, so a key is added here and in `property-illustrations.tsx` together.
 */
export const UNIT_FIGURE = [
  // Public buildings, utilities and places of worship (base مكتب).
  'SCHOOL',
  'ELECTRICITY',
  'WATER',
  'SERAIL',
  'MUNICIPAL',
  'POLICE',
  'SECURITY',
  'MOSQUE',
  'CHURCH',
  'WORSHIP',
  'BANK',
  // Health (base عيادة).
  'DISPENSARY',
  'HEALTH_CENTRE',
  // Trade and services with a shop front (base محل تجاري).
  'RESTAURANT',
  'CAFE',
  'PHARMACY',
  'BAKERY',
  'OVEN',
  'FUEL',
  'SUPERMARKET',
  'BUTCHER',
  'BARBER',
  'BEAUTY',
  // Workshops and production (base مستودع).
  'WORKSHOP',
  'ATELIER',
  'PLANT',
  'FACTORY',
] as const;
export type UnitFigure = (typeof UNIT_FIGURE)[number];

/** A stored key this build can draw, else null: an older build reading a newer key draws the base's front. */
export function knownUnitFigure(key: string | null | undefined): UnitFigure | null {
  return (UNIT_FIGURE as readonly string[]).includes(key ?? '') ? (key as UnitFigure) : null;
}

/**
 * What a new type bills as when no base is sent: «مكتب». The screen asks only
 * for the name (the user's decision of 2026-11-21: one flat list, no billing
 * base shown), so a school or an electricity company is billed as ordinary
 * premises, and a unit that needs no fee goes on «قائمة الإعفاء من الرسوم».
 */
export const DEFAULT_UNIT_TYPE_BASE = 'OFFICE' as const satisfies UnitType;

/** `POST unit-types` — a custom type. */
export const createUnitTypeSchema = z.object({
  nameAr,
  /** Empty is none. */
  nameEn: nameEn.optional(),
  /** Absent is `DEFAULT_UNIT_TYPE_BASE`. */
  baseType: baseType.optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateUnitTypeInput = z.infer<typeof createUnitTypeSchema>;

/**
 * `PATCH unit-types/:id` — only what is sent changes. Renaming changes the
 * label only. A system type's `baseType` never changes (`UNIT_TYPE_SYSTEM_BASE`);
 * a custom type's only while no unit has it (`UNIT_TYPE_BASE_IN_USE`), since a
 * unit's `unitType` is written from its type when it is saved.
 */
export const updateUnitTypeSchema = z
  .object({
    nameAr: nameAr.optional(),
    /** `null` or empty clears it. */
    nameEn: nameEn.nullable().optional(),
    baseType: baseType.optional(),
    isActive: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'لا تغيير');
export type UpdateUnitTypeInput = z.infer<typeof updateUnitTypeSchema>;

/** `GET unit-types?includeInactive=true` — the screen that edits the list reads them all. */
export const listUnitTypesQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type ListUnitTypesQuery = z.infer<typeof listUnitTypesQuerySchema>;

/** A unit type as every screen reads it. Ordered: system types first, then by `sortOrder` and name. */
export interface UnitTypeView {
  id: string;
  nameAr: string;
  nameEn: string | null;
  /** The behaviour it takes: what billing, brackets and the census read. */
  baseType: UnitType;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  /**
   * The drawing the elevation gives its units (`UNIT_FIGURE`), or null for the
   * base's own front. Set by the migration for the default types; no form sets
   * it, so renaming a type never loses it.
   */
  figureKey: string | null;
  /** How many units are filed under it. */
  unitCount: number;
}

/** A type's name in the page's language, the Arabic one when it has no English name. */
export function unitTypeName(type: Pick<UnitTypeView, 'nameAr' | 'nameEn'>, locale: string): string {
  return locale === 'en' && type.nameEn ? type.nameEn : type.nameAr;
}

/** The order every list of unit types is read in: system types first, then `sortOrder`, then the Arabic name. */
export function compareUnitTypes(
  a: Pick<UnitTypeView, 'isSystem' | 'sortOrder' | 'nameAr'>,
  b: Pick<UnitTypeView, 'isSystem' | 'sortOrder' | 'nameAr'>,
): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.nameAr.localeCompare(b.nameAr, 'ar');
}
