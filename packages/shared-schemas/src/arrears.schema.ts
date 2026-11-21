import { z } from 'zod';
import { ar } from './labels';
import { normalizeArabic } from './citizen-import.schema';
import {
  arrearsComponentSchema,
  type ArrearsBatchStatus,
  type ArrearsComponent,
  type ArrearsLineDecision,
} from './enums';
import { hasAtMostTwoDecimals } from './money-amount';
import { businessDay, isCalendarDay, normalizeDigits, uuid } from './primitives';
import { typeError } from './type-error';

/**
 * Old debts, «متأخرات سنوات سابقة» (migrations 0107/0108): what citizens owe
 * from the municipality's old books, brought in as batches the accountant
 * prepares and the manager approves. The plan, the fourteen decisions and the
 * flow are docs/old-debts-plan.md; this file is the API contract both apps
 * build against.
 *
 * The flow, in routes (task 4 and 5):
 *   export   → a DRAFT batch, its citizen set, and the template's rows
 *   import   → the dry run's verdicts, or the draft's lines replaced
 *   submit   → SUBMITTED, with the control total
 *   approve / return / discard
 *   link     → a «للمطابقة» line onto a citizen file, and its bill
 */

// ─────────────────────────────  vocabulary  ─────────────────────────────

/**
 * The fee a line is for. Provisional, from Law 60/1988 and the fees this repo
 * already describes, until the municipality's accountant gives the list its
 * books use (open-decisions §23.1). `arrears_lines.feeType` is text, so the
 * final list needs no migration. `OTHER` carries a description
 * (`feeTypeNote`, CHECK `arrears_lines_other_fee_note`).
 */
export const ARREARS_FEE_TYPE = [
  'RENTAL_VALUE',
  'SEWER_SIDEWALK_MAINTENANCE',
  'SEWER_SIDEWALK_CONSTRUCTION',
  'CLEANING',
  'OTHER',
] as const;
export const arrearsFeeTypeSchema = z.enum(ARREARS_FEE_TYPE, { error: 'اختر نوع الرسم' });
export type ArrearsFeeType = z.infer<typeof arrearsFeeTypeSchema>;

/** Decision 14: a debt older than this many years is dropped («مرور الزمن»). */
export const ARREARS_PRESCRIPTION_YEARS = 5;

/** Old debts are LBP at face value (decision 13). */
export const ARREARS_CURRENCY = 'LBP';

/** The most citizens one template is exported for. */
export const ARREARS_EXPORT_MAX_CITIZENS = 200;

/** The most rows one import takes: a batch is imported whole, so this bounds the file. */
export const ARREARS_IMPORT_MAX_ROWS = 2000;

/** The most one line may carry: `arrears_lines.amount` is `DECIMAL(14,2)`. */
export const ARREARS_AMOUNT_MAX = 999_999_999_999.99;

/** Free text on a line or a batch. */
export const ARREARS_TEXT_MAX = 500;

/** The oldest year a line may name (CHECK `arrears_lines_year_range`). */
export const ARREARS_YEAR_MIN = 1900;

// ──────────────────────────────  template  ──────────────────────────────

/**
 * The template's columns, in order. One list drives the export, the header
 * matcher and the on-screen reference, as `IMPORT_COLUMNS` does for the citizen
 * import.
 *
 * **Never in the file:** a رقم مرجعي, a phone, an ID number, a residency status,
 * or a citizen's id. docs/security.md treats an export carrying a رقم مرجعي as a
 * credential dump; `rowKey` is a small number that means something only inside
 * its batch.
 */
export const ARREARS_TEMPLATE_COLUMN_KEYS = [
  'rowKey',
  'fullName',
  'propertyNumber',
  'unitCode',
  'year',
  'feeType',
  'feeTypeNote',
  'principal',
  'penalty',
  'oldReference',
  'dueDate',
  'note',
] as const;
export type ArrearsTemplateColumnKey = (typeof ARREARS_TEMPLATE_COLUMN_KEYS)[number];

export interface ArrearsTemplateColumn {
  key: ArrearsTemplateColumnKey;
  /** The Arabic header in the template's first row. */
  header: string;
  /** Shown in the column reference. */
  hint: string;
  /** Who fills it: the export, or the accountant from the old books. */
  filledBy: 'EXPORT' | 'ACCOUNTANT';
}

