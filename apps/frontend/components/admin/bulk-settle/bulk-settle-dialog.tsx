'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, Coins, CreditCard, Eraser, Loader2, UserCheck } from 'lucide-react';
import {
  bulkSettlementOrder,
  bulkSettlePaymentsSchema,
  getLabels,
  planBulkSettlement,
  type PaymentMethod,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  bulkSettlePayments,
  getMunicipalitySettings,
  getStaff,
  getTreasuryOverview,
  logApiError,
  type SettlementReceipt,
} from '@/lib/api-client';
import { localizeApiError } from '@/lib/api-errors';
import { bulkKeyScope, dueByCurrency, type SelectedBill } from '@/lib/bulk-settle';
import { currencyUnit, formatMoney, formatTypedAmount, parseAmount } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { heldInDoubt, heldKey, keyIsSpent, markInDoubt, outcomeInDoubt, spendKey } from '@/lib/request-id';
import { useStaffQuery } from '@/lib/use-staff-query';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { BulkBillsTable } from './bulk-bills-table';
import { MoneyList } from './money-list';

/** The three ways money reaches the municipality, in the single settle page's order and with its icons (UX-1). */
const METHODS = [
  { value: 'CASH', icon: Banknote },
  { value: 'WHISH_MONEY', icon: CreditCard },
  { value: 'COLLECTOR', icon: UserCheck },
] as const satisfies ReadonlyArray<{ value: PaymentMethod; icon: unknown }>;

/** Where a field's refusal is shown, and the order focus goes to the first (FRM-2). */
type FieldKey = 'tender' | 'reference' | 'collector';
const FIELD_IDS: Record<FieldKey, string> = {
  tender: 'bulk-settle-local',
  reference: 'bulk-settle-reference',
  collector: 'bulk-settle-collector',
};

/**
 * «تسديد الفواتير المحددة» — the selected bills of one citizen, settled in one
 * press: all of them PAID, or nothing written (docs/finance.md §3.7).
 *
 * ## Why a dialog
 *
 * BAN-10 refuses a modal for a task that needs neither interruption nor
 * protected focus. This one needs the focus: it acts on a selection that lives
 * on the list behind it, and the list must not change under the clerk while
 * the notes are counted — a tick behind an open form would change what is
 * being paid. Closing it returns to the same selection, untouched. And it is
 * the salary payout's shape, not the expense form's (see `StaffSalaryDialog`):
 * a method, one or two figures or a name, and a note, with the bills read back
 * above them. What has to have an address — the receipt — gets a page
 * (`fees/settlements/[settlementId]`), which this opens on success.
 *
 * ## The preview is the server's arithmetic
 *
 * `planBulkSettlement` (shared-schemas) is the function the server runs under
 * the bills' locks; here it gives «الباقي للمواطن», what is short or over, in
 * the words of the server's own refusal (`errors.*`, through `localizeApiError`).
 * The rate is the municipality's official one, shown with its date and never
 * typed (FRM-5): a different rate for one payment stays a single-bill act.
 *
 * ## The change must exist in the safe
 *
 * With cash, the change leaves the base currency's primary cash safe, so a
 * safe holding less than the change, plus the base-currency notes just handed
 * in, refuses the press here — unless a press under this key got no answer
 * (`heldInDoubt`): the balance may already carry it, and only a retry with the
 * key can say. If the treasury cannot be read, nothing is refused; the server
 * checks under lock (`TREASURY_INSUFFICIENT_FUNDS`).
 *
 * ## One press
 *
 * An in-flight ref and a retry key held per set of bills
 * (`bulk-settle:<ids>`, `lib/request-id.ts`), kept across every failure, edit
 * and close, spent on a 2xx or a refusal `keyIsSpent` names. After a 2xx the
 * form stays locked and the receipt page opens.
 */
