'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { HandCoins, UserRound, Users } from 'lucide-react';
import { receiveCustodySchema, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCollectorCustody,
  logApiError,
  receiveCollectorCustody,
  type CollectorCustodyView,
} from '@/lib/api-client';
import { formatMoney, formatTypedAmount, parseAmount } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { heldKey, keyIsSpent, outcomeInDoubt, spendKey } from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

/** The unit segment of an amount field: «ل.ل», «$», or the code itself. */
function unitOf(currency: string, locale: string): string {
  if (currency === 'LBP') return locale === 'en' ? 'LBP' : 'ل.ل';
  return currency === 'USD' ? '$' : currency;
}

/**
 * «ما بعهدة الجباة» — what each collector is still carrying, and the way it
 * reaches the safe.
 *
 * This is the step between a citizen paying at his door and the money being the
 * municipality's. A collector's cash is credited to his own custody wallet, not
 * to the safe, precisely because it is still in his pocket on his motorbike; the
 * safe must never claim money nobody has counted. Here the accountant sees what
 * he is carrying, counts the notes against it, and receives it.
 *
 * Collectors with nothing are kept on the list rather than disappearing: «سلّم
 * كل شيء» is the answer the accountant needs at the end of a round, and a name
 * that vanishes on settling looks like one that never went out.
 *
 * «استلام الصندوق» is offered to the working roles on every row but the
 * signed-in person's own: a collector never receives his own custody — someone
 * else counts it (the server refuses with `CUSTODY_SELF_RECEIPT`), and a button
 * that can only be refused is not offered (CODE-4).
 */
export function CollectorCustodyPanel({
  tenant,
  base,
  token,
  locale,
  role,
  actorId,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  role: string | undefined;
  /** The signed-in staff member, whose own custody row offers no «استلام». */
  actorId: string | undefined;
}): React.JSX.Element | null {
  const t = useTranslations('finance.custody');
  const tCommon = useTranslations('common');
  const [receiving, setReceiving] = useState<CollectorCustodyView | null>(null);

  const canReceive = hasRole(TREASURY_WORK_ROLES, role);

  /*
    The handover retry keys, one per custody wallet (`custody:<accountId>`),
    held in `lib/request-id.ts` rather than in the dialog or this panel: the
    dialog unmounts when it closes, and the panel itself unmounted when a
    background re-read failed — an accountant who then opened the dialog again
    was retrying the same handover with a new key, and it was recorded twice.
    A key is minted the first time a wallet's dialog asks for one, kept across
    every failure, close and unmount, and dropped only when the server confirms
    its act exists (`keyIsSpent`, or a 2xx) — the next handover is a new act.
  */

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'custody'],
    queryFn: (accessToken, signal) => getCollectorCustody(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const rows = query.data ?? [];
  // Nothing to show before any collector has taken a single payment — but a read that failed is not «nothing».
  if (!query.loading && !query.error && rows.length === 0) return null;

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-start gap-3 space-y-0 border-b">
          {/* The same tinted tile the page heading carries, so a section reads as part of the page. */}
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
          >
            <HandCoins className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <p className="text-xs text-muted-foreground">{t('hint')}</p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {query.error ? (
            rows.length === 0 ? (
              /*
                Nothing was ever loaded, so there is no list to put a warning above:
                the panel says it could not be read and offers the retry, rather than
                vanishing as if no collector were carrying anything (STA-1).
              */
              <ErrorState compact title={query.error} onRetry={query.refetch} retryLabel={tCommon('retry')} />
            ) : (
              <div className="px-4 pt-4 sm:px-5">
                <Alert variant="warning" live="status">
                  {query.error}
                </Alert>
              </div>
            )
          ) : null}

          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.accountId}
                className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-colors duration-150 hover:bg-muted/30 sm:px-5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {/*
                    The first letter of his name, not a photograph: the register
                    holds none for staff, and a generic silhouette on every row
                    would tell the rows apart by nothing.
                  */}
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                  >
                    {row.collectorName?.trim().charAt(0) || <UserRound className="size-5" />}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{row.collectorName ?? t('unknownCollector')}</p>
                      {/*
                        An inference, not a report from the field — nothing records
                        whether a man is out on a round. «لم يخرج اليوم» with cash
                        still on him and «سلّم كل شيء» are different answers to
                        «أين علي؟», so they are different badges rather than one
                        vague tone (STA-2).
                      */}
                      <Badge
                        variant={
                          row.status === 'COLLECTING_TODAY'
                            ? 'soft-default'
                            : row.status === 'SETTLED'
                              ? 'soft-success'
                              : 'soft-muted'
                        }
                      >
                        {t(`status.${row.status}`)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.receiptsToday > 0
                        ? t('todayLine', {
                            receipts: row.receiptsToday,
                            amount: formatMoney(row.collectedToday, row.currency, locale),
                          })
                        : row.held > 0 && row.lastCollectedAt
                          ? t('lastCollected', { when: formatDateTime(row.lastCollectedAt) })
                          : t('settled')}
                    </p>
                  </div>
                </div>

                {/* What he carries, labelled — a bare figure beside a name does not say what it is. */}
                <div className="text-end">
                  <p className="text-xs text-muted-foreground">{t('receiveDialog.held')}</p>
                  <TreasuryAmount
                    amount={row.held}
                    currency={row.currency}
                    locale={locale}
                    className="text-lg font-semibold"
                  />
                </div>

                {/* Wraps: at 360px on /en/ the two labels do not fit one line, and the second was cut off. */}
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  {canReceive && row.held > 0 && row.collectorId !== actorId ? (
                    <Button size="sm" variant="outline" onClick={() => setReceiving(row)}>
                      {t('receive')}
                    </Button>
                  ) : null}
                  {/*
                    «من حصّل» — the receipts behind the figure. Offered whether or
                    not he is still carrying anything: a collector who has settled
                    is exactly the one whose round someone asks about afterwards.
                    Ghost beside the outline, so the figure and «استلام» stay the
                    things the eye lands on (PRIM-3).
                  */}
                  {row.collectorId ? (
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`${base}/finance/collectors/${row.collectorId}`}>
                        <Users className="size-4" aria-hidden />
                        {t('viewCollections')}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {receiving && token ? (
        <ReceiveCustodyDialog
          tenant={tenant}
          token={token}
          locale={locale}
          custody={receiving}
          retryKey={() => heldKey(tenant, `custody:${receiving.accountId}`)}
          onKeySpent={() => spendKey(tenant, `custody:${receiving.accountId}`)}
          onClose={() => setReceiving(null)}
        />
      ) : null}
    </>
  );
}

