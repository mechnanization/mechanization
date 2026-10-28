import {
  bracketScales,
  cancelNoticeSchema,
  createFeeNoticeSchema,
  feeMatrixBracketSchema,
  feeMatrixSchema,
  feeNoticePreviewSchema,
  matchBracket,
  type FeeMatrixBracket,
} from '@mechanization/shared-schemas';
import { assessCitizen } from './fees.service';

/**
 * «الرسم حسب فئة المساحة» — the bracket table of a TIERED_AREA notice (0098,
 * 0099; decisions D1 and D7, docs/fees-system-rearchitecture-specification.md).
 *
 * Each (unit type, level count) is its own scale. On a scale the brackets run
 * one into the next: a range includes its minimum and stops short of its
 * maximum, no two overlap, none leaves a gap, and only the last is open-ended.
 */

/** A bracket on the one-level flat scale unless told otherwise. */
const bracket = (
  over: Partial<FeeMatrixBracket> & Pick<FeeMatrixBracket, 'code' | 'minArea' | 'maxArea'>,
): FeeMatrixBracket => ({
  labelAr: `الفئة ${over.code}`,
  unitTypes: ['APARTMENT'],
  levels: 1,
  amount: 1_000_000,
  ...over,
});

const A = bracket({ code: 'A', minArea: 0, maxArea: 100 });
const B = bracket({ code: 'B', minArea: 100, maxArea: 150, amount: 1_500_000 });
const C = bracket({ code: 'C', minArea: 150, maxArea: null, amount: 2_000_000 });

