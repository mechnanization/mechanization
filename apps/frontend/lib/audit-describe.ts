import { createTranslator } from 'next-intl';
import { calendarDayOf, getLabels, qualityLabels } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import type { AuditEntry } from './api-client';
import { FORMAT_LOCALE, type Locale } from './api-errors';
import { formatDate, formatDateTime } from './dates';

/*
  The words, from `messages/{ar,en}.json` under `audit`. A plain module rather
  than a hook, as `api-errors.ts` is: `describeAudit` is called once per entry
  with the page's locale, and `AUDIT_FAMILIES` is read at module scope.
*/
const AR = ar.audit;
const EN = en.audit;
const translators = {
  ar: createTranslator({ locale: FORMAT_LOCALE.ar, messages: { audit: AR }, namespace: 'audit' }),
  en: createTranslator({ locale: FORMAT_LOCALE.en, messages: { audit: EN }, namespace: 'audit' }),
};
type AuditTranslator = (typeof translators)['ar'];

function localeOf(locale: string): Locale {
  return locale === 'en' ? 'en' : 'ar';
}

/**
 * An audit row turned into what a person reads: which family it belongs to, the
 * fields that changed from what to what, the facts it recorded, and the one
 * sentence somebody wrote about it.
 *
 * ## Why not print the JSON
 *
 * `before`/`after` are whatever each feature chose to record, and they were
 * written for a reviewer who can read code. The municipality's auditor cannot,
 * and every clerk-facing screen already speaks the labels in `getLabels` — so
 * values are passed back through them, keys get their Arabic names, ids are
 * kept out of the sentence, and anything unrecognised still appears under
 * «كل التفاصيل» rather than being dropped.
 */

export type AuditTone = 'create' | 'change' | 'remove' | 'review' | 'correction' | 'money' | 'access';

export interface AuditFamily {
  key: string;
  label: [ar: string, en: string];
  tone: AuditTone;
  match: (action: string) => boolean;
}

/** Families, in the order the filter lists them. The first that matches wins. */
export const AUDIT_FAMILIES: AuditFamily[] = [
  {
    key: 'corrections',
    label: [AR.families.corrections, EN.families.corrections],
    tone: 'correction',
    match: (action) => action.startsWith('DATA_'),
  },
  {
    key: 'quality',
    label: [AR.families.quality, EN.families.quality],
    tone: 'review',
    match: (action) => action.startsWith('RECORD_') || action.startsWith('QUALITY_'),
  },
  {
    key: 'register',
    label: [AR.families.register, EN.families.register],
    tone: 'change',
    match: (action) =>
      action.startsWith('CITIZEN_') ||
      action.startsWith('REGISTRATION_') ||
      action.startsWith('LANDLORD_') ||
      action.startsWith('HOUSEHOLD_') ||
      action === 'TENANCY_ENDED' ||
      action === 'OWNERSHIP_ENDED' ||
      action === 'PROPERTY_NUMBER_CORRECTED' ||
      action === 'STATUS_CHANGE',
  },
  {
    key: 'census',
    label: [AR.families.census, EN.families.census],
    tone: 'change',
    match: (action) =>
      action.startsWith('BUILDING_') ||
      action.startsWith('UNIT_') ||
      action.startsWith('OCCUPANCY_') ||
      action.startsWith('CASE_'),
  },
  {
    key: 'money',
    label: [AR.families.money, EN.families.money],
    tone: 'money',
    match: (action) => action.startsWith('FEE_') || action.startsWith('PAYMENT_') || action.startsWith('BILL_') || action.includes('PAYOUT'),
  },
  {
    key: 'land',
    label: [AR.families.land, EN.families.land],
    tone: 'change',
    match: (action) => action.startsWith('ZONE_') || action === 'CADASTRE_IMPORT',
  },
  {
    key: 'access',
    label: [AR.families.access, EN.families.access],
    tone: 'access',
    match: () => true,
  },
];

export function auditFamilyOf(action: string): AuditFamily {
  return AUDIT_FAMILIES.find((family) => family.match(action))!;
}

