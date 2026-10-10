'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { HandCoins, UserRound, Users } from 'lucide-react';
import { receiveCustodySchema, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getCollectorCustody,
  logApiError,
  receiveCollectorCustody,
  type CollectorCustodyView,
} from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeProps } from '@/components/ui/badge';
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
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

/**
 * Which badge each derived status wears (owner's choice, 2026-10-09).
 *
 * «يجمع اليوم» takes `success` as COL-2's "active", and «لم يخرج اليوم» stays
 * neutral. «سلّم كل شيء» takes `info`, which departs from COL-2's list —
 * there "settled" is a `success` meaning — and was chosen so the two states an
 * accountant tells apart at a glance, out collecting and done, do not share a
 * colour. No other meaning on this page uses either tone.
 */
const STATUS_BADGE: Record<CollectorCustodyView['status'], BadgeProps['variant']> = {
  COLLECTING_TODAY: 'soft-success',
  NOT_OUT_TODAY: 'soft-muted',
  SETTLED: 'soft-info',
};

/**
 * «ما بعهدة الجباة» — what each collector is still carrying, and the way it
 * reaches the safe: the body of the «الجباة والتحصيل» page.
 *
 * This is the step between a citizen paying at his door and the money being the
 * municipality's. A collector's cash is credited to his own custody wallet, not
 * to the safe, precisely because it is still in his pocket on his motorbike; the
 * safe must never claim money nobody has counted. Here the accountant sees what
 * he is carrying, counts the notes against it, and receives it.
 *
 * Drawn as a table (owner's request, 2026-10-09): six columns read across one
 * row per pocket — who, where he is in his day, what he took today, what he
 * holds now, when he last took any, and what to do. Above it, the strip of what
 * is out on the street in total.
 *
 * Collectors with nothing are kept in the table rather than disappearing: «سلّم
 * كل شيء» is the answer the accountant needs at the end of a round, and a name
 * that vanishes on settling looks like one that never went out.
 */
