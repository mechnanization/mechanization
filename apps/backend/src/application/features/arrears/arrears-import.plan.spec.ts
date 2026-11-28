import type { ArrearsTemplateCells } from '@mechanization/shared-schemas';
import {
  PRESCRIPTION_DROP_REASON,
  arrearsLineKey,
  conflictsWithMode,
  isPrescribed,
  liveModesOf,
  oldestKeptYear,
  planArrearsImport,
  prescriptionEnds,
  propertyModeKey,
  type ArrearsImportContext,
  type ArrearsMember,
  type ArrearsUnit,
} from './arrears-import.plan';

/**
 * The import's checks (task 4, docs/old-debts-plan.md §6). Every case starts
 * from a row the plan keeps and changes one thing, so a verdict can only be
 * that thing's.
 */

const CITIZEN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const UNIT = '33333333-3333-4333-8333-333333333333';

const member = (over: Partial<ArrearsMember> = {}): ArrearsMember => ({
  citizenId: CITIZEN,
  name: 'أحمد علي حسن',
  archived: false,
  mergedAway: false,
  heldUnitIds: new Set([UNIT]),
  ...over,
});

const unit = (over: Partial<ArrearsUnit> = {}): ArrearsUnit => ({
  unitId: UNIT,
  code: 'Z-1-420-A-0002',
  propertyNumbers: ['420'],
  war: null,
  ...over,
});

const context = (over: Partial<ArrearsImportContext> = {}): ArrearsImportContext => ({
  today: '2026-11-21',
  cutoffYear: 2026,
  startRow: 1,
  members: new Map([[1, member()]]),
  units: new Map([['Z-1-420-A-0002', unit()]]),
  liveKeys: new Set(),
  liveModes: new Map(),
  drops: [],
  controlTotal: null,
  ...over,
});

const row = (cells: ArrearsTemplateCells = {}): ArrearsTemplateCells => ({
  rowKey: '1',
  fullName: 'أحمد علي حسن',
  propertyNumber: '420',
  unitCode: 'Z-1-420-A-0002',
  year: '2023',
  feeType: 'RENTAL_VALUE',
  principal: '100000',
  ...cells,
});

const only = (rows: ArrearsTemplateCells[], ctx = context()) => {
  const plan = planArrearsImport(rows, ctx);
  expect(plan.verdicts).toHaveLength(1);
  return { plan, verdict: plan.verdicts[0]! };
};

describe('prescription (decision 14)', () => {
  it('lets a year stand through 31 December five years on, and drops it the day after', () => {
    expect(prescriptionEnds(2020)).toBe('2025-12-31');
    expect(isPrescribed(2020, '2025-12-31')).toBe(false);
    expect(isPrescribed(2020, '2026-01-01')).toBe(true);
  });

  it('names the oldest year still kept', () => {
    expect(oldestKeptYear('2026-11-21')).toBe(2021);
    expect(isPrescribed(2021, '2026-11-21')).toBe(false);
    expect(isPrescribed(2020, '2026-11-21')).toBe(true);
  });
});

