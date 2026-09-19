import { getLabels, qualityLabels } from '@mechanization/shared-schemas';
import type { AuditEntry } from './api-client';
import { formatDateTime } from './dates';

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
    label: ['التصحيحات اليدوية', 'Manual corrections'],
    tone: 'correction',
    match: (action) => action.startsWith('DATA_'),
  },
  {
    key: 'quality',
    label: ['مراجعة الجودة', 'Quality review'],
    tone: 'review',
    match: (action) => action.startsWith('RECORD_') || action.startsWith('QUALITY_'),
  },
  {
    key: 'register',
    label: ['السجل والمواطنون', 'Register & citizens'],
    tone: 'change',
    match: (action) =>
      action.startsWith('CITIZEN_') ||
      action.startsWith('REGISTRATION_') ||
      action.startsWith('LANDLORD_') ||
      action.startsWith('HOUSEHOLD_') ||
      action === 'TENANCY_ENDED' ||
      action === 'STATUS_CHANGE',
  },
  {
    key: 'census',
    label: ['المباني والوحدات والحالات', 'Buildings, units & cases'],
    tone: 'change',
    match: (action) =>
      action.startsWith('BUILDING_') ||
      action.startsWith('UNIT_') ||
      action.startsWith('OCCUPANCY_') ||
      action.startsWith('CASE_'),
  },
  {
    key: 'money',
    label: ['الرسوم والدفعات', 'Fees & payments'],
    tone: 'money',
    match: (action) => action.startsWith('FEE_') || action.startsWith('PAYMENT_') || action.includes('PAYOUT'),
  },
  {
    key: 'land',
    label: ['القطاعات والمسح', 'Sectors & cadastre'],
    tone: 'change',
    match: (action) => action.startsWith('ZONE_') || action === 'CADASTRE_IMPORT',
  },
  {
    key: 'access',
    label: ['الحسابات والأمان والنظام', 'Accounts, security & system'],
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
  if (action.startsWith('DATA_')) return 'correction';
  if (action.startsWith('RECORD_') || action.startsWith('QUALITY_')) return 'review';
  if (/DELETE|ENDED|DEACTIVATED|UNLINKED|DISMISSED|REJECTED|REMOVED|DISABLED|RESTORED$/.test(action)) {
    return action === 'LANDLORD_MATCH_RESTORED' ? 'change' : 'remove';
  }
  if (action.startsWith('FEE_') || action.startsWith('PAYMENT_') || action.includes('PAYOUT')) return 'money';
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
const INTERNAL_KEYS = new Set(['footprint', 'snapshot', 'census', 'written', 'filter', 'release', 'fileLink']);

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
]);

