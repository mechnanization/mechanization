import { isNonPersonRecord, isOwnerRecord } from '@mechanization/shared-schemas';
import {
  nonResidentCardIssues,
  POSSIBLE_DUPLICATE_FLAG_PATH,
  statusForFlags,
  type CitizenMergeBlock,
  type CitizenMergeFieldConflict,
  type CitizenMergeFieldFill,
  type FieldFlag,
} from '@mechanization/shared-schemas';
import { foldNamePart, foldRecordNumber } from './possible-duplicates';

/**
 * «دمج ملفين» — every decision a merge makes, without a database.
 *
 * The service reads both files, hands them here, and writes what comes back.
 * Everything that could be argued about — which filing becomes the file, which
 * copy of a flat ends, what a flag points at afterwards, what refuses the merge
 * — is decided in this file, so it can be tested card by card.
 *
 * ## Why every current card moves onto one filing
 *
 * A person's file is their newest registration. Billing reads only it
 * (`FeesService.holdingsOf`), the edit form loads only it, and the census sync
 * run by the next edit ends every spell the newest one does not claim
 * (`endUnclaimed`, scope CITIZEN). Two files merged by re-pointing their
 * registrations alone would bill half the person, show half of them to the
 * next officer, and lose the other half's flats on the next save.
 *
 * A moved card keeps crediting the officer who filed it: `filedRegistrationId`
 * remembers the registration it came from (user decision, 2026-09-28).
 *
 * ## A flat on both files
 *
 * The same person recorded twice has usually recorded the same flat twice. The
 * absorbed file's copy ends as «سُجِّل خطأً» (RECORDED_IN_ERROR): it describes a
 * fact the kept file already states. That is the one end reason that withdraws
 * an officer's credit, and it is withdrawn from the duplicate copy's officer
 * only (user decision, 2026-09-28) — the kept copy's officer filed first.
 *
 * Two copies that disagree about *what* the person is there — owner on one,
 * tenant on the other — are not a duplicate the merge can settle; it refuses
 * and names the flat.
 *
 * ## Flags
 *
 * «غير مؤكَّد» flags name a card by its position among the filing's current
 * cards in creation order (`card-flags.ts`). Moving cards onto the newest
 * filing changes every position on it, so each flag is read back to the card
 * or row it named, and written again at that card's new position.
 */

// ─────────────────────────────  Inputs  ─────────────────────────────

/** The columns of a citizen a merge reads and may fill. */
export interface PlanPerson {
  id: string;
  isActive: boolean;
  referenceNumber: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  motherName: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** «لا يملك رقم هاتف» — see `planFields` for how a merge honours it. */
  hasNoPhone: boolean;
  contactPhone: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residencyNumber: string | null;
  residentStatus: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  residence: string;
  residencePlace: string | null;
  localContactName: string | null;
  localContactPhone: string | null;
}

export interface PlanRegistration {
  id: string;
  citizenId: string;
  submittedAt: Date;
  createdById: string | null;
  referenceNumber: string;
  status: string;
  flaggedFields: unknown;
}

export interface PlanRow {
  id: string;
  unitId: string | null;
  unitType: string | null;
  unitStatus: string | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
}

/**
 * One filing's current cards, and each card's current rows, in the order the
 * edit form lists them — read with the form's own query, because that order
 * is what a «غير مؤكَّد» flag's position means. Cards filed in one save share
 * one `createdAt` to the microsecond, so the order among them is whatever the
 * form's query returns, and no rule written here could reproduce it.
 */
export type FormOrder = ReadonlyArray<{ id: string; rows: readonly string[] }>;

export interface PlanCard {
  id: string;
  registrationId: string;
  filedRegistrationId: string | null;
  createdAt: Date;
  endedAt: Date | null;
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  propertyNumber: string | null;
  unitStatus: string | null;
  landlordCitizenId: string | null;
  /** A tenant's link created this card on the owner's file (`landlordLinkMint`). */
  minted: boolean;
  units: PlanRow[];
}

export interface PlanSpell {
  id: string;
  unitId: string;
  citizenId: string;
  role: string;
  toDate: Date | null;
}

export interface PlanInput {
  keep: PlanPerson;
  absorb: PlanPerson;
  /** Whether either file is already folded into another. */
  keepMerged: boolean;
  absorbMerged: boolean;
  /** Both people's registrations. */
  registrations: readonly PlanRegistration[];
  /** Every card on those registrations, current and ended. */
  cards: readonly PlanCard[];
  /** Both people's census spells, current and ended. */
  spells: readonly PlanSpell[];
  /** Each registration's current cards and rows as the form lists them — see `FormOrder`. */
  formOrder?: ReadonlyMap<string, FormOrder>;
  /**
   * What tenants' links wrote into either file: card ids (a card the link
   * added a row to or minted) and spell ids. Ending one of those would leave
   * «إلغاء الربط» reverting a row that is no longer what it wrote.
   */
  linkWritten: { cardIds: ReadonlySet<string>; spellIds: ReadonlySet<string> };
  /** A unit's code, for the sentences — `Z-1-45-A-0102`. */
  unitCode: (unitId: string) => string | null;
  /** A building's code, for a منزل card that names no unit. */
  buildingCode: (buildingId: string) => string | null;
  /**
   * The one unit of a structure that has exactly one — what the census sync
   * reads a منزل card as claiming. Null where it has none or several.
   */
  singleUnitOf: (buildingId: string) => string | null;
}

