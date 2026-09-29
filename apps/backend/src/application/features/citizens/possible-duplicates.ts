import {
  POSSIBLE_DUPLICATE_FLAG_PATH,
  type DuplicateMatchedOn,
  type DuplicateReviewAnswer,
  type FieldFlag,
} from '@mechanization/shared-schemas';
import { normalizeSearchText } from '../../common/search-terms';

/**
 * «هل هذا الشخص مسجَّل مسبقاً؟» — the rules, without a database.
 *
 * ## Why this exists
 *
 * Until now the only thing that recognised a returning person was the identity
 * document, and the document is no longer collected for a Lebanese citizen. So
 * nothing on the server noticed when the same officer filed «علي حسين بسام»
 * twice four minutes apart with every field identical, or «حسين محمد اسليمان»
 * and «حسين محمد سليمان» half an hour apart on one phone. The browser's hint
 * panel did — when it had signal, and only if somebody read it.
 *
 * ## What it is not
 *
 * Not a merge, and never an automatic one. A merge destroys a person in place
 * (launch day, 2026-09-12: three brothers became one row); a duplicate can be
 * merged later by somebody with both files in front of them. Everything here
 * only decides *whether to ask*.
 *
 * ## The shape of the rule
 *
 * Record linkage without a shared identifier compares several fields that are
 * each non-unique, and needs a way to say "these two disagree, so they are two
 * people". Here that is اسم الأم: brothers share a phone and a mother, cousins
 * share three names, but two people with the same three names and *different*
 * mothers are two people, and no further evidence can make them one.
 *
 * Names are compared after the search fold (أإآ→ا, ة→ه, ى→ي, digits), with the
 * spaces inside each part removed — «عبد الحسن» and «عبدالحسن» are one name,
 * and the 2026-09-15 duplicate scan missed exactly that pair — and then by edit
 * distance, which is what catches «اسليمان»/«سليمان». Short parts must match
 * exactly: «حسين»/«حسن» and «محمد»/«حمد» are one letter apart and are
 * different names.
 */

export interface PersonName {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}

export interface PersonKey extends PersonName {
  motherName?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  /** رقم السجل — a family's register entry, shared by everyone in it. */
  civilRecordNumber?: string | null;
  /** رقم الإقامة — a non-Lebanese person's permit. */
  residencyNumber?: string | null;
  gender?: string | null;
  isLebanese?: boolean | null;
  /**
   * The census units this person holds now: their open spells on file, or the
   * flats the cards being typed name. The same person filed twice was most
   * often filed twice *at the same door*.
   */
  unitIds?: readonly string[] | null;
}

/**
 * EXACT: same names. NEAR: a typo apart. PARTIAL: first and father's name
 * agree, the family name does not. NONE: different people's names.
 */
export type NameMatch = 'EXACT' | 'NEAR' | 'PARTIAL' | 'NONE';

/**
 * Below this many letters a part must match exactly.
 *
 * Five, because the common four-letter names are each other's one-letter
 * neighbours (حسين/حسن، محمد/حمد، علي/عل), and treating them as typos would ask
 * about every cousin in the village. At five and above a single-letter slip is
 * far likelier than a different name — اسليمان/سليمان, ابراهيم/ابرهيم.
 */
const MIN_LETTERS_FOR_TYPO = 5;

/** How many single-letter slips a whole name may carry and still be "near". */
const MAX_NAME_EDITS = 2;

/** One name part, folded and with its internal spaces removed. */
export function foldNamePart(value: string | null | undefined): string {
  if (!value) return '';
  return normalizeSearchText(value).replace(/\s+/g, '');
}

/** Levenshtein distance. Names are short, so the plain two-row version is enough. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Real names one letter apart — never a typo of each other, however long.
 *
 * Folded and unspaced, as `foldNamePart` leaves them. Adding one letter to an
 * Arabic name very often makes another valid name (El-Shishtawy, ACL O14-2003),
 * and in a family register the other name is usually a brother's. The list
 * holds the pairs long enough to slip past `MIN_LETTERS_FOR_TYPO`; the short
 * ones (حسن/حسين، محمد/محمود) are already compared exactly. A misspelling that
 * is not a name — «عبد المريم» for «عبد الكريم» — stays a typo.
 */