/** The messages a failed parse raised, with the path each sits on. */
function issues(result: {
  success: boolean;
  error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
}) {
  return result.success
    ? []
    : result.error!.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

describe('feeMatrixBracketSchema', () => {
  it('takes a bracket and defaults its level count to one', () => {
    const { levels, ...withoutLevels } = A;
    const parsed = feeMatrixBracketSchema.parse(withoutLevels);
    expect(levels).toBe(1);
    expect(parsed.levels).toBe(1);
  });

  it('refuses a ceiling at or below the floor', () => {
    expect(issues(feeMatrixBracketSchema.safeParse({ ...A, minArea: 100, maxArea: 100 }))).toEqual([
      { path: 'maxArea', message: 'الحد الأعلى للمساحة يجب أن يكون أكبر من الحد الأدنى' },
    ]);
  });

  it('refuses levels on a type that cannot span them — a shop with a mezzanine stays one level', () => {
    const result = feeMatrixBracketSchema.safeParse({ ...A, unitTypes: ['APARTMENT', 'SHOP'], levels: 2 });
    expect(issues(result).map((issue) => issue.path)).toEqual(['levels']);
  });

  it('takes a duplex bracket for dwellings, a flat or a house', () => {
    expect(feeMatrixBracketSchema.safeParse({ ...A, unitTypes: ['APARTMENT', 'INDEPENDENT_HOUSE'], levels: 2 }).success).toBe(true);
  });

  it('refuses an area with more than two decimals, a negative area and a unit type named twice', () => {
    expect(feeMatrixBracketSchema.safeParse({ ...A, maxArea: 100.555 }).success).toBe(false);
    expect(feeMatrixBracketSchema.safeParse({ ...A, minArea: -1 }).success).toBe(false);
    expect(feeMatrixBracketSchema.safeParse({ ...A, unitTypes: ['APARTMENT', 'APARTMENT'] }).success).toBe(false);
  });

  it('refuses an amount in fractions of a pound, as every notice amount is whole', () => {
    expect(feeMatrixBracketSchema.safeParse({ ...A, amount: 1_000_000.5 }).success).toBe(false);
  });
});

describe('feeMatrixSchema', () => {
  it('takes brackets that run one into the next, the last open-ended', () => {
    expect(feeMatrixSchema.safeParse([A, B, C]).success).toBe(true);
  });

  it('takes them in any order: the scale is sorted, not the table', () => {
    expect(feeMatrixSchema.safeParse([C, A, B]).success).toBe(true);
  });

  it('refuses two brackets that overlap (T-1)', () => {
    const overlapping = bracket({ code: 'B', minArea: 90, maxArea: 150 });
    expect(issues(feeMatrixSchema.safeParse([A, overlapping]))).toEqual([
      { path: '1.minArea', message: 'الفئة «B» تتداخل مع الفئة «A» في المساحة' },
    ]);
  });

  it('refuses a gap between two brackets (T-2), which an area of 100.5 m² would fall into', () => {
    const afterGap = bracket({ code: 'B', minArea: 101, maxArea: 150 });
    expect(issues(feeMatrixSchema.safeParse([A, afterGap]))).toEqual([
      { path: '1.minArea', message: 'بين الفئة «A» والفئة «B» مساحات لا تقع في أي فئة' },
    ]);
  });

  it('refuses an open-ended bracket that is not the last on its scale', () => {
    const openA = bracket({ code: 'A', minArea: 0, maxArea: null });
    expect(issues(feeMatrixSchema.safeParse([openA, B])).map((issue) => issue.path)).toEqual(['1.minArea']);
  });

  it('refuses a code used twice, since a bill names its bracket by code', () => {
    const dwellingB = bracket({ code: 'A', minArea: 100, maxArea: null });
    expect(issues(feeMatrixSchema.safeParse([A, dwellingB]))).toEqual([
      { path: '1.code', message: 'الرمز «A» مستعمل لفئة أخرى' },
    ]);
  });

  it('keeps each unit type and level count on its own scale (D1, D7)', () => {
    const shop = bracket({ code: 'S1', unitTypes: ['SHOP'], minArea: 0, maxArea: null, amount: 3_000_000 });
    const duplex = bracket({ code: 'D1', levels: 2, minArea: 0, maxArea: null, amount: 2_500_000 });
    // Each overlaps A on area, but on another scale, so none of them collides.
    expect(feeMatrixSchema.safeParse([A, B, C, shop, duplex]).success).toBe(true);
  });

  it('lets a scale start above zero: a smaller unit is reported, not priced by guess', () => {
    expect(feeMatrixSchema.safeParse([bracket({ code: 'A', minArea: 20, maxArea: null })]).success).toBe(true);
  });

  it('refuses an empty table', () => {
    expect(issues(feeMatrixSchema.safeParse([]))).toEqual([{ path: '', message: 'أضف فئة واحدة على الأقل' }]);
  });
});

describe('bracketScales', () => {
  it('puts a bracket naming two unit types on both scales, each sorted by its floor', () => {
    const both = bracket({ code: 'X', unitTypes: ['APARTMENT', 'OFFICE'], minArea: 100, maxArea: null });
    const scales = bracketScales([both, A]);
    const codes = scales.map((scale) => scale.map(({ bracket: row }) => row.code));
    expect(codes).toEqual([['A', 'X'], ['X']]);
  });
});

describe('createFeeNoticeSchema under TIERED_AREA', () => {
  const notice = {
    title: 'رسم القيمة التأجيرية',
    frequency: 'ANNUALLY',
    targetType: 'ALL_CITIZENS',
    dueDate: '2026-12-31',
    clientRequestId: '6f1c1f0e-8d4b-4a8e-9a43-1f0f7c9d2a11',
  } as const;

  it('takes a bracket table with an amount of 0', () => {
    const parsed = createFeeNoticeSchema.parse({ ...notice, basis: 'TIERED_AREA', amount: 0, matrixBrackets: [A, B, C] });
    expect(parsed.matrixBrackets).toHaveLength(3);
  });

  it('asks for the table when the basis is TIERED_AREA', () => {
    expect(issues(createFeeNoticeSchema.safeParse({ ...notice, basis: 'TIERED_AREA', amount: 0 }))).toEqual([
      { path: 'matrixBrackets', message: 'أدخل جدول الفئات' },
    ]);
  });

  it('refuses an amount beside the table: the brackets carry the money', () => {
    const result = createFeeNoticeSchema.safeParse({ ...notice, basis: 'TIERED_AREA', amount: 500_000, matrixBrackets: [A] });
    expect(issues(result).map((issue) => issue.path)).toEqual(['amount']);
  });

  it('refuses a table under any other basis', () => {
    const result = createFeeNoticeSchema.safeParse({ ...notice, basis: 'PER_AREA', amount: 5_000, matrixBrackets: [A] });
    expect(issues(result)).toEqual([{ path: 'matrixBrackets', message: 'جدول الفئات للرسم حسب فئة المساحة وحده' }]);
  });

  it('still refuses an amount of 0 under every other basis, with the words it always used', () => {
    expect(issues(createFeeNoticeSchema.safeParse({ ...notice, basis: 'FLAT', amount: 0 }))).toEqual([
      { path: 'amount', message: 'المبلغ يجب أن يكون أكبر من صفر' },
    ]);
    expect(createFeeNoticeSchema.safeParse({ ...notice, basis: 'FLAT', amount: 500_000 }).success).toBe(true);
  });

  it('reports a bad bracket at its place in the table', () => {
    const result = createFeeNoticeSchema.safeParse({
      ...notice,
      basis: 'TIERED_AREA',
      amount: 0,
      matrixBrackets: [A, bracket({ code: 'B', minArea: 90, maxArea: null })],
    });
    expect(issues(result).map((issue) => issue.path)).toEqual(['matrixBrackets.1.minArea']);
  });

  it('previews the same notice without a retry key, by the same rules', () => {
    const { clientRequestId, ...withoutKey } = notice;
    expect(clientRequestId).toBeDefined();
    expect(feeNoticePreviewSchema.safeParse({ ...withoutKey, basis: 'TIERED_AREA', amount: 0, matrixBrackets: [A] }).success).toBe(true);
    expect(feeNoticePreviewSchema.safeParse({ ...withoutKey, basis: 'TIERED_AREA', amount: 0 }).success).toBe(false);
  });
});

describe('a notice’s category (D13)', () => {
  const flat = {
    title: 'رسم النظافة',
    amount: 50_000,
    basis: 'PER_UNIT',
    frequency: 'MONTHLY',
    dueDate: '2026-12-31',
    clientRequestId: '6f1c1f0e-8d4b-4a8e-9a43-1f0f7c9d2a11',
  } as const;

  it('refuses a category on a notice to all citizens or to one: it would narrow what is charged to that category', () => {
    expect(issues(createFeeNoticeSchema.safeParse({ ...flat, targetType: 'ALL_CITIZENS', targetCategory: 'SHOP' }))).toEqual([
      { path: 'targetCategory', message: 'الفئة للرسم الموجّه إلى فئة عقارات وحده' },
    ]);
    const citizen = { targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: '0c5a7a65-58a3-4a54-9b0c-c4f0d81b6a0e' } as const;
    expect(issues(createFeeNoticeSchema.safeParse({ ...flat, ...citizen, targetCategory: 'SHOP' })).map((issue) => issue.path)).toEqual([
      'targetCategory',
    ]);
    expect(createFeeNoticeSchema.safeParse({ ...flat, targetType: 'ALL_CITIZENS' }).success).toBe(true);
  });

  it('still takes, and still asks for, the category of a notice aimed at one', () => {
    expect(createFeeNoticeSchema.safeParse({ ...flat, targetType: 'BUILDING_CATEGORY', targetCategory: 'SHOP' }).success).toBe(true);
    expect(issues(createFeeNoticeSchema.safeParse({ ...flat, targetType: 'BUILDING_CATEGORY' })).map((issue) => issue.path)).toEqual([
      'targetCategory',
    ]);
  });
});

describe('cancelNoticeSchema (D12)', () => {
  const reason = 'صدر بالجدول الخطأ';

  it('takes the periods named, in every shape a period key has', () => {
    expect(cancelNoticeSchema.safeParse({ reason, periodKeys: ['2026-07', '2026-H2', '2026', 'ONCE'] }).success).toBe(true);
  });

  it('refuses a cancel that names no period, a period twice, or something that is not a period', () => {
    expect(cancelNoticeSchema.safeParse({ reason }).success).toBe(false);
    expect(cancelNoticeSchema.safeParse({ reason, periodKeys: [] }).success).toBe(false);
    expect(cancelNoticeSchema.safeParse({ reason, periodKeys: ['2026-07', '2026-07'] }).success).toBe(false);
    expect(cancelNoticeSchema.safeParse({ reason, periodKeys: ['2026-13'] }).success).toBe(false);
    expect(cancelNoticeSchema.safeParse({ reason, periodKeys: ['all'] }).success).toBe(false);
  });
});

describe('matchBracket', () => {
  const table = [A, B, C, bracket({ code: 'D', levels: 2, minArea: 0, maxArea: null })];

  it('puts an area on a boundary in the bracket that starts there (T-3)', () => {
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 100 }, table)).toMatchObject({ bracket: { code: 'B' } });
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 99.99 }, table)).toMatchObject({ bracket: { code: 'A' } });
  });

  it('reads the level count to pick the scale', () => {
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 220, levels: 2 }, table)).toMatchObject({ bracket: { code: 'D' } });
  });

  it('misses a unit of a listed type with no area, or with no bracket for its level count or area', () => {
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: null }, table)).toEqual({ kind: 'miss', reason: 'NO_AREA' });
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 220, levels: 3 }, table)).toEqual({
      kind: 'miss',
      reason: 'NO_BRACKET',
    });
  });

  it('says a type the table never names, or a unit with no type, is outside the table — area or not (D11)', () => {
    expect(matchBracket({ unitType: 'SHOP', unitArea: 80 }, table)).toEqual({ kind: 'miss', reason: 'NOT_IN_TABLE' });
    expect(matchBracket({ unitType: 'SHOP', unitArea: null }, table)).toEqual({ kind: 'miss', reason: 'NOT_IN_TABLE' });
    expect(matchBracket({ unitType: null, unitArea: 80 }, table)).toEqual({ kind: 'miss', reason: 'NOT_IN_TABLE' });
  });

  it('keeps a scale that starts above zero a gap, not outside the table', () => {
    const fromFifty = [bracket({ code: 'M', minArea: 50, maxArea: null })];
    expect(matchBracket({ unitType: 'APARTMENT', unitArea: 30 }, fromFifty)).toEqual({ kind: 'miss', reason: 'NO_BRACKET' });
  });
});

describe('assessCitizen under TIERED_AREA', () => {
  it('refuses a bracket notice that reached it without its table', () => {
    expect(() => assessCitizen([], { amount: 0, basis: 'TIERED_AREA' })).toThrow('without its bracket table');
  });
});
