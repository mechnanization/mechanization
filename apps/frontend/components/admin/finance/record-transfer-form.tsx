'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Repeat2 } from 'lucide-react';
import {
  createTransferSchema,
  exchangeRateOf,
  getLabels,
  judgeExchange,
  municipalToday,
  type TransferKind,
} from '@mechanization/shared-schemas';
import {
  createTransfer,
  logApiError,
  type TreasuryAccountView,
  type TreasuryRate,
} from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

/** A heading over a group of fields — the expense form's own, for the same reasons (BAN-4, TYP-5). */
function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="border-b pb-1.5 text-xs font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** A percentage in Latin digits, two places at most (TYP-4): a message argument, not a figure in a column. */
const percent = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** ليرة has no fractions to move; a dollar keeps its cents. */
const decimalsOf = (currency: string | undefined): 0 | 2 => (currency === 'LBP' ? 0 : 2);

/** A typed figure rounded the way its currency is kept. */
const roundTo = (value: number, currency: string): number => {
  const factor = 10 ** decimalsOf(currency);
  return Math.round(value * factor) / factor;
};

/**
 * «تحويل داخلي» and «مصارفة» — money between two working wallets, on a page of
 * its own (BAN-10: a form worked through with a Whish statement or a صرّاف's
 * slip in hand).
 *
 * ## What the summary answers
 *
 * «هل يكفي؟» for the source — which loses the amount *and* the fee — and what
 * the destination will hold, while the figures are typed. The server judges the
 * same thing under both wallets' locks (FRM-4); this only saves the round trip.
 *
 * ## The rate
 *
 * An exchange is two amounts: what left, what arrived. The rate is what they
 * imply, so the server takes the two amounts and derives it. Here the officer
 * may type either the received amount or the rate the صرّاف quoted, and the
 * other follows; what is sent is the two amounts. The rate is judged against the
 * municipality's own by `judgeExchange`, the function the server refuses with,
 * so the warning and the refusal cannot disagree.
 *
 * Recording moves money, so a second press is guarded by an in-flight ref and a
 * per-attempt idempotency key the server honours (STA-4).
 */
