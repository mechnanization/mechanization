/**
 * What one save of the edit form changed on a citizen's file, field by field.
 *
 * ## Why
 *
 * `CITIZEN_UPDATED` used to record counts — how many cards, how many flags — so
 * the question a clerk actually asks, «who changed this, and what was it
 * before?», had no answer anywhere. This compares the file as the form shows it
 * (`CitizensService.getEditable`) before and after the save, so the trail holds
 * exactly the fields the officer could see and change.
 *
 * ## What is written, and what is not
 *
 * Ordinary fields are written on both sides. Sensitive ones — the identity
 * numbers, صفة الإقامة (refugee status) and phone numbers — are written as the
 * name of the field only: the trail says that the civil record number changed,
 * by whom and why, and never what it was or became (Law 81/2018's
 * minimisation; the user's decision of 2026-09-27). The audit writer redacts
 * the same keys again as a second line of defence.
 */

/** Fields whose values are never written to the trail — only that they changed. */
export const SENSITIVE_FILE_FIELDS = new Set([
  'civilRecordNumber',
  'identityDocNumber',
  'residencyNumber',
  'residentStatus',
  'phone',
  'whatsapp',
  'localContactPhone',
  'landlordPhone',
]);

/** The file as `getEditable` returns it — only the parts compared here. */
export interface EditableFileView {
  residence?: string | null;
  notes?: string | null;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown> & { id: string; units?: Array<Record<string, unknown>> }>;
}

/** One card's changes, keyed by what identifies it to a person. */
export interface CardChange {
  cardId: string;
  /** What the card is, as it stands after the save (or stood, if it was removed). */
  propertyType: unknown;
  propertyNumber: unknown;
  occupancyType: unknown;
  kind: 'added' | 'removed' | 'changed';
  /** Ordinary fields that moved. */
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
  /** Sensitive fields that moved — names only. */
  sensitive?: string[];
  /** Flats on the card: how many were added, removed or changed. */
  rows?: { added: number; removed: number; changed: number };
}

export interface FileChanges {
  /** Ordinary file fields, old values. */
  before: Record<string, unknown>;
  /** Ordinary file fields, new values. */
  after: Record<string, unknown>;
  /** Every file field that changed, sensitive ones included — names only. */
  changed: string[];
  cards: CardChange[];
}

/** Derived or internal: shown nowhere as a field of its own. */
const SKIPPED = new Set(['whatsappSameAsPhone', 'landlordLink', 'landlordCitizenId', 'id', 'units', 'flags']);

const CARD_FIELDS = [
  'occupancyType',
  'landlordName',
  'landlordPhone',
  'propertyType',
  'neighborhood',
  'propertyNumber',
  'landType',
  'buildingName',
  'side',
  'tentLocation',
  'unitArea',
  'shares',
  'sharedRights',
  'unitStatus',
  'unitType',
  'floor',
  'buildingId',
];

const ROW_FIELDS = ['unitType', 'floor', 'side', 'unitArea', 'unitStatus', 'unitId', 'sharedRights'];

/** Blank and absent are one answer on a form: «لا شيء». */
function normal(value: unknown): unknown {
  if (value === undefined || value === '') return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b));
}