// ─────────────────────────────  Output  ─────────────────────────────

export interface CardMove {
  cardId: string;
  fromRegistrationId: string;
  toRegistrationId: string;
  filedRegistrationIdBefore: string | null;
  filedRegistrationIdAfter: string;
}

export interface FlagWrite {
  registrationId: string;
  before: { flaggedFields: unknown; status: string };
  after: { flaggedFields: FieldFlag[]; status: string };
}

export interface DuplicateClaim {
  key: string;
  /** The copy that ends. */
  cardId: string;
  rowId: string | null;
  unitId: string | null;
  label: string;
  /** The registration whose officer filed the ending copy — see `filedOn`. */
  filedOnRegistrationId: string;
}

export interface MergePlan {
  blocks: CitizenMergeBlock[];
  newest: PlanRegistration | null;
  /** The keep side's newest registration before the merge. */
  keepNewest: PlanRegistration | null;
  absorbNewest: PlanRegistration | null;
  registrationMoves: string[];
  cardMoves: CardMove[];
  duplicates: DuplicateClaim[];
  /** Rows that end «سُجِّل خطأً». */
  rowEnds: Array<{ rowId: string; cardId: string }>;
  /**
   * Cards that end — a منزل copy, or a card every current row of which ended.
   * «سُجِّل خطأً» only where nothing on the card ended for a real reason
   * before: the pay rule skips a whole card recorded in error, and a flat the
   * officer filed that was genuinely sold or left keeps its dollar (user
   * decision, 2026-09-28 — only the duplicate copy loses credit).
   */
  cardEnds: Array<{ cardId: string; reason: 'RECORDED_IN_ERROR' | null }>;
  /** The absorbed person's spells, re-pointed to the kept one. */
  spellMoves: string[];
  /** Of those, the current ones the kept person already holds in the same role. */
  spellEnds: string[];
  flagWrites: FlagWrite[];
  fills: Array<{ field: FillableField; value: unknown }>;
  /** The identity document moves with the fill — it is unique, so it leaves the absorbed row. */
  identityMoves: boolean;
  fillsForDisplay: CitizenMergeFieldFill[];
  conflicts: CitizenMergeFieldConflict[];
  flagsAnswered: number;
  /** Current cards on the newest filing once merged, in the order the form lists them. */
  finalCards: string[];
  /**
   * A filing's flags afterwards, for the order its current cards and rows
   * actually have. `flagWrites` is this applied to the order predicted here;
   * the service applies it again to the order the form's query returns once
   * the cards have moved, which is the one the form will read.
   */
  flagsFor: (registrationId: string, order: FormOrder) => FieldFlag[] | null;
}

// ─────────────────────────────  Fields  ─────────────────────────────

/** Columns a merge may fill on the kept file, where it has none. */
export type FillableField =
  | 'middleName'
  | 'motherName'
  | 'phone'
  | 'whatsapp'
  /** «رقم للتواصل» — a relative's number, never an identity. See `User.contactPhone`. */
  | 'contactPhone'
  /** «لا يملك رقم هاتف» — filled true only onto a kept file with no phone and no answer. */
  | 'hasNoPhone'
  | 'gender'
  | 'nationality'
  | 'isLebanese'
  | 'residentStatus'
  | 'civilRecordNumber'
  | 'residencyNumber'
  | 'maritalStatus'
  | 'bloodType'
  | 'totalRegisteredMembers'
  | 'actualHouseholdMembers'
  | 'identityDocType'
  | 'identityDocNumber'
  | 'residencePlace'
  | 'localContactName'
  | 'localContactPhone';

/**
 * Which columns a file of each kind maintains — the same split
 * `citizenColumnsForEdit` writes by. A household file is never given a
 * non-resident's مكان الإقامة, and a non-resident's short record is never given
 * a household's blood type: the edit form would neither show nor maintain it.
 */
/*
  `contactPhone` is a household file's answer — `citizenColumnsForEdit` writes
  it on that branch alone — so it fills a household survivor only. Its phone
  and WhatsApp are filled by `planFields` with «لا يملك رقم هاتف» in hand, not
  from this list.
*/
const SHARED_FIELDS: readonly FillableField[] = ['middleName'];
const RESIDENT_FIELDS: readonly FillableField[] = [
  'contactPhone',
  'motherName',
  'gender',
  'nationality',
  'isLebanese',
  'residentStatus',
  'civilRecordNumber',
  'residencyNumber',
  'maritalStatus',
  'bloodType',
];
const NON_RESIDENT_FIELDS: readonly FillableField[] = ['residencePlace', 'localContactName', 'localContactPhone'];