export const ARREARS_TEMPLATE_COLUMNS: readonly ArrearsTemplateColumn[] = [
  { key: 'rowKey', header: 'رقم السطر', hint: 'لا تغيّره. فارغ لشخص غير موجود في القالب', filledBy: 'EXPORT' },
  { key: 'fullName', header: 'الاسم الكامل', hint: 'كما في الدفتر لشخص غير موجود في القالب', filledBy: 'EXPORT' },
  { key: 'propertyNumber', header: 'رقم العقار', hint: 'إلزامي', filledBy: 'EXPORT' },
  { key: 'unitCode', header: 'رمز الوحدة', hint: 'اختياري', filledBy: 'EXPORT' },
  { key: 'year', header: 'السنة', hint: 'سنة الدين، قبل سنة بدء الفوترة', filledBy: 'ACCOUNTANT' },
  {
    key: 'feeType',
    header: 'نوع الرسم',
    hint: ARREARS_FEE_TYPE.map((code) => ar.arrearsFeeType[code]).join(' / '),
    filledBy: 'ACCOUNTANT',
  },
  { key: 'feeTypeNote', header: 'وصف الرسم الآخر', hint: 'إلزامي إذا كان النوع «رسم آخر»', filledBy: 'ACCOUNTANT' },
  { key: 'principal', header: 'الأصل (ل.ل)', hint: 'المبلغ المستحق من الرسم', filledBy: 'ACCOUNTANT' },
  { key: 'penalty', header: 'الغرامة (ل.ل)', hint: 'كما في الدفتر فقط، لا تُحتسب', filledBy: 'ACCOUNTANT' },
  { key: 'oldReference', header: 'المرجع في الدفتر', hint: 'رقم الصفحة أو الإيصال', filledBy: 'ACCOUNTANT' },
  { key: 'dueDate', header: 'تاريخ الاستحقاق', hint: 'اختياري، YYYY-MM-DD أو DD/MM/YYYY', filledBy: 'ACCOUNTANT' },
  { key: 'note', header: 'ملاحظة', hint: 'اختياري', filledBy: 'ACCOUNTANT' },
];

/** Header → key, for whatever order the accountant's file comes back in. */
export const ARREARS_HEADER_TO_KEY: Readonly<Record<string, ArrearsTemplateColumnKey>> = Object.fromEntries(
  ARREARS_TEMPLATE_COLUMNS.map((column) => [column.header, column.key]),
);

/** One row of the file, as the browser read it: cells by column key, as typed. */
export type ArrearsTemplateCells = Partial<Record<ArrearsTemplateColumnKey, string>>;

/** One row the export hands the browser to write. */
export interface ArrearsTemplateRow {
  rowKey: number;
  fullName: string;
  propertyNumber: string | null;
  unitCode: string | null;
}

// ──────────────────────────────  requests  ──────────────────────────────

const text = (max = ARREARS_TEXT_MAX) => z.string().trim().min(1).max(max);

/**
 * «تصدير قالب»: the next `count` citizens of one zone or one building who are in
 * no batch that is not DISCARDED. The retry key answers a retry with the batch
 * the first press made (`ARREARS_EXPORT_REQUEST_REUSED` for a key sent with
 * another zone, building or count).
 */
export const exportArrearsTemplateSchema = z
  .object({
    zoneId: uuid.optional(),
    buildingId: uuid.optional(),
    count: z
      .number(typeError({ required: 'اكتب عدد المواطنين', invalid: 'العدد رقم' }))
      .int('العدد رقم صحيح')
      .min(1, 'مواطن واحد على الأقل')
      .max(ARREARS_EXPORT_MAX_CITIZENS, `${ARREARS_EXPORT_MAX_CITIZENS} مواطناً على الأكثر`),
    sourceNote: text().optional(),
    clientRequestId: uuid,
  })
  .refine((value) => (value.zoneId ? 1 : 0) + (value.buildingId ? 1 : 0) === 1, {
    message: 'اختر منطقة أو مبنى، واحداً فقط',
    path: ['zoneId'],
  });
export type ExportArrearsTemplateInput = z.infer<typeof exportArrearsTemplateSchema>;

export interface ArrearsExportResult {
  batchId: string;
  /** True when the key answered a retry with the batch an earlier press made. */
  replayed: boolean;
  /** How many citizens the batch's set holds. */
  citizenCount: number;
  rows: ArrearsTemplateRow[];
}

