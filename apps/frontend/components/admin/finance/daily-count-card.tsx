'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, HandCoins, Landmark, Smartphone, Wallet, type LucideIcon } from 'lucide-react';
import { getLabels, type TreasuryAccountType } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  logApiError,
  recordDailyCount,
  type DailyCountLineView,
  type DailyCountSheet,
} from '@/lib/api-client';
import { currencyUnit, formatMoney, formatTypedAmount } from '@/lib/currency';
import {
  countDecimals,
  countPayload,
  initialDraft,
  judgeDraft,
  type CountDraft,
  type DraftProblem,
  varianceKind,
  type VarianceKind,
} from '@/lib/daily-count';
import { formatDateTime } from '@/lib/dates';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

const REASON_MAX = 500;

/** The picture a wallet gets, by what it is — the treasury page's own choice. */
const WALLET_ICON: Record<TreasuryAccountType, LucideIcon> = {
  CASH_SAFE: Banknote,
  WHISH_ACCOUNT: Smartphone,
  BANK_ACCOUNT: Landmark,
  COLLECTOR_CUSTODY: HandCoins,
  PETTY_CASH: Wallet,
};

/**
 * A difference is attention, either way: a surplus has to be explained as
 * much as a shortage. `warning` for both (COL-2), and the word says which.
 */
const VARIANCE_BADGE: Record<VarianceKind, NonNullable<BadgeProps['variant']>> = {
  MATCH: 'soft-success',
  SURPLUS: 'soft-warning',
  SHORTAGE: 'soft-warning',
};

/**
 * «جرد الحسابات» — every counted wallet, the books' figure beside the box the
 * accountant types what was found into, and the difference as it is typed.
 *
 * The boxes belong to the page (`drafts`), not to this card: the close button
 * below must know when a figure on screen has not been saved, so the day is
 * never closed on numbers that only the browser holds.
 *
 * Saving sends only the wallets with something new (`countPayload`): an
 * unchanged count re-sent would restamp who counted it and when. The money
 * never moves here — a difference is recorded with its reason, not posted.
 */
