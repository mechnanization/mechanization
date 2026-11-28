import {
  ar,
  isArrearsLumpSum,
  type ArrearsApprovalProblem,
  type ArrearsComponent,
  type ArrearsFeeType,
  type FeeAssessment,
} from '@mechanization/shared-schemas';
import { isPrescribed } from './arrears-import.plan';

/**
 * Old debts' approval and link, the rules without I/O (task 5,
 * docs/old-debts-plan.md §4.5 and §7): what a kept line is re-checked against on
 * the day the manager approves it, and the bill it becomes. The service reads
 * the register and writes; this decides.
 */

/** A stored line, as approval and the link read it. */
export interface StoredArrearsLine {
  id: string;
  citizenId: string | null;
  propertyNumber: string;
  unitCode: string | null;
  year: number;
  feeType: ArrearsFeeType;
  feeTypeNote: string | null;
  component: ArrearsComponent;
  amount: number;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  decision: 'KEEP' | 'DROP';
}

/**
 * The checks that can change between the dry run and the approval (§4.5): the
 * cutoff (the manager may have set or moved it), prescription (a day has
 * passed), and a citizen folded into another file since. Only a kept line that
 * has a citizen is checked — a dropped line raises nothing, and a «للمطابقة»
 * line is checked when it is linked. The duplicate check is not here: the
 * database's one-live-line index already makes a second live line of one debt
 * impossible, and the lines of another batch cannot have appeared since.
 *
 * Every problem is returned, not the first, so the manager sees all of what the
 * preparer must fix.
 */
export function approvalProblems(
  lines: readonly StoredArrearsLine[],
  ctx: { today: string; cutoffYear: number | null; mergedAway: ReadonlySet<string> },
): ArrearsApprovalProblem[] {
  const problems: ArrearsApprovalProblem[] = [];
  for (const line of lines) {
    if (line.decision !== 'KEEP' || line.citizenId === null) continue;
    if (ctx.cutoffYear === null) problems.push({ lineId: line.id, issue: 'CUTOFF_NOT_SET' });
    else if (line.year >= ctx.cutoffYear) problems.push({ lineId: line.id, issue: 'YEAR_NOT_BEFORE_CUTOFF' });
    if (isPrescribed(line.year, ctx.today)) problems.push({ lineId: line.id, issue: 'PRESCRIBED_SINCE_IMPORT' });
    if (ctx.mergedAway.has(line.citizenId)) problems.push({ lineId: line.id, issue: 'CITIZEN_MERGED_AWAY' });
  }
  return problems;
}

/** «متأخرات 2023 — رسم النظافة», and «… — غرامة» on a penalty line. «رسم آخر» says what it was. */
export function arrearsBillTitle(line: Pick<StoredArrearsLine, 'year' | 'feeType' | 'feeTypeNote' | 'component'>): string {
  const fee = line.feeType === 'OTHER' && line.feeTypeNote ? line.feeTypeNote : ar.arrearsFeeType[line.feeType];
  // A «رصيد إجمالي» is not one year's debt: its stored year only dates it before the cutoff.
  if (isArrearsLumpSum(line.feeType)) return `متأخرات سنوات سابقة — ${fee}`;
  const title = `متأخرات ${line.year} — ${fee}`;
  return line.component === 'PENALTY' ? `${title} — ${ar.arrearsComponent.PENALTY}` : title;
}

/** The line's own due date, else the last day of its year. A date, at midnight UTC as every due date is stored. */
export function arrearsDueDate(line: Pick<StoredArrearsLine, 'year' | 'dueDate'>): Date {
  return new Date(`${line.dueDate ?? `${line.year}-12-31`}T00:00:00.000Z`);
}

/**
 * The one-line assessment (basis FLAT) that lets «المستحق على عقار», and so
 * «براءة ذمة», see the bill: its رقم العقار and unit code (`parcelShareOf`), and
 * on the receipt `propertiesOf`.
 *
 * What it deliberately lacks is a `unitId`: the recurring biller's D8 guard
 * counts a unit as billed in a period by the lines' `unitId` of a **notice's**
 * bills, and an old debt has no notice, so it never counts as this period's
 * billing of the unit; leaving the id out keeps any reader that looks only at
 * lines from reading it as one. `propertyType` says what the line is.
 */
export function arrearsAssessment(
  line: Pick<StoredArrearsLine, 'propertyNumber' | 'unitCode' | 'amount'>,
): FeeAssessment {
  return {
    basis: 'FLAT',
    rate: line.amount,
    unitCount: 1,
    totalArea: 0,
    excludedUnitCount: 0,
    heldUnitCount: 0,
    uninhabitableUnitCount: 0,
    lines: [{ propertyNumber: line.propertyNumber, propertyType: 'ARREARS', unitType: null, unitArea: null, unitCode: line.unitCode }],
  } as FeeAssessment;
}
