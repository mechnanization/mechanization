import { normalizeDigits } from './primitives';

/**
 * The municipality's own numbering — building codes, unit codes, and the floor
 * normalisation both rest on.
 *
 * Pure functions with no schema and no I/O, because all three are needed in
 * three places that cannot import each other's runtime: the backfill script,
 * the buildings service, and the browser form that has to show a code before
 * the server has minted one. See docs/building-census-plan.md §4.
 *
 * The rule that governs the whole file: **the UUID is the identity and the code
 * is a derived display attribute.** `codeSuffix` and `sequence` are stored and
 * never change; `code` and `unitCode` are recomputed from them. UPRN's lesson —
 * identifiers are permanent, addresses are not.
 */

// ─────────────────────────────  Floors  ─────────────────────────────

/**
 * The floor a free-text label means, or null when it means nothing legible.
 *
 * `BuildingUnit.floor` has been a `String` since the first migration, filled by
 * a plain text input on a phone, so the column holds «الأرضي», «ground», «G»,
 * «0», «ط1», «-1» and «قبو» for what are four distinct floors. None of that can
 * be sorted, none of it can produce a unit code, and none of it can answer "how
 * many floors does this building have" — which is why `Unit.floor` is an `Int`
 * and this is the one-way door between the two.
 *
 * Deliberately *not* used to rewrite the legacy column. That string is what an
 * officer actually wrote down, and re-interpreting it in place would destroy
 * the only record of the ambiguity; the parsed integer lives beside it on the
 * new table instead, and a label this cannot read becomes a null the backfill
 * reports rather than a zero it invents.
 *
 * Returns null — never a fallback floor — for anything unrecognised. A
 * mezzanine («ميزانين») and a roof («سطح») are the honest cases: they are real
 * places an integer cannot name, and guessing 0 for them would file a shop in
 * the wrong flat.
 */
export function parseFloorLabel(input: string | null | undefined): number | null {
  if (input == null) return null;

  const text = fold(input);
  if (!text) return null;

  /*
    Basement before everything else, because it is the only case where a word
    changes the *sign* of a number that is also present: «قبو 2» is −2, and
    every later rule would read the 2 and stop. A basement named without a
    number is the first one down, which is what «قبو» on its own means.
  */
  if (BASEMENT.test(text)) {
    const depth = firstMagnitude(text);
    return clamp(-(depth ?? 1));
  }

  // Ground before the numeric pass so «ground floor» is not read as no digits
  // at all, and before the ordinal pass so «الأرضي» never reaches «الأول».
  if (GROUND.test(text)) return 0;

  /*
    A signed integer anywhere in the label. This is what carries «-1», «ط1»,
    «1st floor» and the bare «3» that most rows actually hold — the sign is
    read only when it is attached to the digits, so «طابق - 1» (a dash used as
    a separator) is floor 1 and not floor −1.
  */
  const signed = /(-?)(\d+)/.exec(text);
  if (signed) return clamp(Number(signed[2]) * (signed[1] ? -1 : 1));

  for (const [pattern, floor] of ORDINALS) {
    if (pattern.test(text)) return floor;
  }

  return null;
}

/**
 * Folds a floor label to the alphabet the rules above compare in.
 *
 * The same normalisation `search_normalize` does in migration 0018, minus what
 * a floor label cannot contain: Arabic-Indic digits to Latin, the four alef
 * forms to bare alef, ة to ه, ى to ي, tashkeel and tatweel stripped, case
 * lowered. Without it «الأرضي» and «الارضي» are two different floors, and
 * «٣» is not a digit at all.
 */
function fold(input: string): string {
  return normalizeDigits(input)
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // Tatweel — a letter-stretching character, not a mark, so it needs naming.
    .replace(/\u0640/g, '')
    // Every tashkeel mark, by what it *is* rather than by a hand-listed range:
    // fatha through sukun and the superscript alef are all nonspacing marks,
    // and so is the next one somebody types. Spelling them out in a character
    // class instead renders them combined onto the bracket, which is both
    // unreadable and what `no-misleading-character-class` refuses.
    .replace(/\p{Mn}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first run of digits, ignoring any sign — the depth in «قبو 2». */
function firstMagnitude(text: string): number | null {
  const match = /\d+/.exec(text);
  return match ? Number(match[0]) : null;
}

/**
 * Refuses a number no building has.
 *
 * The field is free text, so it also holds phone numbers, areas and years that
 * someone typed in the wrong box. A floor outside this range is not a floor,
 * and returning null sends it to the same review queue an unreadable label
 * goes to — which is where a mistyped row belongs.
 */
function clamp(floor: number): number | null {
  return floor >= MIN_FLOOR && floor <= MAX_FLOOR ? floor : null;
}

const MIN_FLOOR = -10;
const MAX_FLOOR = 100;

/**
 * `b1` is included and is the reason this is a single alternation rather than a
 * word list: it is what the unit code itself prints for a basement (§4.2), so a
 * collector copying a code back into a form writes exactly that.
 */
const BASEMENT =
  /قبو|سرداب|تحت الارض|بدروم|basement|cellar|underground|\bsub\b|^b\s*-?\d*$/;

const GROUND = /ارضي|ground|\bgf\b|^g$|^g\s*[.\-/]?\s*f$/;

/**
 * Arabic ordinals, longest compound first.
 *
 * «الثاني عشر» contains «الثاني», so testing the singles first would file the
 * twelfth floor as the second. Ordering the list is the whole safeguard; there
 * is no cleverer rule that survives the next ordinal someone adds.
 */
const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/حادي عشر|احدي عشر/, 11],
  [/ثاني عشر/, 12],
  [/ثالث عشر/, 13],
  [/رابع عشر/, 14],
  [/خامس عشر/, 15],
  [/اول|first/, 1],
  [/ثان|second/, 2],
  [/ثالث|third/, 3],
  [/رابع|fourth/, 4],
  [/خامس|fifth/, 5],
  [/سادس|sixth/, 6],
  [/سابع|seventh/, 7],
  [/ثامن|eighth/, 8],
  [/تاسع|ninth/, 9],
  [/عاشر|tenth/, 10],
];