const DISTINCT_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['عبدالحسن', 'عبدالحسين'],
  ['عبدالله', 'عبدالاله'],
  ['سليمان', 'سلمان'],
];

/**
 * Whether two parts a letter apart are two different names.
 *
 * Besides the listed pairs: one name that is the other with the feminine ة
 * (folded to ه) added — جميل/جميلة، نبيل/نبيلة، كامل/كاملة. That is a man and a
 * woman, not a slip.
 */
function distinctNames(a: string, b: string): boolean {
  if (a + 'ه' === b || b + 'ه' === a) return true;
  return DISTINCT_NAMES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/**
 * A family name without its article: «الخطيب» and «خطيب» are one family,
 * written with and without «ال» at two doors.
 */
function familyPart(value: string | null | undefined): string {
  const folded = foldNamePart(value);
  return folded.startsWith('ال') && folded.length >= 5 ? folded.slice(2) : folded;
}

/**
 * The edits between two parts, or null where they are different names.
 *
 * Null rather than a large number so a caller cannot sum its way past it: one
 * part that is a different name makes the whole name different, however close
 * the others are.
 */
function partEdits(a: string, b: string): number | null {
  if (a === b) return 0;
  if (a.length < MIN_LETTERS_FOR_TYPO || b.length < MIN_LETTERS_FOR_TYPO) return null;
  if (distinctNames(a, b)) return null;
  const distance = editDistance(a, b);
  return distance <= 1 ? distance : null;
}

/** Whether two single parts are the same one — `partEdits`' rule, without the count. */
function samePart(a: string, b: string): boolean {
  return partEdits(a, b) !== null;
}

/**
 * One name split into folded parts: «نوال محمود شعبان» → [نوال, محمود, شعبان].
 *
 * Folded first and split second, because the fold is what decides where the
 * parts are: `normalizeSearchText` turns every separator — a hyphen, a comma,
 * a double space — into one space, so «منيرة-عواضة» splits into the same two
 * parts as «منيرة عواضة» rather than staying one. Splitting first left the
 * two sides of a comparison cut in different places, which is the one thing
 * a part-by-part rule cannot survive.
 */
function nameParts(value: string | null | undefined): string[] {
  return value ? normalizeSearchText(value).split(' ').filter(Boolean) : [];
}

/** Whether every part of the shorter name appears in the longer, in order. */
function isSubsequence(shorter: readonly string[], longer: readonly string[]): boolean {
  let index = 0;
  for (const part of longer) {
    if (index < shorter.length && samePart(shorter[index]!, part)) index += 1;
  }
  return index === shorter.length;
}

/** The same woman, a different one, or unknown where one side has no mother on file. */
export type MotherMatch = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

/**
 * Whether two records name the same mother.
 *
 * This is the one signal that *stops* the duplicate question being asked, so
 * reading it wrong is expensive in a way the others are not: a wrong SAME costs
 * one question somebody answers in a second, a wrong DIFFERENT costs the
 * question altogether and the duplicate lands.
 *
 * Compared part by part rather than as one string, because the same woman is
 * routinely written at two lengths — «منيرة عواضة» at one door and «منيرة
 * ابراهيم عواضة» at the next, her father's name included or left out. As single
 * strings those are seven edits apart and read as two women. Production
 * 2026-09-19: «سمير عبد الكريم عواضة» and «سمير عبد المريم عواضة», one phone,
 * one officer, three minutes apart, never asked about because their one mother
 * was written both ways; «تهاني محمد مرزوق» and «…مرزوء» the same afternoon, on
 * «نوال شعبان» and «نوال محمود شعبان».
 *
 * So a name that is the other with parts left out is the same woman: her own
 * name and her family name agree, and everything the shorter says the longer
 * says too, in order. A part the other contradicts is a different woman, and
 * that still ends the matter.
 *
 * A single part on one side (just «فاطمة», or just «دياب») is matched against
 * any part of the other, because it asserts too little to refuse on.
 */
export function compareMothers(
  a: string | null | undefined,
  b: string | null | undefined,
): MotherMatch {
  const left = nameParts(a);
  const right = nameParts(b);
  if (!left.length || !right.length) return 'UNKNOWN';

  /*
    The whole folded string a slip apart — «زينب سعد»/«زينب سعيد», where the
    typo falls in a part too short to be allowed one of its own.
  */
  if (editDistance(left.join(''), right.join('')) <= 1) return 'SAME';

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length > 1) {
    if (!samePart(shorter[0]!, longer[0]!)) return 'DIFFERENT';
    if (!samePart(shorter[shorter.length - 1]!, longer[longer.length - 1]!)) return 'DIFFERENT';
  }
  return isSubsequence(shorter, longer) ? 'SAME' : 'DIFFERENT';
}

