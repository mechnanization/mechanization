import { z } from 'zod';
import { isDwellingUnitType } from './enums';

/**
 * «دوبلكس» and «تريبلكس» — one home on several levels (migration 0095,
 * decision D28, 2026-10-17, replacing D27).
 *
 * A unit has always had one `floor`. A home that runs over two levels was
 * recorded either as two flats or as one flat with a note, and neither could be
 * read by the biller — which now matters, because the municipality charges per
 * roof («لكل سقف») and a duplex pays 1.8 roofs where two separate flats stacked
 * on each other pay 2. So the register says it: `levels` is how many levels
 * this one unit spans, upward from its `floor`, which stays its entrance and
 * the floor its code is read from.
 *
 * The rules, each the user's decision:
 *
 *  - Only a dwelling spans levels — a شقة or a منزل مستقل
 *    (CHECK `units_levels_dwelling_only`). A shop with a mezzanine stays one.
 *  - A FLAT on N levels weighs `levelFactors[N]` roofs under a per-unit notice:
 *    a table each municipality keeps in its settings, `{"2": 1.8}` by default.
 *    A level count the table does not price is not billed by guess — the
 *    citizen is reported unassessable until someone enters the factor.
 *  - A HOUSE on N storeys weighs N full roofs. The discount is for flats.
 *  - Area-based and flat-amount notices ignore all of this: an area fee charges
 *    the area of every level, and a flat fee is per person.
 */

/** The most levels one unit may span — `units_levels_range`. A sanity bound, not a policy. */
export const MAX_UNIT_LEVELS = 6;

/** Whether a unit of this type may span more than one level — `units_levels_dwelling_only`. */
export function canSpanLevels(unitType: string | null | undefined): boolean {
  return isDwellingUnitType(unitType);
}

/** How many levels a unit spans, defaulting the pre-0095 shape (and a missing value) to one. */
export function unitLevels(unit: { levels?: number | null }): number {
  return unit.levels != null && unit.levels >= 1 ? Math.floor(unit.levels) : 1;
}

/** The top floor a unit reaches: its entrance floor plus every level above it. */
export function unitTopFloor(unit: { floor: number; levels?: number | null }): number {
  return unit.floor + unitLevels(unit) - 1;
}

/** Whether a unit occupies `floor` — at its entrance or as an upper level. */
export function unitCoversFloor(unit: { floor: number; levels?: number | null }, floor: number): boolean {
  return floor >= unit.floor && floor <= unitTopFloor(unit);
}

export const unitLevelsField = z.coerce
  .number({ invalid_type_error: 'عدد طوابق المسكن يجب أن يكون رقماً' })
  .int('عدد طوابق المسكن يجب أن يكون رقماً صحيحاً')
  .min(1, 'المسكن طابق واحد على الأقل')
  .max(MAX_UNIT_LEVELS, `المسكن لا يتجاوز ${MAX_UNIT_LEVELS} طوابق`);

/** The factor table a fresh municipality starts with — the 0095 column default. */
export const DEFAULT_LEVEL_FACTORS: Readonly<Record<string, number>> = Object.freeze({ '2': 1.8 });

/**
 * «معامل السقوف» — what a flat on N levels weighs, per N, in roofs.
 *
 * Keys are level counts from 2 to `MAX_UNIT_LEVELS` (a one-level flat is one
 * roof by definition and is not in the table). A factor is a discount or
 * nothing: at least one roof, and never more than the N separate flats it
 * replaces — a duplex that cost more than two flats would punish recording it
 * truthfully.
 */
export const levelFactorsSchema = z
  .record(
    z.string().regex(/^[2-6]$/, 'عدد الطوابق في جدول المعاملات بين 2 و6'),
    z.coerce
      .number({ invalid_type_error: 'المعامل يجب أن يكون رقماً' })
      .positive('المعامل يجب أن يكون أكبر من صفر'),
  )
  .superRefine((table, ctx) => {
    for (const [key, factor] of Object.entries(table)) {
      const levels = Number(key);
      if (factor < 1 || factor > levels) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `معامل ${levels} طوابق بين 1 و${levels}`,
        });
      }
    }
  });

export type LevelFactors = z.infer<typeof levelFactorsSchema>;

/**
 * Reads a stored table, dropping anything the schema would refuse.
 *
 * The column is a JSON object by CHECK, but its contents are only as good as
 * whatever wrote them; a malformed entry is treated as absent (so its level
 * count is unpriced and reported) rather than trusted.
 */
export function readLevelFactors(value: unknown): LevelFactors {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const table: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = levelFactorsSchema.safeParse({ [key]: raw });
    if (parsed.success) Object.assign(table, parsed.data);
  }
  return table;
}

/**
 * How many roofs one unit is, for a per-unit notice.
 *
 * `null` means this flat's level count has no factor in the table — the caller
 * must refuse to bill rather than pick a number.
 */
export function roofWeight(
  unit: { unitType: string | null; levels?: number | null },
  factors: LevelFactors,
): number | null {
  const levels = unitLevels(unit);
  if (levels === 1) return 1;
  if (unit.unitType === 'APARTMENT') return factors[String(levels)] ?? null;
  // A house on N storeys is N full roofs (decision D28). Any other type cannot
  // span levels (CHECK units_levels_dwelling_only), so this is its one roof.
  if (unit.unitType === 'INDEPENDENT_HOUSE') return levels;
  return 1;
}

/**
 * What a unit's level count is called — «دوبلكس», «تريبلكس», «4 طوابق» — or
 * `null` for a one-level unit, which needs no word.
 */
export function unitLevelsLabel(levels: number | null | undefined, locale: string): string | null {
  const count = unitLevels({ levels });
  if (count === 1) return null;
  const en = locale === 'en';
  if (count === 2) return en ? 'Duplex' : 'دوبلكس';
  if (count === 3) return en ? 'Triplex' : 'تريبلكس';
  return en ? `${count} levels` : `${count} طوابق`;
}