/** A line the accountant drops on the preview, by its file row and component. */
export const arrearsLineDropSchema = z.object({
  row: z.number().int().min(1),
  component: arrearsComponentSchema,
  reason: text().min(3, 'اكتب سبب الإسقاط'),
});
export type ArrearsLineDrop = z.infer<typeof arrearsLineDropSchema>;

/**
 * The filled template, imported into a DRAFT batch. `dryRun` only checks; the
 * same call without it runs the same checks and replaces the draft's lines with
 * the file's, refused whole while any row is refused
 * (`ARREARS_IMPORT_HAS_REFUSED_ROWS`).
 */
export const importArrearsSchema = z.object({
  rows: z
    .array(z.partialRecord(z.enum(ARREARS_TEMPLATE_COLUMN_KEYS), z.string()))
    .min(1, 'الملف لا يحتوي على أي صف')
    .max(ARREARS_IMPORT_MAX_ROWS, 'عدد الصفوف كبير جداً'),
  /** Row number of `rows[0]` in the accountant's file, header excluded. */
  startRow: z.number().int().min(1).default(1),
  /** The lines the accountant drops (a war-damaged unit, say), each with its reason. */
  drops: z.array(arrearsLineDropSchema).max(ARREARS_IMPORT_MAX_ROWS * 2).default([]),
  dryRun: z.boolean().default(false),
});
export type ImportArrearsInput = z.infer<typeof importArrearsSchema>;

/** «إرسال للاعتماد»: the hand-added total of the pages copied. */
export const submitArrearsBatchSchema = z.object({
  controlTotal: z
    .number(typeError({ required: 'اكتب مجموع الصفحات', invalid: 'المجموع رقم' }))
    .min(0, 'المجموع لا يكون سالباً')
    .max(ARREARS_AMOUNT_MAX)
    .refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر'),
  sourceNote: text().optional(),
});
export type SubmitArrearsBatchInput = z.infer<typeof submitArrearsBatchSchema>;

/** The manager approves a submitted batch: the bills are raised then. */
export const approveArrearsBatchSchema = z.object({}).strict();
export type ApproveArrearsBatchInput = z.infer<typeof approveArrearsBatchSchema>;

/** Sent back to the accountant as a DRAFT, with what to fix. */
export const returnArrearsBatchSchema = z.object({ note: text().min(3, 'اكتب ما يجب تصحيحه') });
export type ReturnArrearsBatchInput = z.infer<typeof returnArrearsBatchSchema>;

/** Discarded: its lines leave the one-live-line rule and its citizens can be exported again. */
export const discardArrearsBatchSchema = z.object({ reason: text().min(3, 'اكتب سبب الإلغاء') });
export type DiscardArrearsBatchInput = z.infer<typeof discardArrearsBatchSchema>;

/**
 * One line found later, entered by hand. It becomes a one-line batch through the
 * same checks and the same approval. A citizen's file, or the name as the books
 * wrote it («للمطابقة»).
 */
export const arrearsSingleLineSchema = z
  .object({
    citizenId: uuid.optional(),
    sourceName: text(200).optional(),
    propertyNumber: text(50).transform((value) => normalizeDigits(value)),
    unitCode: text(50).optional(),
    year: z.number(typeError({ required: 'اكتب السنة', invalid: 'السنة رقم' })).int().min(ARREARS_YEAR_MIN).max(2100),
    feeType: arrearsFeeTypeSchema,
    feeTypeNote: text(200).optional(),
    component: arrearsComponentSchema,
    amount: z
      .number(typeError({ required: 'اكتب المبلغ', invalid: 'المبلغ رقم' }))
      .positive('المبلغ أكبر من صفر')
      .max(ARREARS_AMOUNT_MAX, 'المبلغ كبير جداً')
      .refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر'),
    currency: z.literal(ARREARS_CURRENCY, { error: 'الديون القديمة بالليرة اللبنانية فقط' }).default(ARREARS_CURRENCY),
    dueDate: businessDay.optional(),
    oldReference: text(200).optional(),
    note: text().optional(),
    clientRequestId: uuid,
  })
  .superRefine((value, ctx) => {
    if (!value.citizenId && !value.sourceName) {
      ctx.addIssue({ code: 'custom', path: ['citizenId'], message: 'اختر ملف المواطن أو اكتب الاسم كما في الدفتر' });
    }
    if (value.citizenId && value.sourceName) {
      ctx.addIssue({ code: 'custom', path: ['sourceName'], message: 'الاسم للسطر الذي لا ملف له فقط' });
    }
    if (value.feeType === 'OTHER' && !value.feeTypeNote) {
      ctx.addIssue({ code: 'custom', path: ['feeTypeNote'], message: 'اكتب وصف الرسم' });
    }
  });