/**
 * How two names compare, and whether the middle name took part.
 *
 * A missing middle name on either side is not a disagreement — a card that
 * says «بسام نسر» is not somebody other than «بسام حبيب نسر». But a match that
 * never compared the middle name is weaker, and `isLikelySamePerson` asks for
 * corroboration before it treats one as a question worth putting.
 *
 * `PARTIAL` is the first name and the father's name agreeing (or the father's
 * name missing on one side) while the family name does not — «حسين علي وطفى»
 * and «حسين علي وطفه» where the family name is too short to be allowed a typo,
 * or spelled two ways nobody would call a slip. On its own it is nothing: it
 * only ever counts toward a question when several other facts agree too.
 * A first name or a father's name that disagrees is still `NONE` — brothers
 * differ in the first, cousins in the second.
 */
export function compareNames(
  a: PersonName,
  b: PersonName,
): { match: NameMatch; middleCompared: boolean } {
  const first = partEdits(foldNamePart(a.firstName), foldNamePart(b.firstName));
  const last = partEdits(familyPart(a.lastName), familyPart(b.lastName));

  const middleA = foldNamePart(a.middleName);
  const middleB = foldNamePart(b.middleName);
  const middleCompared = Boolean(middleA && middleB);
  const middle = middleCompared ? partEdits(middleA, middleB) : 0;

  if (first === null) return { match: 'NONE', middleCompared: false };
  if (middle === null) return { match: 'NONE', middleCompared };
  if (last === null) return { match: 'PARTIAL', middleCompared };

  const edits = first + last + middle;
  if (edits === 0) return { match: 'EXACT', middleCompared };
  return { match: edits <= MAX_NAME_EDITS ? 'NEAR' : 'NONE', middleCompared };
}

/** What a comparison found, kept so the officer is told *why* a record was offered. */
export interface DuplicateSignals {
  name: NameMatch;
  middleCompared: boolean;
  samePhone: boolean;
  sameMother: boolean;
  /** Both mothers are on file and are not a typo apart: two people. */
  motherDiffers: boolean;
  /**
   * Both mothers written with at least her own name and a family name. A lone
   * «فاطمة» agrees with half the register, so it may count toward a question
   * but never toward refusing a save.
   */
  motherInFull: boolean;
  /** رقم السجل — both on file and the same register entry. */
  sameCivilRecord: boolean;
  /** رقم الإقامة — a non-Lebanese person's permit, which is theirs alone. */
  sameResidencyNumber: boolean;
  /** Both hold an open spell on the same census unit — filed twice at one door. */
  sameUnit: boolean;
  /**
   * Facts on file on both sides that contradict one person: a different
   * gender, one Lebanese and one not, or two different residence permits.
   * Each is a typing slip at most once in a long while, so each counts hard
   * against the question — and none may ever stop a save.
   */
  genderDiffers: boolean;
  nationalityDiffers: boolean;
  permitDiffers: boolean;
}

/**
 * A register number as it compares: folded digits, no separators, no leading
 * zeros — «٠٤٠», «40» and «4-0» are one سجل. Blank when nothing is left, and
 * blank for a placeholder of zeros: رقم السجل is required of every Lebanese
 * file, so «0» is what a field typed without the paper looks like, and two
 * placeholders agreeing is not two people agreeing.
 */
export function foldRecordNumber(value: string | null | undefined): string {
  if (!value) return '';
  const folded = normalizeSearchText(value).replace(/\s+/g, '');
  if (/^0+$/.test(folded)) return '';
  return /^\d+$/.test(folded) ? folded.replace(/^0+(?=\d)/, '') : folded;
}