/** Compared for the dialog's «يختلفان» list; the kept file's answer stays. */
const COMPARED_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'motherName',
  'phone',
  'whatsapp',
  'hasNoPhone',
  'contactPhone',
  'residence',
  'gender',
  'nationality',
  'residentStatus',
  'civilRecordNumber',
  'residencyNumber',
  'identityDocNumber',
  'maritalStatus',
  'bloodType',
  'totalRegisteredMembers',
  'actualHouseholdMembers',
  'residencePlace',
  'localContactName',
  'localContactPhone',
] as const;

const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

/**
 * An answer as the preview carries it: text trimmed, a yes-or-no left a
 * boolean (`isLebanese`, `hasNoPhone`) for the dialog to say in the page's
 * language — the server writing «نعم» put Arabic on the English page.
 */
function display(value: unknown): string | boolean | null {
  if (blank(value)) return null;
  if (typeof value === 'boolean') return value;
  return String(value).trim();
}

/**
 * Two answers that are the same answer however they were typed.
 *
 * Text is compared through the duplicate rule's own fold (أإآ→ا، ة→ه، ى→ي,
 * digits, spaces inside a name): «علي» and «على» are one father's name, and
 * listing them as a disagreement would ask the administrator to choose between
 * two spellings of the same word.
 */
function sameAnswer(field: string, a: unknown, b: unknown): boolean {
  if (
    field === 'phone' ||
    field === 'whatsapp' ||
    field === 'contactPhone' ||
    field === 'localContactPhone'
  ) {
    return String(a).replace(/\D/g, '') === String(b).replace(/\D/g, '');
  }
  if (field === 'civilRecordNumber' || field === 'residencyNumber' || field === 'identityDocNumber') {
    return foldRecordNumber(String(a)) === foldRecordNumber(String(b));
  }
  return foldNamePart(String(a)) === foldNamePart(String(b));
}

export function planFields(keep: PlanPerson, absorb: PlanPerson): Pick<
  MergePlan,
  'fills' | 'identityMoves' | 'fillsForDisplay' | 'conflicts'
> {
  const kinds = isOwnerRecord(keep.residence)
    ? [...SHARED_FIELDS, ...NON_RESIDENT_FIELDS]
    : [...SHARED_FIELDS, ...RESIDENT_FIELDS];

  const fills: MergePlan['fills'] = [];
  const resident = !isOwnerRecord(keep.residence);

  /*
    The person's own numbers, with «لا يملك رقم هاتف» in hand.

    The typical pair is the old file holding a son's number in `phone` and the
    corrected one saying the father has no phone. Filling the kept file's empty
    `phone` from the absorbed one would put the son's number back in the
    identity column — citizen sign-in would offer the father's file to the son
    again, which is the defect the answer exists to end. So:

    - a kept file that says «لا يملك رقم هاتف» gets no phone and no WhatsApp;
      the absorbed file's number becomes its «رقم للتواصل», if it has none —
      the same move the form makes when the box is ticked, shown to the
      administrator in the fills before anything is written;
    - a kept file with no phone and no answer takes the absorbed file's answer:
      its numbers, or «لا يملك رقم هاتف» — the latter only when the kept file
      has no WhatsApp number of its own either, because a person with one is
      not a person with no phone (0072 refuses the pair; the disagreement stays
      in the compared fields for the administrator to see);
    - an absorbed phone that is the kept file's own «رقم للتواصل» is never
      filled as the phone: by the kept file's own answer it is a relative's,
      and filling it would put it back in the identity column (0072 refuses
      that pair too);
    - a kept file with a phone keeps it, and a «رقم للتواصل» equal to it is
      never filled.
  */
  const fill = (field: FillableField, value: unknown) => fills.push({ field, value });
  let ownPhone = keep.phone;
  let contact = keep.contactPhone;
  if (keep.hasNoPhone) {
    const relative = absorb.contactPhone ?? absorb.phone;
    if (resident && blank(contact) && !blank(relative)) {
      fill('contactPhone', relative);
      contact = relative;
    }
  } else if (blank(keep.phone)) {
    if (absorb.hasNoPhone) {
      if (resident && blank(keep.whatsapp)) fill('hasNoPhone', true);
    } else if (!blank(absorb.phone)) {
      const keptRelative = !blank(contact) && sameAnswer('phone', contact, absorb.phone);
      if (!keptRelative) {
        fill('phone', absorb.phone);
        ownPhone = absorb.phone;
        if (blank(keep.whatsapp) && !blank(absorb.whatsapp)) fill('whatsapp', absorb.whatsapp);
      }
    }
  } else if (blank(keep.whatsapp) && !blank(absorb.whatsapp)) {
    fill('whatsapp', absorb.whatsapp);
  }
  if (resident && blank(contact) && !blank(absorb.contactPhone)) {
    const sameAsOwn = !blank(ownPhone) && sameAnswer('phone', ownPhone, absorb.contactPhone);
    if (!sameAsOwn) fill('contactPhone', absorb.contactPhone);
  }

  for (const field of kinds) {
    if (field === 'contactPhone') continue; // decided with the phone, above
    if (blank(keep[field]) && !blank(absorb[field])) fills.push({ field, value: absorb[field] });
  }

  /*
    The household counts are one answer in two columns, bound by a CHECK
    (actual ≤ total). Filled as a pair or not at all: half from each file could
    breach it, and would state a household nobody described.
  */
  if (
    resident &&
    keep.totalRegisteredMembers === null &&
    keep.actualHouseholdMembers === null &&
    (absorb.totalRegisteredMembers !== null || absorb.actualHouseholdMembers !== null)
  ) {
    fills.push({ field: 'totalRegisteredMembers', value: absorb.totalRegisteredMembers });
    fills.push({ field: 'actualHouseholdMembers', value: absorb.actualHouseholdMembers });
  }

  /*
    The identity document is unique across the register, so it cannot be
    copied — it moves, and leaves the absorbed row. Only where the kept file
    has none; two different numbers stay where they are and are listed.
  */
  const identityMoves = resident && blank(keep.identityDocNumber) && !blank(absorb.identityDocNumber);
  if (identityMoves) {
    fills.push({ field: 'identityDocType', value: absorb.identityDocType });
    fills.push({ field: 'identityDocNumber', value: absorb.identityDocNumber });
  }

  /*
    A disagreement needs two answers. «لا يملك رقم هاتف» unticked answers only
    beside a number of the file's own — on a file with neither phone nor
    WhatsApp it is no answer — and a field the plan fills had none on the kept
    file, so listing either would show a disagreement nobody made.
  */
  const answered = (side: typeof keep, field: (typeof COMPARED_FIELDS)[number]) => {
    const value = side[field];
    if (blank(value)) return false;
    if (field === 'hasNoPhone' && value === false) return !blank(side.phone) || !blank(side.whatsapp);
    return true;
  };
  const filled = new Set<string>(fills.map((fill) => fill.field));
  const conflicts: CitizenMergeFieldConflict[] = [];
  for (const field of COMPARED_FIELDS) {
    const a = keep[field];
    const b = absorb[field];
    if (filled.has(field) || !answered(keep, field) || !answered(absorb, field) || sameAnswer(field, a, b)) continue;
    conflicts.push({ field, keep: display(a), absorb: display(b) });
  }

  return {
    fills,
    identityMoves,
    fillsForDisplay: fills
      .filter((fill) => fill.field !== 'identityDocType')
      .map((fill) => ({ field: fill.field, value: display(fill.value) })),
    conflicts,
  };
}

