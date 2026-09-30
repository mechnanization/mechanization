import { getLabels } from '@mechanization/shared-schemas';
import type { FeeAssessment } from '@mechanization/shared-schemas';
import { formatLbp } from './currency';

/**
 * One line saying how an invoice's amount was arrived at.
 *
 * The answer to the only question anyone asks at the counter — «ليش عليّ
 * هالمبلغ؟» — and the reason the breakdown is stored on the payment at all. A
 * bill that says «600,000 ل.ل» and nothing else is a number a resident can
 * only accept or argue with; «6 محل تجاري × 100,000 ل.ل» is one they can
 * check, and the register is what they would be checking it against.
 *
 * Returns null for a flat charge, whose amount already explains itself, and
 * for every invoice raised before per-unit billing existed.
 */
export function describeAssessment(
  assessment: FeeAssessment | null | undefined,
  locale: string = 'ar',
): string | null {
  if (!assessment || assessment.basis === 'FLAT') return null;

  const isEnglish = locale === 'en';
  const rate = formatLbp(assessment.rate, locale);

  if (assessment.basis === 'PER_AREA') {
    const area = Math.round(assessment.totalArea).toLocaleString('en-US');
    const line = isEnglish ? `${area} m² × ${rate}` : `${area} م² × ${rate}`;
    return withLeftOut(line, assessment, isEnglish);
  }

  const counted = `${assessment.unitCount} ${countedThing(assessment, locale)} × ${rate}`;

  /*
    What was left out, said out loud.

    A deduction that shows up only as a smaller number is one the resident
    cannot verify and the clerk cannot audit — «٦ محل × ١٠٠٬٠٠٠» on a citizen
    who holds nine reads as a register that lost three of them. Naming the
    three makes the line checkable in the direction that matters: against the
    property cards, where the مؤجرة or شاغرة that dropped them is recorded and
    can be corrected.

    Deliberately not itemised by reason. «٣ وحدات غير محتسبة» is the fact the
    person holding the bill needs; which of three rules dropped each one is a
    question for the register, not for a line on an invoice.
  */
  return withLeftOut(counted, assessment, isEnglish);
}

/**
 * The units left out, said out loud: those the bearer rule did not charge this
 * person for, and — separately, because it is a different fact — the flats
 * whose occupancy fee is held while their records are under review
 * («تعارض في حالة الوحدة»). A held flat is not exempt: it is charged to whoever
 * the review finds bears it, on a later run.
 */
function withLeftOut(line: string, assessment: FeeAssessment, isEnglish: boolean): string {
  const notes: string[] = [];
  if (assessment.excludedUnitCount) {
    notes.push(
      isEnglish
        ? `${assessment.excludedUnitCount} not charged`
        : `${assessment.excludedUnitCount} وحدة غير محتسبة`,
    );
  }
  if (assessment.heldUnitCount) {
    notes.push(
      isEnglish
        ? `${assessment.heldUnitCount} held for review`
        : `${assessment.heldUnitCount} وحدة موقوفة للمراجعة`,
    );
  }
  return notes.length === 0 ? line : `${line} (${notes.join(isEnglish ? '; ' : '، ')})`;
}

/**
 * What was counted, named as specifically as the breakdown allows.
 *
 * A notice aimed at محلات bills lines that are all shops, and saying so is the
 * whole value of the line — «6 محل تجاري» is checkable in a way «6 وحدة» is
 * not. A notice with no category counts a mix, and there the generic word is
 * the honest one: naming the first line's type would quietly claim the other
 * five were the same.
 */
function countedThing(assessment: FeeAssessment, locale: string): string {
  const labels = getLabels(locale);
  const types = new Set(assessment.lines.map((line) => line.unitType));
  const only = types.size === 1 ? [...types][0] : null;

  if (only) {
    const label = labels.unitType[only as keyof typeof labels.unitType];
    if (label) return label;
  }

  return locale === 'en' ? 'unit(s)' : 'وحدة';
}