export type ArrearsSingleLineInput = z.infer<typeof arrearsSingleLineSchema>;

/** A «للمطابقة» line of an approved batch, linked to a citizen file: its bill is raised then. */
export const linkArrearsLineSchema = z.object({ citizenId: uuid });
export type LinkArrearsLineInput = z.infer<typeof linkArrearsLineSchema>;

/**
 * «شطب»: what is left on a bill is written off on a council decision (decision
 * 10). The amount is not sent: it is what is left when the server looks, which
 * the database holds it to (`paidAmount + writeOffAmount = amount`).
 */
export const writeOffBillSchema = z.object({
  reason: text().min(3, 'اكتب سبب الشطب'),
  decisionRef: text(100),
  decisionDate: businessDay,
});
export type WriteOffBillInput = z.infer<typeof writeOffBillSchema>;

/** The cutoff: old debt is a year before this one. `null` clears it, and every import is refused. */
export const arrearsCutoffSchema = z.object({
  arrearsCutoffYear: z.number().int().min(2000).max(2100).nullable(),
});
export type ArrearsCutoffInput = z.infer<typeof arrearsCutoffSchema>;

/** The old books' arrears total for one year (open-decisions §23.4, undecided). */
export const arrearsControlTotalSchema = z.object({
  year: z.number().int().min(ARREARS_YEAR_MIN).max(2100),
  amount: z.number().min(0).max(ARREARS_AMOUNT_MAX).refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر'),
});
export type ArrearsControlTotalInput = z.infer<typeof arrearsControlTotalSchema>;

// ──────────────────────────────  the dry run  ──────────────────────────────

/**
 * Why a row or a line is refused, or what the preview notes on it. Codes, so the
 * screen owns the words (messages `arrears.issue.*`, task 7).
 */
export const ARREARS_LINE_ISSUE = [
  // A cell the parser cannot read.
  'YEAR_INVALID',
  'FEE_TYPE_UNKNOWN',
  'FEE_TYPE_NOTE_REQUIRED',
  'AMOUNT_INVALID',
  'DUE_DATE_INVALID',
  'ROW_KEY_INVALID',
  'PROPERTY_NUMBER_REQUIRED',
  // A year or a fee type with no amount, or an amount with no year.
  'AMOUNT_REQUIRED',
  'YEAR_REQUIRED',
  'FEE_TYPE_REQUIRED',
  // A row with no row key and no name.
  'NAME_REQUIRED',
  // Against the register and the settings.
  'CUTOFF_NOT_SET',
  'YEAR_NOT_BEFORE_CUTOFF',
  'ROW_KEY_NOT_IN_BATCH',
  'CITIZEN_MERGED_AWAY',
  'UNIT_NOT_ON_PROPERTY',
  'DUPLICATE_IN_FILE',
  'DUPLICATE_LIVE_LINE',
  'DROP_NOT_A_LINE',
  // At approval: a kept line is older than the prescription period now (decision 14).
  'PRESCRIBED_SINCE_IMPORT',
] as const;
export type ArrearsLineIssue = (typeof ARREARS_LINE_ISSUE)[number];

/** What becomes of a line: kept, dropped (by prescription or the accountant), waiting for a file, or refused. */
export const ARREARS_LINE_VERDICT = ['KEEP', 'DROP', 'UNMATCHED', 'REFUSED'] as const;
export type ArrearsLineVerdictStatus = (typeof ARREARS_LINE_VERDICT)[number];

/** What the preview flags on a line for the accountant (`arrears_lines.flags`). */
export interface ArrearsLineFlags {
  /** Decision 14: dropped, «مرور الزمن». */
  prescribed?: true;
  /** The unit, or its building, read destroyed or not habitable (decision 11). */
  war?: { level: string; habitable: boolean | null; assessedAt: string };
  /** An archived file: allowed through a batch (decision 12). */
  archived?: true;
  /** A unit the citizen no longer holds: noted, never refused (the debt may predate a sale). */
  unitNotHeld?: true;
}