export function duplicateSignals(incoming: PersonKey, existing: PersonKey): DuplicateSignals {
  const { match, middleCompared } = compareNames(incoming, existing);

  const numbers = (person: PersonKey) =>
    new Set([person.phone, person.whatsapp].filter((value): value is string => Boolean(value)));
  const theirs = numbers(existing);
  const samePhone = [...numbers(incoming)].some((number) => theirs.has(number));

  /*
    A typo in the mother's name is not a different mother, and neither is the
    same woman written at two lengths. See `compareMothers`.
  */
  const mother = compareMothers(incoming.motherName, existing.motherName);

  const same = (a: string | null | undefined, b: string | null | undefined) => {
    const left = foldRecordNumber(a);
    return Boolean(left) && left === foldRecordNumber(b);
  };
  const bothDiffer = (a: string | null | undefined, b: string | null | undefined) => {
    const left = foldRecordNumber(a);
    const right = foldRecordNumber(b);
    return Boolean(left && right) && left !== right;
  };
  const theirUnits = new Set(existing.unitIds ?? []);

  return {
    name: match,
    middleCompared,
    samePhone,
    sameMother: mother === 'SAME',
    motherDiffers: mother === 'DIFFERENT',
    motherInFull: nameParts(incoming.motherName).length >= 2 && nameParts(existing.motherName).length >= 2,
    sameCivilRecord: same(incoming.civilRecordNumber, existing.civilRecordNumber),
    sameResidencyNumber: same(incoming.residencyNumber, existing.residencyNumber),
    sameUnit: (incoming.unitIds ?? []).some((unitId) => theirUnits.has(unitId)),
    genderDiffers: Boolean(incoming.gender && existing.gender) && incoming.gender !== existing.gender,
    nationalityDiffers:
      typeof incoming.isLebanese === 'boolean' &&
      typeof existing.isLebanese === 'boolean' &&
      incoming.isLebanese !== existing.isLebanese,
    permitDiffers: bothDiffer(incoming.residencyNumber, existing.residencyNumber),
  };
}

/**
 * How much each fact counts toward «هل هو الشخص نفسه؟».
 *
 * The question is put at `ASK_AT`. The weights follow record-linkage practice
 * (Fellegi–Sunter: a fact counts by how rarely two different people share it —
 * US Census PVS, ONS 2021, AHIMA patient matching; researched 2026-09-29), set
 * so the rule this replaced still answers every pair it was pinned on:
 *
 *  - the name: three identical parts 3; identical without the father's name,
 *    or a typo apart, 2; first and father's name agreeing with a different
 *    family name 1, and 0 without the father's name to compare;
 *  - the mother: +2 written in full on both sides — after the name, the
 *    strongest fact this register holds, since siblings differ in the first
 *    name and cousins in the mother — and +1 where one side is a lone first
 *    name, which half the village shares;
 *  - the same phone, the same رقم السجل, the same flat: +1 each. None is
 *    anybody's alone — a household shares a line and a flat, a whole family one
 *    سجل (and a سجل number repeats across villages, and changes when a woman
 *    marries) — so each only ever tips a name that already agrees;
 *  - the same رقم الإقامة: +2. A residence permit is one person's.
 *  - a contradiction on file: −4 for a different gender or two different
 *    permits, −3 for one Lebanese and one not.
 *
 * Not yet used, because the register does not hold them: year of birth and
 * محل القيد, which every registry that matches without an ID leans on first.
 * Adding them is a decision about what is collected (Law 81/2018 Art. 87–88),
 * not a tuning — see docs/citizen-duplicates.md.
 */
const NAME_WEIGHT: Record<NameMatch, number> = { EXACT: 2, NEAR: 2, PARTIAL: 1, NONE: 0 };
const ASK_AT = 3;

