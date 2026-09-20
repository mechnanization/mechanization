import {
  POSSIBLE_DUPLICATE_FLAG_PATH,
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
}

/** EXACT: same names. NEAR: a typo apart. NONE: different names. */
export type NameMatch = 'EXACT' | 'NEAR' | 'NONE';

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
 * The edits between two parts, or null where they are different names.
 *
 * Null rather than a large number so a caller cannot sum its way past it: one
 * part that is a different name makes the whole name different, however close
 * the others are.
 */
/** Whether two single parts are the same one, allowing a long part one slip. */
function samePart(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < MIN_LETTERS_FOR_TYPO || b.length < MIN_LETTERS_FOR_TYPO) return false;
  return editDistance(a, b) <= 1;
}

/** One name split into folded parts: «نوال محمود شعبان» → [نوال, محمود, شعبان]. */
function nameParts(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/\s+/)
    .map(foldNamePart)
    .filter(Boolean);
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

function partEdits(a: string, b: string): number | null {
  if (a === b) return 0;
  if (a.length < MIN_LETTERS_FOR_TYPO || b.length < MIN_LETTERS_FOR_TYPO) return null;
  const distance = editDistance(a, b);
  return distance <= 1 ? distance : null;
}

/**
 * How two names compare, and whether the middle name took part.
 *
 * A missing middle name on either side is not a disagreement — a card that
 * says «بسام نسر» is not somebody other than «بسام حبيب نسر». But a match that
 * never compared the middle name is weaker, and `isLikelySamePerson` asks for
 * corroboration before it treats one as a question worth putting.
 */
export function compareNames(
  a: PersonName,
  b: PersonName,
): { match: NameMatch; middleCompared: boolean } {
  const first = partEdits(foldNamePart(a.firstName), foldNamePart(b.firstName));
  const last = partEdits(foldNamePart(a.lastName), foldNamePart(b.lastName));
  if (first === null || last === null) return { match: 'NONE', middleCompared: false };

  const middleA = foldNamePart(a.middleName);
  const middleB = foldNamePart(b.middleName);
  const middleCompared = Boolean(middleA && middleB);
  const middle = middleCompared ? partEdits(middleA, middleB) : 0;
  if (middle === null) return { match: 'NONE', middleCompared };

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

  return {
    name: match,
    middleCompared,
    samePhone,
    sameMother: mother === 'SAME',
    motherDiffers: mother === 'DIFFERENT',
  };
}

/**
 * Whether to stop and ask "is this the same person?".
 *
 *  - different mothers on file → never: that is two people, however alike;
 *  - three identical names → yes, with nothing further needed;
 *  - identical names without a middle name to compare, or a typo apart →
 *    only with a second fact agreeing: the same phone or the same mother.
 *
 * A shared phone with a different name is deliberately *not* a duplicate. A
 * household line is ordinary (father and son, brothers); that case is the
 * phone question, asked separately and only where it points somewhere odd.
 */
export function isLikelySamePerson(signals: DuplicateSignals): boolean {
  if (signals.motherDiffers || signals.name === 'NONE') return false;
  if (signals.name === 'EXACT' && signals.middleCompared) return true;
  return signals.samePhone || signals.sameMother;
}

/** The facts the dialog names beside a candidate, in the order a person weighs them. */
export function matchedOn(signals: DuplicateSignals): Array<'NAME' | 'NAME_SIMILAR' | 'PHONE' | 'MOTHER'> {
  return [
    ...(signals.name === 'EXACT' ? (['NAME'] as const) : []),
    ...(signals.name === 'NEAR' ? (['NAME_SIMILAR'] as const) : []),
    ...(signals.samePhone ? (['PHONE'] as const) : []),
    ...(signals.sameMother ? (['MOTHER'] as const) : []),
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
