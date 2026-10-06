import { municipalToday } from './cash-policy';
import type { DamageLevel } from './enums';

/**
 * The rules a damage reading is judged by, in one place for the server that
 * stores it, the biller that holds a fee on it and every screen that colours
 * it.
 */

/**
 * The scale ordered worst-first — the order a rollup needs.
 *
 * `UNCLASSIFIED` sits at the bottom deliberately and is not a severity at all:
 * it means nobody has judged the structure yet. Ranking it as "least damaged"
 * would let an unassessed building outrank a `NOT_AFFECTED` one in a
 * worst-case rollup, which reads on the map as "we checked and it is fine".
 *
 * One ladder for the server's rollups and the map's rings. It was two copies,
 * and a level added to one and not the other drew an assessed building with no
 * ring — which on the map means nobody has looked.
 */
export const DAMAGE_SEVERITY = [
  'TOTAL_COLLAPSE',
  'UNSAFE_EVACUATE',
  'RESTRICTED_USE',
  'SAFE_MINOR_DAMAGE',
  'NOT_AFFECTED',
  'UNCLASSIFIED',
] as const satisfies readonly DamageLevel[];

/** Lower is worse. No reading sorts after every level; an unknown label just before that. */
export function damageSeverity(level: string | null | undefined): number {
  if (!level) return DAMAGE_SEVERITY.length + 1;
  const index = (DAMAGE_SEVERITY as readonly string[]).indexOf(level);
  return index === -1 ? DAMAGE_SEVERITY.length : index;
}

/** The worse of two levels, for a building rolling up its units. */
export function worstDamage(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return damageSeverity(a) <= damageSeverity(b) ? a : b;
}

/*
 * ── Habitability: the second axis ──────────────────────────────────────────
 *
 * «صالحة للسكن؟» is asked beside the structural level, never folded into it
 * (decision, 2026-10-05). The UN-Habitat scale stays verbatim so the
 * municipality's figures still add up with the national reconstruction
 * datasets (D4); whether anybody can live in the unit is a separate yes/no.
 * A unit can be structurally sound and still not fit to live in — no windows,
 * no water, the kitchen gone — which is the reading the scale has no word for.
 * Post-disaster practice keeps the two apart for the same reason (ATC-20's
 * placards and FEMA P-2055's habitability evaluation sit on top of the
 * structural one).
 */

/**
 * The levels that settle habitability by themselves: nobody lives in a
 * building that has collapsed or that its residents must leave tonight. The
 * form shows «غير صالحة للسكن» locked, and the server refuses «صالحة».
 */
export const NEVER_HABITABLE_DAMAGE_LEVELS = [
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
] as const satisfies readonly DamageLevel[];

/**
 * The levels whose answer starts at «صالحة للسكن» and can be changed. A sound
 * or lightly damaged unit is normally lived in; an inspector who finds it
 * stripped of its services says so.
 */
export const HABITABLE_BY_DEFAULT_DAMAGE_LEVELS = [
  'NOT_AFFECTED',
  'SAFE_MINOR_DAMAGE',
] as const satisfies readonly DamageLevel[];

/** What the habitability question starts at for a level, and whether it can be changed. */
export interface HabitabilityDefault {
  /** The prefilled answer; null means nothing is assumed. */
  value: boolean | null;
  /** The level decides it, and no other answer is accepted. */
  locked: boolean;
  /** A reading at this level must carry an answer. */
  required: boolean;
}

/**
 * The prefill for a level.
 *
 * - collapse or evacuation: «غير صالحة», locked;
 * - no or minor damage: «صالحة», changeable;
 * - restricted use: no default — the one level where either answer is
 *   ordinary, so the inspector is made to say which;
 * - unclassified: no default and no answer required — nobody has judged the
 *   structure, so nobody has judged whether it can be lived in.
 */
export function habitabilityFor(level: DamageLevel): HabitabilityDefault {
  if ((NEVER_HABITABLE_DAMAGE_LEVELS as readonly string[]).includes(level)) {
    return { value: false, locked: true, required: true };
  }
  if ((HABITABLE_BY_DEFAULT_DAMAGE_LEVELS as readonly string[]).includes(level)) {
    return { value: true, locked: false, required: true };
  }
  if (level === 'UNCLASSIFIED') return { value: null, locked: false, required: false };
  return { value: null, locked: false, required: true };
}

/**
 * Whether a reading makes a finding about habitability at all.
 *
 * «غير مصنّف» with no answer judged nothing: nobody assessed the structure, so
 * nobody assessed whether it can be lived in. Such a reading is kept as
 * history, but it does not decide habitability — in particular it does not end
 * a hold an earlier reading started, which waits for a reading that says
 * otherwise (decision 2: «until a re-inspection reads it habitable»). Every
 * other reading answers, explicitly or by its level. `answersHabitabilitySql`
 * (`apps/backend/src/application/features/buildings/habitability.ts`) is its
 * SQL twin; change them together.
 */
export function answersHabitability(reading: { level: string; habitable?: boolean | null }): boolean {
  return !(reading.level === 'UNCLASSIFIED' && (reading.habitable === null || reading.habitable === undefined));
}

/**
 * Whether this reading says nobody can live in its target.
 *
 * An explicit «غير صالحة» does. So does a reading recorded before the
 * question existed (`habitable` null) at a level that settles it — a collapsed
 * or evacuated building was never habitable, whether or not anyone was asked.
 * The billing hold, the re-inspection worklist and the panels' notice all read
 * this one predicate — of the latest reading that `answersHabitability` — and
 * `uninhabitableSql` (`apps/backend/src/application/features/buildings/habitability.ts`)
 * states the same rule in SQL.
 */
export function isUninhabitableReading(reading: {
  level: string;
  habitable?: boolean | null;
}): boolean {
  if (reading.habitable === false) return true;
  if (reading.habitable == null) {
    return (NEVER_HABITABLE_DAMAGE_LEVELS as readonly string[]).includes(reading.level);
  }
  return false;
}

/**
 * The calendar day a date-only value names, as `YYYY-MM-DD`.
 *
 * A planned day travels as `YYYY-MM-DD` and is coerced to midnight UTC, so the
 * UTC date *is* the day the inspector picked — reading it in another zone
 * would move it.
 */
export function calendarDayOf(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Whether a re-inspection day is still ahead: today or later on the
 * municipality's own calendar (`municipalToday`), not the server's UTC day and
 * not the browser's. Between midnight and three in the morning in Beirut those
 * two disagree, and either would accept a day already gone.
 */
export function isReinspectDayAhead(day: Date | string, now: Date = new Date()): boolean {
  return calendarDayOf(day) >= municipalToday(now);
}

/** Whether a planned re-inspection day has passed. */
export function isReinspectOverdue(day: Date | string, now: Date = new Date()): boolean {
  return calendarDayOf(day) < municipalToday(now);
}