export function duplicateScore(signals: DuplicateSignals): number {
  const name =
    signals.name === 'EXACT' && signals.middleCompared
      ? 3
      : signals.name === 'PARTIAL' && !signals.middleCompared
        ? 0
        : NAME_WEIGHT[signals.name];
  /*
    A سجل is a family's, and cousins named after one grandfather can share
    one. It tips a name only once the father's names were compared, or with a
    fact of this person's own beside it.
  */
  const civil =
    signals.sameCivilRecord &&
    (signals.middleCompared || signals.samePhone || signals.sameMother || signals.sameUnit);
  // A permit is one person's — but not enough to carry a different family name with no father to compare.
  const permit = signals.sameResidencyNumber && !(signals.name === 'PARTIAL' && !signals.middleCompared);
  return (
    name +
    (signals.sameMother ? (signals.motherInFull ? 2 : 1) : 0) +
    (signals.samePhone ? 1 : 0) +
    (civil ? 1 : 0) +
    (signals.sameUnit ? 1 : 0) +
    (permit ? 2 : 0) -
    (signals.genderDiffers ? 4 : 0) -
    (signals.permitDiffers ? 4 : 0) -
    (signals.nationalityDiffers ? 3 : 0)
  );
}

/**
 * Whether to stop and ask "is this the same person?".
 *
 *  - different mothers on file → never: that is two people, however alike;
 *  - a first name or a father's name that disagrees → never: brothers,
 *    cousins, a father and his son;
 *  - otherwise, when the facts that agree add up — see `duplicateScore`.
 *    Three identical names are enough alone; «حسين علي وطفى» against
 *    «حسين علي وطفه» needs, say, the same mother and the same رقم السجل.
 *
 * A shared phone with a different name is deliberately *not* a duplicate. A
 * household line is ordinary (father and son, brothers); that case is the
 * phone question, asked separately and only where it points somewhere odd.
 */
export function isLikelySamePerson(signals: DuplicateSignals): boolean {
  if (signals.motherDiffers || signals.name === 'NONE') return false;
  return duplicateScore(signals) >= ASK_AT;
}

/**
 * What the register does about a candidate: nothing, ask, or refuse.
 *
 * `BLOCK` is the officer being *stopped*, not asked (user decision,
 * 2026-09-29: «know when to stop an officer from creating a duplicate, do not
 * just warn»). It is reserved for evidence no two different people in this town
 * would share:
 *
 *  - all three names the same (or a typo apart), the father's name compared,
 *    the same mother — written in full on both, not a lone «فاطمة» that
 *    matches half the register — and one more fact of their own: the same
 *    phone, the same رقم السجل, or the same residence permit;
 *  - or the same name and the same residence permit, which is one person's.
 *
 * Brothers never reach it (different first names), nor cousins (different
 * fathers), nor a namesake with a different mother. What stops an officer is
 * the save; the way on is to open the file on record and add the property to
 * it. An administrator may still file it as a different person, with a reason
 * — the one escape a rule this strict needs, kept away from the screen where
 * the duplicate would be made.
 */
export type DuplicateVerdict = 'NONE' | 'ASK' | 'BLOCK';

export function duplicateVerdict(signals: DuplicateSignals): DuplicateVerdict {
  if (!isLikelySamePerson(signals)) return 'NONE';
  // Anything on file that says «two people» leaves the question to the officer.
  if (signals.genderDiffers || signals.nationalityDiffers || signals.permitDiffers) return 'ASK';
  const fullName = (signals.name === 'EXACT' || signals.name === 'NEAR') && signals.middleCompared;
  const ownFact = signals.samePhone || signals.sameCivilRecord || signals.sameResidencyNumber || signals.sameUnit;
  if (fullName && signals.sameMother && signals.motherInFull && ownFact) return 'BLOCK';
  if (signals.name === 'EXACT' && signals.sameResidencyNumber && (signals.middleCompared || signals.sameMother)) {
    return 'BLOCK';
  }
  return 'ASK';
}

/** The facts the dialog names beside a candidate, in the order a person weighs them. */
export function matchedOn(signals: DuplicateSignals): DuplicateMatchedOn[] {
  return [
    ...(signals.name === 'EXACT' ? (['NAME'] as const) : []),
    ...(signals.name === 'NEAR' ? (['NAME_SIMILAR'] as const) : []),
    ...(signals.name === 'PARTIAL' ? (['NAME_PARTIAL'] as const) : []),
    ...(signals.samePhone ? (['PHONE'] as const) : []),
    ...(signals.sameMother ? (['MOTHER'] as const) : []),
    ...(signals.sameCivilRecord ? (['CIVIL_RECORD'] as const) : []),
    ...(signals.sameResidencyNumber ? (['RESIDENCY_NUMBER'] as const) : []),
    ...(signals.sameUnit ? (['SAME_UNIT'] as const) : []),
  ];
}