export function BulkSettleDialog({
  tenant,
  base,
  token,
  locale,
  bills,
  onRemove,
  onClose,
  onSettled,
  onStale,
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}`. */
  base: string;
  token: string;
  locale: string;
  /** The selected bills, at least one, all one citizen's. */
  bills: readonly SelectedBill[];
  /** Unticks one bill — after `BULK_SETTLE_SOME_ALREADY_PAID`, the way out the refusal names. */
  onRemove: (id: string) => void;
  onClose: () => void;
  /** The settlement is recorded: clear the selection and re-read the bills. */
  onSettled: (receipt: SettlementReceipt) => void;
  /** A bill was settled since it was ticked: re-read the bills so the list shows it. */
  onStale: () => void;
}): React.JSX.Element {
  const t = useTranslations('bulkSettle.dialog');
  const tCounter = useTranslations('counterPayment');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [reference, setReference] = useState('');
  const [collectedById, setCollectedById] = useState('');
  const [localRaw, setLocalRaw] = useState('');
  const [foreignRaw, setForeignRaw] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the bills are paid, and nothing here records again. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  const cash = method === 'CASH';

  const settingsQuery = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (accessToken) => getMunicipalitySettings(tenant, accessToken),
    tenant,
    base,
    token,
    errorMessage: t('settingsError'),
  });
  /* The treasury page's own read: the change check, for cash only. */
  const overviewQuery = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token: cash ? token : null,
    errorMessage: t('treasuryUnread'),
  });
  /* The staff page's own read, for the collector picker only. Not open to every role that settles. */
  const staffQuery = useStaffQuery({
    queryKey: ['staff', tenant],
    queryFn: (accessToken, signal) => getStaff(tenant, accessToken, signal),
    tenant,
    base,
    token: method === 'COLLECTOR' ? token : null,
    errorMessage: tCounter('collectorsFailed'),
  });

  const ordered = useMemo(() => bulkSettlementOrder([...bills]), [bills]);
  const citizen = bills[0];
  const settings = settingsQuery.data ?? null;
  const baseCurrency = settings?.baseCurrency ?? 'LBP';
  /** Only the municipality's own second currency is taken as notes, at its official rate. */
  const foreignCurrency =
    settings?.secondaryCurrency === 'USD' || settings?.secondaryCurrency === 'EUR' ? settings.secondaryCurrency : null;
  const officialRate = foreignCurrency && settings?.exchangeRate ? settings.exchangeRate : null;
  const local = parseAmount(localRaw);
  const foreign = foreignCurrency ? parseAmount(foreignRaw) : 0;
  const typed = local > 0 || foreign > 0;
  const due = dueByCurrency(bills, baseCurrency);

  const planned = planBulkSettlement({
    bills: ordered.map((bill) => ({
      id: bill.id,
      currency: bill.currency,
      outstanding: bill.remaining,
      dueDate: bill.dueDate,
      createdAt: bill.createdAt,
    })),
    method,
    tender: cash ? { local, foreign, foreignCurrency: foreignCurrency ?? 'USD' } : null,
    baseCurrency,
    exchangeRate: officialRate,
  });
  const change = planned.ok ? planned.plan.change : 0;
  /** A bill in a currency neither note pays is said at once; a shortfall only once something is typed. */
  const refusal =
    cash && settings && !planned.ok && (typed || planned.refusal.code === 'BULK_SETTLE_CURRENCY_UNSUPPORTED')
      ? localizeApiError(
          { code: planned.refusal.code, params: planned.refusal.params },
          locale === 'en' ? 'en' : 'ar',
        )
      : null;

  const scope = bulkKeyScope(bills.map((bill) => bill.id));
  /** Read on each render: every press that changes it also sets state. */
  const retrying = heldInDoubt(tenant, scope);

  const overview = cash ? overviewQuery.data : undefined;
  const safe = overview?.active
    ? overview.accounts.find(
        (account) =>
          account.type === 'CASH_SAFE' && account.currency === baseCurrency && account.isPrimary && account.active,
      )
    : undefined;
  const changeShort = cash && planned.ok && safe !== undefined && change > 0 && safe.balance + local < change;
  const refusesChange = changeShort && !retrying;
  const treasuryUnread = cash && change > 0 && Boolean(overviewQuery.error) && !overviewQuery.data;

  const pickable = (staffQuery.data?.items ?? []).filter(
    (candidate) => candidate.isActive && candidate.role !== 'VIEWER',
  );

  const decimals = (currency: string): 0 | 2 => (currency === 'LBP' ? 0 : 2);

  const fillExact = (): void => {
    const baseDue = due.find((entry) => entry.currency === baseCurrency)?.amount ?? 0;
    const foreignDue = foreignCurrency ? (due.find((entry) => entry.currency === foreignCurrency)?.amount ?? 0) : 0;
    setLocalRaw(baseDue > 0 ? formatTypedAmount(String(baseDue), decimals(baseCurrency)) : '');
    setForeignRaw(foreignDue > 0 ? formatTypedAmount(String(foreignDue), 2) : '');
    setFieldErrors(({ tender: _cleared, ...rest }) => rest);
  };

  const refreshTreasury = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || done || bills.length === 0 || !citizen) return;

    const errors: Partial<Record<FieldKey, string>> = {};
    if (cash && !typed) errors.tender = t('enterTender');
    const ref = reference.trim();
    if (method === 'WHISH_MONEY' && (ref.length < 4 || ref.length > 80)) errors.reference = t('referenceInvalid');
    if (method === 'COLLECTOR' && !collectedById) errors.collector = t('collectorMissing');

    const parsed = bulkSettlePaymentsSchema.safeParse({
      citizenId: citizen.citizenId,
      paymentIds: ordered.map((bill) => bill.id),
      method,
      collectedById: method === 'COLLECTOR' ? collectedById || undefined : undefined,
      whishTransactionRef: method === 'WHISH_MONEY' ? ref || undefined : undefined,
      tendered: cash ? { local, foreign, foreignCurrency: foreignCurrency ?? 'USD' } : undefined,
      note: note.trim() || undefined,
      clientRequestId: heldKey(tenant, scope),
    });
    if (!parsed.success) {
      /*
        The shared schema is the contract and its messages are Arabic by design,
        so only the field names come from it; the words are this dialog's (TXT-1).
      */
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (field === 'tendered' && !errors.tender) errors.tender = t('enterTender');
        else if (field === 'whishTransactionRef' && !errors.reference) errors.reference = t('referenceInvalid');
        else if (field === 'collectedById' && !errors.collector) errors.collector = t('collectorMissing');
      }
    }
    const first = (['tender', 'reference', 'collector'] as const).find((field) => errors[field]);
    if (first) {
      setFieldErrors(errors);
      setFormError(null);
      document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    if (!parsed.success) {
      setFormError(t('failed'));
      return;
    }
    // The preview already says why; the server would refuse the same.
    if (cash && (!settings || !planned.ok || refusesChange)) return;

    setFieldErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    let result: SettlementReceipt;
    try {
      result = await bulkSettlePayments(tenant, token, parsed.data);
    } catch (caught) {
      logApiError(caught);
      // The words for the code (TXT-6); the server's own only for a refusal this build does not know.
      setFormError(caught instanceof ApiRequestError && caught.message ? caught.message : t('failed'));
      if (keyIsSpent(caught)) {
        // That settlement exists: the next press is a new act, and the balances on screen are behind it.
        spendKey(tenant, scope);
        void refreshTreasury();
      } else if (outcomeInDoubt(caught)) {
        /*
          It may have been recorded. The key is kept, so a retry of the same set
          is answered from it; marked in doubt, so a balance the lost settlement
          moved does not refuse that retry; and the balances are read again.
        */
        markInDoubt(tenant, scope);
        void refreshTreasury();
      }
      if (caught instanceof ApiRequestError && caught.code === 'BULK_SETTLE_SOME_ALREADY_PAID') onStale();
      // A failed attempt releases the button; a recorded one never does.
      inFlight.current = false;
      setBusy(false);
      return;
    }

    // Recorded: `inFlight` stays held and the form locked; the receipt page opens.
    spendKey(tenant, scope);
    setDone(true);
    setBusy(false);
    // The receipt page reads this key: it opens on the server's answer, with nothing to fetch (STA-6).
    queryClient.setQueryData(['fees-settlement', tenant, result.id], result);
    // Money moved into wallets and the bills are paid: every read of either is stale.
    void Promise.all([
      refreshTreasury(),
      queryClient.invalidateQueries({ queryKey: ['fees-payments', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['fees-context', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['fee-filter-options', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant] }),
    ]);
    if (result.replayed) {
      // An earlier attempt recorded it: its details stand, whatever the form says now.
      toast.warning(t('replayedTitle', { number: result.number }), { description: t('replayedBody') });
    } else {
      toast.success(t('successTitle', { number: result.number }), {
        description: t('successBody', { count: result.items.length }),
      });
    }
    router.push(`${base}/fees/settlements/${encodeURIComponent(result.id)}`);
    onSettled(result);
  };

  /** The notes typed, per currency, the municipality's own first. */
  const notes: Array<{ amount: number; currency: string }> = [];
  if (local > 0) notes.push({ amount: local, currency: baseCurrency });
  if (foreign > 0 && foreignCurrency) notes.push({ amount: foreign, currency: foreignCurrency });

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { count: bills.length, name: citizen?.citizenName ?? '' })}
          </DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <fieldset disabled={busy || done} className="m-0 min-w-0 space-y-4 border-0 p-0">
            {/* The bills, as the server will settle them: oldest first. */}
            <BulkBillsTable bills={ordered} due={due} locale={locale} onRemove={onRemove} />

            <Field label={t('method')} htmlFor="bulk-settle-method" required>
              <div className="grid gap-2 sm:grid-cols-3">
                {METHODS.map((option) => (
                  <ChoiceCard
                    key={option.value}
                    name="bulk-settle-method"
                    value={option.value}
                    checked={method === option.value}
                    onChange={(next) => {
                      setMethod(next as PaymentMethod);
                      setFieldErrors({});
                      if (next !== 'WHISH_MONEY') setReference('');
                      if (next !== 'COLLECTOR') setCollectedById('');
                    }}
                    title={labels.paymentMethod[option.value]}
                    description={tCounter(`methodBody.${option.value}`)}
                    icon={option.icon}
                  />
                ))}
              </div>
            </Field>

            {method === 'WHISH_MONEY' ? (
              <Field label={tCounter('reference')} htmlFor={FIELD_IDS.reference} error={fieldErrors.reference} required>
                <Input
                  id={FIELD_IDS.reference}
                  dir="ltr"
                  className="text-start font-mono font-semibold"
                  placeholder="TRX-000000"
                  maxLength={80}
                  invalid={Boolean(fieldErrors.reference)}
                  value={reference}
                  onChange={(event) => {
                    setReference(event.target.value);
                    setFieldErrors(({ reference: _cleared, ...rest }) => rest);
                  }}
                />
              </Field>
            ) : null}

            {method === 'COLLECTOR' ? (
              <Field label={tCounter('collector')} htmlFor={FIELD_IDS.collector} error={fieldErrors.collector} required>
                {staffQuery.error && !staffQuery.data ? (
                  <Alert variant="warning">{tCounter('collectorsFailed')}</Alert>
                ) : staffQuery.loading ? (
                  <LoadingState compact label={t('collectorsLoading')} />
                ) : pickable.length === 0 ? (
                  <Alert variant="warning">{tCounter('noCollectors')}</Alert>
                ) : (
                  <Select
                    value={collectedById}
                    onValueChange={(next) => {
                      setCollectedById(next);
                      setFieldErrors(({ collector: _cleared, ...rest }) => rest);
                    }}
                  >
                    <SelectTrigger id={FIELD_IDS.collector}>
                      <SelectValue placeholder={tCounter('collectorPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {pickable.map((collector) => (
                        <SelectItem key={collector.id} value={collector.id}>
                          {collector.fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            ) : null}

            {cash ? (
              settingsQuery.error && !settings ? (
                <ErrorState compact title={settingsQuery.error} onRetry={settingsQuery.refetch} retryLabel={t('retry')} />
              ) : !settings ? (
                <LoadingState compact label={t('settingsLoading')} />
              ) : (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{t('tender')}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={fillExact}>
                        <Coins className="size-3.5" aria-hidden />
                        {t('exact')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          setLocalRaw('');
                          setForeignRaw('');
                        }}
                      >
                        <Eraser className="size-3.5" aria-hidden />
                        {t('clearTender')}
                      </Button>
                    </div>
                  </div>

                  <div className={cn('grid gap-3', foreignCurrency && 'sm:grid-cols-2')}>
                    <Field
                      label={t('tenderIn', { unit: currencyUnit(baseCurrency, locale) })}
                      htmlFor={FIELD_IDS.tender}
                      error={fieldErrors.tender}
                      optionalLabel=""
                    >
                      <CurrencyInput
                        id={FIELD_IDS.tender}
                        unit={currencyUnit(baseCurrency, locale)}
                        value={localRaw}
                        placeholder="0"
                        invalid={Boolean(fieldErrors.tender)}
                        inputClassName="text-lg font-bold"
                        onChange={(raw) => {
                          setLocalRaw(formatTypedAmount(raw, decimals(baseCurrency)));
                          setFieldErrors(({ tender: _cleared, ...rest }) => rest);
                        }}
                      />
                    </Field>
                    {foreignCurrency ? (
                      <Field
                        label={t('tenderIn', { unit: currencyUnit(foreignCurrency, locale) })}
                        htmlFor="bulk-settle-foreign"
                        optionalLabel=""
                      >
                        <CurrencyInput
                          id="bulk-settle-foreign"
                          unit={currencyUnit(foreignCurrency, locale)}
                          value={foreignRaw}
                          placeholder="0"
                          inputClassName="text-lg font-bold"
                          onChange={(raw) => {
                            setForeignRaw(formatTypedAmount(raw, 2));
                            setFieldErrors(({ tender: _cleared, ...rest }) => rest);
                          }}
                        />
                      </Field>
                    ) : null}
                  </div>

                  {/* The official rate, shown with its date and never typed (FRM-5). */}
                  {foreignCurrency && officialRate ? (
                    <p className="text-xs text-muted-foreground">
                      {t.rich(settings.exchangeRateUpdatedAt ? 'rateLine' : 'rateLineUndated', {
                        unit: formatMoney(1, foreignCurrency, locale),
                        rate: formatMoney(officialRate, baseCurrency, locale),
                        date: settings.exchangeRateUpdatedAt ? formatDate(settings.exchangeRateUpdatedAt) : '',
                        v: (chunks) => (
                          <bdi dir="ltr" className="font-semibold tabular-nums text-foreground">
                            {chunks}
                          </bdi>
                        ),
                      })}
                    </p>
                  ) : foreignCurrency ? (
                    <p className="text-xs text-muted-foreground">{t('noRate', { currency: foreignCurrency })}</p>
                  ) : null}

                  {/* What the press would record — the server works it out again and prints its own. */}
                  <div className="rounded-lg bg-muted/50 px-3" aria-live="polite">
                    <SummaryList>
                      <SummaryRow label={t('summaryDue')}>
                        <MoneyList entries={due} locale={locale} />
                      </SummaryRow>
                      <SummaryRow label={t('summaryReceived')}>
                        {notes.length > 0 ? <MoneyList entries={notes} locale={locale} /> : '—'}
                      </SummaryRow>
                      {typed && planned.ok ? (
                        <SummaryRow label={t('summaryChange')} className={change > 0 ? 'text-info' : undefined}>
                          {change > 0 ? (
                            <Money amount={change} currency={baseCurrency} locale={locale} exact />
                          ) : (
                            t('noChange')
                          )}
                        </SummaryRow>
                      ) : null}
                    </SummaryList>
                  </div>

                  {refusal ? (
                    <Alert variant="destructive" live="status">
                      {refusal}
                    </Alert>
                  ) : null}

                  {changeShort && safe ? (
                    retrying ? (
                      <Alert variant="warning" live="status" title={t('changeShortInDoubtTitle')}>
                        {t('changeShortInDoubtBody')}
                      </Alert>
                    ) : (
                      <Alert variant="destructive" live="status" title={t('changeShortTitle')}>
                        {t('changeShortBody', {
                          account: safe.name,
                          balance: formatMoney(safe.balance, baseCurrency, locale),
                          local: formatMoney(local, baseCurrency, locale),
                          change: formatMoney(change, baseCurrency, locale),
                        })}
                      </Alert>
                    )
                  ) : null}
                  {treasuryUnread ? <Alert variant="info">{t('treasuryUnread')}</Alert> : null}
                </section>
              )
            ) : null}

            <Field label={t('note')} htmlFor="bulk-settle-note" optionalLabel={t('optional')}>
              <Textarea
                id="bulk-settle-note"
                rows={2}
                maxLength={500}
                placeholder={t('notePlaceholder')}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="resize-none"
              />
            </Field>
          </fieldset>

          {/* After a lost answer the way out is the same press, unchanged. */}
          {retrying && !changeShort ? <Alert variant="warning">{t('inDoubt')}</Alert> : null}

          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || done || refusesChange || (cash && (!settings || refusal !== null))}
              className="w-full gap-1.5 sm:w-auto"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="size-4" aria-hidden />
              )}
              {busy ? t('submitting') : t('submit', { count: bills.length })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