// ─────────────────────────────  Flags  ─────────────────────────────

/**
 * Creation order, leaving ties where they were — `Array.prototype.sort` is
 * stable, and the input arrives in the form's own order (see `FormOrder`).
 */
const byCreation = <T extends { createdAt: Date }>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime();

function readFlagList(value: unknown): FieldFlag[] {
  return Array.isArray(value)
    ? (value as FieldFlag[]).filter((flag) => flag && typeof flag.path === 'string')
    : [];
}

/** A flag read back to what it names: a card, a row on it, or the person. */
type AnchoredFlag =
  | { on: 'person'; flag: FieldFlag }
  | { on: 'card'; cardId: string; rest: string; flag: FieldFlag }
  | { on: 'row'; cardId: string; rowId: string; rest: string; flag: FieldFlag };

function currentRows(card: PlanCard, ended: ReadonlySet<string> = new Set()): PlanRow[] {
  return card.units.filter((row) => !row.endedAt && !ended.has(row.id)).sort(byCreation);
}

/**
 * One registration's flags, each tied to the card or row it names.
 *
 * A flag whose position names no current card is kept on the person side of
 * the ledger as it was — it was already pointing at nothing, and the merge is
 * not the place to decide what it meant.
 */
function anchorFlags(
  registration: PlanRegistration,
  cards: readonly PlanCard[],
  order: FormOrder | undefined,
): AnchoredFlag[] {
  const listed: FormOrder =
    order ??
    cards
      .filter((card) => card.registrationId === registration.id && !card.endedAt)
      .sort(byCreation)
      .map((card) => ({ id: card.id, rows: currentRows(card).map((row) => row.id) }));

  return readFlagList(registration.flaggedFields).map((flag): AnchoredFlag => {
    const row = /^properties\.(\d+)\.units\.(\d+)\.(.+)$/.exec(flag.path);
    if (row) {
      const card = listed[Number(row[1])];
      const unit = card?.rows[Number(row[2])];
      if (card && unit) return { on: 'row', cardId: card.id, rowId: unit, rest: row[3]!, flag };
    }
    const whole = /^properties\.(\d+)\.(.+)$/.exec(flag.path);
    if (whole && !row) {
      const card = listed[Number(whole[1])];
      if (card) return { on: 'card', cardId: card.id, rest: whole[2]!, flag };
    }
    return { on: 'person', flag };
  });
}

/** `personal.motherName` → `motherName`. */
function fieldOf(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? '';
}

