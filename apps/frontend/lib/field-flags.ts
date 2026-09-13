import { getLabels } from '@mechanization/shared-schemas';

/**
 * `properties.1.propertyNumber` → «رقم العقار — العقار ٢».
 *
 * A stored flag names a path, which is the right thing to store and the wrong
 * thing to read: nobody reviewing a household's file thinks in dot-paths. The
 * card number is 1-based because that is how the cards are labelled on the form
 * the officer filled in.
 *
 * Shared rather than duplicated because the same stored path is now read by two
 * audiences — the staff profile, which shows it with the reason the officer
 * gave, and ملفّي, which shows the citizen the list of what is still missing
 * from their own file. Two copies of this would drift, and the version the
 * citizen sees is the one nobody would notice drifting.
 */
export function flagFieldLabel(path: string, locale: string): string {
  const labels = getLabels(locale);
  const segments = path.split('.');
  const field = labels.citizenField[segments.at(-1) ?? ''] ?? segments.at(-1) ?? path;

  if (segments[0] !== 'properties') return field;

  /*
    `properties.0.units.2.unitType` — a flag on one flat inside one card.

    Both indices are named, because «نوع الوحدة — العقار ١» on a building with
    nine flats sends whoever reads it to look at all nine. A path with no unit
    index keeps the shorter form it always had.
  */
  const card = Number(segments[1]) + 1;
  const unitIndex = segments.indexOf('units');
  const unit = unitIndex > 0 && segments.length > unitIndex + 1 ? Number(segments[unitIndex + 1]) : NaN;

  if (Number.isNaN(card)) return field;
  if (!Number.isNaN(unit)) {
    return locale === 'en'
      ? `${field} — property ${card}, unit ${unit + 1}`
      : `${field} — العقار ${card}، الوحدة ${unit + 1}`;
  }
  return locale === 'en' ? `${field} — property ${card}` : `${field} — العقار ${card}`;
}