export function CollectorCustodyPanel({
  tenant,
  base,
  token,
  locale,
  role,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  role: string | undefined;
}): React.JSX.Element {
  const t = useTranslations('finance.custody');
  const [receiving, setReceiving] = useState<CollectorCustodyView | null>(null);

  const canReceive = hasRole(TREASURY_WORK_ROLES, role);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'custody'],
    queryFn: (accessToken, signal) => getCollectorCustody(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);

  /* «كم بقي خارج الصندوق؟» — every custody wallet added up, one figure per currency. */
  const totals = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const row of rows) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.held);
    return [...byCurrency].map(([currency, amount]) => ({ currency, amount }));
  }, [rows]);

  /** How many collectors still owe the safe a handover, in any currency. */
  const holding = useMemo(
    () => new Set(rows.filter((row) => row.held > 0).map((row) => row.collectorId ?? row.accountId)).size,
    [rows],
  );

  /* «بعهدة الجباة بالليرة», not «… بـ LBP»: a sentence, not a code glued to a preposition (TXT-5). */
  const heldLabel = (currency: string): string =>
    currency === 'LBP'
      ? t('stats.heldInLBP')
      : currency === 'USD'
        ? t('stats.heldInUSD')
        : t('stats.heldInOther', { currency });

  return (
    <>
      {/*
        What is out on the street, all collectors together: one figure per
        currency, never added to the safe's balances, and how many people that
        cash is with. Plain figures, no icon tiles (BAN-6).
      */}
      {totals.length > 0 ? (
        <StatStrip>
          {totals.map((total) => (
            <StatItem
              key={total.currency}
              label={heldLabel(total.currency)}
              value={<TreasuryAmount amount={total.amount} currency={total.currency} locale={locale} />}
              className={total.amount === 0 ? 'text-muted-foreground' : undefined}
            />
          ))}
          <StatItem label={t('stats.collectorsHolding')} value={String(holding)} />
        </StatStrip>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="space-y-1 border-b sm:px-5">
          <CardTitle className="text-base">
            <h2>{t('title')}</h2>
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
        </CardHeader>
        <CardContent className="p-0">
          {/*
            This is a page of its own («الجباة والتحصيل»), so an empty answer
            cannot be an empty screen: the four states (STA-1). A failed refetch
            over rows already shown keeps the rows and says so above them.
          */}
          {rows.length === 0 ? (
            query.error ? (
              <ErrorState title={query.error} onRetry={query.refetch} />
            ) : query.loading ? (
              <LoadingState />
            ) : (
              <EmptyState icon={HandCoins} title={t('empty')} description={t('emptyHint')} />
            )
          ) : (
            <>
              {query.error ? (
                <div className="px-4 pt-4 sm:px-5">
                  <Alert variant="warning" live="status">
                    {query.error}
                  </Alert>
                </div>
              ) : null}

              {/*
                `Table` is a bare `<table>` by design and leaves the scroll to its
                container, so a phone scrolls the six columns sideways inside the
                card rather than pushing the page wider than the screen (LAY-5).
                One row per custody wallet: a collector carrying both ليرة and
                dollars has two rows, one per pocket, as the server returns them.
              */}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="ps-4 sm:ps-5">{t('columns.collector')}</TableHead>
                      <TableHead>{t('columns.status')}</TableHead>
                      <TableHead>{t('columns.today')}</TableHead>
                      <TableHead className="text-end">{t('columns.held')}</TableHead>
                      <TableHead>{t('columns.lastActivity')}</TableHead>
                      <TableHead className="pe-4 text-end sm:pe-5">{t('columns.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.accountId}>
                        <TableCell className="ps-4 sm:ps-5">
                          <div className="flex items-center gap-3">
                            {/*
                              The first letter of his name, not a photograph: the
                              register holds none for staff, and a generic
                              silhouette on every row would tell the rows apart by
                              nothing.
                            */}
                            <span
                              aria-hidden
                              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                            >
                              {row.collectorName?.trim().charAt(0) || <UserRound className="size-4" />}
                            </span>
                            <span className="font-medium">{row.collectorName ?? t('unknownCollector')}</span>
                          </div>
                        </TableCell>

                        <TableCell>
                          {/*
                            An inference, not a report from the field — nothing
                            records whether a man is out on a round. «لم يخرج
                            اليوم» with cash still on him and «سلّم كل شيء» are
                            different answers to «أين علي؟», so each has its own
                            badge, and the word carries the meaning with the
                            colour only repeating it (COL-3).
                          */}
                          <Badge variant={STATUS_BADGE[row.status]}>{t(`status.${row.status}`)}</Badge>
                        </TableCell>

                        <TableCell>
                          {row.receiptsToday > 0 ? (
                            <div className="space-y-0.5">
                              <p className="tabular-nums">{t('receiptsToday', { count: row.receiptsToday })}</p>
                              <TreasuryAmount
                                amount={row.collectedToday}
                                currency={row.currency}
                                locale={locale}
                                className="text-xs text-muted-foreground"
                              />
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{t('noneToday')}</span>
                          )}
                        </TableCell>

                        {/*
                          What he carries now: the figure the accountant counts the
                          notes against. Nothing held is muted, so the eye goes to
                          the rows that still have cash out; the «0» and the badge
                          still say it.
                        */}
                        <TableCell className="text-end">
                          <TreasuryAmount
                            amount={row.held}
                            currency={row.currency}
                            locale={locale}
                            className={cn('text-base font-semibold', row.held === 0 && 'text-muted-foreground')}
                          />
                        </TableCell>

                        {/* Null once his wallet is empty: the server only dates cash still held. */}
                        <TableCell className="tabular-nums text-muted-foreground">
                          {row.lastCollectedAt ? formatDateTime(row.lastCollectedAt) : '—'}
                        </TableCell>

                        <TableCell className="pe-4 sm:pe-5">
                          <div className="flex items-center justify-end gap-2">
                            {canReceive && row.held > 0 ? (
                              <Button size="sm" variant="outline" onClick={() => setReceiving(row)}>
                                {t('receive')}
                              </Button>
                            ) : null}
                            {/*
                              «من حصّل» — the receipts behind the figure. Offered
                              whether or not he is still carrying anything: a
                              collector who has settled is exactly the one whose
                              round someone asks about afterwards. Ghost beside the
                              outline, so «استلام» stays the thing the eye lands on.
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
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {receiving && token ? (
        <ReceiveCustodyDialog
          tenant={tenant}
          token={token}
          locale={locale}
          custody={receiving}
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
 */
function ReceiveCustodyDialog({
  tenant,
  token,
  locale,
  custody,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  custody: CollectorCustodyView;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.custody.receiveDialog');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [amount, setAmount] = useState(() =>
    formatTypedAmount(String(custody.held), custody.currency === 'LBP' ? 0 : 2),
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef(crypto.randomUUID());

  const received = parseAmount(amount);
  const remaining = useMemo(
    () => Math.round((custody.held - (Number.isFinite(received) ? received : 0)) * 100) / 100,
    [custody.held, received],
  );
  const tooMuch = Number.isFinite(received) && received > custody.held;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const parsed = receiveCustodySchema.safeParse({
      custodyAccountId: custody.accountId,
      amount: received,
      note: note.trim() || undefined,
      clientRequestId: requestId.current,
    });
    if (!parsed.success) {
      setError(t('errors.amount'));
      return;
    }
    if (tooMuch) {
      setError(t('errors.tooMuch'));
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await receiveCollectorCustody(tenant, token, parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success', { number: result.transferNumber }), { description: t('successBody') });
      onClose();
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6); never branch on it.
      setError(caught instanceof Error ? caught.message : t('errors.form'));
      requestId.current = crypto.randomUUID();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('title', { name: custody.collectorName ?? '' })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field htmlFor="custody-amount" label={t('amount')} error={error ?? undefined} required>
            <CurrencyInput
              id="custody-amount"
              unit={currencyUnit(custody.currency, locale)}
              value={amount}
              placeholder="0"
              invalid={Boolean(error) || tooMuch}
              inputClassName="text-lg font-bold"
              onChange={(raw) => {
                setAmount(formatTypedAmount(raw, custody.currency === 'LBP' ? 0 : 2));
                setError(null);
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

          <Field htmlFor="custody-note" label={t('note')} optionalLabel={t('optional')}>
            <Textarea
              id="custody-note"
              rows={2}
              maxLength={500}
              value={note}
              placeholder={t('notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>

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
