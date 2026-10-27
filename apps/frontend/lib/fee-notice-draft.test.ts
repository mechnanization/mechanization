import { describe, expect, it } from 'vitest';
import { CITIZEN_RESIDENCE, createFeeNoticeSchema, FEE_TARGET_CATEGORY, matchBracket } from '@mechanization/shared-schemas';
import {
  chainedFollowers,
  coverage,
  emptyBracket,
  extendBracket,
  extensionsOf,
  issuePayload,
  matrixIssues,
  nextBracket,
  nextExtensionLevels,
  noticeIssues,
  noticePayload,
  noticeWarnings,
  occupancyOf,
  occupancyStates,
  presetOf,
  PRICED_UNIT_TYPES,
  standardBrackets,
  toMatrix,
  unitStatesFor,
  wholeMetres,
  UNIT_TYPE_PRESETS,
  withExtensions,
  type BracketDraft,
  type NoticeDraft,
} from './fee-notice-draft';

const bracket = (over: Partial<BracketDraft>): BracketDraft => ({ ...emptyBracket(), touched: true, ...over });

const A = bracket({ code: 'A', labelAr: 'الفئة أ', minArea: '0', maxArea: '100', amount: '1,000,000' });
// «0 – 100» includes 100 m²: the next bracket starts at 101.
const B = bracket({ code: 'B', labelAr: 'الفئة ب', minArea: '101', maxArea: '', amount: '1,500,000' });

const draft = (over: Partial<NoticeDraft> = {}): NoticeDraft => ({
  title: 'رسم النظافة',
  amount: '500,000',
  basis: 'PER_UNIT',
  bearer: 'OCCUPANT',
  frequency: 'ANNUALLY',
  audience: 'ALL',
  categories: [...FEE_TARGET_CATEGORY],
  unitStates: null,
  residences: [...CITIZEN_RESIDENCE],
  scopeConfirmed: false,
  targetCitizenId: '',
  dueDate: '2026-12-31',
  instructions: '',
  matrixBrackets: [],
  ...over,
});

describe('toMatrix', () => {
  it('reads the typed figures, Arabic-Indic digits and separators included, and an empty ceiling as none', () => {
    expect(toMatrix([bracket({ code: ' A ', labelAr: 'أ', minArea: '٠', maxArea: '١٠٠', amount: '١٬٠٠٠٬٠٠٠' })])).toMatchObject([
      { code: 'A', minArea: 0, maxArea: 101, amount: 1_000_000 },
    ]);
    expect(toMatrix([B])[0]!.maxArea).toBeNull();
  });

  it('sends a range typed with both ends included as the engine reads it: «0 – 50» as [0, 51), «51 – 60» as [51, 61)', () => {
    const sent = toMatrix([bracket({ minArea: '0', maxArea: '50' }), bracket({ minArea: '51', maxArea: '60' })]);
    expect(sent.map((row) => [row.minArea, row.maxArea])).toEqual([
      [0, 51],
      [51, 61],
    ]);
    // 50 m² is the first bracket’s, 51 m² the second’s, and nothing between them is left out.
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 50 }, sent)).toMatchObject({ kind: 'matched', bracket: { minArea: 0 } });
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 50.4 }, sent)).toMatchObject({ kind: 'matched', bracket: { minArea: 0 } });
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 51 }, sent)).toMatchObject({ kind: 'matched', bracket: { minArea: 51 } });
  });
});

describe('wholeMetres', () => {
  it('keeps the whole metres typed, Arabic-Indic digits read as Latin, and stops at a decimal mark', () => {
    expect(wholeMetres('١٢٠')).toBe('120');
    expect(wholeMetres('50.5')).toBe('50');
    expect(wholeMetres('0.5')).toBe('0');
    expect(wholeMetres('٥٠٫٧')).toBe('50');
    expect(wholeMetres('1,000')).toBe('1000');
  });
});