// ─────────────────────────────  Findings  ─────────────────────────────

/**
 * How long after an officer registers somebody a second record on that same
 * phone is worth a question.
 *
 * Both copied numbers found on 2026-09-16 were typed 4–5 minutes after the
 * landlord's own record, by the officer who had just filed it. Two hours covers
 * one building's worth of doors; past that, a shared number is far more likely
 * to be a household line than a slip from the previous screen.
 */
export const RECENT_SAME_PHONE_MS = 2 * 60 * 60 * 1000;

/** One citizen as the lookup returns them — enough to compare and to show. */
export interface RegisterRow extends PersonKey {
  id: string;
  referenceNumber: string | null;
  residence: string | null;
  registrations: ReadonlyArray<{
    submittedAt: Date;
    createdById: string | null;
    createdBy: { firstName: string; lastName: string } | null;
    _count: { properties: number };
  }>;
}

export interface DuplicateCandidate {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  motherName: string | null;
  phone: string | null;
  residence: string | null;
  propertyCount: number;
  registeredAt: string | null;
  registeredBy: string | null;
  matchedOn: ReturnType<typeof matchedOn>;
  /**
   * `duplicateVerdict` said BLOCK: the save is refused, not asked about — see
   * `CitizensService.create`. Only an administrator may file past it.
   */
  certain: boolean;
}

/**
 * Which of this record's two numbers a match was on.
 *
 * `whatsapp` is only ever named when it differs from `phone` — a WhatsApp
 * number that is the phone is the phone. The two are asked about separately
 * because the answers can differ: the phone may be the citizen's own while the
 * WhatsApp number typed beside it is the landlord's, and «ليس رقمه» has to clear
 * the field that was wrong, not the one that was right.
 */
export type ContactField = 'phone' | 'whatsapp';

export interface PhoneOwner {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  phone: string | null;
  /** This record's fields that carry a number the person answers on. */
  fields: ContactField[];
  registeredAt: string;
  minutesAgo: number;
}

/** A card of this very record whose landlord number is one of the citizen's own numbers. */
export interface LandlordPhoneCard {
  index: number;
  landlordName: string | null;
  field: ContactField;
}

export interface DuplicateReviewFindings {
  possibleDuplicates: DuplicateCandidate[];
  phoneOwners: PhoneOwner[];
  landlordPhoneCards: LandlordPhoneCard[];
}

export const NO_FINDINGS: DuplicateReviewFindings = {
  possibleDuplicates: [],
  phoneOwners: [],
  landlordPhoneCards: [],
};