export interface ArrearsLineVerdict {
  /** The row in the accountant's file, header excluded. */
  row: number;
  rowKey: number | null;
  /** The name the file shows: the citizen's for a matched row, the books' for an unmatched one. */
  name: string | null;
  propertyNumber: string | null;
  unitCode: string | null;
  year: number | null;
  feeType: ArrearsFeeType | null;
  component: ArrearsComponent | null;
  amount: number | null;
  status: ArrearsLineVerdictStatus;
  issues: ArrearsLineIssue[];
  /** On a DROP: «مرور الزمن», or the accountant's reason. */
  dropReason: string | null;
  flags: ArrearsLineFlags;
}

export interface ArrearsFigure {
  count: number;
  amount: number;
}

export interface ArrearsImportTotals {
  kept: ArrearsFigure;
  /** Every DROP, prescribed ones included. */
  dropped: ArrearsFigure;
  /** Of `dropped`, those prescription dropped (decision 14). */
  prescribed: ArrearsFigure;
  unmatched: ArrearsFigure;
  refused: { count: number };
  /** The sum of every line read — kept, dropped and unmatched — which the control total is held to. */
  fileTotal: number;
  /** The batch's own, once submitted; null on a draft that has none yet. */
  controlTotal: number | null;
}

export interface ArrearsCoverage {
  /** The citizens the template was exported for. */
  citizens: number;
  /** Of them, with at least one line in the file. */
  withLines: number;
  /** Of them, with a row left blank: checked, nothing owed. */
  checkedNothingOwed: number;
  /** Of them, with no row in the file at all. */
  notInFile: number;
}

export interface ArrearsImportResult {
  batchId: string;
  dryRun: boolean;
  /** The cutoff the checks ran against; null when none is set (every line refused). */
  cutoffYear: number | null;
  /** The last year a line may be and not be prescribed, on the day the checks ran. */
  oldestKeptYear: number;
  lines: ArrearsLineVerdict[];
  totals: ArrearsImportTotals;
  coverage: ArrearsCoverage;
  /** On a write: how many lines the draft now holds. */
  written: number | null;
}

/** A batch as the lists show it. */
export interface ArrearsBatchView {
  id: string;
  status: ArrearsBatchStatus;
  scope: { zoneId?: string; buildingId?: string; count: number } | null;
  preparedBy: { id: string; name: string };
  submittedAt: string | null;
  approvedAt: string | null;
  approvedBy: { id: string; name: string } | null;
  discardedAt: string | null;
  returnNote: string | null;
  controlTotal: number | null;
  sourceNote: string | null;
  citizenCount: number;
  lineCount: number;
  createdAt: string;
}

/** One year × fee type × component of a batch, summed: what the manager approves. */
export interface ArrearsBatchTotalRow {
  year: number;
  feeType: ArrearsFeeType;
  component: ArrearsComponent;
  count: number;
  amount: number;
}

/**
 * A submitted batch as the manager reviews it (`GET arrears/batches/:id/review`):
 * what it holds, by year and fee, the lines whose handling the preparer decided
 * (war damage, an archived file, a person not yet on the register), and what
 * approval would raise. `flagged[i].row` is the line's place in the batch, not a
 * row of the accountant's file, which a stored line does not keep.
 */
export interface ArrearsBatchReview {
  batch: ArrearsBatchView;
  totals: ArrearsImportTotals;
  byYearAndFee: ArrearsBatchTotalRow[];
  flagged: ArrearsLineVerdict[];
  /** One bill per kept line with a citizen. */
  bills: { count: number; amount: number; citizens: number };
}

/** A «للمطابقة» line of an approved batch, waiting to be linked to a file (`GET arrears/lines/unmatched`). */
export interface ArrearsUnmatchedLine {
  id: string;
  batchId: string;
  sourceName: string;
  propertyNumber: string;
  unitCode: string | null;
  year: number;
  feeType: ArrearsFeeType;
  component: ArrearsComponent;
  amount: number;
}

/** What approval found wrong with a kept line (`ARREARS_APPROVAL_CHECKS_FAILED`, `details.problems`). */
export interface ArrearsApprovalProblem {
  lineId: string;
  issue: ArrearsLineIssue;
}