describe('matrixIssues', () => {
  it('takes a table that runs from one bracket into the next', () => {
    expect(matrixIssues([A, B]).ok).toBe(true);
  });

  it('refuses a bracket starting at the last one’s «حتى», which it already includes, and one skipping a metre', () => {
    expect(matrixIssues([A, { ...B, minArea: '100' }]).rows[1]?.minArea).toBe('الفئة «B» تتداخل مع الفئة «A» في المساحة');
    expect(matrixIssues([A, { ...B, minArea: '102' }]).rows[1]?.minArea).toBe(
      'بين الفئة «A» والفئة «B» مساحات لا تقع في أي فئة',
    );
  });

  it('puts an overlap on the row that overlaps, in the schema’s words', () => {
    const overlapping = bracket({ code: 'B', labelAr: 'ب', minArea: '90', maxArea: '', amount: '1' });
    const issues = matrixIssues([A, overlapping]);
    expect(issues.ok).toBe(false);
    expect(issues.rows[1]?.minArea).toBe('الفئة «B» تتداخل مع الفئة «A» في المساحة');
    expect(issues.rows[0]).toEqual({});
  });

  it('marks a blank figure on its own field, and an empty table across it', () => {
    expect(matrixIssues([bracket({ code: 'A', labelAr: 'أ', minArea: '0', amount: '' })]).rows[0]?.amount).toBeDefined();
    expect(matrixIssues([]).table).toBe('أضف فئة واحدة على الأقل');
  });
});

describe('noticePayload', () => {
  it('sends every category ticked as «جميع المواطنين», one as targetCategory, several as a list', () => {
    expect(noticePayload(draft())).toMatchObject({ targetType: 'ALL_CITIZENS', targetCategory: undefined, targetCategories: undefined });
    expect(noticePayload(draft({ categories: ['SHOP'] }))).toMatchObject({
      targetType: 'BUILDING_CATEGORY',
      targetCategory: 'SHOP',
      targetCategories: undefined,
    });
    // In the list's own order, whatever order they were ticked in.
    expect(noticePayload(draft({ categories: ['WAREHOUSE', 'SHOP'] }))).toMatchObject({
      targetType: 'BUILDING_CATEGORY',
      targetCategory: undefined,
      targetCategories: ['SHOP', 'WAREHOUSE'],
    });
  });

  it('sends no scope for a notice that names none of it — the notice from before', () => {
    const payload = noticePayload(draft());
    expect(payload.unitStates).toBeUndefined();
    expect(payload.residences).toBeUndefined();
    expect(noticePayload(draft({ unitStates: ['OWNER_OCCUPIED', 'RENTED', 'FREE_OCCUPIED', 'SEASONAL'] })).unitStates).toBeUndefined();
  });

  it('sends the unit states only where they differ from the bearer’s, and never under FLAT', () => {
    const all = ['OWNER_OCCUPIED', 'RENTED', 'FREE_OCCUPIED', 'SEASONAL', 'VACANT', 'UNDER_CONSTRUCTION'] as const;
    expect(noticePayload(draft({ unitStates: [...all] })).unitStates).toEqual([...all]);
    expect(noticePayload(draft({ bearer: 'OWNER', unitStates: [...all] })).unitStates).toBeUndefined();
    expect(noticePayload(draft({ basis: 'FLAT', unitStates: ['VACANT'] })).unitStates).toBeUndefined();
  });

  it('sends the kinds of file only when one is left out, and never for one citizen', () => {
    expect(noticePayload(draft({ residences: ['RESIDENT'] })).residences).toEqual(['RESIDENT']);
    expect(noticePayload(draft({ audience: 'INDIVIDUAL', residences: ['RESIDENT'] })).residences).toBeUndefined();
  });

  it('sends a citizen only with a notice to one', () => {
    expect(noticePayload(draft({ targetCitizenId: 'abc' })).targetCitizenId).toBeUndefined();
    expect(noticePayload(draft({ audience: 'INDIVIDUAL', targetCitizenId: 'abc' })).targetCitizenId).toBe('abc');
    expect(noticePayload(draft({ audience: 'INDIVIDUAL', targetCitizenId: 'abc', categories: ['SHOP'] }))).toMatchObject({
      targetType: 'INDIVIDUAL_CITIZEN',
      targetCategory: undefined,
    });
  });

  it('sends the table with an amount of 0 under TIERED_AREA, and no table under any other basis', () => {
    const tiered = noticePayload(draft({ basis: 'TIERED_AREA', amount: '999', matrixBrackets: [A, B] }));
    expect(tiered.amount).toBe(0);
    expect(tiered.matrixBrackets).toHaveLength(2);
    const perUnit = noticePayload(draft({ matrixBrackets: [A] }));
    expect(perUnit).toMatchObject({ amount: 500_000 });
    expect(perUnit.matrixBrackets).toBeUndefined();
  });

  it('reads a flat amount typed on an Arabic layout — `\\D` dropped every Arabic-Indic digit', () => {
    expect(noticePayload(draft({ basis: 'FLAT', amount: '٥٠٠٬٠٠٠' })).amount).toBe(500_000);
    expect(noticePayload(draft({ basis: 'FLAT', amount: '۵۰۰۰۰۰' })).amount).toBe(500_000);
    expect(noticePayload(draft({ basis: 'FLAT', amount: '٥0٠،000' })).amount).toBe(500_000);
    expect(noticePayload(draft({ basis: 'FLAT', amount: '' })).amount).toBe(0);
  });
});