const fullNameOf = (row: PersonName) =>
  [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ');

/**
 * Everything worth asking about one filing, from the rows the lookup found.
 *
 * Three questions, kept apart because they have different right answers:
 *
 *  1. **Is this somebody already on file?** — `isLikelySamePerson`.
 *  2. **Is this phone somebody else's?** — the same number on a person with a
 *     different name, registered by *this officer* within the last two hours.
 *     That is the shape of both 2026-09-16 cases (an occupant carrying the
 *     landlord's number, typed minutes after the landlord's own record). The
 *     same number on somebody registered last week by someone else is a
 *     household line and is not asked about.
 *  3. **Is the landlord's number on this record's own card also the citizen's
 *     number?** — decidable from the filing alone. It is either a family that
 *     shares a line, or the occupant's field holding the owner's number.
 */
export function assessFindings(input: {
  incoming: PersonKey;
  rows: readonly RegisterRow[];
  cards: ReadonlyArray<{ occupancyType?: string | null; landlordPhone?: string | null; landlordName?: string | null }>;
  actorId: string;
  now: Date;
}): DuplicateReviewFindings {
  // The WhatsApp number counts on its own only where it is a different number.
  const ownNumbers: Array<[ContactField, string]> = [
    ...(input.incoming.phone ? ([['phone', input.incoming.phone]] as Array<[ContactField, string]>) : []),
    ...(input.incoming.whatsapp && input.incoming.whatsapp !== input.incoming.phone
      ? ([['whatsapp', input.incoming.whatsapp]] as Array<[ContactField, string]>)
      : []),
  ];

  const possibleDuplicates: DuplicateCandidate[] = [];
  const phoneOwners: PhoneOwner[] = [];

  for (const row of input.rows) {
    const signals = duplicateSignals(input.incoming, row);
    const latest = row.registrations[0] ?? null;

    if (isLikelySamePerson(signals)) {
      possibleDuplicates.push({
        id: row.id,
        referenceNumber: row.referenceNumber,
        fullName: fullNameOf(row),
        motherName: row.motherName ?? null,
        phone: row.phone ?? null,
        residence: row.residence,
        propertyCount: row.registrations.reduce((sum, reg) => sum + reg._count.properties, 0),
        registeredAt: latest ? latest.submittedAt.toISOString() : null,
        registeredBy: latest?.createdBy
          ? `${latest.createdBy.firstName} ${latest.createdBy.lastName}`
          : null,
        matchedOn: matchedOn(signals),
        certain: duplicateVerdict(signals) === 'BLOCK',
      });
      continue;
    }

    const fields = ownNumbers
      .filter(([, number]) => number === row.phone || number === row.whatsapp)
      .map(([field]) => field);
    if (fields.length === 0) continue;
    const recentByActor = row.registrations.find(
      (reg) =>
        reg.createdById === input.actorId &&
        input.now.getTime() - reg.submittedAt.getTime() <= RECENT_SAME_PHONE_MS,
    );
    if (!recentByActor) continue;

    phoneOwners.push({
      id: row.id,
      referenceNumber: row.referenceNumber,
      fullName: fullNameOf(row),
      phone: row.phone ?? null,
      fields,
      registeredAt: recentByActor.submittedAt.toISOString(),
      minutesAgo: Math.max(
        0,
        Math.round((input.now.getTime() - recentByActor.submittedAt.getTime()) / 60_000),
      ),
    });
  }

  const landlordPhoneCards = input.cards.flatMap((card, index) => {
    if (card.occupancyType === 'OWNER' || !card.landlordPhone) return [];
    const hit = ownNumbers.find(([, number]) => number === card.landlordPhone);
    return hit ? [{ index, landlordName: card.landlordName?.trim() || null, field: hit[0] }] : [];
  });

  return { possibleDuplicates, phoneOwners, landlordPhoneCards };
}

/** What is still unanswered once the officer's answer is taken into account. */
export function outstandingFindings(
  findings: DuplicateReviewFindings,
  answer: DuplicateReviewAnswer | undefined,
): DuplicateReviewFindings {
  return {
    possibleDuplicates: findings.possibleDuplicates.filter(
      (candidate) => !answer?.differentFrom.includes(candidate.id),
    ),
    phoneOwners: findings.phoneOwners.filter((owner) => !answer?.sharedPhoneWith.includes(owner.id)),
    landlordPhoneCards: answer?.sharedPhoneWithLandlord ? [] : findings.landlordPhoneCards,
  };
}

export function hasFindings(findings: DuplicateReviewFindings): boolean {
  return (
    findings.possibleDuplicates.length > 0 ||
    findings.phoneOwners.length > 0 ||
    findings.landlordPhoneCards.length > 0
  );
}

/** Flag reasons have a 300-character ceiling; three names fit comfortably. */
const MAX_NAMED_IN_FLAG = 3;

/**
 * The «يتطلب مراجعة» note for a filing that arrived with nobody to ask.
 *
 * Names the records by reference as well as by name, because the reference is
 * what a reviewer types into search, and a name is exactly the thing in doubt.
 */
export function possibleDuplicateFlag(candidates: readonly DuplicateCandidate[]): FieldFlag {
  const named = candidates
    .slice(0, MAX_NAMED_IN_FLAG)
    .map((candidate) =>
      candidate.referenceNumber
        ? `${candidate.fullName} (${candidate.referenceNumber})`
        : candidate.fullName,
    )
    .join('، ');
  const more = candidates.length > MAX_NAMED_IN_FLAG ? ` و${candidates.length - MAX_NAMED_IN_FLAG} غيرهم` : '';
  return {
    path: POSSIBLE_DUPLICATE_FLAG_PATH,
    kind: 'UNVERIFIED',
    reason: `قد يكون مسجَّلاً مسبقاً: ${named}${more} — تحقَّق هل هو الشخص نفسه`.slice(0, 300),
  };
}
