import { describe, expect, it } from 'vitest';
import { emptyBracket, matrixIssues, noticePayload, toMatrix, type BracketDraft, type NoticeDraft } from './fee-notice-draft';

const bracket = (over: Partial<BracketDraft>): BracketDraft => ({ ...emptyBracket(), touched: true, ...over });

const A = bracket({ code: 'A', labelAr: 'الفئة أ', minArea: '0', maxArea: '100', amount: '1,000,000' });
const B = bracket({ code: 'B', labelAr: 'الفئة ب', minArea: '100', maxArea: '', amount: '1,500,000' });

const draft = (over: Partial<NoticeDraft> = {}): NoticeDraft => ({
  title: 'رسم النظافة',
  amount: '500,000',
  basis: 'PER_UNIT',
  bearer: 'OCCUPANT',
  frequency: 'ANNUALLY',
  targetType: 'ALL_CITIZENS',
  targetCategory: 'SHOP',
  targetCitizenId: '',
  dueDate: '2026-12-31',
  instructions: '',
  matrixBrackets: [],
  ...over,
});

describe('toMatrix', () => {
  it('reads the typed figures, Arabic-Indic digits and separators included, and an empty ceiling as none', () => {
    expect(toMatrix([bracket({ code: ' A ', labelAr: 'أ', minArea: '٠', maxArea: '١٠٠٫٥', amount: '١٬٠٠٠٬٠٠٠' })])).toMatchObject([
      { code: 'A', minArea: 0, amount: 1_000_000 },
    ]);
    expect(toMatrix([B])[0]!.maxArea).toBeNull();
  });
});

describe('matrixIssues', () => {
  it('takes a table that runs from one bracket into the next', () => {
    expect(matrixIssues([A, B]).ok).toBe(true);
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
  it('sends a category only with a notice aimed at one — a default left on «جميع المواطنين» narrowed what it charged', () => {
    expect(noticePayload(draft()).targetCategory).toBeUndefined();
    expect(noticePayload(draft({ targetType: 'BUILDING_CATEGORY' })).targetCategory).toBe('SHOP');
  });

  it('sends a citizen only with a notice to one', () => {
    expect(noticePayload(draft({ targetCitizenId: 'abc' })).targetCitizenId).toBeUndefined();
    expect(noticePayload(draft({ targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: 'abc' })).targetCitizenId).toBe('abc');
  });

  it('sends the table with an amount of 0 under TIERED_AREA, and no table under any other basis', () => {
    const tiered = noticePayload(draft({ basis: 'TIERED_AREA', amount: '999', matrixBrackets: [A, B] }));
    expect(tiered.amount).toBe(0);
    expect(tiered.matrixBrackets).toHaveLength(2);
    const perUnit = noticePayload(draft({ matrixBrackets: [A] }));
    expect(perUnit).toMatchObject({ amount: 500_000 });
    expect(perUnit.matrixBrackets).toBeUndefined();
  });
});