/** The cutoff year and the old books' totals per year (`GET arrears/settings`). */
export interface ArrearsSettingsView {
  arrearsCutoffYear: number | null;
  /** Read only until open-decisions §23.4 is decided: nothing writes them yet. */
  controlTotals: ArrearsControlTotalInput[];
}

// ──────────────────────────  reading a row  ──────────────────────────

/** One debt a row holds: its principal, or its penalty. */
export interface ParsedArrearsLine {
  component: ArrearsComponent;
  amount: number;
}

/** A row read, before anything is asked of the register. */
export type ParsedArrearsRow =
  | {
      /** No year and no amount: checked, nothing owed (when it has a row key). */
      kind: 'BLANK';
      rowKey: number | null;
    }
  | {
      kind: 'LINES';
      rowKey: number | null;
      fullName: string | null;
      propertyNumber: string;
      unitCode: string | null;
      year: number;
      feeType: ArrearsFeeType;
      feeTypeNote: string | null;
      dueDate: string | null;
      oldReference: string | null;
      note: string | null;
      lines: ParsedArrearsLine[];
    }
  | {
      kind: 'INVALID';
      rowKey: number | null;
      fullName: string | null;
      issues: { column: ArrearsTemplateColumnKey; issue: ArrearsLineIssue }[];
    };

