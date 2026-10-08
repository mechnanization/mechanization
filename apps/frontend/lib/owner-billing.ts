import { createTranslator } from 'next-intl';
import { getLabels, isStructuralUnitType, normalizeDigits, ownerSharesValue } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { FORMAT_LOCALE, type Locale } from './api-errors';
import type { CitizenProfileUnit, UnitOccupant, UnitWithOccupants } from './api-client';

/*
  «توزيع الرسم على المالكين» on the screen (migration 0075): who the owners
  are, what an officer typed, and how a flat's division is said — once, for the
  unit panel, the owner's file and the citizen's own «ملفّي». A plain module
  rather than a hook, as `fee-assessment.ts` is, so it is testable and the two
  audiences cannot word the same fact two ways.
*/
const translators = {
  ar: createTranslator({ locale: FORMAT_LOCALE.ar, messages: { ownerBilling: ar.ownerBilling }, namespace: 'ownerBilling' }),
  en: createTranslator({ locale: FORMAT_LOCALE.en, messages: { ownerBilling: en.ownerBilling }, namespace: 'ownerBilling' }),
};

function translatorFor(locale: string) {
  return translators[(locale === 'en' ? 'en' : 'ar') satisfies Locale];
}

/**
 * أسهم as typed: a whole number from 1 to 2400 (`ownerSharesValue`, the bound
 * the server refuses outside), or nothing usable. Arabic-Indic digits are read
 * as the numbers they are — «١٢٠٠» is 1200 — because that is what an Arabic
 * keyboard types (FRM-4).
 */
export function parseShares(value: string): number | null {
  const typed = normalizeDigits(value).trim();
  if (!/^\d+$/.test(typed)) return null;
  const parsed = ownerSharesValue.safeParse(typed);
  return parsed.success ? parsed.data : null;
}

/**
 * A flat's current OWNER spells, one per person, in the order the server reads
 * them (`activeOwnerSpells`: from the earliest `fromDate`, then the earliest
 * recorded) — open and archived files alike.
 */
export function ownerSpells(unit: Pick<UnitWithOccupants, 'occupants'>): UnitOccupant[] {
  const seen = new Set<string>();
  return unit.occupants
    .filter((occupant) => occupant.toDate === null && occupant.role === 'OWNER')
    .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || (a.recordedAt ?? '').localeCompare(b.recordedAt ?? ''))
    .filter((occupant) => (seen.has(occupant.citizenId) ? false : (seen.add(occupant.citizenId), true)));
}

/**
 * The owners billing divides the flat between — those whose file is open. An
 * archived file is never billed, so its part falls to the others (the server's
 * `activeOwnerSpells`, the same rule).
 */
export function currentOwners(unit: Pick<UnitWithOccupants, 'occupants'>): UnitOccupant[] {
  return ownerSpells(unit).filter((occupant) => occupant.citizenActive !== false);
}

/** The owners left out of the division because their file is archived. */
export function archivedOwners(unit: Pick<UnitWithOccupants, 'occupants'>): UnitOccupant[] {
  return ownerSpells(unit).filter((occupant) => occupant.citizenActive === false);
}

/**
 * Whether the unit panel shows «توزيع الرسم على المالكين»: a flat with several
 * owners, or one that lost its co-owners and still carries a choice somebody
 * should withdraw. Never a structural floor (طابق أعمدة, طابق فارغ), which is
 * not billed and which the server refuses a choice for.
 */
export function showsOwnerBilling(
  unit: Pick<UnitWithOccupants, 'occupants' | 'ownerBillingMode' | 'unitType'>,
): boolean {
  if (isStructuralUnitType(unit.unitType)) return false;
  return currentOwners(unit).length > 1 || Boolean(unit.ownerBillingMode);
}

/** A co-owned flat's billing as an owner's file or «ملفّي» carries it. */
export type OwnerBillingView = NonNullable<CitizenProfileUnit['ownerBilling']>;

export interface OwnerBillingWording {
  /** The method in force, or «بالتساوي (لم تُختر طريقة)» when nobody chose. */
  method: string;
  /** This owner's part of it. */
  part: string;
  /** Why the method is not the one chosen; null when it is (and always on «ملفّي», which is not sent it). */
  fallback: string | null;
  /** Method and part as one sentence, for a single line. */
  line: string;
}

/**
 * How a co-owned flat is billed, said to staff about an owner (`file`) or to
 * the owner themselves (`mine`).
 *
 * Both read «مالك مسؤول» from the part alone: 0/1 is someone else paying, 1/1
 * is this owner paying for all. That is the figure billing charges, so the two
 * screens cannot disagree with each other or with the bill.
 */
export function ownerBillingWording(
  billing: OwnerBillingView,
  locale: string,
  perspective: 'file' | 'mine',
): OwnerBillingWording {
  const t = translatorFor(locale);
  const mine = perspective === 'mine';
  const method = billing.mode ? getLabels(locale).ownerBillingMode[billing.effectiveMode] : t('fileDefault');

  let part: string;
  if (!billing.share) {
    part = mine ? t('mineUnknown') : t('fileUnknown');
  } else if (billing.effectiveMode === 'RESPONSIBLE_OWNER') {
    const paysNone = billing.share.numerator === 0;
    if (mine) part = paysNone ? t('minePaysNone') : t('minePaysAll');
    else part = paysNone ? t('filePaysNone') : t('filePaysAll');
  } else {
    const { numerator, denominator } = billing.share;
    part = mine ? t('mineShare', { numerator, denominator }) : t('fileShare', { numerator, denominator });
  }

  return {
    method,
    part,
    fallback: billing.fallback === 'RESPONSIBLE_NOT_OWNER' ? t('fallback') : null,
    line: t('summaryLine', { method, part }),
  };
}