function fieldLabels(en: boolean): Record<string, string> {
  const pairs: Record<string, [string, string]> = {
    name: ['الاسم', 'Name'],
    code: ['الرمز', 'Code'],
    title: ['العنوان', 'Title'],
    email: ['البريد الإلكتروني', 'Email'],
    role: ['الصفة', 'Role'],
    status: ['الحالة', 'Status'],
    nextStatus: ['حالة السجل بعد الحفظ', 'Record status after save'],
    afterStatus: ['الحالة بعدها', 'Status after'],
    unitStatus: ['حالة الوحدة', 'Unit status'],
    surveyStatus: ['حالة المسح', 'Survey status'],
    outcome: ['النتيجة', 'Outcome'],
    structureType: ['نوع المنشأة', 'Structure type'],
    lifecycleStatus: ['وضع المنشأة', 'Lifecycle'],
    postedNumber: ['الرقم المكتوب على المبنى', 'Posted number'],
    isPartitioned: ['مفروزة', 'Partitioned'],
    partitionNumbers: ['أرقام الأقسام', 'Partition numbers'],
    sharedParcelNumbers: ['العقارات المشتركة', 'Shared parcels'],
    latitude: ['خط العرض', 'Latitude'],
    longitude: ['خط الطول', 'Longitude'],
    floorsCount: ['عدد الطوابق', 'Floors'],
    basementsCount: ['عدد الطوابق السفلية', 'Basements'],
    notes: ['الملاحظات', 'Notes'],
    parcelNumber: ['رقم العقار', 'Parcel'],
    propertyNumber: ['رقم العقار', 'Parcel'],
    parcelCount: ['عدد العقارات', 'Parcels'],
    unitCode: ['الوحدة', 'Unit'],
    unitCodes: ['الوحدات', 'Units'],
    unitArea: ['مساحة الوحدة (م²)', 'Unit area (m²)'],
    floor: ['الطابق', 'Floor'],
    sequence: ['الترتيب', 'Sequence'],
    units: ['الوحدات', 'Units'],
    total: ['المجموع', 'Total'],
    skipped: ['المتروك', 'Skipped'],
    referenceNumber: ['الرقم المرجعي', 'Reference'],
    keptReference: ['الرقم المرجعي المُبقى', 'Kept reference'],
    removedReference: ['الرقم المرجعي المحذوف', 'Removed reference'],
    propertyCount: ['عدد العقارات', 'Properties'],
    propertiesRemoved: ['عقارات حُذفت من الملف', 'Properties removed'],
    unestablishedFields: ['حقول غير مؤكَّدة', 'Unverified fields'],
    residence: ['نوع الملف', 'File type'],
    identity: ['رقم الوثيقة', 'Document number'],
    casesResolved: ['حالات أُغلقت', 'Cases closed'],
    toDate: ['تاريخ الانتهاء', 'End date'],
    endedAt: ['انتهى في', 'Ended at'],
    observedAt: ['تاريخ المعاينة', 'Observed on'],
    basis: ['الأساس', 'Basis'],
    attempts: ['عدد المحاولات', 'Attempts'],
    visitCount: ['عدد الزيارات', 'Visits'],
    vacancyStands: ['الشغور المؤكَّد باقٍ', 'Vacancy stands'],
    via: ['عبر', 'Via'],
    unitsClaimed: ['وحدات أُضيفت للمالك', 'Units put on the owner'],
    occupanciesRecorded: ['إشغالات سُجِّلت', 'Occupancies recorded'],
    occupanciesEnded: ['إشغالات أُنهيت', 'Occupancies ended'],
    rowsAdded: ['أسطر أُضيفت', 'Rows added'],
    cardsCreated: ['بطاقات أُنشئت', 'Cards created'],
    cardsEnded: ['بطاقات أُنهيت', 'Cards ended'],
    recordedAfterTenant: ['سُجِّل المالك بعد المستأجر', 'Owner recorded after tenant'],
    split: ['نُقلت الوحدة إلى بطاقة مستقلة', 'Moved onto its own card'],
    kept: ['أُبقي', 'Kept'],
    documentType: ['نوع المرفق', 'Document type'],
    parcelsImported: ['عقارات استوردت', 'Parcels imported'],
    parcelsSkipped: ['عقارات تُركت', 'Parcels skipped'],
    linesImported: ['خطوط استوردت', 'Lines imported'],
    amount: ['المبلغ', 'Amount'],
    targetType: ['الجهة المستهدفة', 'Target'],
    issuedCount: ['عدد الإشعارات', 'Notices issued'],
    periodKey: ['الفترة', 'Period'],
    confirmed: ['مؤكَّدة', 'Confirmed'],
    method: ['طريقة الدفع', 'Method'],
    snapshotCreatedAt: ['تاريخ النسخة الاحتياطية', 'Snapshot date'],
    rowCount: ['عدد الصفوف', 'Rows'],
    provisionalSuffix: ['الحرف المؤقت', 'Provisional suffix'],
    from: ['من', 'From'],
    to: ['إلى', 'To'],
    percent: ['النسبة ٪', 'Percent'],
    sampled: ['سُحب للتحقق', 'Sampled'],
    officers: ['عدد الموظفين', 'Officers'],
    parcels: ['العقارات', 'Parcels'],
    created: ['أُنشئ', 'Created'],
  };
  return Object.fromEntries(Object.entries(pairs).map(([key, [ar, enLabel]]) => [key, en ? enLabel : ar]));
}

