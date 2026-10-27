import {
  canSpanLevels,
  CITIZEN_RESIDENCE,
  defaultUnitStates,
  DWELLING_UNIT_TYPE,
  FEE_TARGET_CATEGORY,
  MAX_UNIT_LEVELS,
  feeMatrixSchema,
  feeNoticePreviewSchema,
  feeScopeWarnings,
  normalizeDigits,
  STRUCTURAL_UNIT_TYPE,
  UNIT_STATUS,
  UNIT_TYPE,
  UNOCCUPIED_UNIT_STATUS,
  type CitizenResidence,
  type FeeBasis,
  type FeeBearer,
  type FeeFrequency,
  type FeeMatrixBracket,
  type FeeNoticePreviewInput,
  type FeeScopeWarning,
  type FeeTargetCategory,
  type UnitStatus,
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
  /**
   * The one-level bracket this row prices at more levels («D-2» under «D»):
   * its code, name, range and unit types are that row's (`withExtensions`),
   * and only its level count and amount are its own. Never sent: once sent it
   * is a bracket like any other.
   */
  extendsKey?: string;
}

export type BracketField = 'code' | 'labelAr' | 'unitTypes' | 'levels' | 'minArea' | 'maxArea' | 'amount';

/**
 * A key no reload can repeat. A counter in this module started again with the
 * module — a hot reload, a deploy picked up mid-session — while the rows keyed
 * by it lived on in the wizard's state, so a new row could take an old row's
 * key, and an extension then followed the wrong bracket («B-2-2» under «A»,
 * 2026-10-27).
 */
