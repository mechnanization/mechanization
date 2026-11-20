import { z } from 'zod';
import { calendarDayOf } from './damage-rule';
import { feeExemptionReasonSchema, type FeeExemptionReason, type OccupancyRole, type UnitType } from './enums';

/**
 * «قائمة الإعفاء من الرسوم» — the fee whitelist (migration 0104; the user's
 * decisions of 2026-11-16, docs/fees-system-rearchitecture-specification.md,
 * "The fee whitelist").
 *
 * The exemption belongs to a **unit**, never to a person: a citizen who holds
 * three units may have one exempt and pay on the other two. Nothing here is
 * keyed by a citizen; the citizen search only finds the units they hold.
 */

/** The longest a decision number may be, «رقم قرار المجلس البلدي». */
export const FEE_EXEMPTION_DECISION_REF_MAX = 100;
/** A lift's reason in words: at least this long, at most `FEE_EXEMPTION_TEXT_MAX`. */
export const FEE_EXEMPTION_LIFT_REASON_MIN = 3;
export const FEE_EXEMPTION_TEXT_MAX = 500;

/**
 * Whether a unit is exempt from fees on `day` (`YYYY-MM-DD`, a municipal day):
 * an exemption is recorded and its last day, if it has one, is not before
 * `day` (decision 1 of 2026-11-16). An exemption whose period ended is billed
 * again; nothing lifts it automatically, and «ملاحظات الجودة» lists it
 * (`FEE_EXEMPTION_ENDED`).
 *
 * The one predicate every reader asks. Its SQL twin is `feeExemptSql` in the
 * backend (`application/features/buildings/fee-exemption.ts`): change them
 * together.
 *
 * Billing asks it of the first day of the period it bills, so a unit exempt on
 * that day is exempt for the whole period (no proration).
 */
export function isFeeExemptOn(
  unit: { feeExemption: string | null; feeExemptionValidUntil?: string | Date | null },
  day: string,
): boolean {
  if (unit.feeExemption === null) return false;
  if (unit.feeExemptionValidUntil === null || unit.feeExemptionValidUntil === undefined) return true;
  return calendarDayOf(unit.feeExemptionValidUntil) >= day;
}

/**
 * Whether a recorded exemption has run out on `day` but was never lifted: the
 * unit is billed again, and the register still shows it on the list.
 */
export function feeExemptionEndedOn(
  unit: { feeExemption: string | null; feeExemptionValidUntil?: string | Date | null },
  day: string,
): boolean {
  return unit.feeExemption !== null && !isFeeExemptOn(unit, day);
}

/** Which periods the whitelist lists: the ones standing, or the ones lifted. */
export const FEE_EXEMPTION_LIST_STATUS = ['OPEN', 'LIFTED'] as const;
export type FeeExemptionListStatus = (typeof FEE_EXEMPTION_LIST_STATUS)[number];

/** The whitelist's ceiling on a page number, so the offset the server binds stays a number Postgres reads. */
export const FEE_EXEMPTION_LIST_MAX_PAGE = 1_000_000;

/**
 * `GET fee-exemptions` — the whitelist, searched on the server by unit code,
 * building code, the full reference «<building>-<unit>», parcel or holder
 * name.
 */
export const feeExemptionListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  reason: feeExemptionReasonSchema.optional(),
  status: z.enum(FEE_EXEMPTION_LIST_STATUS).default('OPEN'),
  page: z.coerce.number().int().min(1).max(FEE_EXEMPTION_LIST_MAX_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type FeeExemptionListQuery = z.infer<typeof feeExemptionListQuerySchema>;

/**
 * `GET fee-exemptions/units?reference=` — one unit by its full reference,
 * «<building code>-<unit code>» (`formatFullUnitReference`). A unit's own code
 * is only unique inside its building.
 */
export const feeExemptionUnitLookupSchema = z.object({
  reference: z.string().trim().min(3, 'اكتب رمز الوحدة الكامل').max(80),
});
export type FeeExemptionUnitLookup = z.infer<typeof feeExemptionUnitLookupSchema>;

/** A staff member as the list names them. */
export interface FeeExemptionStaffRef {
  id: string;
  name: string;
}

/** One exemption period of a unit (`unit_fee_exemptions`). Staff screens only: the note is free text. */
export interface FeeExemptionPeriodView {
  id: string;
  reason: FeeExemptionReason;
  note: string | null;
  decisionRef: string | null;
  /** The last exempt day, `YYYY-MM-DD`, or null for none. */
  validUntil: string | null;
  grantedAt: string;
  grantedBy: FeeExemptionStaffRef | null;
  liftedAt: string | null;
  liftedBy: FeeExemptionStaffRef | null;
  liftReason: string | null;
}

/** Someone who holds the unit now. */
export interface FeeExemptionHolder {
  citizenId: string;
  name: string;
  role: OccupancyRole;
}

/** The unit and building a period belongs to. */
export interface FeeExemptionUnitRef {
  unitId: string;
  unitCode: string;
  /** «<building code>-<unit code>». */
  reference: string;
  unitType: UnitType | null;
  building: { id: string; code: string; name: string | null; parcelNumber: string };
}

/** A row of the whitelist. */
export interface FeeExemptionListItem extends FeeExemptionUnitRef {
  period: FeeExemptionPeriodView;
  /** Open and past its last day: billed again, still to be lifted. */
  ended: boolean;
  holders: FeeExemptionHolder[];
}

export interface FeeExemptionListResult {
  items: FeeExemptionListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** The municipal day `ended` was judged on. */
  today: string;
}

/** A unit as the grant panel shows it: what it is, who holds it, its standing exemption and its history. */
export interface FeeExemptionUnitView extends FeeExemptionUnitRef {
  unitArea: number | null;
  holders: FeeExemptionHolder[];
  /** The open period, or null when the unit is billed normally. */
  current: FeeExemptionPeriodView | null;
  /** Whether it is exempt today (`isFeeExemptOn`). */
  exemptToday: boolean;
  /** Every period, newest first, the open one included. */
  history: FeeExemptionPeriodView[];
}

/** `GET fee-exemptions/citizens/:citizenId/units` — every unit a person holds now, structural floors left out. */
export interface FeeExemptionCitizenUnits {
  citizen: { id: string; name: string };
  units: Array<FeeExemptionUnitView & { role: OccupancyRole }>;
  today: string;
}