/** Every reference number a «سجل مشابه» flag names. */
function referencesIn(reason: string | undefined): string[] {
  return [...(reason ?? '').matchAll(/\(([A-Z]{3}-\d{4}-[A-Z0-9]{6})\)/g)].map((match) => match[1]!);
}

/**
 * A «سجل مشابه» flag this merge answers: it names the other file of the pair
 * and nobody else. One that also names a third person is still an open
 * question about them, and stays — and so does one that names somebody the
 * reason could only give by name (a file with no reference), or ends in «و N
 * غيرهم» (`possibleDuplicateFlag` names three at most).
 */
function answeredBy(flag: FieldFlag, other: PlanPerson): boolean {
  if (flag.path !== POSSIBLE_DUPLICATE_FLAG_PATH || !other.referenceNumber) return false;
  const reason = flag.reason ?? '';
  if (reason.includes('غيرهم')) return false;
  const list = /:\s*(.+?)\s+—/.exec(reason)?.[1];
  if (!list) return false;
  const named = list.split('، ').map((entry) => entry.trim()).filter(Boolean);
  return (
    named.length > 0 &&
    named.every((entry) => referencesIn(entry).length === 1 && referencesIn(entry)[0] === other.referenceNumber)
  );
}

// ─────────────────────────────  The plan  ─────────────────────────────

/** Where a card's credit is: the registration it was filed on. */
export const filedOn = (card: Pick<PlanCard, 'registrationId' | 'filedRegistrationId'>) =>
  card.filedRegistrationId ?? card.registrationId;

/** The newest of a set of registrations — the file. Ties broken by id, so both reads agree. */
function newestOf(registrations: readonly PlanRegistration[]): PlanRegistration | null {
  let best: PlanRegistration | null = null;
  for (const registration of registrations) {
    if (
      !best ||
      registration.submittedAt.getTime() > best.submittedAt.getTime() ||
      (registration.submittedAt.getTime() === best.submittedAt.getTime() && registration.id > best.id)
    ) {
      best = registration;
    }
  }
  return best;
}

/** The most current cards a file may carry — the edit form's own ceiling. */
export const MAX_MERGED_CARDS = 25;

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'مالك',
  TENANT: 'مستأجر',
  FREE_OCCUPANT: 'شاغل بتسامح',
};

