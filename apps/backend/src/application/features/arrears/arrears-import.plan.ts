import {
  ARREARS_PRESCRIPTION_YEARS,
  arrearsLineMode,
  arrearsLumpSumYear,
  normalizeArabic,
  normalizeDigits,
  parseArrearsRow,
  type ArrearsComponent,
  type ArrearsLineMode,
  type ArrearsCoverage,
  type ArrearsFeeType,
  type ArrearsFigure,
  type ArrearsImportTotals,
  type ArrearsLineDecision,
  type ArrearsLineDrop,
  type ArrearsLineFlags,
  type ArrearsLineIssue,
  type ArrearsLineVerdict,
  type ArrearsTemplateCells,
} from '@mechanization/shared-schemas';

/**
 * The old-debts import's checks (task 4, docs/old-debts-plan.md §6), pure: the
 * service reads the register and the settings, and this decides what becomes of
 * every line. The dry run and the write run the same function, the write inside
 * the transaction that holds the batch's lock.
 */

/** The reason a prescribed line is dropped with (decision 14). */
export const PRESCRIPTION_DROP_REASON = 'مرور الزمن';

/**
 * Decision 14: a debt older than 5 years is dropped. The default chosen, still
 * to be confirmed (open-decisions §23.2): the years count from 31 December of
 * the debt's year, so a line of year Y stands through 31 December of Y + 5 and is
 * prescribed from 1 January of Y + 6. `today` is a `YYYY-MM-DD` on the
 * municipality's calendar; the comparison is on the ISO strings.
 */
export function prescriptionEnds(year: number): string {
  return `${year + ARREARS_PRESCRIPTION_YEARS}-12-31`;
}

export function isPrescribed(year: number, today: string): boolean {
  return today > prescriptionEnds(year);
}

/** The oldest year a line may be on `today` and not be prescribed. */
export function oldestKeptYear(today: string): number {
  return Number(today.slice(0, 4)) - ARREARS_PRESCRIPTION_YEARS;
}

/**
 * The key of `arrears_lines_one_live_key`, as the index computes it: the citizen,
 * the رقم العقار with Eastern digits folded and edges trimmed, the unit code
 * trimmed and upper-cased ('' for none), the year, the fee type, the component.
 */
export function arrearsLineKey(line: {
  citizenId: string;
  propertyNumber: string;
  unitCode: string | null;
  year: number;
  feeType: string;
  component: string;
}): string {
  return [
    line.citizenId.toLowerCase(),
    normalizeDigits(line.propertyNumber.trim()),
    (line.unitCode ?? '').trim().toUpperCase(),
    line.year,
    line.feeType,
    line.component,
  ].join('|');
}

/** A unit code compared as the register spells it: digits folded, trimmed, upper case. */
export function unitCodeKey(code: string): string {
  return normalizeDigits(code.trim()).toUpperCase();
}

/**
 * Where the «one mode per رقم العقار» rule is judged: a citizen (or, for a line
 * with no file, the name as the books wrote it) on one رقم العقار, digits folded.
 */
export function propertyModeKey(owner: string, propertyNumber: string): string {
  return `${owner.toLowerCase()}|${normalizeDigits(propertyNumber.trim())}`;
}

/**
 * How the live lines already enter each citizen's debts on each رقم العقار:
 * itemised, «رصيد إجمالي», or (after a merge brought two files together) both.
 */
export function liveModesOf(
  lines: readonly { citizenId: string | null; propertyNumber: string; feeType: string }[],
): Map<string, Set<ArrearsLineMode>> {
  const modes = new Map<string, Set<ArrearsLineMode>>();
  for (const line of lines) {
    if (line.citizenId === null) continue;
    const key = propertyModeKey(line.citizenId, line.propertyNumber);
    const set = modes.get(key) ?? new Set<ArrearsLineMode>();
    set.add(arrearsLineMode(line.feeType));
    modes.set(key, set);
  }
  return modes;
}

/** True when a line entered as `mode` would sit beside lines entered the other way. */
export function conflictsWithMode(existing: ReadonlySet<ArrearsLineMode> | undefined, mode: ArrearsLineMode): boolean {
  if (!existing) return false;
  for (const other of existing) if (other !== mode) return true;
  return false;
}

