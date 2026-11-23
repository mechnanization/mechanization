import {
  ARREARS_LINE_ISSUE,
  sameMoney,
  type ArrearsComponent,
  type ArrearsImportResult,
  type ArrearsLineDrop,
  type ArrearsLineIssue,
  type ArrearsLineVerdict,
} from '@mechanization/shared-schemas';

/**
 * Why «سطر منفرد» was refused (`ARREARS_LINE_REFUSED`): the issue codes the server
 * sends in `details.issues`, the ones this build can word (`arrears.issue.*`), in
 * order and once each. Empty for any other refusal or shape.
 */
export function refusedLineIssues(payload: { code?: unknown; details?: unknown } | null | undefined): ArrearsLineIssue[] {
  if (!payload || payload.code !== 'ARREARS_LINE_REFUSED') return [];
  const issues = (payload.details as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  const known = new Set<string>(ARREARS_LINE_ISSUE);
  return [...new Set(issues.filter((issue): issue is ArrearsLineIssue => typeof issue === 'string' && known.has(issue)))];
}

/**
 * Old debts' import screen (task 7, docs/old-debts-plan.md §4–§6): the rules the
 * preview and the reconcile panel apply, pure, so they are tested without a
 * browser. The server judges the file again on every press; nothing here decides
 * a line, it decides only what the screen asks the accountant before sending.
 */

/** One line of the file: its row and its component (a row's principal and its penalty are two lines). */
export function lineKey(line: { row: number; component: ArrearsComponent | null }): string {
  return `${line.row}|${line.component ?? ''}`;
}

/** What the accountant chose for a flagged line. A drop carries its reason. */
export type LineDecision = { choice: 'KEEP' } | { choice: 'DROP'; reason: string };

/** The least a drop's reason may be, as `arrearsLineDropSchema` holds it. */
export const DROP_REASON_MIN = 3;

/**
 * A line that needs the accountant's explicit keep or drop before the file is
 * saved: a unit read destroyed or not habitable (decision 11), a person not on
 * the register yet («للمطابقة», decision 8), an archived file (decision 12). A
 * line prescription dropped is decided by the rule, and a refused one cannot be
 * kept at all: it is fixed in the file.
 */
export function needsDecision(line: ArrearsLineVerdict): boolean {
  if (line.status === 'REFUSED' || line.flags.prescribed) return false;
  if (line.status === 'UNMATCHED') return true;
  return Boolean(line.flags.war || line.flags.archived);
}

/**
 * The flagged lines still without a decision. A line the server already shows
 * dropped by the accountant (sent in an earlier check) counts as decided.
 */
export function undecidedLines(
  lines: readonly ArrearsLineVerdict[],
  decisions: ReadonlyMap<string, LineDecision>,
): ArrearsLineVerdict[] {
  return lines.filter((line) => {
    if (!needsDecision(line)) return false;
    const decision = decisions.get(lineKey(line));
    if (!decision) return true;
    return decision.choice === 'DROP' && decision.reason.trim().length < DROP_REASON_MIN;
  });
}

/** The drops to send with the import, from the decisions on lines the latest check still lists. */
export function dropsOf(
  lines: readonly ArrearsLineVerdict[],
  decisions: ReadonlyMap<string, LineDecision>,
): ArrearsLineDrop[] {
  const drops: ArrearsLineDrop[] = [];
  for (const line of lines) {
    if (!line.component) continue;
    const decision = decisions.get(lineKey(line));
    if (decision?.choice === 'DROP' && decision.reason.trim().length >= DROP_REASON_MIN) {
      drops.push({ row: line.row, component: line.component, reason: decision.reason.trim() });
    }
  }
  return drops;
}

/** Why the checked file cannot be saved into the draft yet, or null when it can. */
export function writeBlocker(
  result: ArrearsImportResult,
  decisions: ReadonlyMap<string, LineDecision>,
): 'CUTOFF_NOT_SET' | 'REFUSED_ROWS' | 'UNDECIDED' | 'NOTHING' | null {
  if (result.cutoffYear === null) return 'CUTOFF_NOT_SET';
  if (result.totals.refused.count > 0) return 'REFUSED_ROWS';
  if (undecidedLines(result.lines, decisions).length > 0) return 'UNDECIDED';
  if (result.lines.length === 0) return 'NOTHING';
  return null;
}

/**
 * The control total («مجموع الصفحات»), as the accountant added up the pages he
 * copied, against the file's sum — every line read, kept, dropped and unmatched
 * alike, since the pages hold all of them (old-debts-plan §4.4). To the cent.
 */
export function reconciles(fileTotal: number, controlTotal: number | null): boolean {
  return controlTotal !== null && sameMoney(fileTotal, controlTotal);
}