export function describeAudit(entry: AuditEntry, locale: string): AuditDescription {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const names = fieldLabels(en);
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
    fields: [quality.reviewField],
    differences: [quality.checkDifference],
    result: [quality.checkResult],
  };

  const format = (key: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (value === REDACTED) return en ? 'hidden to protect personal data' : 'مخفي لحماية البيانات';
    if (typeof value === 'boolean') return value ? (en ? 'Yes' : 'نعم') : en ? 'No' : 'لا';
    if (typeof value === 'number') return value.toLocaleString(en ? 'en' : 'ar');
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
      const shown = value.slice(0, 6).map((item) => (typeof item === 'object' ? summarize(item, en) : format(key, item)));
      return value.length > 6 ? `${shown.join('، ')} +${value.length - 6}` : shown.join('، ');
    }
    return summarize(value, en);
  };

  const result: AuditDescription = { changes: [], facts: [], quotes: [], details: [] };
  const seen = new Set<string>();

  // ── sentences somebody wrote ──
  const note = after?.note ?? before?.note;
  if (typeof note === 'string' && note) {
    result.quotes.push({ label: en ? 'Note' : 'ملاحظة', value: note });
  }
  const reason = after?.reason ?? before?.reason;
  if (typeof reason === 'string' && reason) {
    const reasonLabel =
      entry.action === 'RECORD_RETURNED'
        ? en ? 'What to correct' : 'المطلوب تصحيحه'
        : entry.action.startsWith('QUALITY_FINDING')
          ? en ? 'Why it is not a problem' : 'سبب اعتبارها ليست مشكلة'
          : en ? 'Reason' : 'السبب';
    result.quotes.push({ label: reasonLabel, value: reason });
  }
  if (typeof after?.duplicateReason === 'string' && after.duplicateReason) {
    result.quotes.push({
      label: en ? 'Why it is a separate structure' : 'لماذا هي منشأة منفصلة',
      value: after.duplicateReason,
    });
  }

  // ── recorded facts with their own wording ──
  const fact = (label: string, value: string | null | undefined) => {
    if (value) result.facts.push({ label, value });
  };
  if (typeof after?.noPinReason === 'string') {
    fact(en ? 'No entrance pin — why' : 'بلا دبوس مدخل — السبب', after.noPinReason);
  }
  if (typeof after?.unitAreaNotMeasured === 'string') {
    fact(en ? 'Area not measured — why' : 'المساحة غير مُقاسة — السبب', after.unitAreaNotMeasured);
  }
  if (typeof after?.unitStatusNotEstablished === 'string') {
    fact(en ? 'Occupant not known — why' : 'لم يُعرف من يشغلها — السبب', after.unitStatusNotEstablished);
  }
  if (Array.isArray(after?.acknowledgedNeighbours)) {
    fact(
      en ? 'Structures already on the parcel' : 'منشآت قائمة على العقار أُقرَّ بها',
      (after.acknowledgedNeighbours as Json[])
        .map((row) =>
          row.distanceMetres != null
            ? `${String(row.code)} (${en ? `${row.distanceMetres} m` : `على بُعد ${row.distanceMetres} م`})`
            : String(row.code),
        )
        .join('، '),
    );
  }
  const review = asObject(after?.duplicateReview);
  if (review) {
    fact(en ? 'Confirmed a different person from' : 'أُكِّد أنه شخص مختلف عن', listOf(review.differentFrom));
    fact(en ? 'Confirmed sharing a phone with' : 'أُكِّد أنه يتشارك الهاتف مع', listOf(review.sharedPhoneWith));
    if (review.sharedPhoneWithLandlord === true) {
      fact(en ? 'Shares a phone with the landlord' : 'يتشارك الهاتف مع المالك', en ? 'Yes' : 'نعم');
    }
    if (typeof review.reason === 'string') {
      result.quotes.push({ label: en ? 'How the officer knew' : 'كيف تحقَّق الموظف', value: review.reason });
    }
  }
  fact(en ? 'Held for review — may already be' : 'مُعلَّق للمراجعة — قد يكون', listOf(after?.heldAsPossibleDuplicateOf));
  const reviewed = asObject(after?.possibleDuplicateReviewed);
  if (reviewed) {
    fact(en ? 'Resolved note' : 'التنبيه الذي حُلّ', typeof reviewed.was === 'string' ? reviewed.was : null);
    if (typeof reviewed.reason === 'string') {
      result.quotes.push({ label: en ? 'Why it is a different person' : 'لماذا هو شخص مختلف', value: reviewed.reason });
    }
  }
  if (Array.isArray(after?.fields)) {
    fact(
      en ? 'Parts to correct' : 'أجزاء تحتاج تصحيحاً',
      (after.fields as string[]).map((code) => quality.reviewField[code as never] ?? code).join('، '),
    );
  }
  if (after?.result === 'MATCHES' || after?.result === 'DIFFERS') {
    fact(
      en ? 'Re-check result' : 'نتيجة التحقق',
      after.result === 'MATCHES' ? (en ? 'Matches the record' : 'مطابق للسجل') : en ? 'Differs' : 'مختلف عن السجل',
    );
  }
  if (Array.isArray(after?.differences) && (after.differences as string[]).length) {
    fact(
      en ? 'Found different' : 'ما وُجد مختلفاً',
      (after.differences as string[]).map((code) => quality.checkDifference[code as never] ?? code).join('، '),
    );
  }
  if (after?.matchedBy === 'NAME') {
    fact(en ? 'Matched' : 'طريقة المطابقة', en ? 'By name only' : 'بالاسم فقط');
  }
  if (after?.acknowledgedRepeat === true) {
    fact(en ? 'Second visit today' : 'زيارة ثانية في اليوم نفسه', en ? 'Confirmed by the officer' : 'أكَّدها الموظف');
  }
  const kind = after?.kind ?? before?.kind;
  if (typeof kind === 'string' && entry.action.startsWith('QUALITY_FINDING')) {
    fact(en ? 'Finding' : 'الملاحظة', quality.findingKind[kind as never] ?? kind);
  }
  const changedNames = after?.changed;
  if (Array.isArray(changedNames) && changedNames.length) {
    fact(en ? 'Fields changed' : 'الحقول المعدَّلة', (changedNames as string[]).map(labelOf).join('، '));
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

function listOf(value: unknown): string | null {
  return Array.isArray(value) && value.length ? (value as unknown[]).map(String).join('، ') : null;
}

function summarize(value: unknown, en: boolean): string {
  if (!value || typeof value !== 'object') return String(value ?? '—');
  const count = Object.keys(value as Json).length;
  return en ? `${count} recorded field(s)` : `${count} حقلاً مسجَّلاً`;
}

/** `unitLinksCleared` → «unit links cleared» — a readable last resort for a key with no label yet. */
function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}
