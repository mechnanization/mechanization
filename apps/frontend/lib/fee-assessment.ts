import { createTranslator } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import type { FeeAssessment } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { FORMAT_LOCALE, type Locale } from './api-errors';
import { formatLbp } from './currency';

/*
  The words, from `messages/{ar,en}.json` under `feeAssessment`. A plain
  module rather than a hook, as `api-errors.ts` is: the line is built inside
  table cells, receipts and the citizen's own file, each of which already has
  the locale and calls this with it.
*/
const translators = {
  ar: createTranslator({
    locale: FORMAT_LOCALE.ar,
    messages: { feeAssessment: ar.feeAssessment },
    namespace: 'feeAssessment',
  }),
  en: createTranslator({
    locale: FORMAT_LOCALE.en,
    messages: { feeAssessment: en.feeAssessment },
    namespace: 'feeAssessment',
  }),
};

function translatorFor(locale: string) {
  return translators[(locale === 'en' ? 'en' : 'ar') satisfies Locale];
}

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

  const t = translatorFor(locale);
  const rate = formatLbp(assessment.rate, locale);

  if (assessment.basis === 'PER_AREA') {
    const area = Math.round(assessment.totalArea).toLocaleString('en-US');
    return withLeftOut(t('perArea', { area, rate }), assessment, locale);
  }

  /*
    A co-owned flat charged at this owner's part counts as that part — two
    whole shops and a quarter of a third are 2.25, the figure the rate was
    multiplied by (`chargedUnits`, migration 0075).
  */
  const units = assessment.chargedUnits ?? assessment.unitCount;
  const count = Number.isInteger(units) ? units : Math.round(units * 100) / 100;
  const counted = t('perUnit', { count, thing: countedThing(assessment, locale), rate });

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
  return withLeftOut(counted, assessment, locale);
}

/**
 * The units left out, said out loud: those the bearer rule did not charge this
 * person for, and — separately, because each is a different fact — the flats
 * whose occupancy fee is held while their records are under review
 * («تعارض في حالة الوحدة»), and the flats read «غير صالحة للسكن», whose
 * occupant-borne fees are held until a re-inspection reads them habitable. A
 * held flat is not exempt, but it is not charged on this invoice either. And a
 * flat several people own: charged at this owner's part, or paid by another.
 */
function withLeftOut(line: string, assessment: FeeAssessment, locale: string): string {
  const t = translatorFor(locale);
  const notes: string[] = [];
  if (assessment.excludedUnitCount) notes.push(t('notCharged', { count: assessment.excludedUnitCount }));
  if (assessment.heldUnitCount) notes.push(t('heldForReview', { count: assessment.heldUnitCount }));
  if (assessment.uninhabitableUnitCount) {
    notes.push(t('uninhabitable', { count: assessment.uninhabitableUnitCount }));
  }
  // «توزيع الرسم على المالكين»: a flat several people own, charged at this owner's part or not at all.
  if (assessment.sharedUnitCount) notes.push(t('coOwnedShare', { count: assessment.sharedUnitCount }));
  if (assessment.coOwnerPaidUnitCount) notes.push(t('coOwnerPays', { count: assessment.coOwnerPaidUnitCount }));
  return notes.length === 0 ? line : t('withNotes', { line, notes: notes.join(t('notesSeparator')) });
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

  return translatorFor(locale)('unitFallback');
}