/**
 * The colour an entry wears — what kind of act it was, not which screen made it.
 * A deletion is a deletion whether a building or a case was deleted.
 */
export function auditToneOf(action: string): AuditTone {
  // A session ended because its refresh token was presented twice — the one
  // entry in the access family that says something may have been stolen.
  if (action === 'STAFF_SESSION_REUSE_DETECTED') return 'remove';
  if (action === 'STAFF_LOGOUT') return 'access';
  if (action.startsWith('DATA_')) return 'correction';
  if (action.startsWith('RECORD_') || action.startsWith('QUALITY_')) return 'review';
  if (/DELETE|ENDED|DEACTIVATED|UNLINKED|DISMISSED|REJECTED|REMOVED|DISABLED|RESTORED$/.test(action)) {
    return action === 'LANDLORD_MATCH_RESTORED' ? 'change' : 'remove';
  }
  if (action.startsWith('FEE_') || action.startsWith('PAYMENT_') || action.startsWith('BILL_') || action.includes('PAYOUT')) return 'money';
  if (/LOGIN|TOTP|PASSWORD|EMAIL_CHANGED|DOCUMENT_VIEW|CSV_EXPORT|SETTINGS/.test(action)) return 'access';
  if (/CREATED|RECORDED|LOGGED|ADDED|LINKED|SUBMITTED|ISSUED|GENERATED|CONFIRMED|IMPORT/.test(action)) {
    return 'create';
  }
  return 'change';
}

export interface AuditChange {
  label: string;
  before: string;
  after: string;
}

export interface AuditFact {
  label: string;
  value: string;
}

export interface AuditDescription {
  /** Fields that moved, from what to what. */
  changes: AuditChange[];
  /** What the entry recorded that is not a before/after pair. */
  facts: AuditFact[];
  /** A sentence a person wrote: a correction note, a reason. */
  quotes: AuditFact[];
  /** Everything else, still readable, for «كل التفاصيل». */
  details: AuditFact[];
}

type Json = Record<string, unknown>;

const REDACTED = '[redacted]';

/** Keys that name rows rather than describe them — kept out of the sentence. */
const isIdKey = (key: string) => /^id$|Id$|Ids$|^subjectKey$/.test(key);

/** Structures too internal to read; summarised under «كل التفاصيل» only. */
const INTERNAL_KEYS = new Set(['footprint', 'snapshot', 'census', 'written', 'filter', 'release', 'fileLink', 'figure']);

/** Keys consumed by a special rule below, so the generic pass skips them. */
const SPECIAL_KEYS = new Set([
  'note',
  'reason',
  'duplicateReason',
  'noPinReason',
  'unitAreaNotMeasured',
  'unitStatusNotEstablished',
  'acknowledgedNeighbours',
  'duplicateReview',
  'heldAsPossibleDuplicateOf',
  'possibleDuplicateReviewed',
  'changedFields',
  'changed',
  'fields',
  'differences',
  'result',
  'matchedBy',
  'acknowledgedRepeat',
  'kind',
  'cards',
  'requestedBy',
  'reinspectAt',
]);

/**
 * Fields a citizen edit names but never values — `SENSITIVE_FILE_FIELDS` on the
 * server. Said as such, so «what was it?» is answered: it was never written.
 */
const SENSITIVE_FIELDS = new Set([
  'civilRecordNumber',
  'identityDocNumber',
  'residencyNumber',
  'residentStatus',
  'phone',
  'whatsapp',
  // «رقم للتواصل» — a relative's number, never written on the server either (0069).
  'contactPhone',
  'localContactPhone',
  'landlordPhone',
]);


