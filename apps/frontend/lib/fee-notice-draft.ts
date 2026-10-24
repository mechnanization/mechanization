import {
  feeMatrixSchema,
  normalizeDigits,
  type FeeBasis,
  type FeeBearer,
  type FeeMatrixBracket,
  type FeeNoticePreviewInput,
  type UnitType,
} from '@mechanization/shared-schemas';

/**
 * «إصدار رسم جديد» as the wizard holds it, and as the API takes it — pure, so
 * the preview and the issue send one notice and the rules are tested apart
 * from the screen (`fee-notice-draft.test.ts`).
 */

/** One bracket of a TIERED_AREA table as typed: strings, so a half-typed figure is kept as it is. */
export interface BracketDraft {
  /** A local key for React; never sent. */
  key: string;
  code: string;
  labelAr: string;
  unitTypes: UnitType[];
  levels: string;
  minArea: string;
  /** Empty for no ceiling: the top bracket. */
  maxArea: string;
  amount: string;
  /** Edited at least once: only then are its problems shown. */
  touched: boolean;
}

export type BracketField = 'code' | 'labelAr' | 'unitTypes' | 'levels' | 'minArea' | 'maxArea' | 'amount';

let nextKey = 0;

/** A fresh bracket: a one-level flat, everything else to type. */
export function emptyBracket(): BracketDraft {
  nextKey += 1;
  return {
    key: `bracket-${nextKey}`,
    code: '',
    labelAr: '',
    unitTypes: ['APARTMENT'],
    levels: '1',
    minArea: '',
    maxArea: '',
    amount: '',
    touched: false,
  };
}

/**
 * A typed figure as a number; NaN when blank. Arabic-Indic digits, the Arabic
 * thousands separator «٬» and decimal mark «٫» are read as a keyboard on an
 * Arabic layout types them, as are Latin commas and spaces between thousands.
 */
function figure(text: string): number {
  const clean = normalizeDigits(text).replace(/[,،٬\s]/g, '').replace(/٫/g, '.');
  return clean === '' ? Number.NaN : Number(clean);
}

/** The table as the API takes it (`feeMatrixSchema`). */
export function toMatrix(drafts: readonly BracketDraft[]): FeeMatrixBracket[] {
  return drafts.map((draft) => ({
    code: draft.code.trim(),
    labelAr: draft.labelAr.trim(),
    unitTypes: draft.unitTypes,
    levels: Number(draft.levels),
    minArea: figure(draft.minArea),
    maxArea: draft.maxArea.trim() === '' ? null : figure(draft.maxArea),
    amount: figure(draft.amount),
  }));
}

/**
 * What is wrong with the table, by row and field and across it, in the words
 * of the schema the server checks it by; `ok` when the server would take it.
 */
export function matrixIssues(drafts: readonly BracketDraft[]): {
  ok: boolean;
  rows: Array<Partial<Record<BracketField, string>>>;
  table: string | null;
} {
  const parsed = feeMatrixSchema.safeParse(toMatrix(drafts));
  const rows: Array<Partial<Record<BracketField, string>>> = drafts.map(() => ({}));
  let table: string | null = null;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [index, field] = issue.path;
      if (typeof index === 'number' && typeof field === 'string' && rows[index]) {
        rows[index]![field as BracketField] ??= issue.message;
      } else if (typeof index !== 'number') {
        table ??= issue.message;
      }
    }
  }
  return { ok: parsed.success, rows, table };
}

/** The wizard's fields, as typed. */
export interface NoticeDraft {
  title: string;
  amount: string;
  /** What `amount` is per — see `FEE_BASIS`. */
  basis: FeeBasis;
  /** Who owes it — see `FEE_BEARER`. Only consulted when basis is not FLAT. */
  bearer: FeeBearer;
  frequency: string;
  targetType: string;
  targetCategory: string;
  targetCitizenId: string;
  dueDate: string;
  instructions: string;
  /** The bracket table, under TIERED_AREA; kept when the basis changes, sent only under it. */
  matrixBrackets: BracketDraft[];
}

/**
 * The notice as the API takes it — one shape for the preview and the issue, so
 * the figure the clerk is shown is the figure that is raised.
 *
 * A category is sent only with a notice aimed at one, and a citizen only with a
 * notice to one: the form keeps both while the clerk moves between targets, and
 * a category sent with «جميع المواطنين» narrowed what a rate-based notice
 * charged to that category (`assessCitizen` filters by it). Under TIERED_AREA
 * the amount is 0 and the table is sent; under any other basis, no table.
 */
export function noticePayload(values: NoticeDraft): FeeNoticePreviewInput {
  const tiered = values.basis === 'TIERED_AREA';
  return {
    title: values.title,
    amount: tiered ? 0 : Number(values.amount.replace(/\D/g, '')),
    basis: values.basis,
    bearer: values.bearer,
    frequency: values.frequency as FeeNoticePreviewInput['frequency'],
    targetType: values.targetType as FeeNoticePreviewInput['targetType'],
    targetCategory:
      values.targetType === 'BUILDING_CATEGORY'
        ? (values.targetCategory as FeeNoticePreviewInput['targetCategory'])
        : undefined,
    targetCitizenId: values.targetType === 'INDIVIDUAL_CITIZEN' ? values.targetCitizenId || undefined : undefined,
    dueDate: values.dueDate,
    instructions: values.instructions.trim() || undefined,
    matrixBrackets: tiered ? toMatrix(values.matrixBrackets) : undefined,
  };
}