/** A citizen in the batch's set, by row key. */
export interface ArrearsMember {
  citizenId: string;
  name: string;
  archived: boolean;
  /** Folded into another file by «دمج ملفين» since the export. */
  mergedAway: boolean;
  /** The units they hold now, on an open spell. */
  heldUnitIds: ReadonlySet<string>;
}

/** A unit a row names, found by its full code. */
export interface ArrearsUnit {
  unitId: string;
  /** The full code as stored, «<building>-<unit>». */
  code: string;
  /** Its building's رقم العقار and the ones it shares, digits folded. */
  propertyNumbers: readonly string[];
  /** Its current reading, when it says the unit is destroyed or not habitable (decision 11). */
  war: { level: string; habitable: boolean | null; assessedAt: string } | null;
}

export interface ArrearsImportContext {
  today: string;
  cutoffYear: number | null;
  /** Row number of the first row in the accountant's file. */
  startRow: number;
  members: ReadonlyMap<number, ArrearsMember>;
  /** By `unitCodeKey`. */
  units: ReadonlyMap<string, ArrearsUnit>;
  /** The live lines of every other batch, by `arrearsLineKey`. */
  liveKeys: ReadonlySet<string>;
  /** The same lines' modes, by `propertyModeKey` (`liveModesOf`): «رصيد إجمالي» or itemised. */
  liveModes: ReadonlyMap<string, ReadonlySet<ArrearsLineMode>>;
  drops: readonly ArrearsLineDrop[];
  controlTotal: number | null;
}

/** A line to write into the draft. */
export interface PlannedArrearsLine {
  row: number;
  rowKey: number | null;
  citizenId: string | null;
  sourceName: string | null;
  propertyNumber: string;
  unitId: string | null;
  unitCode: string | null;
  year: number;
  feeType: ArrearsFeeType;
  feeTypeNote: string | null;
  component: ArrearsComponent;
  amount: number;
  dueDate: string | null;
  oldReference: string | null;
  note: string | null;
  decision: ArrearsLineDecision;
  dropReason: string | null;
  flags: ArrearsLineFlags;
}

export interface ArrearsImportPlan {
  verdicts: ArrearsLineVerdict[];
  /** The lines a write puts in the draft: kept, dropped and unmatched; never a refused one. */
  lines: PlannedArrearsLine[];
  totals: ArrearsImportTotals;
  coverage: ArrearsCoverage;
}

const cents = (amount: number) => Math.round(amount * 100);
const pounds = (sum: number) => sum / 100;

