import {
  REOPEN_REASON_MIN,
  sameMoney,
  varianceOf,
  type CloseDayInput,
  type DailyCountLineView,
  type DailyCountSheet,
  type DayClosureVerdict,
  type RecordDailyCountInput,
} from '@mechanization/shared-schemas';
import { formatTypedAmount } from './currency';
import { formatDay } from './dates';
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

/** `recount`: the books moved under a refused save, so the figure and its reason are typed again. */
export type DraftProblem = 'notNumber' | 'decimals' | 'tooLarge' | 'reasonRequired' | 'recount';

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

/**
 * The boxes after a save has landed: cleared onto the saved figures, except
 * any touched while the request was in flight.
 *
 * `sent` is the drafts as they stood when «سجّل الجرد» built its request.
 * Clearing everything on success threw away a correction typed after that —
 * the box snapped back to the figure just saved, `hasUnsavedCounts` went
 * false, and the close was offered on a count the accountant had just
 * corrected. A box whose figure or reason differs from `sent` is kept, and so
 * still holds the close until it is saved.
 */
export function draftsAfterSave(
  current: Readonly<Record<string, CountDraft>>,
  sent: Readonly<Record<string, CountDraft>>,
): Record<string, CountDraft> {
  const kept: Record<string, CountDraft> = {};
  for (const [accountId, draft] of Object.entries(current)) {
    const before = sent[accountId];
    if (!before || before.raw !== draft.raw || before.reason !== draft.reason) kept[accountId] = draft;
  }
  return kept;
}

/** The wallets a `COUNT_EXPECTED_CHANGED` refusal names (`details.accounts[].accountId`). */
export function movedAccounts(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const accounts = (details as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts
    .map((row) => (row && typeof row === 'object' ? (row as { accountId?: unknown }).accountId : undefined))
    .filter((id): id is string => typeof id === 'string');
}

/**
 * The boxes after a save refused because the books moved (`COUNT_EXPECTED_CHANGED`).
 *
 * The moved wallets' figure and reason are emptied, not kept: the reason was
 * written for the old difference, and kept, a second press filed it against
 * the new one — the very thing the server's refusal exists to stop. Emptied,
 * the wallet is counted again against the figure now on screen, and a
 * difference asks for its own reason. The other wallets keep what was typed.
 */
export function draftsAfterExpectedChanged(
  current: Readonly<Record<string, CountDraft>>,
  moved: readonly string[],
): Record<string, CountDraft> {
  const next: Record<string, CountDraft> = { ...current };
  for (const accountId of moved) next[accountId] = { raw: '', reason: '' };
  return next;
}

/**
 * «أقفل اليومية» as the dialog sends it: the day, and every count the dialog
 * listed with its `countedAt`, so the server can refuse a close confirmed on
 * counts that were replaced while the dialog was open (`COUNT_CHANGED_SINCE_LOADED`).
 */
export function closeRequest(sheet: Pick<DailyCountSheet, 'day' | 'lines'>): CloseDayInput {
  return {
    businessDate: sheet.day.businessDate,
    counts: sheet.lines.flatMap((line) =>
      line.count ? [{ accountId: line.account.id, countedAt: line.count.countedAt }] : [],
    ),
  };
}

/**
 * Whether a close whose answer was lost went through: a re-read of that day
 * finds it CLOSED. Read by the day, not by «the next day to close», which a
 * committed close has already moved on.
 */
export function closeLanded(reread: Pick<DailyCountSheet, 'day'> | null, businessDate: string): boolean {
  return reread !== null && reread.day.businessDate === businessDate && reread.day.status === 'CLOSED';
}

/** Days in a sentence: `09/10/2026، 10/10/2026` in Arabic, `09/10/2026, 10/10/2026` in English. */
export function dayList(days: readonly string[], locale: string): string {
  return days.map(formatDay).join(locale === 'en' ? ', ' : '، ');
}

/**
 * The values a closure verdict's message names, as the page shows them: the
 * day in the page's own `dd/mm/yyyy`, never the wire's ISO form.
 */
export function verdictParams(
  verdict: Extract<DayClosureVerdict, { ok: false }>,
  businessDate: string,
): { date: string; count: number; min: number } {
  return {
    date: formatDay(verdict.day ?? businessDate),
    count: verdict.days ?? verdict.accounts ?? 0,
    min: REOPEN_REASON_MIN,
  };
}