/**
 * «استلام صندوق الجابي» — the accountant records what was counted out.
 *
 * A dialog, not a page: it is one figure confirmed against a pile of notes
 * already on the desk, with the collector standing there. Nothing is typed at
 * length and nothing is lost if it closes.
 *
 * The amount is pre-filled with what he is carrying, because a full handover is
 * the ordinary case, and left editable because a partial one is normal too —
 * he may be passing the office, or the rest is in another currency. What is
 * refused is more than he holds.
 *
 * The retry key is the panel's (`retryKey`), so closing and reopening the
 * dialog after a lost answer retries the same handover. A field's own problem
 * is said under the field; the server's refusal is said for the form, in an
 * `Alert` above the buttons, because it is about the handover, not the box.
 */
function ReceiveCustodyDialog({
  tenant,
  token,
  locale,
  custody,
  retryKey,
  onKeySpent,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  custody: CollectorCustodyView;
  /** This wallet's retry key, kept by the panel across closes until its act is confirmed. */
  retryKey: () => string;
  /** The server confirmed the key's act: the panel drops the key, and the next handover gets a new one. */
  onKeySpent: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.custody.receiveDialog');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [amount, setAmount] = useState(() =>
    formatTypedAmount(String(custody.held), custody.currency === 'LBP' ? 0 : 2),
  );
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const received = parseAmount(amount);
  const remaining = useMemo(
    () => Math.round((custody.held - (Number.isFinite(received) ? received : 0)) * 100) / 100,
    [custody.held, received],
  );
  const tooMuch = Number.isFinite(received) && received > custody.held;

  /** Every treasury read: the custody list behind the dialog, and the safe it fills. */
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });

  /**
   * The server's refusal, in words. Already the localised text for the code
   * (TXT-6), except where the dialog knows more: an earlier press that was
   * recorded and has since been cancelled is answered `TRANSFER_ALREADY_VOID`,
   * which on its own reads as a refusal to cancel.
   */
  const failureText = (caught: unknown): string => {
    if (caught instanceof ApiRequestError && caught.code === 'TRANSFER_ALREADY_VOID') {
      const number = caught.payload.params?.transferNumber;
      if (number) return t('errors.earlierVoided', { number: String(number) });
    }
    return caught instanceof Error && caught.message ? caught.message : t('errors.form');
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const parsed = receiveCustodySchema.safeParse({
      custodyAccountId: custody.accountId,
      amount: received,
      note: note.trim() || undefined,
      clientRequestId: retryKey(),
    });
    if (!parsed.success) {
      /*
        Each field's own words. The schema's messages are Arabic by design, so
        only the field and the kind of failure are read from it (TXT-1).
      */
      let nextAmount: string | null = null;
      let nextNote: string | null = null;
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'amount' && !nextAmount) {
          nextAmount =
            issue.code === 'too_big'
              ? t('errors.tooLarge')
              : issue.code === 'custom'
                ? t('errors.decimals')
                : t('errors.amount');
        } else if (field === 'note' && !nextNote) {
          nextNote = t('errors.note');
        }
      }
      setAmountError(nextAmount);
      setNoteError(nextNote);
      // An issue on nothing the accountant can edit would otherwise fail without a word.
      setFormError(nextAmount || nextNote ? null : t('errors.form'));
      document.getElementById(nextAmount ? 'custody-amount' : 'custody-note')?.focus();
      return;
    }
    if (tooMuch) {
      setAmountError(t('errors.tooMuch'));
      document.getElementById('custody-amount')?.focus();
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setAmountError(null);
    setNoteError(null);
    setFormError(null);
    let result: Awaited<ReturnType<typeof receiveCollectorCustody>>;
    try {
      result = await receiveCollectorCustody(tenant, token, parsed.data);
    } catch (caught) {
      logApiError(caught);
      setFormError(failureText(caught));
      if (keyIsSpent(caught)) {
        // That handover exists: the next press is a new one, and the figures on screen are behind it.
        onKeySpent();
        void refresh();
      } else if (outcomeInDoubt(caught)) {
        /*
          It may have been recorded. Re-read, so a reopened dialog prefills
          what he holds now rather than what he held before the lost answer;
          the key is kept, so a retry of the same handover is answered from it.
        */
        void refresh();
      }
      inFlight.current = false;
      setBusy(false);
      return;
    }

    // Recorded: the key is spent and the dialog does not take another press.
    onKeySpent();
    await refresh();
    if (result.replayed) {
      // An earlier press recorded it and its answer was lost: that handover stands, as first recorded.
      toast.warning(t('replayed', { number: result.transferNumber }), { description: t('replayedBody') });
    } else {
      toast.success(t('success', { number: result.transferNumber }), { description: t('successBody') });
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('title', { name: custody.collectorName ?? '' })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field htmlFor="custody-amount" label={t('amount')} error={amountError ?? undefined} required>
            <CurrencyInput
              id="custody-amount"
              unit={unitOf(custody.currency, locale)}
              value={amount}
              placeholder="0"
              invalid={Boolean(amountError) || tooMuch}
              inputClassName="text-lg font-bold"
              onChange={(raw) => {
                setAmount(formatTypedAmount(raw, custody.currency === 'LBP' ? 0 : 2));
                setAmountError(null);
              }}
            />
          </Field>

          {/* The arithmetic the accountant would otherwise do with the collector waiting. */}
          <SummaryList className="rounded-md border bg-muted/20 px-3">
            <SummaryRow label={t('held')}>
              <TreasuryAmount amount={custody.held} currency={custody.currency} locale={locale} />
            </SummaryRow>
            <SummaryRow label={t('remaining')} className={tooMuch ? 'text-destructive' : undefined}>
              <TreasuryAmount amount={remaining} currency={custody.currency} locale={locale} />
            </SummaryRow>
          </SummaryList>

          {remaining > 0 && !tooMuch ? (
            <Alert variant="info" live="status">
              {t('partial')}
            </Alert>
          ) : null}

          <Field
            htmlFor="custody-note"
            label={t('note')}
            optionalLabel={t('optional')}
            error={noteError ?? undefined}
          >
            <Textarea
              id="custody-note"
              rows={2}
              maxLength={500}
              value={note}
              placeholder={t('notePlaceholder')}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
          </Field>

          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || tooMuch} className="w-full sm:w-auto">
              {busy ? t('saving') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