export function planMerge(input: PlanInput): MergePlan {
  const { keep, absorb } = input;
  const blocks: CitizenMergeBlock[] = [];
  const block = (code: CitizenMergeBlock['code'], message: string) => {
    if (!blocks.some((existing) => existing.code === code && existing.message === message)) {
      blocks.push({ code, message });
    }
  };

  if (keep.id === absorb.id) block('SAME_FILE', 'لا يمكن دمج ملف في نفسه.');
  if (!keep.isActive || !absorb.isActive) {
    block(
      'INACTIVE',
      'أحد الملفين معطّل. أعد تفعيله أولاً من صفحته، ثم ادمج — الملف المعطّل لا يُفوتَر، ودمجه قد يعيد فوترة ما أُوقف عمداً.',
    );
  }
  if (input.keepMerged || input.absorbMerged) {
    block('ALREADY_MERGED', 'أحد الملفين مدموج في ملف آخر. افتح الملف الذي دُمج فيه وادمج منه.');
  }
  /*
    A person and an estate or an institution are never one record (0076): an
    estate is the deceased's own file, converted in place, and folding a living
    person into it — or two kinds of body into one — would put one party's
    holdings and bills on another.
  */
  if (
    (isNonPersonRecord(keep.residence) || isNonPersonRecord(absorb.residence)) &&
    keep.residence !== absorb.residence
  ) {
    block(
      'RESIDENCE_CONFLICT',
      'لا يُدمج ملف تركة أو جهة بملف شخص، ولا تركة بجهة. إن كان أحدهما سُجِّل بالنوع الخطأ فصحّح نوع الملف أولاً من صفحته.',
    );
  }

  const registrations = input.registrations;
  const keepRegs = registrations.filter((registration) => registration.citizenId === keep.id);
  const absorbRegs = registrations.filter((registration) => registration.citizenId === absorb.id);
  const keepNewest = newestOf(keepRegs);
  const absorbNewest = newestOf(absorbRegs);
  const newest = newestOf(registrations);
  const sideOf = (registrationId: string): 'keep' | 'absorb' =>
    absorbRegs.some((registration) => registration.id === registrationId) ? 'absorb' : 'keep';

  const cardsById = new Map(input.cards.map((card) => [card.id, card]));
  const current = input.cards.filter((card) => !card.endedAt);

  // ── A flat on both files ──────────────────────────────────────────────

  type Claim = { card: PlanCard; row: PlanRow | null; side: 'keep' | 'absorb' };
  const claims = new Map<string, Claim[]>();
  const claim = (key: string, value: Claim) => claims.set(key, [...(claims.get(key) ?? []), value]);

  for (const card of current) {
    const side = sideOf(card.registrationId);
    const linked = currentRows(card).filter((row) => row.unitId);
    for (const row of linked) claim(`u:${row.unitId}`, { card, row, side });
    /*
      A منزل names its structure, not a unit. The census sync reads it as the
      structure's one unit where it has exactly one, so the same flat filed as a
      منزل on one file and as a row of a مبنى on the other is one claim.
    */
    if (linked.length === 0 && card.propertyType === 'HOUSE' && card.buildingId) {
      const unitId = input.singleUnitOf(card.buildingId);
      claim(unitId ? `u:${unitId}` : `h:${card.buildingId}`, { card, row: null, side });
    }
  }

  const labelOf = (claimKey: string, card: PlanCard): { label: string; unitId: string | null } => {
    if (claimKey.startsWith('u:')) {
      const unitId = claimKey.slice(2);
      return { label: input.unitCode(unitId) ?? card.propertyNumber ?? 'وحدة', unitId };
    }
    const code = card.buildingId ? input.buildingCode(card.buildingId) : null;
    return { label: code ?? card.propertyNumber ?? 'منزل', unitId: null };
  };

  const duplicates: DuplicateClaim[] = [];
  const endedRows = new Set<string>();
  const endedHouseCards = new Set<string>();

  for (const [key, list] of claims) {
    const kept = list.filter((entry) => entry.side === 'keep');
    const dropped = list.filter((entry) => entry.side === 'absorb');
    if (kept.length === 0 || dropped.length === 0) continue;

    const { label, unitId } = labelOf(key, dropped[0]!.card);
    const roles = new Set(list.map((entry) => entry.card.occupancyType));
    if (roles.size > 1) {
      block(
        'ROLE_CONFLICT',
        `${label}: أحد الملفين يسجّله ${ROLE_LABEL[kept[0]!.card.occupancyType] ?? 'شاغلاً'} والآخر ${
          ROLE_LABEL[dropped[0]!.card.occupancyType] ?? 'شاغلاً'
        }. صحّح البطاقة الخاطئة في ملفها أولاً، ثم ادمج.`,
      );
      continue;
    }

    for (const entry of dropped) {
      if (entry.card.minted || input.linkWritten.cardIds.has(entry.card.id)) {
        block(
          'LINKED_DUPLICATE',
          `${label}: نسخة الملف المدموج كتبها ربط مستأجر بمالكه. ألغِ ذلك الربط من ملف المستأجر أولاً، ثم ادمج، ثم أعد الربط بالملف الباقي.`,
        );
        continue;
      }
      if (entry.row) endedRows.add(entry.row.id);
      else endedHouseCards.add(entry.card.id);
      duplicates.push({
        key,
        cardId: entry.card.id,
        rowId: entry.row?.id ?? null,
        unitId,
        label,
        filedOnRegistrationId: filedOn(entry.card),
      });
    }
  }

  /*
    A card whose every current row ended ends too. «سُجِّل خطأً» on the card
    only where no earlier row on it ended for a real reason — see `cardEnds`.
  */
  const cardEndReason = new Map<string, 'RECORDED_IN_ERROR' | null>(
    [...endedHouseCards].map((cardId) => [cardId, 'RECORDED_IN_ERROR']),
  );
  for (const card of current) {
    const rows = currentRows(card);
    if (rows.length === 0 || !rows.every((row) => endedRows.has(row.id))) continue;
    const realEndingBefore = card.units.some((row) => row.endedAt && row.endReason !== 'RECORDED_IN_ERROR');
    cardEndReason.set(card.id, realEndingBefore ? null : 'RECORDED_IN_ERROR');
  }
  const cardEnds = new Set(cardEndReason.keys());

  // ── Spells ────────────────────────────────────────────────────────────

  const keepCurrent = new Map(
    input.spells
      .filter((spell) => spell.citizenId === keep.id && !spell.toDate)
      .map((spell) => [spell.unitId, spell]),
  );
  const spellMoves: string[] = [];
  const spellEnds: string[] = [];
  for (const spell of input.spells.filter((entry) => entry.citizenId === absorb.id)) {
    spellMoves.push(spell.id);
    if (spell.toDate) continue;
    const held = keepCurrent.get(spell.unitId);
    if (!held) continue;
    const label = input.unitCode(spell.unitId) ?? 'وحدة';
    if (held.role !== spell.role) {
      block(
        'ROLE_CONFLICT',
        `${label}: سجل المباني يسجّل الشخص ${ROLE_LABEL[held.role] ?? held.role} في أحد الملفين و${
          ROLE_LABEL[spell.role] ?? spell.role
        } في الآخر. صحّح الوحدة في مصفوفة المبنى أولاً، ثم ادمج.`,
      );
      continue;
    }
    if (input.linkWritten.spellIds.has(spell.id)) {
      block(
        'LINKED_DUPLICATE',
        `${label}: إشغال الملف المدموج لهذه الوحدة كتبه ربط مستأجر بمالكه. ألغِ ذلك الربط أولاً، ثم ادمج، ثم أعد الربط.`,
      );
      continue;
    }
    spellEnds.push(spell.id);
  }

  // ── Somebody renting from themselves ─────────────────────────────────

  for (const card of current) {
    const side = sideOf(card.registrationId);
    const other = side === 'keep' ? absorb.id : keep.id;
    if (card.landlordCitizenId === other) {
      block(
        'SELF_LINK',
        `بطاقة في أحد الملفين تسجّل صاحب الملف الآخر مالكاً لها (${card.propertyNumber ?? 'عقار'}) — بعد الدمج يصبح الشخص مستأجراً من نفسه. ألغِ هذا الربط من البطاقة أولاً.`,
      );
    }
  }

  // ── The file afterwards ──────────────────────────────────────────────

  const cardMoves: CardMove[] = [];
  if (newest) {
    for (const card of current) {
      if (cardEnds.has(card.id) || card.registrationId === newest.id) continue;
      cardMoves.push({
        cardId: card.id,
        fromRegistrationId: card.registrationId,
        toRegistrationId: newest.id,
        filedRegistrationIdBefore: card.filedRegistrationId,
        filedRegistrationIdAfter: filedOn(card),
      });
    }
  }

  const movedIds = new Set(cardMoves.map((move) => move.cardId));
  /*
    Each filing's cards in the form's own order, then all of them by creation —
    stable, so a tie keeps the order its filing's form showed. A prediction:
    the service re-reads the real order once the cards have moved.
  */
  const inFormOrder = (registrationId: string): PlanCard[] => {
    const order = input.formOrder?.get(registrationId);
    const own = current.filter((card) => card.registrationId === registrationId);
    if (!order) return own.sort(byCreation);
    const position = new Map(order.map((entry, index) => [entry.id, index]));
    return own.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  };
  const rowOrder = (card: PlanCard): string[] => {
    const listed = input.formOrder?.get(card.registrationId)?.find((entry) => entry.id === card.id)?.rows;
    const rows = listed ?? currentRows(card).map((row) => row.id);
    return rows.filter((rowId) => !endedRows.has(rowId));
  };
  const finalCards = newest
    ? [newest.id, ...new Set(cardMoves.map((move) => move.fromRegistrationId))]
        .flatMap((registrationId) => inFormOrder(registrationId))
        .filter((card) => !cardEnds.has(card.id) && (card.registrationId === newest.id || movedIds.has(card.id)))
        .sort(byCreation)
    : [];

  if (finalCards.length > MAX_MERGED_CARDS) {
    block(
      'TOO_MANY_CARDS',
      `الملف الناتج يحمل ${finalCards.length} بطاقة، والحدّ ${MAX_MERGED_CARDS}. أنهِ البطاقات المنتهية في أحد الملفين أولاً.`,
    );
  }

  // ── Flags ─────────────────────────────────────────────────────────────

  const fieldPlan = planFields(keep, absorb);
  const filled = new Set(fieldPlan.fills.map((fill) => fill.field as string));
  const touched = new Set<string>([
    ...cardMoves.map((move) => move.fromRegistrationId),
    ...[...cardEnds, ...[...endedRows].map((rowId) => rowOwner(input.cards, rowId))]
      .map((cardId) => cardsById.get(cardId ?? '')?.registrationId)
      .filter((id): id is string => Boolean(id)),
    ...(newest ? [newest.id] : []),
    ...(keepNewest ? [keepNewest.id] : []),
    ...(absorbNewest ? [absorbNewest.id] : []),
  ]);

  const anchored = new Map(
    registrations.map((registration) => [
      registration.id,
      anchorFlags(registration, input.cards, input.formOrder?.get(registration.id)),
    ]),
  );
  const cardFlags = (cardId: string) =>
    [...anchored.values()].flat().filter((entry) => entry.on !== 'person' && entry.cardId === cardId) as Array<
      Exclude<AnchoredFlag, { on: 'person' }>
    >;
  const personFlags = (registrationId: string | undefined) =>
    registrationId
      ? (anchored.get(registrationId) ?? []).filter((entry) => entry.on === 'person').map((entry) => entry.flag)
      : [];

  /** Card and row flags, at the positions the given order puts their cards and rows. */
  const placeCardFlags = (order: FormOrder): FieldFlag[] =>
    order.flatMap((card, index) =>
      cardFlags(card.id).flatMap((entry): FieldFlag[] => {
        if (entry.on === 'card') return [{ ...entry.flag, path: `properties.${index}.${entry.rest}` }];
        const at = card.rows.indexOf(entry.rowId);
        return at < 0 ? [] : [{ ...entry.flag, path: `properties.${index}.units.${at}.${entry.rest}` }];
      }),
    );

  let flagsAnswered = 0;

  /**
   * The person's flags on the file afterwards.
   *
   * The kept person's own, because theirs is the person the file now shows —
   * except where a blank they flagged was filled from the other file, which
   * takes that file's flag on the field with the value (the caveat travels
   * with the answer). A «سجل مشابه» that named only this pair is answered by
   * the merge and dropped; one the absorbed filing raised about somebody else
   * is still a question, and comes across.
   */
  const personAfter = (): FieldFlag[] => {
    const own = personFlags(keepNewest?.id);
    const theirs = personFlags(absorbNewest?.id);
    const result: FieldFlag[] = [];
    for (const flag of own) {
      if (filled.has(fieldOf(flag.path))) continue;
      if (answeredBy(flag, absorb)) {
        flagsAnswered += 1;
        continue;
      }
      result.push(flag);
    }
    for (const flag of theirs) {
      if (filled.has(fieldOf(flag.path)) && !result.some((existing) => existing.path === flag.path)) {
        result.push(flag);
        continue;
      }
      if (flag.path !== POSSIBLE_DUPLICATE_FLAG_PATH) continue;
      if (answeredBy(flag, keep)) {
        flagsAnswered += 1;
        continue;
      }
      if (!result.some((existing) => existing.path === POSSIBLE_DUPLICATE_FLAG_PATH)) result.push(flag);
    }
    return result;
  };

  // Computed once: it counts the «سجل مشابه» flags it answers.
  const newestPeople = personAfter();

  /** Null for a filing this merge does not touch. */
  const flagsFor = (registrationId: string, order: FormOrder): FieldFlag[] | null => {
    if (!touched.has(registrationId)) return null;
    if (newest && registrationId === newest.id) return [...newestPeople, ...placeCardFlags(order)];
    // Superseded by the file's own person flags on the newest filing.
    const people =
      registrationId === keepNewest?.id || registrationId === absorbNewest?.id ? [] : personFlags(registrationId);
    return [...people, ...placeCardFlags(order)];
  };

  const predictedOrder = (registrationId: string): FormOrder =>
    (newest && registrationId === newest.id
      ? finalCards
      : inFormOrder(registrationId).filter((card) => !cardEnds.has(card.id) && !movedIds.has(card.id))
    ).map((card) => ({ id: card.id, rows: rowOrder(card) }));

  const flagWrites: FlagWrite[] = [];
  for (const registrationId of touched) {
    const registration = registrations.find((entry) => entry.id === registrationId);
    if (!registration) continue;

    const write = flagWriteFor(registration, flagsFor(registrationId, predictedOrder(registrationId))!);
    if (write) flagWrites.push(write);
  }

  // ── Somebody who does not live here, holding a home they live in ─────

  if (isOwnerRecord(keep.residence) && newest) {
    const flags = flagWrites.find((write) => write.registrationId === newest.id)?.after.flaggedFields ??
      readFlagList(newest.flaggedFields);
    const flaggedPaths = new Set(flags.map((flag) => flag.path));
    finalCards.forEach((card, index) => {
      // The kept file's own cards were accepted on it; only what arrives is asked about.
      if (sideOf(card.registrationId) !== 'absorb') return;
      const shaped = {
        occupancyType: card.occupancyType,
        propertyType: card.propertyType,
        unitStatus: card.unitStatus,
        units: rowOrder(card)
          .map((rowId) => card.units.find((row) => row.id === rowId)!)
          .map((row) => ({ unitType: row.unitType, unitStatus: row.unitStatus })),
      };
      if (nonResidentCardIssues(shaped, flaggedPaths, `properties.${index}`).length > 0) {
        block(
          'RESIDENCE_CONFLICT',
          `الملف الباقي «غير مقيم في البلدة»، والملف الآخر يحمل بطاقة تقول إنه يسكن في البلدة (${
            card.propertyNumber ?? 'عقار'
          }). احتفظ بالملف الآخر بدلاً منه، أو صحّح الإقامة أولاً عبر «تغيير الإقامة».`,
        );
      }
    });
  }

  return {
    blocks,
    newest,
    keepNewest,
    absorbNewest,
    registrationMoves: absorbRegs.map((registration) => registration.id),
    cardMoves,
    duplicates,
    rowEnds: [...endedRows].map((rowId) => ({ rowId, cardId: rowOwner(input.cards, rowId)! })),
    cardEnds: [...cardEndReason].map(([cardId, reason]) => ({ cardId, reason })),
    spellMoves,
    spellEnds,
    flagWrites,
    ...fieldPlan,
    flagsAnswered,
    finalCards: finalCards.map((card) => card.id),
    flagsFor,
  };
}

/**
 * The write one filing's flags need, or null where they come out as they were.
 * Only a status the flags decide is re-derived; anything else is left.
 */
export function flagWriteFor(
  registration: Pick<PlanRegistration, 'id' | 'flaggedFields' | 'status'>,
  after: FieldFlag[],
): FlagWrite | null {
  const before = readFlagList(registration.flaggedFields);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    registrationId: registration.id,
    before: { flaggedFields: registration.flaggedFields, status: registration.status },
    after: {
      flaggedFields: after,
      status:
        registration.status === 'REQUIRES_REVIEW' || registration.status === 'PENDING' || after.length > 0
          ? statusForFlags(after)
          : registration.status,
    },
  };
}

function rowOwner(cards: readonly PlanCard[], rowId: string): string | null {
  return cards.find((card) => card.units.some((row) => row.id === rowId))?.id ?? null;
}
