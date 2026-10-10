import {
  sameMoney,
  varianceOf,
  type DailyCountLineView,
  type RecordDailyCountInput,
} from '@mechanization/shared-schemas';
import { formatTypedAmount } from './currency';
import { parseOpeningAmount } from './treasury-input';

/**
 * «جرد الصندوق» as the screen holds it: what was typed beside each wallet, and
 * what that means against the books. Pure, so the rules can be tested without
 * rendering the sheet.
 *
 * The server computes the books' figure and the difference itself and refuses
 * a count made against a figure that has since moved; this only lets the
 * screen show the same difference while the accountant types (FRM-4), and send
 * exactly the wallets that have something new to say.
 */

/** What a difference is, in words: the colour on screen only repeats it (COL-3). */
export type VarianceKind = 'MATCH' | 'SURPLUS' | 'SHORTAGE';

export function varianceKind(difference: number): VarianceKind {
  if (sameMoney(difference, 0)) return 'MATCH';
  return difference > 0 ? 'SURPLUS' : 'SHORTAGE';
}

/** Whole pounds for ليرة; cents for anything else. */
export function countDecimals(currency: string): 0 | 2 {
  return currency === 'LBP' ? 0 : 2;
}

/** One wallet's box and reason, as typed. */
export interface CountDraft {
  raw: string;
  reason: string;
}

/**
 * The box as the sheet opens: the recorded count, so a correction starts from
 * what was found last time. Empty when there is none — and when the books have
 * moved since it was taken, because that figure was compared against books
 * that no longer exist, and re-saving it unchanged would only restamp it.
 */
export function initialDraft(line: DailyCountLineView): CountDraft {
  if (!line.count || line.count.stale) return { raw: '', reason: '' };
  return {
    raw: formatTypedAmount(String(line.count.countedAmount), countDecimals(line.account.currency)),
    reason: line.count.varianceReason ?? '',
  };
}

export type DraftVerdict =
  | { state: 'EMPTY' }
  | { state: 'INVALID'; reason: 'notNumber' | 'decimals' | 'tooLarge' }
  | {
      state: 'READY';
      counted: number;
      /** counted − the books as they stand now. */
      difference: number;
      kind: VarianceKind;
      /** A difference with no reason typed: the server would refuse it. */
      needsReason: boolean;
      /** Something the server does not have yet: a first count, a recount, a new reason, or a stale count re-taken. */
      changed: boolean;
    };

/** One wallet's box, judged against the books. */
export function judgeDraft(line: DailyCountLineView, draft: CountDraft): DraftVerdict {
  const parsed = parseOpeningAmount(draft.raw);
  if (!parsed.ok) return parsed.reason === 'required' ? { state: 'EMPTY' } : { state: 'INVALID', reason: parsed.reason };

  const difference = varianceOf(parsed.value, line.expectedAmount);
  const kind = varianceKind(difference);
  const reason = draft.reason.trim();
  const count = line.count;
  const changed =
    !count ||
    count.stale ||
    !sameMoney(count.countedAmount, parsed.value) ||
    (count.varianceReason ?? '') !== reason;

  return { state: 'READY', counted: parsed.value, difference, kind, needsReason: kind !== 'MATCH' && reason === '', changed };
}

export type DraftProblem = 'notNumber' | 'decimals' | 'tooLarge' | 'reasonRequired';

/**
 * The request «سجّل الجرد» sends, or the boxes that stop it.
 *
 * Only wallets with something new go: re-sending an unchanged count would
 * restamp who counted it and when, which is the record of who actually did.
 * An empty box is a wallet not counted yet, never a zero.
 */
export function countPayload(
  businessDate: string,
  lines: readonly DailyCountLineView[],
  drafts: Readonly<Record<string, CountDraft>>,
): { input: RecordDailyCountInput | null; problems: Record<string, DraftProblem> } {
  const problems: Record<string, DraftProblem> = {};
  const counts: RecordDailyCountInput['counts'] = [];

  for (const line of lines) {
    const draft = drafts[line.account.id] ?? initialDraft(line);
    const verdict = judgeDraft(line, draft);
    if (verdict.state === 'EMPTY') continue;
    if (verdict.state === 'INVALID') {
      problems[line.account.id] = verdict.reason;
      continue;
    }
    if (!verdict.changed) continue;
    if (verdict.needsReason) {
      problems[line.account.id] = 'reasonRequired';
      continue;
    }
    counts.push({
      accountId: line.account.id,
      expectedAmount: line.expectedAmount,
      countedAmount: verdict.counted,
      varianceReason: draft.reason.trim() || undefined,
    });
  }

  const blocked = Object.keys(problems).length > 0;
  return { input: !blocked && counts.length > 0 ? { businessDate, counts } : null, problems };
}

/**
 * Whether any box holds something the server does not have yet — closing waits
 * for it to be saved, so the day is never signed off on figures still on screen.
 * An emptied box is not one: a count can be replaced, never withdrawn.
 */
export function hasUnsavedCounts(
  lines: readonly DailyCountLineView[],
  drafts: Readonly<Record<string, CountDraft>>,
): boolean {
  return lines.some((line) => {
    const draft = drafts[line.account.id];
    if (!draft) return false;
    const verdict = judgeDraft(line, draft);
    if (verdict.state === 'INVALID') return true;
    return verdict.state === 'READY' && verdict.changed;
  });
}