export function fileChanges(before: EditableFileView, after: EditableFileView): FileChanges {
  const result: FileChanges = { before: {}, after: {}, changed: [], cards: [] };

  const compare = (field: string, a: unknown, b: unknown) => {
    if (SKIPPED.has(field) || same(a, b)) return;
    result.changed.push(field);
    if (SENSITIVE_FILE_FIELDS.has(field)) return;
    result.before[field] = normal(a);
    result.after[field] = normal(b);
  };

  compare('residence', before.residence, after.residence);
  compare('notes', before.notes, after.notes);
  for (const section of ['personal', 'contact'] as const) {
    const keys = new Set([...Object.keys(before[section] ?? {}), ...Object.keys(after[section] ?? {})]);
    for (const key of keys) compare(key, before[section]?.[key], after[section]?.[key]);
  }

  const beforeCards = new Map(before.properties.map((card) => [card.id, card]));
  const afterCards = new Map(after.properties.map((card) => [card.id, card]));
  const describe = (card: Record<string, unknown>) => ({
    propertyType: card.propertyType ?? null,
    propertyNumber: card.propertyNumber ?? null,
    occupancyType: card.occupancyType ?? null,
  });

  for (const [id, card] of beforeCards) {
    if (!afterCards.has(id)) result.cards.push({ cardId: id, kind: 'removed', ...describe(card) });
  }
  for (const [id, card] of afterCards) {
    const was = beforeCards.get(id);
    if (!was) {
      result.cards.push({ cardId: id, kind: 'added', ...describe(card) });
      continue;
    }
    const fields: NonNullable<CardChange['fields']> = [];
    const sensitive: string[] = [];
    for (const field of CARD_FIELDS) {
      if (same(was[field], card[field])) continue;
      if (SENSITIVE_FILE_FIELDS.has(field)) sensitive.push(field);
      else fields.push({ field, before: normal(was[field]), after: normal(card[field]) });
    }
    const rows = rowChanges(was.units ?? [], card.units ?? []);
    if (fields.length === 0 && sensitive.length === 0 && !rows) continue;
    result.cards.push({
      cardId: id,
      kind: 'changed',
      ...describe(card),
      ...(fields.length ? { fields } : {}),
      ...(sensitive.length ? { sensitive } : {}),
      ...(rows ? { rows } : {}),
    });
  }

  return result;
}

/** Flats on one card, matched by the row id the form carries. */
function rowChanges(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
): CardChange['rows'] | null {
  const was = new Map(before.map((row) => [String(row.id), row]));
  const now = new Map(after.map((row) => [String(row.id), row]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const id of was.keys()) if (!now.has(id)) removed += 1;
  for (const [id, row] of now) {
    const old = was.get(id);
    if (!old) added += 1;
    else if (ROW_FIELDS.some((field) => !same(old[field], row[field]))) changed += 1;
  }
  return added || removed || changed ? { added, removed, changed } : null;
}

const IDENTITY_NUMBERS = ['civilRecordNumber', 'identityDocNumber', 'residencyNumber'] as const;

/**
 * The high-impact edits that need a reason (the user's decision of 2026-09-27):
 * نوع الملف, صفة الإقامة (refugee status), an identity number that already held
 * a value, and a saved card's owner/tenant capacity or رقم العقار. Anyone who
 * may edit may make them — with a reason, kept on the audit row.
 *
 * A correction, not a completion: filling a blank asks nothing. A field the
 * save marks «غير مؤكَّد» asks nothing either — the flag carries its own reason.
 */
export function highImpactChanges(
  before: EditableFileView,
  after: EditableFileView,
  flaggedPaths: ReadonlySet<string> = new Set(),
): string[] {
  const found = new Set<string>();
  const corrected = (was: unknown, now: unknown) => normal(was) !== null && !same(was, now);
  /*
    Only what the submission carries. An owner who lives elsewhere is not asked
    صفة الإقامة, so their form never sends it — and a stored value compared with
    an absent one would demand a reason on every save of every such file.
  */
  const personalCorrected = (field: string) =>
    field in after.personal &&
    !flaggedPaths.has(`personal.${field}`) &&
    corrected(before.personal[field], after.personal[field]);

  if (!same(before.residence, after.residence)) found.add('residence');
  if (personalCorrected('residentStatus')) found.add('residentStatus');
  for (const field of IDENTITY_NUMBERS) {
    if (personalCorrected(field)) found.add(field);
  }

  const beforeCards = new Map(before.properties.map((card) => [card.id, card]));
  after.properties.forEach((card, index) => {
    const was = card.id ? beforeCards.get(card.id) : undefined;
    if (!was) return;
    if ('occupancyType' in card && !same(was.occupancyType, card.occupancyType)) found.add('occupancyType');
    if (
      'propertyNumber' in card &&
      !flaggedPaths.has(`properties.${index}.propertyNumber`) &&
      corrected(was.propertyNumber, card.propertyNumber)
    ) {
      found.add('propertyNumber');
    }
  });
  return [...found];
}

/** Whether a save changed nothing a person would recognise as a change. */
export function isEmptyChange(changes: FileChanges): boolean {
  return changes.changed.length === 0 && changes.cards.length === 0;
}