export function RecordTransferForm({
  tenant,
  token,
  locale,
  backHref,
  accounts,
  rate,
  onRecorded,
  onPrint,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** Where «إلغاء» goes. */
  backHref: string;
  /** The working wallets: the overview's, which leaves custody out. */
  accounts: TreasuryAccountView[];
  rate: TreasuryRate;
  onRecorded: () => void;
  /** Opens the transfer just written, to print: the success toast's action. */
  onPrint: (transferId: string) => void;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.form');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();

  const wallets = useMemo(() => accounts.filter((account) => account.active), [accounts]);
  const today = municipalToday();

  const [kind, setKind] = useState<TransferKind>('SAME_CURRENCY');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState('');
  const [quotedRate, setQuotedRate] = useState('');
  const [fee, setFee] = useState('');
  const [changer, setChanger] = useState('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [transferredOn, setTransferredOn] = useState(today);
  const [backdateReason, setBackdateReason] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** One id per attempt; a refused transfer moved nothing, so the retry is a new act. */
  const requestId = useRef(crypto.randomUUID());

  const from = wallets.find((account) => account.id === fromId);
  const to = wallets.find((account) => account.id === toId);
  const backdated = transferredOn < today;

  /* The destinations this kind allows from this source: one currency for a transfer, the other for an exchange. */
  const destinations = wallets.filter(
    (account) =>
      account.id !== fromId &&
      (!from || (kind === 'SAME_CURRENCY' ? account.currency === from.currency : account.currency !== from.currency)),
  );

  const typedAmount = parseAmount(amount);
  const typedFee = parseAmount(fee);
  const typedReceived = kind === 'EXCHANGE' ? parseAmount(received) : typedAmount;
  const leaving = typedAmount + typedFee;
  const sourceAfter = from ? roundTo(from.balance - leaving, from.currency) : 0;
  const destinationAfter = to ? roundTo(to.balance + typedReceived, to.currency) : 0;
  const short = Boolean(from) && leaving > 0 && sourceAfter < 0;

  const legs =
    kind === 'EXCHANGE' && from && to && typedAmount > 0 && typedReceived > 0
      ? exchangeRateOf({
          fromCurrency: from.currency,
          toCurrency: to.currency,
          amount: typedAmount,
          receivedAmount: typedReceived,
          baseCurrency: rate.baseCurrency,
        })
      : null;
  const judgement = legs
    ? judgeExchange({
        rate: legs.rate,
        foreignAmount: legs.foreignAmount,
        officialRate: rate.exchangeRate,
        tolerancePercent: rate.tolerancePercent,
        largeThreshold: rate.largeExchangeThreshold,
      })
    : null;

  const walletOption = (account: TreasuryAccountView) => (
    <SelectItem key={account.id} value={account.id}>
      {`${account.name} · ${labels.treasuryAccountType[account.type]}`}
    </SelectItem>
  );

  /** Received from the quoted rate: base per unit of the other side, whichever way the money goes. */
  const receivedFromRate = (sold: number, quoted: number): string => {
    if (!from || !to || sold <= 0 || quoted <= 0) return received;
    const value = to.currency === rate.baseCurrency ? sold * quoted : sold / quoted;
    return formatTypedAmount(String(roundTo(value, to.currency)), decimalsOf(to.currency));
  };

  const changeKind = (next: TransferKind): void => {
    setKind(next);
    setToId('');
    setReceived('');
    setQuotedRate('');
    setErrors({});
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const base = {
      fromAccountId: fromId,
      toAccountId: toId,
      amount: typedAmount,
      feeAmount: typedFee > 0 ? typedFee : undefined,
      description,
      transferredOn,
      backdateReason: backdated ? backdateReason.trim() || undefined : undefined,
      clientRequestId: requestId.current,
    };
    const parsed = createTransferSchema.safeParse(
      kind === 'SAME_CURRENCY'
        ? { kind, ...base }
        : {
            kind,
            ...base,
            receivedAmount: typedReceived,
            moneyChangerName: changer.trim() || undefined,
            adjustmentReason: reason.trim() || undefined,
          },
    );

    const next: Record<string, string> = {};
    if (!parsed.success) {
      /*
        The shared schema is the contract and its messages are Arabic by
        design, so only the field names come from it; the words are this
        screen's (TXT-1).
      */
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        if (!next[field]) next[field] = t(`errors.${field === 'clientRequestId' || field === 'kind' ? 'form' : field}`);
      }
    }
    // What the server refuses, said before the round trip.
    if (short && !next.amount) next.amount = t('errors.short');
    if (judgement?.beyondTolerance && !reason.trim()) next.adjustmentReason = t('errors.adjustmentReason');
    if (backdated && !backdateReason.trim()) next.backdateReason = t('errors.backdateReason');

    if (!parsed.success || Object.keys(next).length > 0) {
      setErrors(next);
      setFormError(null);
      // Put the officer on the first thing to fix (FRM-2).
      const order = ['fromAccountId', 'toAccountId', 'amount', 'receivedAmount', 'feeAmount', 'adjustmentReason', 'description', 'backdateReason'];
      const first = order.find((field) => next[field]);
      document.getElementById(`transfer-${first ?? 'amount'}`)?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await createTransfer(tenant, token, parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      // The server's numbers, never a client-side reconstruction (STA-6).
      toast.success(t('success', { number: result.transferNumber }), {
        description: result.requiresReview
          ? t('successFlagged')
          : result.feeVoucherNumber
            ? t('successFee', { number: result.feeVoucherNumber })
            : t('successBody'),
        action: { label: t('print'), onClick: () => onPrint(result.id) },
      });
      onRecorded();
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6); never branch on it.
      setFormError(caught instanceof Error ? caught.message : t('errors.form'));
      requestId.current = crypto.randomUUID();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const clear = (field: string) => setErrors(({ [field]: _cleared, ...rest }) => rest);

  return (
    <form noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start" onSubmit={submit}>
      <div className="space-y-6">
        <SegmentedControl
          aria-label={t('kind')}
          value={kind}
          onChange={(value) => changeKind(value as TransferKind)}
          options={[
            { value: 'SAME_CURRENCY', label: t('kinds.SAME_CURRENCY'), icon: ArrowLeftRight },
            { value: 'EXCHANGE', label: t('kinds.EXCHANGE'), icon: Repeat2 },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {kind === 'SAME_CURRENCY' ? t('kindHint.SAME_CURRENCY') : t('kindHint.EXCHANGE')}
        </p>

        <FormSection title={t('sections.wallets')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="transfer-fromAccountId" label={t('from')} error={errors.fromAccountId} required>
              <Select
                value={fromId}
                onValueChange={(next) => {
                  setFromId(next);
                  const nextFrom = wallets.find((account) => account.id === next);
                  // A destination that no longer fits the source is cleared rather than kept wrong.
                  if (to && (to.id === next || (nextFrom && (kind === 'SAME_CURRENCY') !== (to.currency === nextFrom.currency)))) {
                    setToId('');
                  }
                  setAmount((current) => formatTypedAmount(current, decimalsOf(nextFrom?.currency)));
                  setFee((current) => formatTypedAmount(current, decimalsOf(nextFrom?.currency)));
                  clear('fromAccountId');
                }}
              >
                <SelectTrigger id="transfer-fromAccountId">
                  <SelectValue placeholder={t('walletPlaceholder')} />
                </SelectTrigger>
                <SelectContent>{wallets.map(walletOption)}</SelectContent>
              </Select>
            </Field>

            <Field htmlFor="transfer-toAccountId" label={t('to')} error={errors.toAccountId} required>
              {/* Keyed on the source, so a destination cleared above is cleared in Radix too (docs/gotchas.md). */}
              <Select
                key={`${fromId}-${kind}`}
                value={toId}
                onValueChange={(next) => {
                  setToId(next);
                  clear('toAccountId');
                }}
                disabled={!from}
              >
                <SelectTrigger id="transfer-toAccountId">
                  <SelectValue placeholder={from ? t('walletPlaceholder') : t('fromFirst')} />
                </SelectTrigger>
                <SelectContent>{destinations.map(walletOption)}</SelectContent>
              </Select>
            </Field>
          </div>
          {from && destinations.length === 0 ? (
            <Alert variant="info">{kind === 'SAME_CURRENCY' ? t('noSameCurrency') : t('noOtherCurrency')}</Alert>
          ) : null}
        </FormSection>

        <FormSection title={t('sections.amounts')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              htmlFor="transfer-amount"
              label={kind === 'EXCHANGE' ? t('amountSold') : t('amount')}
              error={errors.amount}
              required
            >
              <CurrencyInput
                id="transfer-amount"
                unit={from ? currencyUnit(from.currency, locale) : ''}
                value={amount}
                placeholder="0"
                invalid={Boolean(errors.amount) || short}
                onChange={(raw) => {
                  const next = formatTypedAmount(raw, decimalsOf(from?.currency));
                  setAmount(next);
                  if (kind === 'EXCHANGE' && parseAmount(quotedRate) > 0) {
                    setReceived(receivedFromRate(parseAmount(next), parseAmount(quotedRate)));
                  }
                  clear('amount');
                }}
              />
            </Field>

            <Field htmlFor="transfer-feeAmount" label={t('fee')} error={errors.feeAmount} optionalLabel={t('optional')}>
              <CurrencyInput
                id="transfer-feeAmount"
                unit={from ? currencyUnit(from.currency, locale) : ''}
                value={fee}
                placeholder="0"
                invalid={Boolean(errors.feeAmount)}
                onChange={(raw) => {
                  setFee(formatTypedAmount(raw, decimalsOf(from?.currency)));
                  clear('feeAmount');
                }}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('feeHint')}</p>

          {kind === 'EXCHANGE' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="transfer-rate" label={t('quotedRate')} optionalLabel={t('optional')}>
                <CurrencyInput
                  id="transfer-rate"
                  unit={t('rateUnit', { base: currencyUnit(rate.baseCurrency, locale) })}
                  value={quotedRate}
                  placeholder={rate.exchangeRate ? String(rate.exchangeRate) : '0'}
                  onChange={(raw) => {
                    const next = formatTypedAmount(raw, 2);
                    setQuotedRate(next);
                    setReceived(receivedFromRate(typedAmount, parseAmount(next)));
                    clear('receivedAmount');
                  }}
                />
              </Field>

              <Field htmlFor="transfer-receivedAmount" label={t('received')} error={errors.receivedAmount} required>
                <CurrencyInput
                  id="transfer-receivedAmount"
                  unit={to ? currencyUnit(to.currency, locale) : ''}
                  value={received}
                  placeholder="0"
                  invalid={Boolean(errors.receivedAmount)}
                  onChange={(raw) => {
                    setReceived(formatTypedAmount(raw, decimalsOf(to?.currency)));
                    // Typed directly, the received figure is the fact; the quoted rate no longer drives it.
                    setQuotedRate('');
                    clear('receivedAmount');
                  }}
                />
              </Field>
            </div>
          ) : null}

          {kind === 'EXCHANGE' && judgement?.beyondTolerance ? (
            <Alert variant="warning" live="status" title={t('toleranceTitle')}>
              {t('toleranceBody', {
                deviation: percent(judgement.deviationPercent ?? 0),
                tolerance: percent(rate.tolerancePercent),
              })}
            </Alert>
          ) : null}

          {kind === 'EXCHANGE' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="transfer-changer" label={t('changer')} optionalLabel={t('optional')}>
                <Input
                  id="transfer-changer"
                  value={changer}
                  maxLength={200}
                  placeholder={t('changerPlaceholder')}
                  onChange={(event) => setChanger(event.target.value)}
                />
              </Field>
              {judgement?.beyondTolerance ? (
                <Field htmlFor="transfer-adjustmentReason" label={t('adjustmentReason')} error={errors.adjustmentReason} required>
                  <Input
                    id="transfer-adjustmentReason"
                    value={reason}
                    maxLength={1000}
                    placeholder={t('adjustmentPlaceholder')}
                    invalid={Boolean(errors.adjustmentReason)}
                    onChange={(event) => {
                      setReason(event.target.value);
                      clear('adjustmentReason');
                    }}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
        </FormSection>

        <FormSection title={t('sections.paperwork')}>
          <Field htmlFor="transfer-description" label={t('description')} error={errors.description} required>
            <Textarea
              id="transfer-description"
              rows={2}
              maxLength={500}
              value={description}
              placeholder={kind === 'EXCHANGE' ? t('descriptionPlaceholderExchange') : t('descriptionPlaceholder')}
              onChange={(event) => {
                setDescription(event.target.value);
                clear('description');
              }}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="transfer-date" label={t('date')} required>
              <DatePicker
                id="transfer-date"
                value={transferredOn}
                max={today}
                locale={locale === 'en' ? 'en' : 'ar'}
                onChange={(value) => setTransferredOn(value || today)}
              />
            </Field>
            {backdated ? (
              <Field htmlFor="transfer-backdateReason" label={t('backdateReason')} error={errors.backdateReason} required>
                <Input
                  id="transfer-backdateReason"
                  value={backdateReason}
                  maxLength={500}
                  placeholder={t('backdatePlaceholder')}
                  invalid={Boolean(errors.backdateReason)}
                  onChange={(event) => {
                    setBackdateReason(event.target.value);
                    clear('backdateReason');
                  }}
                />
              </Field>
            ) : null}
          </div>
        </FormSection>

        {formError ? (
          <Alert variant="destructive" live="alert">
            {formError}
          </Alert>
        ) : null}
      </div>

      {/*
        The summary, sticky beside the fields: the expense form's panel, sized
        the same way for the same reasons (see `RecordExpenseForm`). Below `lg`
        it falls under the fields, directly above the button it qualifies.
      */}
      <aside className="lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]">
        <Card className={cn('flex h-full flex-col', short && 'border-destructive/30')}>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>

            {from ? (
              <SummaryList>
                <SummaryRow label={t('summarySource', { name: from.name })}>
                  <TreasuryAmount amount={from.balance} currency={from.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryLeaving')}>
                  <TreasuryAmount amount={leaving} currency={from.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryAfter')} className={cn(short && 'text-destructive')}>
                  <TreasuryAmount amount={sourceAfter} currency={from.currency} locale={locale} />
                </SummaryRow>
              </SummaryList>
            ) : (
              <p className="text-sm text-muted-foreground">{t('summaryEmpty')}</p>
            )}

            {to ? (
              <SummaryList className="border-t pt-1">
                <SummaryRow label={t('summaryDestination', { name: to.name })}>
                  <TreasuryAmount amount={to.balance} currency={to.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryArriving')}>
                  <TreasuryAmount amount={typedReceived} currency={to.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryAfter')}>
                  <TreasuryAmount amount={destinationAfter} currency={to.currency} locale={locale} />
                </SummaryRow>
              </SummaryList>
            ) : null}

            {kind === 'EXCHANGE' && from && to ? (
              <SummaryList className="border-t pt-1">
                {/* A rate is an amount of the base currency per one unit of the other: «89,500 ل.ل». */}
                <SummaryRow label={t('summaryRate')}>
                  {legs ? <TreasuryAmount amount={legs.rate} currency={rate.baseCurrency} locale={locale} /> : '—'}
                </SummaryRow>
                <SummaryRow label={t('summaryOfficial')}>
                  {rate.exchangeRate ? (
                    <TreasuryAmount amount={rate.exchangeRate} currency={rate.baseCurrency} locale={locale} />
                  ) : (
                    t('noOfficialRate')
                  )}
                </SummaryRow>
                {judgement?.deviationPercent !== null && judgement?.deviationPercent !== undefined ? (
                  <SummaryRow
                    label={t('summaryDeviation')}
                    className={cn('tabular-nums', judgement.beyondTolerance && 'text-warning')}
                  >
                    {`${percent(judgement.deviationPercent)}%`}
                  </SummaryRow>
                ) : null}
              </SummaryList>
            ) : null}

            {short ? (
              <Alert variant="destructive" live="status" title={t('shortTitle')}>
                {t('shortBody')}
              </Alert>
            ) : null}

            {judgement?.requiresReview ? (
              <Alert variant="info" title={t('reviewTitle')}>
                {judgement.noOfficialRate
                  ? t('reviewNoRate')
                  : judgement.large && !judgement.beyondTolerance
                    ? t('reviewLarge', { threshold: rate.largeExchangeThreshold })
                    : t('reviewTolerance')}
              </Alert>
            ) : null}

            {/* `mt-auto` pushes the actions to the foot of a panel taller than its content. */}
            <div className="mt-auto flex flex-col gap-2 pt-2">
              <Button type="submit" disabled={busy || short}>
                {busy ? t('saving') : kind === 'EXCHANGE' ? t('submitExchange') : t('submit')}
              </Button>
              <Button asChild type="button" variant="outline" disabled={busy}>
                <Link href={backHref}>{t('cancel')}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </aside>
    </form>
  );
}