export function describeAudit(entry: AuditEntry, locale: string): AuditDescription {
  const loc = localeOf(locale);
  const t = translators[loc];
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const names: Record<string, string> = (loc === 'en' ? EN : AR).fields;
  const separator = t('text.listSeparator');
  const before = asObject(entry.before);
  const after = asObject(entry.after);

  const labelOf = (key: string) =>
    names[key] ?? (labels.citizenField as Record<string, string>)[key] ?? humanize(key);

  const enumMaps: Record<string, Array<Record<string, string>>> = {
    unitStatus: [labels.unitStatus],
    afterStatus: [labels.unitStatus],
    surveyStatus: [labels.surveyStatus],
    outcome: [labels.surveyStatus],
    structureType: [labels.structureType],
    lifecycleStatus: [labels.buildingLifecycle],
    role: [labels.occupancyRole, labels.staffRole],
    status: [labels.citizenRecordStatus, labels.caseStatus],
    nextStatus: [labels.citizenRecordStatus],
    caseType: [labels.caseType],
    basis: [labels.vacancyBasis],
    ownerBillingMode: [labels.ownerBillingMode],
    residence: [labels.citizenResidence],
    documentType: [labels.documentType],
    method: [labels.paymentMethod],
    targetType: [labels.feeTargetType],
    unitType: [labels.unitType],
    propertyType: [labels.propertyType],
    maritalStatus: [labels.maritalStatus],
    gender: [labels.gender],
    /*
      The quality vocabularies. `RECORD_RETURNED` stores `fields: ['AREA', …]`
      and `QUALITY_CHECK_DONE` stores `result` and `differences` — codes, as
      they must be in an append-only row that outlives this UI. Untranslated
      they reach the screen as `AREA، UNIT_STATUS`, which is the register
      talking to itself in front of an auditor.
    */
    level: [labels.damageLevel],
    source: [labels.damageSource],
    fields: [quality.reviewField],
    differences: [quality.checkDifference],
    result: [quality.checkResult],
  };

  const format = (key: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (value === REDACTED) return t('text.redacted');
    if (typeof value === 'boolean') return value ? t('text.yes') : t('text.no');
    // Latin digits on the Arabic page too, as every figure on the portal is written.
    if (typeof value === 'number') return value.toLocaleString(FORMAT_LOCALE[loc]);
    if (typeof value === 'string') {
      for (const map of enumMaps[key] ?? []) {
        if (map[value]) return map[value]!;
      }
      const generic =
        (labels.occupancyEndReason as Record<string, string>)[value] ??
        (labels.vacancyEndReason as Record<string, string>)[value];
      if (generic) return generic;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return formatDateTime(value);
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '—';
      const shown = value.slice(0, 6).map((item) => (typeof item === 'object' ? summarize(item, t) : format(key, item)));
      return value.length > 6 ? `${shown.join(separator)} +${value.length - 6}` : shown.join(separator);
    }
    return summarize(value, t);
  };

  const result: AuditDescription = { changes: [], facts: [], quotes: [], details: [] };
  const seen = new Set<string>();

  // ── sentences somebody wrote ──
  const note = after?.note ?? before?.note;
  if (typeof note === 'string' && note) {
    result.quotes.push({ label: t('text.note'), value: note });
  }
  const reason = after?.reason ?? before?.reason;
  if (typeof reason === 'string' && reason) {
    const reasonLabel =
      entry.action === 'RECORD_RETURNED'
        ? t('text.whatToCorrect')
        : entry.action.startsWith('QUALITY_FINDING')
          ? t('text.whyNotAProblem')
          : t('text.reason');
    // An ending's reason is a code («سُجّل خطأً», «انتقال الملكية»); a person's is prose.
    result.quotes.push({ label: reasonLabel, value: format('reason', reason) });
  }
  /*
    Who asked for a citizen file to be archived — the citizen, a relative, the
    mukhtar (decision, 2026-10-05). Written by a person, so quoted as written.
  */
  const requestedBy = after?.requestedBy;
  if (typeof requestedBy === 'string' && requestedBy) {
    result.quotes.push({ label: t('text.requestedBy'), value: requestedBy });
  }
  if (typeof after?.duplicateReason === 'string' && after.duplicateReason) {
    result.quotes.push({
      label: t('text.whySeparateStructure'),
      value: after.duplicateReason,
    });
  }

  // ── recorded facts with their own wording ──
  const fact = (label: string, value: string | null | undefined) => {
    if (value) result.facts.push({ label, value });
  };
  if (typeof after?.noPinReason === 'string') {
    fact(t('text.noPinWhy'), after.noPinReason);
  }
  if (typeof after?.unitAreaNotMeasured === 'string') {
    fact(t('text.areaNotMeasuredWhy'), after.unitAreaNotMeasured);
  }
  if (typeof after?.unitStatusNotEstablished === 'string') {
    fact(t('text.occupantNotKnownWhy'), after.unitStatusNotEstablished);
  }
  if (Array.isArray(after?.acknowledgedNeighbours)) {
    fact(
      t('text.neighboursAcknowledged'),
      (after.acknowledgedNeighbours as Json[])
        .map((row) =>
          row.distanceMetres != null
            ? t('text.neighbourDistance', { code: String(row.code), metres: String(row.distanceMetres) })
            : String(row.code),
        )
        .join(separator),
    );
  }
  const review = asObject(after?.duplicateReview);
  if (review) {
    fact(t('text.differentPersonFrom'), listOf(review.differentFrom, separator));
    fact(t('text.sharesPhoneWith'), listOf(review.sharedPhoneWith, separator));
    if (review.sharedPhoneWithLandlord === true) {
      fact(t('text.sharesPhoneWithLandlord'), t('text.yes'));
    }
    if (typeof review.reason === 'string') {
      result.quotes.push({ label: t('text.howOfficerKnew'), value: review.reason });
    }
  }
  fact(t('text.heldAsDuplicateOf'), listOf(after?.heldAsPossibleDuplicateOf, separator));
  const reviewed = asObject(after?.possibleDuplicateReviewed);
  if (reviewed) {
    fact(t('text.resolvedNote'), typeof reviewed.was === 'string' ? reviewed.was : null);
    if (typeof reviewed.reason === 'string') {
      result.quotes.push({ label: t('text.whyDifferentPerson'), value: reviewed.reason });
    }
  }
  if (Array.isArray(after?.fields)) {
    fact(
      t('text.partsToCorrect'),
      (after.fields as string[]).map((code) => quality.reviewField[code as never] ?? code).join(separator),
    );
  }
  if (after?.result === 'MATCHES' || after?.result === 'DIFFERS') {
    fact(
      t('text.recheckResult'),
      after.result === 'MATCHES' ? t('text.recheckMatches') : t('text.recheckDiffers'),
    );
  }
  if (Array.isArray(after?.differences) && (after.differences as string[]).length) {
    fact(
      t('text.foundDifferent'),
      (after.differences as string[]).map((code) => quality.checkDifference[code as never] ?? code).join(separator),
    );
  }
  if (after?.matchedBy === 'NAME') fact(t('text.matched'), t('text.matchedByName'));
  if (after?.matchedBy === 'PROPERTY') fact(t('text.matched'), t('text.matchedByProperty'));
  // The card's number was the owner's «رقم للتواصل» — a relative's, recorded because they have no phone.
  if (after?.matchedBy === 'CONTACT') fact(t('text.matched'), t('text.matchedByContact'));
  if (after?.acknowledgedRepeat === true) {
    fact(t('text.secondVisitToday'), t('text.confirmedByOfficer'));
  }
  const kind = after?.kind ?? before?.kind;
  if (typeof kind === 'string' && entry.action.startsWith('QUALITY_FINDING')) {
    fact(t('text.finding'), quality.findingKind[kind as never] ?? kind);
  }
  /*
    A planned day, `YYYY-MM-DD` or midnight UTC: the calendar day the inspector
    picked, never a moment — read as a timestamp it would print a time of day,
    and in Beirut the evening before.
  */
  const reinspectAt = after?.reinspectAt;
  if (typeof reinspectAt === 'string' && reinspectAt) {
    fact(t('text.reinspectAt'), formatDate(`${calendarDayOf(reinspectAt)}T12:00:00.000Z`));
  }
  /*
    `changed` names every field a save moved. The ones whose values the entry
    also holds are listed below as before → after, so only the rest are named
    here — and a sensitive one is said to be sensitive, because «what was it?»
    is the next question and the answer is that it was never written down.
  */
  const changedNames = after?.changed;
  if (Array.isArray(changedNames) && changedNames.length) {
    const valued = (key: string) => Boolean((before && key in before) || (after && key in after));
    const unvalued = (changedNames as string[]).filter((key) => !valued(key));
    const sensitive = unvalued.filter((key) => SENSITIVE_FIELDS.has(key));
    const plain = unvalued.filter((key) => !SENSITIVE_FIELDS.has(key));
    if (plain.length) fact(t('text.fieldsChanged'), plain.map(labelOf).join(separator));
    if (sensitive.length) fact(t('text.changedValueNotKept'), sensitive.map(labelOf).join(separator));
  }

  // ── a citizen's cards, one line per change ──
  if (Array.isArray(after?.cards)) {
    for (const card of after.cards as Json[]) {
      const name = [
        typeof card.propertyType === 'string' ? format('propertyType', card.propertyType) : null,
        card.propertyNumber ? t('text.parcel', { number: String(card.propertyNumber) }) : null,
        typeof card.occupancyType === 'string'
          ? ((labels.occupancyType as Record<string, string>)[card.occupancyType] ?? card.occupancyType)
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const cardLabel = t('text.card', { name });
      if (card.kind === 'added') fact(t('text.cardAdded'), name);
      if (card.kind === 'removed') fact(t('text.cardRemoved'), name);
      for (const field of (Array.isArray(card.fields) ? card.fields : []) as Json[]) {
        const key = String(field.field);
        result.changes.push({
          label: `${cardLabel} — ${labelOf(key)}`,
          before: format(key, field.before),
          after: format(key, field.after),
        });
      }
      if (Array.isArray(card.sensitive) && card.sensitive.length) {
        fact(t('text.cardChangedValueNotKept', { card: cardLabel }), (card.sensitive as string[]).map(labelOf).join(separator));
      }
      const rows = asObject(card.rows);
      if (rows) {
        const parts = [
          Number(rows.added) ? t('text.rowsAdded', { count: String(rows.added) }) : null,
          Number(rows.removed) ? t('text.rowsRemoved', { count: String(rows.removed) }) : null,
          Number(rows.changed) ? t('text.rowsChanged', { count: String(rows.changed) }) : null,
        ].filter(Boolean);
        if (parts.length) fact(t('text.cardUnits', { card: cardLabel }), parts.join(separator));
      }
    }
  }

  // ── before → after, and what only one side holds ──
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  for (const key of keys) {
    if (SPECIAL_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    const b = before?.[key];
    const a = after?.[key];
    const inBoth = before !== null && after !== null && key in (before ?? {}) && key in (after ?? {});

    if (isIdKey(key) || INTERNAL_KEYS.has(key)) {
      result.details.push({ label: labelOf(key), value: format(key, a ?? b) });
      continue;
    }
    if (inBoth) {
      if (JSON.stringify(b) === JSON.stringify(a)) {
        result.details.push({ label: labelOf(key), value: format(key, a) });
      } else {
        result.changes.push({ label: labelOf(key), before: format(key, b), after: format(key, a) });
      }
      continue;
    }
    const value = key in (after ?? {}) ? a : b;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.details.push({ label: labelOf(key), value: format(key, value) });
    } else {
      result.facts.push({ label: labelOf(key), value: format(key, value) });
    }
  }

  return result;
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function listOf(value: unknown, separator: string): string | null {
  return Array.isArray(value) && value.length ? (value as unknown[]).map(String).join(separator) : null;
}

function summarize(value: unknown, t: AuditTranslator): string {
  if (!value || typeof value !== 'object') return String(value ?? '—');
  return t('text.recordedFields', { count: String(Object.keys(value as Json).length) });
}

/** `unitLinksCleared` → «unit links cleared» — a readable last resort for a key with no label yet. */
function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}