function cell(cells: ArrearsTemplateCells, key: ArrearsTemplateColumnKey): string | null {
  const value = (cells[key] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * An amount as an accountant types it: Arabic or Latin digits, thousands
 * separated by commas, spaces or the Arabic «٬», a decimal point or «٫». Null for
 * anything else; zero is a number here and the caller decides what it means.
 */
export function parseArrearsAmount(raw: string): number | null {
  const folded = normalizeDigits(raw.trim()).replace(/٫/g, '.').replace(/[,\s٬]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(folded)) return null;
  const value = Number(folded);
  return Number.isFinite(value) && value <= ARREARS_AMOUNT_MAX ? value : null;
}

/** A due date as `YYYY-MM-DD` or `DD/MM/YYYY` (Excel on an Arabic system), returned as `YYYY-MM-DD`. */
export function parseArrearsDueDate(raw: string): string | null {
  const folded = normalizeDigits(raw.trim());
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(folded);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(folded);
  const parts = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : null;
  if (!parts) return null;
  const day = `${parts[0]}-${parts[1]!.padStart(2, '0')}-${parts[2]!.padStart(2, '0')}`;
  return isCalendarDay(day) ? day : null;
}

/** A fee type by its code or its Arabic label, with the spelling differences folded. */
export function parseArrearsFeeType(raw: string): ArrearsFeeType | null {
  const needle = normalizeArabic(raw);
  if (!needle) return null;
  for (const code of ARREARS_FEE_TYPE) {
    if (normalizeArabic(code) === needle || normalizeArabic(ar.arrearsFeeType[code]) === needle) return code;
  }
  return null;
}

/**
 * Reads one row of the filled template into the lines it holds, or the cells it
 * cannot read. Pure: the register's checks (the row key, the unit, the cutoff,
 * duplicates, prescription) are the server's, in `arrears-import.plan.ts`. The
 * browser may run it for its own preview; the server runs it again.
 *
 * A row with neither a year nor an amount is BLANK — "checked, nothing owed". A
 * principal and a penalty on one row are two lines. A zero is no line, so a row
 * whose only amounts are zero is blank too, year or not; a year with both amount
 * cells empty is refused (`AMOUNT_REQUIRED`), since it may be a figure left out.
 */
export function parseArrearsRow(cells: ArrearsTemplateCells): ParsedArrearsRow {
  const issues: { column: ArrearsTemplateColumnKey; issue: ArrearsLineIssue }[] = [];

  const rowKeyCell = cell(cells, 'rowKey');
  let rowKey: number | null = null;
  if (rowKeyCell !== null) {
    const folded = normalizeDigits(rowKeyCell);
    if (/^\d+$/.test(folded) && Number(folded) > 0) rowKey = Number(folded);
    else issues.push({ column: 'rowKey', issue: 'ROW_KEY_INVALID' });
  }
  const fullName = cell(cells, 'fullName');

  const yearCell = cell(cells, 'year');
  const principalCell = cell(cells, 'principal');
  const penaltyCell = cell(cells, 'penalty');
  const feeTypeCell = cell(cells, 'feeType');

  const amounts: ParsedArrearsLine[] = [];
  let sawZero = false;
  for (const [column, component] of [
    ['principal', 'PRINCIPAL'],
    ['penalty', 'PENALTY'],
  ] as const) {
    const raw = column === 'principal' ? principalCell : penaltyCell;
    if (raw === null) continue;
    const amount = parseArrearsAmount(raw);
    if (amount === null) issues.push({ column, issue: 'AMOUNT_INVALID' });
    else if (amount > 0) amounts.push({ component, amount });
    else sawZero = true;
  }

  // Nothing owed: no amount at all and no year, or only zeros (with or without a year).
  const amountIssues = issues.some((entry) => entry.issue === 'AMOUNT_INVALID');
  if (amounts.length === 0 && !amountIssues && (yearCell === null || sawZero)) {
    return issues.length > 0 ? { kind: 'INVALID', rowKey, fullName, issues } : { kind: 'BLANK', rowKey };
  }

  let year: number | null = null;
  if (yearCell === null) issues.push({ column: 'year', issue: 'YEAR_REQUIRED' });
  else {
    const folded = normalizeDigits(yearCell);
    if (/^\d{4}$/.test(folded) && Number(folded) >= ARREARS_YEAR_MIN && Number(folded) <= 2100) year = Number(folded);
    else issues.push({ column: 'year', issue: 'YEAR_INVALID' });
  }

  if (amounts.length === 0 && !amountIssues) issues.push({ column: 'principal', issue: 'AMOUNT_REQUIRED' });

  let feeType: ArrearsFeeType | null = null;
  if (feeTypeCell === null) issues.push({ column: 'feeType', issue: 'FEE_TYPE_REQUIRED' });
  else {
    feeType = parseArrearsFeeType(feeTypeCell);
    if (feeType === null) issues.push({ column: 'feeType', issue: 'FEE_TYPE_UNKNOWN' });
  }
  const feeTypeNote = cell(cells, 'feeTypeNote');
  if (feeType === 'OTHER' && feeTypeNote === null) issues.push({ column: 'feeTypeNote', issue: 'FEE_TYPE_NOTE_REQUIRED' });

  const propertyCell = cell(cells, 'propertyNumber');
  if (propertyCell === null) issues.push({ column: 'propertyNumber', issue: 'PROPERTY_NUMBER_REQUIRED' });

  const dueCell = cell(cells, 'dueDate');
  const dueDate = dueCell === null ? null : parseArrearsDueDate(dueCell);
  if (dueCell !== null && dueDate === null) issues.push({ column: 'dueDate', issue: 'DUE_DATE_INVALID' });

  if (rowKey === null && rowKeyCell === null && fullName === null) issues.push({ column: 'fullName', issue: 'NAME_REQUIRED' });

  if (issues.length > 0 || year === null || feeType === null || propertyCell === null) {
    return { kind: 'INVALID', rowKey, fullName, issues };
  }
  return {
    kind: 'LINES',
    rowKey,
    fullName,
    propertyNumber: normalizeDigits(propertyCell),
    unitCode: cell(cells, 'unitCode'),
    year,
    feeType,
    feeTypeNote: feeType === 'OTHER' ? feeTypeNote : null,
    dueDate,
    oldReference: cell(cells, 'oldReference'),
    note: cell(cells, 'note'),
    lines: amounts,
  };
}

/** Cells by column key, from a row keyed by the template's Arabic headers. Unknown headers are dropped. */
export function arrearsCellsFromHeaders(row: Readonly<Record<string, string>>): ArrearsTemplateCells {
  const cells: ArrearsTemplateCells = {};
  for (const [header, value] of Object.entries(row)) {
    const key = ARREARS_HEADER_TO_KEY[header.trim()];
    if (key) cells[key] = value;
  }
  return cells;
}

/** The line decision a verdict lands as in `arrears_lines`. Refused and unmatched lines are not decisions. */
export function arrearsDecisionOf(status: ArrearsLineVerdictStatus): ArrearsLineDecision | null {
  return status === 'KEEP' || status === 'UNMATCHED' ? 'KEEP' : status === 'DROP' ? 'DROP' : null;
}