describe('planArrearsImport', () => {
  it('keeps a good row, as a line on the citizen with the register’s unit', () => {
    const { plan, verdict } = only([row()]);
    expect(verdict).toMatchObject({ status: 'KEEP', issues: [], name: 'أحمد علي حسن', amount: 100_000, flags: {} });
    expect(plan.lines).toEqual([
      expect.objectContaining({ citizenId: CITIZEN, unitId: UNIT, unitCode: 'Z-1-420-A-0002', decision: 'KEEP', dropReason: null, rowKey: 1 }),
    ]);
  });

  it('drops a prescribed line with «مرور الزمن», and counts it apart', () => {
    const { plan, verdict } = only([row({ year: '2020' })]);
    expect(verdict).toMatchObject({ status: 'DROP', dropReason: PRESCRIPTION_DROP_REASON, flags: { prescribed: true } });
    expect(plan.lines[0]).toMatchObject({ decision: 'DROP', dropReason: PRESCRIPTION_DROP_REASON });
    expect(plan.totals.prescribed).toEqual({ count: 1, amount: 100_000 });
    expect(plan.totals.dropped).toEqual({ count: 1, amount: 100_000 });
  });

  it('keeps the year the boundary still holds', () => {
    expect(only([row({ year: '2021' })]).verdict.status).toBe('KEEP');
  });

  it('refuses every line while no cutoff is set', () => {
    const { plan, verdict } = only([row()], context({ cutoffYear: null }));
    expect(verdict).toMatchObject({ status: 'REFUSED', issues: ['CUTOFF_NOT_SET'] });
    expect(plan.lines).toEqual([]);
  });

  it('refuses a year that is not before the cutoff', () => {
    expect(only([row({ year: '2026' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['YEAR_NOT_BEFORE_CUTOFF'] });
    expect(only([row({ year: '2025' })]).verdict.status).toBe('KEEP');
  });

  it('sends a row whose key is not in the batch, with a name, to «للمطابقة»', () => {
    const { plan, verdict } = only([row({ rowKey: '9', fullName: 'سمير خليل' })]);
    expect(verdict).toMatchObject({ status: 'UNMATCHED', name: 'سمير خليل' });
    expect(plan.lines[0]).toMatchObject({ citizenId: null, sourceName: 'سمير خليل', rowKey: null, decision: 'KEEP' });
  });

  it('never matches by name: the same name as a member, with no key, still waits', () => {
    expect(only([row({ rowKey: '', fullName: 'أحمد علي حسن' })]).verdict.status).toBe('UNMATCHED');
  });

  it('refuses a key not in the batch with no name', () => {
    expect(only([row({ rowKey: '9', fullName: '' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['ROW_KEY_NOT_IN_BATCH'] });
  });

  it('refuses a citizen merged away since the export', () => {
    const ctx = context({ members: new Map([[1, member({ mergedAway: true })]]) });
    expect(only([row()], ctx).verdict).toMatchObject({ status: 'REFUSED', issues: ['CITIZEN_MERGED_AWAY'] });
  });

  it('refuses a unit code that is not on the رقم العقار, or not in the register', () => {
    expect(only([row({ propertyNumber: '421' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['UNIT_NOT_ON_PROPERTY'] });
    expect(only([row({ unitCode: 'Z-1-420-A-0099' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['UNIT_NOT_ON_PROPERTY'] });
  });

  it('takes a unit on a رقم العقار its building shares, and a unit code typed loosely', () => {
    const ctx = context({ units: new Map([['Z-1-420-A-0002', unit({ propertyNumbers: ['420', '421'] })]]) });
    expect(only([row({ propertyNumber: '421', unitCode: ' z-1-420-a-٠٠٠٢ ' })], ctx).verdict.status).toBe('KEEP');
  });

  it('takes a row with no unit at all', () => {
    expect(only([row({ unitCode: '' })]).verdict).toMatchObject({ status: 'KEEP', unitCode: null });
  });

  it('notes a unit the citizen no longer holds, an archived file and war damage, and keeps the line', () => {
    const war = { level: 'DESTROYED', habitable: false, assessedAt: '2024-10-02T00:00:00.000Z' };
    const ctx = context({
      members: new Map([[1, member({ archived: true, heldUnitIds: new Set() })]]),
      units: new Map([['Z-1-420-A-0002', unit({ war })]]),
    });
    expect(only([row()], ctx).verdict).toMatchObject({ status: 'KEEP', flags: { war, archived: true, unitNotHeld: true } });
  });

  it("drops the line the accountant drops, with the accountant's reason, and only that component", () => {
    const ctx = context({ drops: [{ row: 1, component: 'PENALTY', reason: 'الوحدة مهدّمة منذ 2024' }] });
    const plan = planArrearsImport([row({ penalty: '5000' })], ctx);
    expect(plan.verdicts.map((verdict) => [verdict.component, verdict.status, verdict.dropReason])).toEqual([
      ['PRINCIPAL', 'KEEP', null],
      ['PENALTY', 'DROP', 'الوحدة مهدّمة منذ 2024'],
    ]);
  });

  it('refuses a drop that names no line of the file', () => {
    const plan = planArrearsImport([row()], context({ drops: [{ row: 7, component: 'PRINCIPAL', reason: 'سبب' }] }));
    expect(plan.verdicts[1]).toMatchObject({ row: 7, status: 'REFUSED', issues: ['DROP_NOT_A_LINE'] });
  });

  it('refuses the second of two identical lines in the file, and a line another batch holds', () => {
    const twice = planArrearsImport([row(), row({ unitCode: 'z-1-420-a-0002' })], context());
    expect(twice.verdicts.map((verdict) => verdict.status)).toEqual(['KEEP', 'REFUSED']);
    expect(twice.verdicts[1]!.issues).toEqual(['DUPLICATE_IN_FILE']);

    const live = arrearsLineKey({ citizenId: CITIZEN, propertyNumber: '420', unitCode: 'Z-1-420-A-0002', year: 2023, feeType: 'RENTAL_VALUE', component: 'PRINCIPAL' });
    expect(only([row()], context({ liveKeys: new Set([live]) })).verdict).toMatchObject({ status: 'REFUSED', issues: ['DUPLICATE_LIVE_LINE'] });
  });

  it('does not hold a dropped line to the duplicate rule', () => {
    const live = arrearsLineKey({ citizenId: CITIZEN, propertyNumber: '420', unitCode: 'Z-1-420-A-0002', year: 2020, feeType: 'RENTAL_VALUE', component: 'PRINCIPAL' });
    expect(only([row({ year: '2020' })], context({ liveKeys: new Set([live]) })).verdict.status).toBe('DROP');
  });

  it('refuses a row the parser cannot read, naming its cells', () => {
    expect(only([row({ year: '23' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['YEAR_INVALID'], name: 'أحمد علي حسن' });
  });

  it('adds the file up, and says who was checked', () => {
    const ctx = context({
      members: new Map([
        [1, member()],
        [2, member({ citizenId: OTHER, name: 'ثان' })],
        [3, member({ citizenId: '44444444-4444-4444-8444-444444444444', name: 'ثالث' })],
      ]),
      controlTotal: 1_000,
    });
    const plan = planArrearsImport(
      [
        row({ principal: '100000.10', penalty: '0.20' }),
        row({ year: '2019', principal: '50000' }),
        row({ rowKey: '', fullName: 'سمير', unitCode: '', principal: '7' }),
        row({ rowKey: '2', year: '', principal: '', feeType: '' }),
        row({ rowKey: '2', year: '2024', principal: 'x' }),
      ],
      ctx,
    );
    expect(plan.totals).toEqual({
      kept: { count: 2, amount: 100_000.3 },
      dropped: { count: 1, amount: 50_000 },
      prescribed: { count: 1, amount: 50_000 },
      unmatched: { count: 1, amount: 7 },
      refused: { count: 1 },
      fileTotal: 150_007.3,
      controlTotal: 1_000,
    });
    expect(plan.coverage).toEqual({ citizens: 3, withLines: 1, checkedNothingOwed: 1, notInFile: 1 });
    expect(plan.lines).toHaveLength(4);
  });
});

describe('«رصيد إجمالي» (LUMP_SUM, the decision of 2026-11-23)', () => {
  const lump = (cells: ArrearsTemplateCells = {}) => row({ year: '', feeType: 'LUMP_SUM', principal: '1500000', ...cells });

  it('keeps one amount with no year, filed under the last year before the cutoff', () => {
    const { plan, verdict } = only([lump()]);
    expect(verdict).toMatchObject({ status: 'KEEP', issues: [], year: 2025, feeType: 'LUMP_SUM', component: 'PRINCIPAL', amount: 1_500_000 });
    expect(plan.lines).toEqual([expect.objectContaining({ year: 2025, feeType: 'LUMP_SUM', decision: 'KEEP', citizenId: CITIZEN })]);
  });

  it('follows the cutoff it is dated by', () => {
    expect(only([lump()], context({ cutoffYear: 2024 })).verdict).toMatchObject({ status: 'KEEP', year: 2023 });
  });

  it('is never prescribed while it is within five years of its date', () => {
    // Dated 2025, it stands through 31 December 2030.
    expect(only([lump()], context({ today: '2030-12-31' })).verdict.status).toBe('KEEP');
  });

  it('refuses a lump sum while no cutoff is set, with nothing to write', () => {
    const { plan, verdict } = only([lump()], context({ cutoffYear: null }));
    expect(verdict).toMatchObject({ status: 'REFUSED', issues: ['CUTOFF_NOT_SET'], year: null, feeType: 'LUMP_SUM' });
    expect(plan.lines).toEqual([]);
  });

  it('refuses a year typed on it, and a penalty beside it', () => {
    expect(only([lump({ year: '2023' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['LUMP_SUM_YEAR_GIVEN'] });
    expect(only([lump({ penalty: '5000' })]).verdict).toMatchObject({ status: 'REFUSED', issues: ['LUMP_SUM_PENALTY'] });
  });

  it('reads «رصيد إجمالي» typed in Arabic', () => {
    expect(only([lump({ feeType: 'رصيد إجمالي' })]).verdict).toMatchObject({ status: 'KEEP', feeType: 'LUMP_SUM' });
  });

  it('refuses a lump sum and itemised lines for one person on one رقم العقار in the same file, either way round', () => {
    const detailedFirst = planArrearsImport([row(), lump()], context());
    expect(detailedFirst.verdicts.map((verdict) => [verdict.status, verdict.issues])).toEqual([
      ['KEEP', []],
      ['REFUSED', ['MIXED_WITH_LUMP_SUM']],
    ]);
    const lumpFirst = planArrearsImport([lump(), row()], context());
    expect(lumpFirst.verdicts.map((verdict) => verdict.status)).toEqual(['KEEP', 'REFUSED']);
    expect(lumpFirst.verdicts[1]!.issues).toEqual(['MIXED_WITH_LUMP_SUM']);
  });

  it('allows the other mode on another رقم العقار, or for another person', () => {
    const units = new Map([
      ['Z-1-420-A-0002', unit()],
      ['Z-1-500-A-0001', unit({ unitId: '55555555-5555-4555-8555-555555555555', code: 'Z-1-500-A-0001', propertyNumbers: ['500'] })],
    ]);
    const ctx = context({ units, members: new Map([[1, member()], [2, member({ citizenId: OTHER, name: 'ثان' })]]) });
    const plan = planArrearsImport([row(), lump({ propertyNumber: '500', unitCode: 'Z-1-500-A-0001' }), lump({ rowKey: '2' })], ctx);
    expect(plan.verdicts.map((verdict) => verdict.status)).toEqual(['KEEP', 'KEEP', 'KEEP']);
  });

  it('refuses the other mode against the live lines of another batch', () => {
    const itemised = liveModesOf([{ citizenId: CITIZEN, propertyNumber: '٤٢٠', feeType: 'RENTAL_VALUE' }]);
    expect(only([lump()], context({ liveModes: itemised })).verdict).toMatchObject({ status: 'REFUSED', issues: ['MIXED_WITH_LUMP_SUM'] });
    expect(only([row()], context({ liveModes: itemised })).verdict.status).toBe('KEEP');

    const lumped = liveModesOf([{ citizenId: CITIZEN, propertyNumber: '420', feeType: 'LUMP_SUM' }]);
    expect(only([row()], context({ liveModes: lumped })).verdict).toMatchObject({ status: 'REFUSED', issues: ['MIXED_WITH_LUMP_SUM'] });
  });

  it('holds a line with no file to the rule by the name as the books wrote it, within the file', () => {
    const plan = planArrearsImport(
      [row({ rowKey: '', fullName: 'سمير خليل', unitCode: '' }), lump({ rowKey: '', fullName: 'سمير خليل', unitCode: '' })],
      context(),
    );
    expect(plan.verdicts.map((verdict) => verdict.status)).toEqual(['UNMATCHED', 'REFUSED']);
    expect(plan.verdicts[1]!.issues).toEqual(['MIXED_WITH_LUMP_SUM']);
  });

  it('keys the mode on the person and the رقم العقار, digits folded, and sees a conflict only across modes', () => {
    expect(propertyModeKey(CITIZEN.toUpperCase(), ' ٤٢٠ ')).toBe(propertyModeKey(CITIZEN, '420'));
    const modes = liveModesOf([
      { citizenId: CITIZEN, propertyNumber: '420', feeType: 'CLEANING' },
      { citizenId: null, propertyNumber: '420', feeType: 'LUMP_SUM' },
    ]);
    expect(conflictsWithMode(modes.get(propertyModeKey(CITIZEN, '420')), 'DETAILED')).toBe(false);
    expect(conflictsWithMode(modes.get(propertyModeKey(CITIZEN, '420')), 'LUMP')).toBe(true);
    expect(conflictsWithMode(undefined, 'LUMP')).toBe(false);
  });
});
