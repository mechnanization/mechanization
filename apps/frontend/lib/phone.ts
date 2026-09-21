import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/**
 * A stored E.164 number, grouped the way its own country writes it:
 * `+96170964631` → `+961 70 964 631`, `+33612345678` → `+33 6 12 34 56 78`,
 * `+15551234567` → `+1 555 123 4567`.
 *
 * The register holds numbers from anywhere (see `internationalPhone`), and a
 * single grouping rule cannot read them all: the hand-written one this replaces
 * guessed where the country code ended and split `+1 555…` as `+155 512…`. The
 * grouping comes from libphonenumber's metadata, so it follows the country the
 * number belongs to rather than a guess.
 *
 * Always rendered inside `dir="ltr"` by the caller. It only inserts spaces, so
 * copying it back into a form still parses. Anything it cannot parse at all
 * comes back exactly as stored rather than mangled.
 *
 * ## Numbers the country's own patterns do not cover
 *
 * The metadata groups only numbers that fit one of the country's known shapes.
 * A number that is the right length but fits none of them — a legacy row, a
 * mobile missing a digit (`+961 8174134`: an 81 number has eight digits, this
 * has seven) — came back as one unbroken run, the one row in a column nobody
 * could read. Those are grouped in threes from the end, which is how a Lebanese
 * number is written anyway: `+961 8 174 134`. The digits are untouched; only the
 * spacing is a guess, and a guess in the country's own rhythm.
 */
export function formatPhone(value: string): string {
  const parsed = parsePhoneNumberFromString(value.trim());
  if (!parsed) return value;

  const international = parsed.formatInternational();
  const national = international.slice(`+${parsed.countryCallingCode} `.length);
  if (national.includes(' ') || national.length <= 4) return international;

  return `+${parsed.countryCallingCode} ${groupFromEnd(parsed.nationalNumber)}`;
}

/** `8174134` → `8 174 134`: threes from the right, the remainder leading. */
function groupFromEnd(digits: string): string {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(' ');
}