export function DailyCountCard({
  sheet,
  tenant,
  token,
  locale,
  editable,
  readOnlyNote,
  drafts,
  onDraftChange,
  onSaved,
}: {
  sheet: DailyCountSheet;
  tenant: string;
  token: string;
  locale: string;
  /** The role may count and the day is not closed. */
  editable: boolean;
  /** Why the boxes are not offered, when they are not. */
  readOnlyNote: string | null;
  drafts: Record<string, CountDraft>;
  onDraftChange: (accountId: string, draft: CountDraft) => void;
  /** After a save has landed and the sheet has been read again. */
  onSaved: () => void;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.sheet');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [problems, setProblems] = useState<Record<string, DraftProblem>>({});
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const draftOf = (line: DailyCountLineView) => drafts[line.account.id] ?? initialDraft(line);

  const change = (accountId: string, draft: CountDraft) => {
    onDraftChange(accountId, draft);
    // The mark goes when the box is touched; the next save judges it again (FRM-2).
    if (problems[accountId]) {
      setProblems((current) => {
        const { [accountId]: _cleared, ...rest } = current;
        return rest;
      });
    }
    setNote(null);
    setFailure(null);
  };

  const save = async (): Promise<void> => {
    if (inFlight.current) return;
    const { input, problems: found } = countPayload(sheet.day.businessDate, sheet.lines, drafts);
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      setNote(t('fixFirst'));
      // Focus the first box that stops the save (FRM-2).
      const first = sheet.lines.find((line) => found[line.account.id]);
      if (first) {
        const target = found[first.account.id] === 'reasonRequired' ? `reason-${first.account.id}` : `count-${first.account.id}`;
        document.getElementById(target)?.focus();
      }
      return;
    }
    if (!input) {
      setNote(t('nothingNew'));
      return;
    }
    setNote(null);

    inFlight.current = true;
    setBusy(true);
    try {
      await recordDailyCount(tenant, token, input);
      // Awaited, so the boxes are cleared onto the saved figures, not onto the old sheet.
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      onSaved();
      toast.success(t('saved'), { description: t('savedBody', { count: input.counts.length }) });
    } catch (error) {
      logApiError(error);
      // The message for the code, kept beside the button with every figure still typed (STA-3).
      setFailure(error instanceof Error ? error.message : String(error));
      // The books moved under the sheet: read them again so the new figure is on screen.
      if (error instanceof ApiRequestError && error.code === 'COUNT_EXPECTED_CHANGED') {
        void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="daily-count-heading">
      <Card className="overflow-hidden">
        <div className="space-y-1 border-b px-4 py-3 sm:px-5">
          <h2 id="daily-count-heading" className="text-base font-semibold">
            {t('heading')}
          </h2>
          {editable ? <p className="text-xs text-muted-foreground">{t('intro')}</p> : null}
        </div>

        <ul className="divide-y">
          {sheet.lines.map((line) => (
            <CountLine
              key={line.account.id}
              line={line}
              draft={draftOf(line)}
              problem={problems[line.account.id] ?? null}
              editable={editable}
              locale={locale}
              onChange={(draft) => change(line.account.id, draft)}
            />
          ))}
        </ul>

        <div className="space-y-3 border-t bg-muted/30 px-4 py-3 sm:px-5">
          {failure ? (
            <Alert variant="destructive" live="alert">
              {failure}
            </Alert>
          ) : null}
          {editable ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {note}
              </p>
              <Button onClick={() => void save()} disabled={busy} className="w-full sm:w-auto">
                {busy ? t('saving') : t('save')}
              </Button>
            </div>
          ) : readOnlyNote ? (
            <p className="text-xs text-muted-foreground">{readOnlyNote}</p>
          ) : null}
        </div>
      </Card>
    </section>
  );
}

/** One wallet: its books, its box, its difference, and why. */
function CountLine({
  line,
  draft,
  problem,
  editable,
  locale,
  onChange,
}: {
  line: DailyCountLineView;
  draft: CountDraft;
  problem: DraftProblem | null;
  editable: boolean;
  locale: string;
  onChange: (draft: CountDraft) => void;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.sheet');
  const labels = getLabels(locale);
  const { account, count } = line;
  const Icon = WALLET_ICON[account.type] ?? Wallet;

  /*
    On a locked or read-only sheet the recorded count is the figure shown; on
    an open one, what is typed — judged against the books as they stand now.
  */
  const verdict = editable ? judgeDraft(line, draft) : null;
  const shown =
    verdict?.state === 'READY'
      ? { difference: verdict.difference, kind: verdict.kind }
      : !editable && count
        ? { difference: count.difference, kind: varianceKind(count.difference) }
        : null;
  const reasonShown = editable
    ? (verdict?.state === 'READY' && verdict.kind !== 'MATCH') || draft.reason.trim() !== ''
    : Boolean(count?.varianceReason);

  const boxId = `count-${account.id}`;
  const reasonId = `reason-${account.id}`;
  const problemText =
    problem && problem !== 'reasonRequired' ? t(`problems.${problem}`) : undefined;

  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium" title={account.name}>
              {account.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {labels.treasuryAccountType[account.type]} · {account.currency}
            </p>
          </div>
          {!account.active ? <Badge variant="soft-muted">{t('inactive')}</Badge> : null}
        </div>
        <div className="text-end">
          <p className="text-xs text-muted-foreground">{t('expected')}</p>
          <TreasuryAmount amount={line.expectedAmount} currency={account.currency} locale={locale} className="text-lg font-semibold" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        {editable ? (
          <Field htmlFor={boxId} label={t('countedFor', { name: isolate(account.name) })} error={problemText} required>
            <CurrencyInput
              id={boxId}
              unit={currencyUnit(account.currency, locale)}
              value={draft.raw}
              placeholder="0"
              invalid={Boolean(problemText)}
              onChange={(value) => onChange({ ...draft, raw: formatTypedAmount(value, countDecimals(account.currency)) })}
            />
          </Field>
        ) : (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('counted')}</p>
            {count ? (
              <TreasuryAmount amount={count.countedAmount} currency={account.currency} locale={locale} className="font-semibold" />
            ) : (
              <p className="text-sm text-muted-foreground">{t('notCounted')}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:justify-end" aria-live="polite">
          <span className="text-xs text-muted-foreground">{t('difference')}</span>
          {shown ? (
            <>
              <Badge variant={VARIANCE_BADGE[shown.kind]}>{t(`kind.${shown.kind}`)}</Badge>
              {shown.kind !== 'MATCH' ? (
                <TreasuryAmount
                  amount={Math.abs(shown.difference)}
                  currency={account.currency}
                  locale={locale}
                  className="text-sm font-semibold text-warning"
                />
              ) : null}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {reasonShown ? (
        editable ? (
          <Field
            htmlFor={reasonId}
            label={t('reason')}
            required
            error={problem === 'reasonRequired' ? t('problems.reasonRequired') : undefined}
          >
            <Textarea
              id={reasonId}
              rows={2}
              maxLength={REASON_MAX}
              value={draft.reason}
              placeholder={t('reasonPlaceholder')}
              aria-invalid={problem === 'reasonRequired' || undefined}
              onChange={(event) => onChange({ ...draft, reason: event.target.value })}
            />
          </Field>
        ) : (
          <p className="text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t('reason')}: </span>
            {count?.varianceReason}
          </p>
        )
      ) : null}

      {count?.stale ? (
        <Alert variant="warning" live="status">
          {t('stale', {
            before: formatMoney(count.expectedAmount, account.currency, locale),
            after: formatMoney(line.expectedAmount, account.currency, locale),
          })}
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          {count ? t('countedBy', { name: count.countedByName ?? '—', date: formatDateTime(count.countedAt) }) : t('notCounted')}
        </p>
      )}
    </li>
  );
}

/**
 * A wallet's name inside a sentence, isolated (FSI … PDI) — `<bdi>` for a plain string, since `Field`'s
 * label is one (RTL-2). Without it an Arabic name in an English label turns the «» around it.
 */
function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}