// ───────────────────────────  Unit codes  ───────────────────────────

/**
 * The unit's display code — floor-derived, so a collector reads the floor off
 * it without opening the app.
 *
 *   floor 0, unit 1  → "0001"
 *   floor 3, unit 4  → "0304"
 *   floor 12, unit 1 → "1201"
 *   floor −1, unit 2 → "B102"
 *
 * Basements take a `B` prefix rather than a minus sign for one practical
 * reason: the code is printed on notices and read aloud at a counter, and a
 * leading `-` in an RTL line renders on whichever side the bidi algorithm
 * decides, which is not always the side it was typed on.
 *
 * Derived on every read and never stored as the identity — `floor` and
 * `sequence` are the durable pair. See D9.
 */
export function formatUnitCode(floor: number, sequence: number): string {
  const magnitude = Math.abs(floor) * 100 + sequence;
  return floor < 0 ? `B${pad(magnitude, 3)}` : pad(magnitude, 4);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// ─────────────────────────  Building codes  ─────────────────────────

/**
 * The per-parcel suffix alphabet — `I` and `O` are not in it.
 *
 * Both read as digits in the one place the code matters most: hand-painted on a
 * wall, or read back over a phone. `A-1042-O` and `A-1042-0` are the same
 * sound and nearly the same glyph, and the parcel number beside them is
 * numeric, so the ambiguity resolves the wrong way about half the time.
 */
export const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * The nth suffix in allocation order: `A`, `B`, … `Z`, `AA`, `AB`, …
 *
 * Bijective base-24 rather than positional, so there is no zero digit and no
 * gap between `Z` and `AA`. Most parcels never see anything past `A`; the
 * two-letter range exists so a parcel with thirty structures on it does not
 * become a special case someone has to invent an answer for in the field.
 */
export function buildingSuffixAt(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Suffix index must be a non-negative integer, got ${index}`);
  }

  const base = SUFFIX_ALPHABET.length;
  let remaining = index + 1;
  let out = '';

  while (remaining > 0) {
    const digit = (remaining - 1) % base;
    out = SUFFIX_ALPHABET[digit] + out;
    remaining = Math.floor((remaining - 1) / base);
  }

  return out;
}

/**
 * The first suffix this parcel has not used.
 *
 * Scans from `A` rather than counting the existing rows, so a parcel whose `B`
 * was deleted gets `B` back instead of a permanent hole — and, more to the
 * point, so two callers looking at the same parcel cannot both be handed the
 * same "count + 1". The authoritative allocation still happens under a row lock
 * on the parcel (§4.4); this is the function that lock protects, and the same
 * one a phone uses offline to show a provisional code.
 */
export function nextBuildingSuffix(taken: readonly string[]): string {
  const used = new Set(taken.map((suffix) => suffix.trim().toUpperCase()));
  for (let index = 0; ; index += 1) {
    const candidate = buildingSuffixAt(index);
    if (!used.has(candidate)) return candidate;
  }
}

/** A parcel that belongs to no zone. Rendered, not stored — see D13. */
export const UNZONED_CODE = 'X';

/**
 * `ZONE-PARCEL-SUFFIX` — `A-1042-B`.
 *
 * Delimited rather than concatenated because `A1042B` cannot be read back: the
 * parcel number is variable-width and the zone code is not always one
 * character, so there is no position at which the reader can split it.
 *
 * The zone half is passed in rather than looked up here, and that is the whole
 * of D13: zone membership lives in `Zone.parcelNumbers` and nowhere else, so a
 * building carries no `zoneId` to fall out of date. A parcel in no zone renders
 * `X`, which is a statement — this parcel has not been assigned to a sector yet
 * — rather than a blank that reads as a bug.
 */
export function formatBuildingCode(input: {
  zoneCode?: string | null;
  parcelNumber: string;
  codeSuffix: string;
}): string {
  const zone = input.zoneCode?.trim().toUpperCase() || UNZONED_CODE;
  return `${zone}-${input.parcelNumber.trim()}-${input.codeSuffix.trim().toUpperCase()}`;
}

/**
 * The full reference to one unit — `A-1042-B-0304`.
 *
 * Zone A, parcel 1042, building B, third floor, fourth unit. Printed beside
 * `postedNumber` wherever the two disagree (D14): if the register says `0304`
 * and the door says `12`, the collector standing in the stairwell trusts the
 * door, and a notice that shows only our code sends them to the wrong flat.
 */
export function formatFullUnitReference(buildingCode: string, unitCode: string): string {
  return `${buildingCode}-${unitCode}`;
}
