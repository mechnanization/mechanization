import {
  answersHabitability,
  isReinspectOverdue,
  isUninhabitableReading,
  municipalToday,
  type DamageLevel,
  type DamageSource,
} from '@mechanization/shared-schemas';
import type { DamageAssessmentRow, RecordDamageInput } from './api-client';

/**
 * Damage readings, as the census panels read them — the rules live in
 * `@mechanization/shared-schemas` (`damage-rule.ts`); this is the panels'
 * side of them, kept pure so it is tested.
 */

/** What a reading is about: one flat, or the whole structure. */
export type DamageTarget = { unitId: string } | { buildingId: string };

/**
 * The reading that applies to a target *now*.
 *
 * For a flat: the latest of its own readings and its building's — a
 * whole-building reading after a strike speaks for every flat until a flat is
 * read on its own. For the structure: its own latest whole-building reading.
 * Latest by the day of the visit (`history` arrives newest first, ordered by
 * `assessedAt` — `DamageService.history`), the same rule the server's fee hold
 * reads (`currentReadingForUnit`).
 */
export function applicableReading(
  history: readonly DamageAssessmentRow[],
  target: DamageTarget,
): DamageAssessmentRow | null {
  if ('unitId' in target) {
    return history.find((row) => row.unitId === target.unitId || row.unitId === null) ?? null;
  }
  return history.find((row) => row.unitId === null) ?? null;
}

/**
 * The reading that decides whether this target can be lived in now: the latest
 * that applies to it and makes a finding (`answersHabitability`). A later
 * «غير مصنّف» with no answer judged nothing, so it leaves an earlier
 * «غير صالحة للسكن» standing — the server's fee hold and «بانتظار إعادة
 * الكشف» read the same reading (`currentReadingForUnit`, `answering`).
 */
export function governingReading(
  history: readonly DamageAssessmentRow[],
  target: DamageTarget,
): DamageAssessmentRow | null {
  return applicableReading(history.filter((row) => answersHabitability(row)), target);
}

/** Whether the reading that decides for this target says nobody can live in it. */
export function isUninhabitableNow(history: readonly DamageAssessmentRow[], target: DamageTarget): boolean {
  const reading = governingReading(history, target);
  return reading !== null && isUninhabitableReading(reading);
}

/** Whether a planned re-inspection day has passed, on the municipality's calendar. */
export function reinspectOverdue(reinspectAt: string | null | undefined, now: Date = new Date()): boolean {
  return Boolean(reinspectAt) && isReinspectOverdue(reinspectAt!, now);
}

/** Today, as `YYYY-MM-DD`, on the municipality's calendar — the earliest re-inspection day, the latest visit day. */
export function today(now: Date = new Date()): string {
  return municipalToday(now);
}

/** What the damage form gives back. */
export interface DamageFormValues {
  level: DamageLevel;
  source: DamageSource;
  observations: string;
  assessedAt: string;
  /** Null where the level leaves it unasked (unclassified). */
  habitable: boolean | null;
  /** "YYYY-MM-DD", only on a «غير صالحة للسكن» reading; empty otherwise. */
  reinspectAt: string;
}

/**
 * The request a form submission makes. A re-inspection day left over from an
 * earlier answer is not sent once the answer is «صالحة»; the server refuses
 * it on a habitable reading anyway.
 */
export function damageInput(values: DamageFormValues, target: DamageTarget): RecordDamageInput {
  return {
    ...target,
    level: values.level,
    source: values.source,
    observations: values.observations.trim() || undefined,
    assessedAt: values.assessedAt || undefined,
    ...(values.habitable === null ? {} : { habitable: values.habitable }),
    reinspectAt: values.habitable === false ? values.reinspectAt || undefined : undefined,
  };
}