/** Decides every line of the file. */
export function planArrearsImport(rows: readonly ArrearsTemplateCells[], ctx: ArrearsImportContext): ArrearsImportPlan {
  const verdicts: ArrearsLineVerdict[] = [];
  const lines: PlannedArrearsLine[] = [];
  const dropsByLine = new Map<string, ArrearsLineDrop>(ctx.drops.map((drop) => [`${drop.row}|${drop.component}`, drop]));
  const dropsUsed = new Set<string>();
  const seenInFile = new Set<string>();
  // The first mode the file uses for each person on each رقم العقار.
  const modesInFile = new Map<string, ArrearsLineMode>();
  const membersWithLines = new Set<number>();
  const membersBlank = new Set<number>();
  const membersInFile = new Set<number>();

  rows.forEach((cells, index) => {
    const row = ctx.startRow + index;
    const parsed = parseArrearsRow(cells);

    if (parsed.rowKey !== null && ctx.members.has(parsed.rowKey)) membersInFile.add(parsed.rowKey);

    if (parsed.kind === 'BLANK') {
      if (parsed.rowKey !== null && ctx.members.has(parsed.rowKey)) membersBlank.add(parsed.rowKey);
      return;
    }

    if (parsed.kind === 'INVALID') {
      const member = parsed.rowKey !== null ? ctx.members.get(parsed.rowKey) : undefined;
      verdicts.push({
        row,
        rowKey: parsed.rowKey,
        name: member?.name ?? parsed.fullName,
        propertyNumber: normalizeDigits((cells.propertyNumber ?? '').trim()) || null,
        unitCode: (cells.unitCode ?? '').trim() || null,
        year: null,
        feeType: null,
        component: null,
        amount: null,
        status: 'REFUSED',
        issues: [...new Set(parsed.issues.map((entry) => entry.issue))],
        dropReason: null,
        flags: {},
      });
      return;
    }

    const member = parsed.rowKey !== null ? ctx.members.get(parsed.rowKey) : undefined;
    const unmatched = !member;
    const rowIssues: ArrearsLineIssue[] = [];
    if (unmatched && parsed.rowKey !== null && !parsed.fullName) rowIssues.push('ROW_KEY_NOT_IN_BATCH');
    if (member?.mergedAway) rowIssues.push('CITIZEN_MERGED_AWAY');
    // A «رصيد إجمالي» carries no year: it is filed under the last year before the cutoff.
    const year = parsed.year ?? (ctx.cutoffYear === null ? null : arrearsLumpSumYear(ctx.cutoffYear));
    if (ctx.cutoffYear === null) rowIssues.push('CUTOFF_NOT_SET');
    else if (year !== null && year >= ctx.cutoffYear) rowIssues.push('YEAR_NOT_BEFORE_CUTOFF');

    // One mode per person per رقم العقار: against the live lines, then the rest of the file.
    const mode = arrearsLineMode(parsed.feeType);
    const modeKey = propertyModeKey(member ? member.citizenId : `name:${normalizeArabic(parsed.fullName ?? '')}`, parsed.propertyNumber);
    const fileMode = modesInFile.get(modeKey);
    if ((member && conflictsWithMode(ctx.liveModes.get(modeKey), mode)) || (fileMode !== undefined && fileMode !== mode)) {
      rowIssues.push('MIXED_WITH_LUMP_SUM');
    } else if (fileMode === undefined) modesInFile.set(modeKey, mode);

    let unit: ArrearsUnit | undefined;
    if (parsed.unitCode !== null) {
      unit = ctx.units.get(unitCodeKey(parsed.unitCode));
      if (!unit || !unit.propertyNumbers.includes(parsed.propertyNumber)) rowIssues.push('UNIT_NOT_ON_PROPERTY');
    }

    const flags: ArrearsLineFlags = {};
    if (unit?.war) flags.war = unit.war;
    if (member?.archived) flags.archived = true;
    if (member && unit && !member.heldUnitIds.has(unit.unitId)) flags.unitNotHeld = true;

    const name = member?.name ?? parsed.fullName;

    // A lump sum with no cutoff to date it by: refused (`CUTOFF_NOT_SET` is among the row's issues).
    if (year === null) {
      for (const { component, amount } of parsed.lines) {
        verdicts.push({
          row,
          rowKey: parsed.rowKey,
          name,
          propertyNumber: parsed.propertyNumber,
          unitCode: parsed.unitCode,
          year: null,
          feeType: parsed.feeType,
          component,
          amount,
          status: 'REFUSED',
          issues: [...rowIssues],
          dropReason: null,
          flags: { ...flags },
        });
      }
      return;
    }

    const prescribed = isPrescribed(year, ctx.today);

    for (const { component, amount } of parsed.lines) {
      const issues = [...rowIssues];
      const lineFlags: ArrearsLineFlags = { ...flags };
      const dropKey = `${row}|${component}`;
      const accountantDrop = dropsByLine.get(dropKey);
      if (accountantDrop) dropsUsed.add(dropKey);

      let status: ArrearsLineVerdict['status'];
      let dropReason: string | null = null;
      if (issues.length > 0) status = 'REFUSED';
      else if (prescribed) {
        status = 'DROP';
        dropReason = PRESCRIPTION_DROP_REASON;
        lineFlags.prescribed = true;
      } else if (accountantDrop) {
        status = 'DROP';
        dropReason = accountantDrop.reason;
      } else status = unmatched ? 'UNMATCHED' : 'KEEP';

      // Duplicates: a kept line against the other batches' live lines and the
      // rest of the file; an unmatched one against the file, by the name as written.
      if (status === 'KEEP' || status === 'UNMATCHED') {
        // The unit as it will be stored (the register's spelling), as the index reads it.
        const debt = { propertyNumber: parsed.propertyNumber, unitCode: unit?.code ?? parsed.unitCode, year, feeType: parsed.feeType, component };
        const key = member
          ? arrearsLineKey({ citizenId: member.citizenId, ...debt })
          : `name:${normalizeArabic(parsed.fullName ?? '')}|${arrearsLineKey({ citizenId: '', ...debt })}`;
        if (member && ctx.liveKeys.has(key)) {
          status = 'REFUSED';
          issues.push('DUPLICATE_LIVE_LINE');
        } else if (seenInFile.has(key)) {
          status = 'REFUSED';
          issues.push('DUPLICATE_IN_FILE');
        } else seenInFile.add(key);
      }

      verdicts.push({
        row,
        rowKey: parsed.rowKey,
        name,
        propertyNumber: parsed.propertyNumber,
        unitCode: parsed.unitCode,
        year,
        feeType: parsed.feeType,
        component,
        amount,
        status,
        issues,
        dropReason,
        flags: lineFlags,
      });

      if (status === 'REFUSED') continue;
      if (member && parsed.rowKey !== null) membersWithLines.add(parsed.rowKey);
      lines.push({
        row,
        rowKey: member ? parsed.rowKey : null,
        citizenId: member?.citizenId ?? null,
        sourceName: member ? null : parsed.fullName,
        propertyNumber: parsed.propertyNumber,
        unitId: unit?.unitId ?? null,
        unitCode: unit ? unit.code : parsed.unitCode,
        year,
        feeType: parsed.feeType,
        feeTypeNote: parsed.feeTypeNote,
        component,
        amount,
        dueDate: parsed.dueDate,
        oldReference: parsed.oldReference,
        note: parsed.note,
        decision: status === 'DROP' ? 'DROP' : 'KEEP',
        dropReason,
        flags: lineFlags,
      });
    }
  });

  // A drop that names no line of the file: refused, so the accountant sees it.
  for (const drop of ctx.drops) {
    if (dropsUsed.has(`${drop.row}|${drop.component}`)) continue;
    verdicts.push({
      row: drop.row,
      rowKey: null,
      name: null,
      propertyNumber: null,
      unitCode: null,
      year: null,
      feeType: null,
      component: drop.component,
      amount: null,
      status: 'REFUSED',
      issues: ['DROP_NOT_A_LINE'],
      dropReason: drop.reason,
      flags: {},
    });
  }

  return { verdicts, lines, totals: totalsOf(verdicts, ctx.controlTotal), coverage: coverageOf(ctx, membersWithLines, membersBlank, membersInFile) };
}