describe('noticeIssues', () => {
  it('takes a notice the server would take', () => {
    expect(noticeIssues(draft())).toEqual({});
  });

  it('names each refused field in the schema’s words', () => {
    const issues = noticeIssues(draft({ title: ' ab ', amount: '', dueDate: '' }));
    expect(issues.title).toBe('اسم الرسم قصير جداً');
    expect(issues.amount).toBeDefined();
    expect(issues.dueDate).toBe('تاريخ الاستحقاق مطلوب');
    expect(issues.targetCitizenId).toBeUndefined();
  });

  it('asks for the citizen of a notice to one, and reads an Arabic-Indic amount as given', () => {
    const issues = noticeIssues(draft({ basis: 'FLAT', amount: '٥٠٠٬٠٠٠', audience: 'INDIVIDUAL' }));
    expect(issues).toEqual({ targetCitizenId: 'اختر المواطن المستهدف' });
  });
});

describe('standardBrackets', () => {
  it('fills nine dwelling brackets A to I, each starting the metre after the one before ends, the last open, every fee blank', () => {
    const brackets = standardBrackets();
    expect(brackets.map((row) => row.code)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(brackets[0]).toMatchObject({ labelAr: 'الفئة أ', minArea: '0', maxArea: '100', amount: '', levels: '1' });
    expect(brackets[1]).toMatchObject({ minArea: '101', maxArea: '150' });
    expect(brackets[8]).toMatchObject({ labelAr: 'الفئة ط', minArea: '501', maxArea: '' });
    brackets.slice(1).forEach((row, at) => expect(Number(row.minArea)).toBe(Number(brackets[at]!.maxArea) + 1));
    expect(brackets.every((row) => presetOf(row.unitTypes) === 'residential')).toBe(true);
    expect(new Set(brackets.map((row) => row.key)).size).toBe(9);
  });

  it('passes the server schema once the fees are typed', () => {
    const priced = standardBrackets().map((row) => ({ ...row, amount: '1,000,000' }));
    expect(matrixIssues(priced).ok).toBe(true);
    expect(matrixIssues(standardBrackets()).ok).toBe(false);
  });
});

describe('presetOf', () => {
  it('names a quick pick only for its exact set of types, in any order', () => {
    expect(presetOf(['INDEPENDENT_HOUSE', 'APARTMENT'])).toBe('residential');
    expect(presetOf(['SHOP', 'OFFICE', 'CLINIC', 'WAREHOUSE'])).toBe('commercial');
    expect(presetOf([...PRICED_UNIT_TYPES])).toBe('all');
    expect(presetOf(['APARTMENT'])).toBeNull();
    expect(presetOf(['SHOP', 'OFFICE', 'CLINIC', 'WAREHOUSE', 'GARAGE'])).toBeNull();
    expect(presetOf([])).toBeNull();
  });

  it('leaves the garage out of both groups', () => {
    expect(UNIT_TYPE_PRESETS.residential).not.toContain('GARAGE');
    expect(UNIT_TYPE_PRESETS.commercial).not.toContain('GARAGE');
    expect(UNIT_TYPE_PRESETS.all).toContain('GARAGE');
  });
});

describe('nextBracket', () => {
  it('starts the metre after the last bracket ends, on its scale', () => {
    const last = bracket({ unitTypes: ['SHOP'], levels: '1', minArea: '0', maxArea: '50' });
    expect(nextBracket([last])).toMatchObject({ unitTypes: ['SHOP'], levels: '1', minArea: '51', maxArea: '' });
    expect(nextBracket([])).toMatchObject({ minArea: '', unitTypes: ['APARTMENT'] });
  });

  it('names the first «A» and «الفئة أ», and each after it the next letter', () => {
    expect(nextBracket([])).toMatchObject({ code: 'A', labelAr: 'الفئة أ' });
    let table: BracketDraft[] = [];
    for (let press = 0; press < 5; press += 1) table = [...table, nextBracket(table)];
    expect(table.map((row) => row.code)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(table.map((row) => row.labelAr)).toEqual(['الفئة أ', 'الفئة ب', 'الفئة ج', 'الفئة د', 'الفئة هـ']);
  });

  it('goes on after the template, past an extension, and from the highest letter rather than the count', () => {
    expect(nextBracket(standardBrackets())).toMatchObject({ code: 'J', labelAr: 'الفئة ي' });
    const a = bracket({ code: 'A', unitTypes: ['APARTMENT'] });
    expect(nextBracket(extendBracket([a], a.key)).code).toBe('B');
    expect(nextBracket([bracket({ code: 'A' }), bracket({ code: 'D' })]).code).toBe('E');
    expect(nextBracket([bracket({ code: 'Z' })]).code).toBe('');
  });
});

describe('chainedFollowers', () => {
  it('finds the bracket starting the metre after this ceiling on a shared scale, Arabic-Indic digits included', () => {
    const [a, b, c] = standardBrackets();
    expect(chainedFollowers([a!, b!, c!], 0)).toEqual([b!.key]);
    const arabic = { ...b!, minArea: '١٠١' };
    expect(chainedFollowers([a!, arabic], 0)).toEqual([arabic.key]);
  });

  it('ignores a bracket on another scale, and a ceiling that is not a figure', () => {
    const [a, b] = standardBrackets();
    expect(chainedFollowers([a!, { ...b!, unitTypes: ['SHOP'] }], 0)).toEqual([]);
    expect(chainedFollowers([a!, { ...b!, levels: '2' }], 0)).toEqual([]);
    expect(chainedFollowers([{ ...a!, maxArea: '' }, b!], 0)).toEqual([]);
  });
});

describe('coverage', () => {
  it('draws the flat and the house priced alike as one bar with no gap', () => {
    const scales = coverage(standardBrackets());
    expect(scales).toHaveLength(1);
    expect(scales[0]!.unitTypes).toEqual(['APARTMENT', 'INDEPENDENT_HOUSE']);
    expect(scales[0]!.steps.every((step) => step.kind === 'bracket' && !step.overlaps)).toBe(true);
    expect(scales[0]!.steps[0]).toMatchObject({ code: 'A', min: 0, max: 100 });
    expect(scales[0]!.steps.at(-1)).toMatchObject({ code: 'I', min: 501, max: null });
  });

  it('marks a gap and an overlap where they fall, in order of area, both ends of each included', () => {
    const rows = [
      bracket({ code: 'B', minArea: '120', maxArea: '200' }),
      bracket({ code: 'A', minArea: '0', maxArea: '100' }),
      bracket({ code: 'C', minArea: '150', maxArea: '' }),
    ];
    expect(coverage(rows)[0]!.steps).toEqual([
      { kind: 'bracket', index: 1, code: 'A', min: 0, max: 100, overlaps: false },
      { kind: 'gap', from: 101, to: 119 },
      { kind: 'bracket', index: 0, code: 'B', min: 120, max: 200, overlaps: false },
      { kind: 'bracket', index: 2, code: 'C', min: 150, max: null, overlaps: true },
    ]);
  });

  it('keeps scales apart, and leaves out a bracket whose area is not typed yet', () => {
    const rows = [
      bracket({ code: 'A', unitTypes: ['APARTMENT'], minArea: '0', maxArea: '' }),
      bracket({ code: 'S', unitTypes: ['SHOP'], minArea: '0', maxArea: '' }),
      bracket({ code: 'D', unitTypes: ['APARTMENT'], levels: '2', minArea: '', maxArea: '' }),
    ];
    const scales = coverage(rows);
    expect(scales.map((scale) => [scale.unitTypes, scale.levels])).toEqual([
      [['APARTMENT'], 1],
      [['SHOP'], 1],
    ]);
  });
});

describe('the scope’s warnings (0100)', () => {
  const unoccupied = ['OWNER_OCCUPIED', 'RENTED', 'FREE_OCCUPIED', 'SEASONAL', 'VACANT'] as const;

  it('raises none for a notice that charges what the law does', () => {
    expect(noticeWarnings(draft())).toEqual([]);
    expect(noticeWarnings(draft({ bearer: 'OWNER' }))).toEqual([]);
  });

  it('warns of an occupancy fee on empty units, of a status left out, and of a kind of file left out', () => {
    expect(noticeWarnings(draft({ unitStates: [...unoccupied] }))).toEqual(['UNOCCUPIED_CHARGED']);
    expect(noticeWarnings(draft({ unitStates: ['OWNER_OCCUPIED'] }))).toEqual(['STATE_LEFT_OUT']);
    expect(noticeWarnings(draft({ residences: ['RESIDENT'] }))).toEqual(['RESIDENCE_LEFT_OUT']);
    // Under FLAT the statuses decide nothing, so they warn of nothing.
    expect(noticeWarnings(draft({ basis: 'FLAT', unitStates: ['VACANT'] }))).toEqual([]);
  });

  it('sends the warnings only once confirmed — and the server refuses the notice without them', () => {
    const warned = draft({ unitStates: [...unoccupied] });
    const issue = (values: typeof warned) => ({ ...issuePayload(values), clientRequestId: '00000000-0000-4000-8000-000000000000' });
    expect(issuePayload(warned).acknowledgedWarnings).toBeUndefined();
    expect(createFeeNoticeSchema.safeParse(issue(warned)).success).toBe(false);
    const confirmed = { ...warned, scopeConfirmed: true };
    expect(issuePayload(confirmed).acknowledgedWarnings).toEqual(['UNOCCUPIED_CHARGED']);
    expect(createFeeNoticeSchema.safeParse(issue(confirmed)).success).toBe(true);
    expect(createFeeNoticeSchema.safeParse(issue(draft())).success).toBe(true);
  });

  it('refuses a notice to everyone with no category ticked, on the categories', () => {
    expect(noticeIssues(draft({ categories: [] })).targetCategories).toBe('اختر نوعاً واحداً على الأقل');
  });
});

describe('«مدّ الفئة»: a bracket priced at more levels', () => {
  const D = bracket({
    code: 'D',
    labelAr: 'الفئة د',
    unitTypes: ['APARTMENT', 'SHOP'],
    minArea: '100',
    maxArea: '150',
    amount: '1,000,000',
  });
  const E = bracket({ code: 'E', labelAr: 'الفئة هـ', unitTypes: ['APARTMENT'], minArea: '150', amount: '2,000,000' });

  it('adds the duplex, then the triplex, under the row, coded D-2 and D-3, its price left to type', () => {
    const once = extendBracket([D, E], D.key);
    const twice = extendBracket(once, D.key);
    expect(twice.map((row) => row.code)).toEqual(['D', 'D-2', 'D-3', 'E']);
    expect(twice.map((row) => row.levels)).toEqual(['1', '2', '3', '1']);
    expect(twice[1]).toMatchObject({ extendsKey: D.key, labelAr: 'الفئة د', minArea: '100', maxArea: '150', amount: '' });
  });

  it('keeps every unit type of its base on screen, and sends the dwellings among them: a shop has no duplex', () => {
    const all = bracket({ code: 'A', labelAr: 'أ', unitTypes: [...PRICED_UNIT_TYPES], minArea: '0', maxArea: '', amount: '1' });
    const table = extendBracket([all], all.key).map((row) => (row.extendsKey ? { ...row, amount: '2' } : row));
    expect(table[1]!.unitTypes).toEqual([...PRICED_UNIT_TYPES]);
    expect(presetOf(table[1]!.unitTypes)).toBe('all');
    expect(toMatrix(table)[1]!.unitTypes).toEqual(['APARTMENT', 'INDEPENDENT_HOUSE']);
    expect(matrixIssues(table).ok).toBe(true);
  });

  it('gives every row its own key, so an extension never follows another row', () => {
    const keys = new Set(Array.from({ length: 500 }, () => emptyBracket().key));
    expect(keys.size).toBe(500);
  });

  it('stops at the most levels a dwelling has, and offers nothing for a bracket with no dwelling type', () => {
    let table: BracketDraft[] = [D];
    for (let press = 0; press < 10; press += 1) table = extendBracket(table, D.key);
    expect(extensionsOf(table, D.key).map((row) => row.levels)).toEqual(['2', '3', '4', '5', '6']);
    expect(nextExtensionLevels(table, D.key)).toBeNull();
    const shops = bracket({ code: 'S', unitTypes: ['SHOP'] });
    expect(nextExtensionLevels([shops], shops.key)).toBeNull();
    expect(nextExtensionLevels(table, table[1]!.key)).toBeNull();
  });

  it('keeps an extension in step with its base, and drops it with the base', () => {
    const table = extendBracket([D, E], D.key);
    const renamed = withExtensions(table.map((row) => (row.key === D.key ? { ...row, code: 'X', maxArea: '160' } : row)));
    expect(renamed[1]).toMatchObject({ code: 'X-2', maxArea: '160', amount: '' });
    expect(withExtensions(renamed.filter((row) => row.key !== D.key)).map((row) => row.code)).toEqual(['E']);
  });

  it('sends each extension as a bracket on its own scale, which the schema takes', () => {
    const table = withExtensions(
      extendBracket([{ ...D, unitTypes: ['APARTMENT'], minArea: '0', maxArea: '' }], D.key).map((row) =>
        row.extendsKey ? { ...row, amount: '1,800,000' } : row,
      ),
    );
    expect(toMatrix(table)[1]).toMatchObject({ code: 'D-2', levels: 2, amount: 1800000, unitTypes: ['APARTMENT'] });
    expect(matrixIssues(table).ok).toBe(true);
  });

  it('starts «أضف فئة» from the last bracket of its own, not from an extension', () => {
    const table = extendBracket([D], D.key);
    const added = nextBracket(table);
    expect(added).toMatchObject({ levels: '1', minArea: '151' });
    expect(added.extendsKey).toBeUndefined();
  });
});

describe('«الوحدات المشمولة»: occupied, vacant or both', () => {
  it('splits the six statuses by the unoccupied set of the enum, a seasonal home among the occupied', () => {
    expect(occupancyStates('OCCUPIED')).toEqual(['OWNER_OCCUPIED', 'RENTED', 'FREE_OCCUPIED', 'SEASONAL']);
    expect(occupancyStates('VACANT')).toEqual(['VACANT', 'UNDER_CONSTRUCTION']);
    expect(occupancyStates('ALL')).toHaveLength(6);
  });

  it('reads a list back as one of the three, in any order, or as a mix', () => {
    expect(occupancyOf(['UNDER_CONSTRUCTION', 'VACANT'])).toBe('VACANT');
    expect(occupancyOf(['RENTED', 'VACANT'])).toBeNull();
  });

  it('follows the bearer when the choice is what it charges anyway, and sends the list otherwise', () => {
    expect(unitStatesFor('OCCUPIED', 'OCCUPANT')).toBeNull();
    expect(unitStatesFor('ALL', 'OWNER')).toBeNull();
    expect(unitStatesFor('VACANT', 'OCCUPANT')).toEqual(['VACANT', 'UNDER_CONSTRUCTION']);
    expect(unitStatesFor('ALL', 'OCCUPANT')).toHaveLength(6);
  });

  it('asks for confirmation before an occupancy fee reaches an empty unit', () => {
    expect(noticeWarnings(draft({ basis: 'PER_UNIT', bearer: 'OCCUPANT', unitStates: unitStatesFor('VACANT', 'OCCUPANT') })).length).toBeGreaterThan(0);
  });
});