function freshKey(): string {
  return `bracket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh bracket: a one-level flat, everything else to type. */
export function emptyBracket(): BracketDraft {
  return {
    key: freshKey(),
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

/** The unit types a bracket can price: every type but a floor nobody occupies. */
export const PRICED_UNIT_TYPES = UNIT_TYPE.filter(
  (type) => !(STRUCTURAL_UNIT_TYPE as readonly string[]).includes(type),
) as UnitType[];

/**
 * The quick picks for a bracket's unit types, beside the boxes one by one.
 *
 * «سكني» is the census's own dwellings (`DWELLING_UNIT_TYPE`), «تجاري ومهني»
 * the business premises. The كراج is in neither: the census files it as a
 * household's lock-up, not a commercial garage, so only «جميع الوحدات» or its
 * own box prices it (the user's decision, 2026-10-24).
 */
export const UNIT_TYPE_PRESETS = {
  residential: [...DWELLING_UNIT_TYPE],
  commercial: ['CLINIC', 'OFFICE', 'SHOP', 'WAREHOUSE'],
  all: PRICED_UNIT_TYPES,
} as const satisfies Record<string, readonly UnitType[]>;
export type UnitTypePreset = keyof typeof UNIT_TYPE_PRESETS;
export const UNIT_TYPE_PRESET_KEYS = Object.keys(UNIT_TYPE_PRESETS) as UnitTypePreset[];

/** The quick pick these types are, or null for a choice made box by box. */
export function presetOf(types: readonly UnitType[]): UnitTypePreset | null {
  const chosen = new Set(types);
  const found = UNIT_TYPE_PRESET_KEYS.find((preset) => {
    const members: readonly UnitType[] = UNIT_TYPE_PRESETS[preset];
    return members.length === chosen.size && members.every((type) => chosen.has(type));
  });
  return found ?? null;
}

/**
 * A bracket's range as the clerk types and reads it includes both its ends, in
 * whole metres: «0 – 50», then «51 – 60» (the user's decision, 2026-10-27). The
 * engine matches a range that includes its floor and stops short of its
 * ceiling (`matchBracket`), so the «حتى» typed is sent as the next whole metre
 * (`toMatrix`): «0 – 50» goes as [0, 51), «51 – 60» as [51, 61) — no gap
 * between them, and an area of 50.4 m², should one be recorded, still lands in
 * «0 – 50». Nothing on the server changes.
 */

/** The «من» that follows a «حتى»: the next whole metre, «51» after «50»; blank while the «حتى» is not a figure. */
export function floorAfter(ceiling: string): string {
  const value = figure(ceiling);
  return Number.isFinite(value) ? String(value + 1) : '';
}

/**
 * An area as the bracket table takes it: whole metres, Arabic-Indic digits read
 * as Latin. A decimal mark ends the figure — «50.5» stays «50» — rather than
 * being dropped, which would turn «0.5» into «05».
 */
export function wholeMetres(text: string): string {
  return normalizeDigits(text)
    .replace(/[.٫].*$/, '')
    .replace(/\D/g, '');
}

/**
 * «نموذج 9 فئات»: the bounds a nine-bracket table starts from, in square
 * metres — «0 – 100», «101 – 150» … «401 – 500», then «501» and up. Not a legal
 * standard — the assessment committee sets a town's brackets — but the 50 m²
 * steps the user chose for the template on 2026-10-24; the clerk adjusts them
 * and types every fee.
 */
const TEMPLATE_BOUNDS = [0, 100, 150, 200, 250, 300, 350, 400, 500] as const;
/** A bracket's code in turn: «A» to «Z», the template's nine and then the ones «أضف فئة» adds. */
const BRACKET_CODES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
/** The same in its name, «الفئة أ» to «الفئة ض», in abjad order, as the categories are named on paper. */
const BRACKET_LETTERS = [
  'أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي', 'ك', 'ل', 'م',
  'ن', 'س', 'ع', 'ف', 'ص', 'ق', 'ر', 'ش', 'ت', 'ث', 'خ', 'ذ', 'ض',
] as const;

/** The code and name of the bracket in this place of the sequence; nothing past «Z». */
function bracketName(at: number): Pick<BracketDraft, 'code' | 'labelAr'> | null {
  const code = BRACKET_CODES[at];
  const letter = BRACKET_LETTERS[at];
  return code && letter ? { code, labelAr: `الفئة ${letter}` } : null;
}

/**
 * The template's nine brackets, «A» to «I», for dwellings on one level: codes,
 * names and areas filled in, every fee left to type. The name is the bill's
 * own words (`bracketLabel`), Arabic on both locales like every `labelAr`.
 */
export function standardBrackets(): BracketDraft[] {
  return TEMPLATE_BOUNDS.map((min, at) => ({
    ...emptyBracket(),
    ...bracketName(at)!,
    unitTypes: [...UNIT_TYPE_PRESETS.residential],
    // Each after the first starts the metre after the one before it ends.
    minArea: String(at === 0 ? min : min + 1),
    maxArea: at + 1 < TEMPLATE_BOUNDS.length ? String(TEMPLATE_BOUNDS[at + 1]) : '',
  }));
}

/**
 * «مدّ الفئة» (the user's design, 2026-10-27): the rows that price a bracket at
 * more levels, under decision D1 — «D-2» for a «دوبلكس», «D-3» for a
 * «تريبلكس», up to `MAX_UNIT_LEVELS`. On screen an extension is its base's row
 * again with a price of its own; sent, it is a bracket like any other, on the
 * scale of its level count.
 */
export function extensionCode(code: string, levels: number): string {
  return `${code.trim()}-${levels}`;
}

/** The extensions of the bracket with this key, in table order. */
export function extensionsOf(drafts: readonly BracketDraft[], key: string): BracketDraft[] {
  return drafts.filter((draft) => draft.extendsKey === key);
}

/**
 * The level count the bracket's next extension prices: one above the highest
 * of the bracket and its extensions. Null when none is left — past
 * `MAX_UNIT_LEVELS`, on an extension itself, or for a bracket with no dwelling
 * type, since only a dwelling spans levels.
 */
export function nextExtensionLevels(drafts: readonly BracketDraft[], key: string): number | null {
  const base = drafts.find((draft) => draft.key === key);
  if (!base || base.extendsKey || !base.unitTypes.some(canSpanLevels)) return null;
  const top = Math.max(...[base, ...extensionsOf(drafts, key)].map((draft) => Number(draft.levels) || 1));
  return top < MAX_UNIT_LEVELS ? top + 1 : null;
}

/** The table with the bracket's next extension added under it and its extensions so far, its amount to type. */
export function extendBracket(drafts: readonly BracketDraft[], key: string): BracketDraft[] {
  const levels = nextExtensionLevels(drafts, key);
  if (levels === null) return [...drafts];
  let end = drafts.findIndex((draft) => draft.key === key);
  while (drafts[end + 1]?.extendsKey === key) end += 1;
  const added: BracketDraft = { ...emptyBracket(), extendsKey: key, levels: String(levels) };
  return withExtensions([...drafts.slice(0, end + 1), added, ...drafts.slice(end + 1)]);
}

/**
 * Every extension brought in step with its base, after any change to the
 * table: the base's code with the level count after it, its name, its range
 * and its unit types, all of them, as the clerk chose them for the base («جميع
 * الوحدات» stays «جميع الوحدات»). `toMatrix` sends the dwellings among them:
 * only a dwelling spans levels, so nothing else could ever match. An extension
 * whose base was removed goes with it.
 */
export function withExtensions(drafts: readonly BracketDraft[]): BracketDraft[] {
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
  return drafts.flatMap((draft) => {
    if (!draft.extendsKey) return [draft];
    const base = byKey.get(draft.extendsKey);
    if (!base) return [];
    return [
      {
        ...draft,
        code: extensionCode(base.code, Number(draft.levels)),
        labelAr: base.labelAr,
        minArea: base.minArea,
        maxArea: base.maxArea,
        unitTypes: [...base.unitTypes],
      },
    ];
  });
}

/**
 * The bracket «أضف فئة» adds: on the last one's scale, starting where it ends,
 * so a table typed top to bottom is chained as it is written; and named next in
 * the sequence (the user's decision, 2026-10-27) — «A» and «الفئة أ» first, then
 * the letter after the highest the table already uses: «B» after «A», «E» after
 * «A» and «D». Codes of the clerk's own are passed over; past «Z», no name.
 */
export function nextBracket(drafts: readonly BracketDraft[]): BracketDraft {
  // The last bracket of its own: an extension's scale is its base's to extend, not a new row's to start.
  const last = [...drafts].reverse().find((draft) => !draft.extendsKey);
  const highest = Math.max(
    -1,
    ...drafts
      .filter((draft) => !draft.extendsKey)
      .map((draft) => BRACKET_CODES.indexOf(draft.code.trim().toUpperCase())),
  );
  const fresh = { ...emptyBracket(), ...bracketName(highest + 1) };
  return last
    ? { ...fresh, unitTypes: [...last.unitTypes], levels: last.levels, minArea: floorAfter(last.maxArea) }
    : fresh;
}

/** Two brackets price at least one unit type at the same level count. */
function shareScale(a: BracketDraft, b: BracketDraft): boolean {
  return a.levels === b.levels && a.unitTypes.some((type) => b.unitTypes.includes(type));
}

/**
 * The brackets whose «من» is the metre after this one's «حتى» on a scale they
 * share: the ones a change to its ceiling moves with it, so retyping 100 as 120
 * moves the next «101» to «121», with neither a gap nor an overlap. Read by key
 * when the clerk starts editing the ceiling, so the link holds while the figure
 * is half typed or empty.
 */
export function chainedFollowers(drafts: readonly BracketDraft[], index: number): string[] {
  const draft = drafts[index];
  if (!draft) return [];
  const ceiling = figure(draft.maxArea);
  if (!Number.isFinite(ceiling)) return [];
  return drafts
    .filter((other, at) => at !== index && shareScale(other, draft) && figure(other.minArea) === ceiling + 1)
    .map((other) => other.key);
}

/** One block of a scale's coverage bar: a bracket, or areas between two that none prices. */
export type CoverageStep =
  | {
      kind: 'bracket';
      /** The bracket's place in the table. */
      index: number;
      code: string;
      /** Both ends included, as the clerk typed them. */
      min: number;
      /** Null for no ceiling. */
      max: number | null;
      /** Starts below the ceiling of the bracket before it on this scale. */
      overlaps: boolean;
    }
  /** The whole metres between two brackets that none prices, both ends included: «51–52». */
  | { kind: 'gap'; from: number; to: number };

/** One scale of the table — or several that hold the same brackets, drawn as one bar. */
export interface CoverageScale {
  unitTypes: UnitType[];
  levels: number;
  steps: CoverageStep[];
}

/**
 * The table as a bar per scale: each scale's brackets in order of area, with
 * the gaps and overlaps `feeMatrixSchema` refuses marked where they fall.
 * Scales holding exactly the same brackets (a flat and a house priced alike)
 * share one bar. A bracket whose areas are not figures yet is left out until
 * they are.
 */
export function coverage(drafts: readonly BracketDraft[]): CoverageScale[] {
  const readable = toMatrix(drafts)
    .map((bracket, index) => ({ ...bracket, index }))
    .filter(
      (bracket) => Number.isFinite(bracket.minArea) && (bracket.maxArea === null || Number.isFinite(bracket.maxArea)),
    );
  const scales = new Map<string, CoverageScale>();
  for (const levels of [...new Set(readable.map((bracket) => bracket.levels))].sort((a, b) => a - b)) {
    for (const unitType of PRICED_UNIT_TYPES) {
      const rows = readable
        .filter((bracket) => bracket.levels === levels && bracket.unitTypes.includes(unitType))
        .sort((a, b) => a.minArea - b.minArea || a.index - b.index);
      if (rows.length === 0) continue;
      const key = `${levels}:${rows.map((row) => row.index).join(',')}`;
      const known = scales.get(key);
      if (known) {
        known.unitTypes.push(unitType);
        continue;
      }
      const steps: CoverageStep[] = [];
      rows.forEach((row, at) => {
        const previous = rows[at - 1];
        // Read as sent — a ceiling the bracket stops short of — and drawn as typed, both ends included.
        const ceiling = previous ? previous.maxArea : undefined;
        if (typeof ceiling === 'number' && row.minArea > ceiling) {
          steps.push({ kind: 'gap', from: ceiling, to: row.minArea - 1 });
        }
        steps.push({
          kind: 'bracket',
          index: row.index,
          code: row.code,
          min: row.minArea,
          max: row.maxArea === null ? null : row.maxArea - 1,
          overlaps: previous !== undefined && (ceiling === null || row.minArea < (ceiling as number)),
        });
      });
      scales.set(key, { unitTypes: [unitType], levels, steps });
    }
  }
  return [...scales.values()];
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

/**
 * The table as the API takes it (`feeMatrixSchema`): each «حتى», which the
 * clerk's range includes, sent as the next whole metre, the ceiling the engine
 * stops short of — «0 – 50» as [0, 51).
 */
export function toMatrix(drafts: readonly BracketDraft[]): FeeMatrixBracket[] {
  return drafts.map((draft) => ({
    code: draft.code.trim(),
    labelAr: draft.labelAr.trim(),
    /*
      An extension prices its base's types at more levels, and only a dwelling
      spans levels (`units_levels_dwelling_only`): the dwellings among them are
      sent, the rest could match no unit, and the schema refuses them there.
    */
    unitTypes: draft.extendsKey ? draft.unitTypes.filter(canSpanLevels) : draft.unitTypes,
    levels: Number(draft.levels),
    minArea: figure(draft.minArea),
    maxArea: draft.maxArea.trim() === '' ? null : figure(draft.maxArea) + 1,
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
  frequency: FeeFrequency;
  /** «لمن يصدر»: everyone the filters below reach, or one named citizen. */
  audience: 'ALL' | 'INDIVIDUAL';
  /** «نوع العقار / الوحدة» (0100): every one ticked is «جميع المواطنين». */
  categories: FeeTargetCategory[];
  /** «حالة الوحدة» (0100): null follows the bearer (`defaultUnitStates`); set once the clerk ticks a box. */
  unitStates: UnitStatus[] | null;
  /** «نوع الإقامة» (0100): every kind by default. */
  residences: CitizenResidence[];
  /** The clerk confirmed the scope's warnings (`noticeWarnings`); cleared by any change to the scope. */
  scopeConfirmed: boolean;
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
 * The scope («من يشمل الإشعار», 0100) is sent only where it departs from the
 * defaults, so a notice that names none of it is exactly the notice from before:
 *
 *  - Every category ticked is «جميع المواطنين»; one is `targetCategory`; several
 *    are `targetCategories`. None at all is sent as an empty list, which the
 *    schema refuses in its own words.
 *  - The unit states only when they differ from the bearer's own, and never
 *    under FLAT, where they decide nothing.
 *  - The kinds of file only when one is left out, and never for one citizen.
 *
 * A category or a kind of file is never sent with a notice to one citizen, and a
 * citizen only with one: the form keeps them while the clerk moves between
 * audiences. Under TIERED_AREA the amount is 0 and the table is sent; under any
 * other basis, no table.
 */
export function noticePayload(values: NoticeDraft): FeeNoticePreviewInput {
  const tiered = values.basis === 'TIERED_AREA';
  const individual = values.audience === 'INDIVIDUAL';
  const everyCategory = FEE_TARGET_CATEGORY.every((category) => values.categories.includes(category));
  const states = unitStatesOf(values);
  const everyResidence = CITIZEN_RESIDENCE.every((kind) => values.residences.includes(kind));
  return {
    title: values.title,
    amount: tiered ? 0 : typedAmount(values.amount),
    basis: values.basis,
    bearer: values.bearer,
    frequency: values.frequency,
    targetType: individual ? 'INDIVIDUAL_CITIZEN' : everyCategory ? 'ALL_CITIZENS' : 'BUILDING_CATEGORY',
    targetCategory: !individual && values.categories.length === 1 ? values.categories[0] : undefined,
    targetCategories:
      !individual && !everyCategory && values.categories.length !== 1 ? inOrder(FEE_TARGET_CATEGORY, values.categories) : undefined,
    unitStates:
      values.basis !== 'FLAT' && !sameStates(states, defaultUnitStates(values.bearer)) ? states : undefined,
    residences: !individual && !everyResidence ? inOrder(CITIZEN_RESIDENCE, values.residences) : undefined,
    targetCitizenId: individual ? values.targetCitizenId || undefined : undefined,
    dueDate: values.dueDate,
    instructions: values.instructions.trim() || undefined,
    matrixBrackets: tiered ? toMatrix(values.matrixBrackets) : undefined,
  };
}

/** The unit states the draft charges: those ticked, or the bearer's own while none was touched. */
export function unitStatesOf(values: Pick<NoticeDraft, 'unitStates' | 'bearer'>): UnitStatus[] {
  return values.unitStates ?? defaultUnitStates(values.bearer);
}

/**
 * «الوحدات المشمولة» on the details step (the user's decision, 2026-10-27): the
 * short answer to «حالة الوحدة», whose six boxes on the scope step are the long
 * one. «الشاغلة» is every status but `UNOCCUPIED_UNIT_STATUS` — «مسكن موسمي»
 * counts as occupied, as the enum says — «الشاغرة» is those two, and «الكل»
 * all six. Both write the same `unitStates`, so the two never disagree.
 */
export const UNIT_OCCUPANCY = ['OCCUPIED', 'VACANT', 'ALL'] as const;
export type UnitOccupancy = (typeof UNIT_OCCUPANCY)[number];

export function occupancyStates(occupancy: UnitOccupancy): UnitStatus[] {
  const unoccupied = (state: UnitStatus) => (UNOCCUPIED_UNIT_STATUS as readonly string[]).includes(state);
  if (occupancy === 'OCCUPIED') return UNIT_STATUS.filter((state) => !unoccupied(state));
  if (occupancy === 'VACANT') return UNIT_STATUS.filter(unoccupied);
  return [...UNIT_STATUS];
}

/** Which of the three the statuses are, or null for a mix ticked box by box on the scope step. */
export function occupancyOf(states: readonly UnitStatus[]): UnitOccupancy | null {
  return (
    UNIT_OCCUPANCY.find((occupancy) => {
      const expected = occupancyStates(occupancy);
      return expected.length === states.length && expected.every((state) => states.includes(state));
    }) ?? null
  );
}

/**
 * The `unitStates` a choice of the three sends: null — follow the bearer, as
 * an untouched notice does — when it is what the bearer charges anyway.
 */
export function unitStatesFor(occupancy: UnitOccupancy, bearer: FeeBearer): UnitStatus[] | null {
  const states = occupancyStates(occupancy);
  return occupancyOf(defaultUnitStates(bearer)) === occupancy ? null : states;
}

/** A choice in the list's own order, so the same ticks always send the same list. */
function inOrder<T extends string>(order: readonly T[], chosen: readonly T[]): T[] {
  return order.filter((value) => chosen.includes(value));
}

function sameStates(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * What the clerk must confirm before this notice is issued (`feeScopeWarnings`,
 * the server's own rule): an occupancy fee on empty units, a status or a kind of
 * file the law charges left out. Empty for a notice that charges what the law
 * does.
 */
export function noticeWarnings(values: NoticeDraft): FeeScopeWarning[] {
  return feeScopeWarnings(noticePayload(values));
}

/**
 * The notice as «إصدار» sends it: the preview's notice, and the warnings the
 * clerk confirmed — none unless they did, so an unconfirmed scope is refused by
 * the server as well as held by the wizard.
 */
export function issuePayload(values: NoticeDraft): FeeNoticePreviewInput {
  const warnings = noticeWarnings(values);
  return {
    ...noticePayload(values),
    acknowledgedWarnings: values.scopeConfirmed && warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * The flat amount or rate as typed, read the way `figure` reads a bracket's: an
 * Arabic layout's «٥٠٠٬٠٠٠» is 500000, as «500,000» is. 0 when blank, which the
 * schema refuses outside TIERED_AREA.
 */
export function typedAmount(text: string): number {
  const value = figure(text);
  return Number.isFinite(value) ? value : 0;
}

/** The wizard's fields the schema can refuse, as `noticePayload` names them. */
export type NoticeField =
  | 'title'
  | 'amount'
  | 'matrixBrackets'
  | 'dueDate'
  | 'instructions'
  | 'unitStates'
  | 'residences'
  | 'targetCategories'
  | 'targetCitizenId';

/**
 * Which step asks for each field, so a step is checked for its own fields only.
 * «جدول الفئات» is a step of its own, shown under TIERED_AREA alone.
 */
export const STEP_FIELDS = {
  details: ['title', 'amount', 'dueDate', 'instructions'],
  brackets: ['matrixBrackets'],
  target: ['unitStates', 'residences', 'targetCategories', 'targetCitizenId'],
} as const satisfies Record<string, readonly NoticeField[]>;
export type CheckedStep = keyof typeof STEP_FIELDS;

/** The step that asks for a field. */
export function stepOf(field: NoticeField): CheckedStep {
  return (Object.keys(STEP_FIELDS) as CheckedStep[]).find((step) =>
    (STEP_FIELDS[step] as readonly NoticeField[]).includes(field),
  )!;
}

/**
 * What the server would refuse in this notice, by field, in the schema's own
 * words (`feeNoticePreviewSchema`, the check the preview and the issue run).
 * The bracket table's own problems are `matrixIssues`; here it is one entry.
 */
export function noticeIssues(values: NoticeDraft): Partial<Record<NoticeField, string>> {
  const parsed = feeNoticePreviewSchema.safeParse(noticePayload(values));
  const issues: Partial<Record<NoticeField, string>> = {};
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const sent = issue.path[0] as string | undefined;
    // One category or several, the clerk ticks one list: its refusal is that list's.
    const field = (sent === 'targetCategory' ? 'targetCategories' : sent) as NoticeField | undefined;
    if (field) issues[field] ??= issue.message;
  }
  return issues;
}