function totalsOf(verdicts: readonly ArrearsLineVerdict[], controlTotal: number | null): ArrearsImportTotals {
  const figure = (keep: (verdict: ArrearsLineVerdict) => boolean): ArrearsFigure => {
    const chosen = verdicts.filter(keep);
    return { count: chosen.length, amount: pounds(chosen.reduce((sum, verdict) => sum + cents(verdict.amount ?? 0), 0)) };
  };
  const kept = figure((verdict) => verdict.status === 'KEEP');
  const dropped = figure((verdict) => verdict.status === 'DROP');
  const unmatched = figure((verdict) => verdict.status === 'UNMATCHED');
  return {
    kept,
    dropped,
    prescribed: figure((verdict) => verdict.status === 'DROP' && verdict.flags.prescribed === true),
    unmatched,
    refused: { count: verdicts.filter((verdict) => verdict.status === 'REFUSED').length },
    fileTotal: pounds(cents(kept.amount) + cents(dropped.amount) + cents(unmatched.amount)),
    controlTotal,
  };
}

function coverageOf(
  ctx: ArrearsImportContext,
  withLines: ReadonlySet<number>,
  blank: ReadonlySet<number>,
  inFile: ReadonlySet<number>,
): ArrearsCoverage {
  let checkedNothingOwed = 0;
  for (const rowKey of blank) if (!withLines.has(rowKey)) checkedNothingOwed += 1;
  return {
    citizens: ctx.members.size,
    withLines: withLines.size,
    checkedNothingOwed,
    notInFile: [...ctx.members.keys()].filter((rowKey) => !inFile.has(rowKey)).length,
  };
}
