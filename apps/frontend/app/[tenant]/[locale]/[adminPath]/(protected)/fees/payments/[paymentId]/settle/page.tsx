'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  CreditCard,
  Loader2,
  RotateCcw,
  UserCheck,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenProfile,
  getMunicipalitySettings,
  getPaymentById,
  getStaff,
  getTenantConfig,
  logApiError,
  settlePayment,
} from '@/lib/api-client';
import type {
  AdminPaymentItem,
  CitizenProfile,
  CitizenProfilePayment,
  MunicipalitySettings,
  StaffSummary,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { PAYMENT_SETTLE_ROLES, hasRole } from '@/lib/staff-roles';
import { formatLbp, formatTypedAmount } from '@/lib/currency';
import { CurrencyInput } from '@/components/ui/currency-input';
import { formatDate } from '@/lib/dates';
import { tafqeet } from '@/lib/tafqeet';
import { PaymentReceipt, type RecordedMovement } from '@/components/admin/payment-receipt';
import { heldKey, keyIsSpent, spendKey } from '@/lib/request-id';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

const METHODS = [
  { value: 'CASH', icon: Banknote },
  { value: 'WHISH_MONEY', icon: CreditCard },
  { value: 'COLLECTOR', icon: UserCheck },
] as const;

type Method = (typeof METHODS)[number]['value'];

type SettleResult = Awaited<ReturnType<typeof settlePayment>>;

/**
 * The bill as the receipt prints it once money has moved: the citizen's own
 * row when his file has it, else the row this page loaded, carrying the
 * figures the server returned. Either way the balance is the server's.
 */
function receiptPayment(
  item: AdminPaymentItem,
  fromFile: CitizenProfilePayment | undefined,
  result: SettleResult,
  method: Method,
): CitizenProfilePayment {
  const row: CitizenProfilePayment = fromFile ?? {
    id: item.id,
    title: item.title,
    amount: item.amount,
    paidAmount: result.paidAmount,
    remaining: result.remaining,
    currency: item.currency,
    dueDate: item.dueDate,
    paymentStatus: result.paymentStatus,
    paymentMethod: item.paymentMethod ?? method,
    invoiceNumber: null,
    whishTransactionRef: item.whishTransactionRef,
    paidAt: item.paidAt,
    reviewNote: null,
    frequency: item.frequency,
    assessment: item.assessment ?? null,
  };
  return { ...row, remaining: result.remaining };
}

/**
 * «تسجيل دفعة» — one bill settled at the counter, in cash, by Whish, or as a
 * collector's round.
 *
 * ## Once the server has answered, the page is done
 *
 * Settling and printing are two reads, and only the first moves money. When
 * `settlePayment` resolves the page enters its success state and stays there:
 * the form is locked, the in-flight guard is never released and the retry key
 * is never renewed, so nothing on the page can take the money a second time.
 * The receipt is built from what the server returned (`recorded`: its RCP
 * number, its moment, its amounts) and the citizen's file, which is read after.
 * If that read fails, the page says the payment is recorded under its RCP
 * number and that the full receipt could not be loaded, and offers to read the
 * file again — never to pay again. Folding the two into one `try` is what made
 * a throttled profile read re-enable a payment that had already been taken.
 *
 * ## The retry key
 *
 * One per bill (STA-4, `keyIsSpent`), held in `lib/request-id.ts` as
 * `settle:<paymentId>` — the citizen cash page settles the same bill and holds
 * the same key — so it outlives this page: a reload of the page's own reads, a
 * trip away and back. Kept across every failure and every edit, because a
 * refusal proves only that *this* attempt took nothing. A counter payment's key
 * is bound to its bill alone, so a retry after a lost answer is answered with
 * the first receipt — which may carry another amount than the form now shows,
 * and the page says so (`replayed`). It is spent on a 2xx, so the next payment
 * on the bill is a new act, and on a refusal `keyIsSpent` names — among them
 * `TRANSACTION_ALREADY_REVERSED`, an earlier receipt that has been reversed since.
 */
export default function SettlePaymentPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; paymentId: string }>;
}) {
  const { tenant, locale, adminPath, paymentId } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useTranslations('counterPayment');
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payment, setPayment] = useState<AdminPaymentItem | null>(null);
  const [collectors, setCollectors] = useState<StaffSummary[]>([]);
  /** The staff read failed (it is not open to every role that settles), which is not «no staff». */
  const [collectorsFailed, setCollectorsFailed] = useState(false);

  const [municipalityName, setMunicipalityName] = useState('');
  const [settings, setSettings] = useState<MunicipalitySettings | null>(null);

  // Form State
  const [method, setMethod] = useState<Method>('CASH');
  const [reference, setReference] = useState('');
  const [collectedById, setCollectedById] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /** What the server recorded. Once set, the page is in its success state for good. */
  const [settled, setSettled] = useState<SettleResult | null>(null);
  /** The citizen's file for the receipt, read after the money moved; its own failure is its own. */
  const [citizen, setCitizen] = useState<CitizenProfile | null>(null);
  const [receiptState, setReceiptState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [receiptOpen, setReceiptOpen] = useState(false);

  /*
    Double submission (STA-4): `submitting` disables the button a render too
    late for a fast second press, so a ref stops it synchronously. See the
    component's doc comment for the retry key.
  */
  const inFlight = useRef(false);
  const keyScope = `settle:${paymentId}` as const;

  const load = useCallback(async () => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    /*
      Settling is the money roles' (`PAYMENT_SETTLE_ROLES`, as the route):
      anyone else reaching this address — «مشاهد فقط» typing it in — is sent
      back to the fees screen rather than shown a form the server refuses.
    */
    if (!hasRole(PAYMENT_SETTLE_ROLES, session.user.role)) {
      router.replace(`${base}/fees`);
      return;
    }
    const accessToken = session.accessToken;
    setToken(accessToken);
    setLoading(true);
    setLoadError(null);

    try {
      const row = await getPaymentById(tenant, accessToken, paymentId);
      setPayment(row);
      setAmount(formatTypedAmount(String(Math.round(row.remaining)), 0));
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      setLoadError(caught instanceof ApiRequestError && caught.status === 404 ? t('notFound') : t('loadError'));
      return;
    } finally {
      setLoading(false);
    }

    getStaff(tenant, accessToken)
      .then(({ items }) => {
        setCollectors(items);
        setCollectorsFailed(false);
      })
      .catch((caught) => {
        logApiError(caught);
        setCollectors([]);
        setCollectorsFailed(true);
      });
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(locale === 'en' ? (config.name || config.nameAr) : (config.nameAr || config.name)))
      .catch(() => setMunicipalityName(tenant));
    getMunicipalitySettings(tenant, accessToken)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [tenant, base, paymentId, router, locale, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Reads the citizen's file for the receipt. Called once the money has moved,
   * and again from «أعد تحميل الوصل» if it failed; it never touches the payment.
   */
  const loadReceipt = useCallback(
    async (citizenId: string) => {
      if (!token) return;
      setReceiptState('loading');
      try {
        const profile = await getCitizenProfile(tenant, token, citizenId);
        setCitizen(profile);
        setReceiptState('idle');
        setReceiptOpen(true);
      } catch (caught) {
        logApiError(caught);
        setReceiptState('failed');
      }
    },
    [tenant, token],
  );

  if (loading) {
    return (
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <LoadingState fullHeight />
      </div>
    );
  }

  if (loadError || !payment) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-12 sm:px-6">
        <ErrorState description={loadError ?? undefined} onRetry={() => void load()} />
        <div className="flex justify-center">
          <Link
            href={`${base}/fees`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
            {t('backToFees')}
          </Link>
        </div>
      </div>
    );
  }

  const received = Number(amount.replace(/\D/g, '')) || 0;
  const isWhish = method === 'WHISH_MONEY';
  const isCollector = method === 'COLLECTOR';
  const missingReference = isWhish && reference.trim() === '';
  const missingCollector = isCollector && collectedById === '';
  const tooMuch = received > payment.remaining;
  const valid = received > 0 && !tooMuch && !missingReference && !missingCollector;
  const isPartial = received > 0 && received < payment.remaining;
  /** The money has moved: nothing on the page may move it again. */
  const locked = settled !== null;
  /** What the bill stands at: the server's figures once it has answered, the loaded bill before. */
  const paidSoFar = settled ? settled.paidAmount : payment.paidAmount;
  const stillDue = settled ? settled.remaining : payment.remaining;
  /**
   * Who may be named as the collector: active staff who can hold cash. «مشاهد
   * فقط» cannot (the server refuses a VIEWER with `COLLECTOR_NOT_FOUND`), so the
   * picker does not offer one.
   */
  const pickable = collectors.filter((candidate) => candidate.isActive && candidate.role !== 'VIEWER');

  const submit = async () => {
    if (!token || !valid || locked || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);

    let result: SettleResult;
    try {
      result = await settlePayment(tenant, token, payment.id, {
        method,
        amount: received,
        whishTransactionRef: isWhish ? reference.trim() : undefined,
        collectedById: isCollector ? collectedById : undefined,
        note: note.trim() || undefined,
        clientRequestId: heldKey(tenant, keyScope),
      });
    } catch (caught) {
      logApiError(caught);
      // A key whose act exists is spent; every other failure keeps it, so a retry is answered from the first.
      if (keyIsSpent(caught)) spendKey(tenant, keyScope);
      setSubmitError(failureText(caught));
      inFlight.current = false;
      setSubmitting(false);
      return;
    }

    // Recorded. `inFlight` stays held and the page is done; the next payment on this bill is a new act.
    spendKey(tenant, keyScope);
    setSettled(result);
    setSubmitting(false);
    // Cash, a Whish transfer or a collector's custody just moved: every treasury balance read before it is stale.
    void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
    if (result.replayed) {
      // Over the receipt, which opens next: the first receipt stands, as first recorded.
      toast.warning(t('replayedTitle', { number: result.receiptNumber }), {
        description: t('replayedBody', { amount: formatLbp(result.received, locale) }),
      });
    }
    await loadReceipt(payment.citizenId);
  };

  /** The words for a failed press: the localised text for the code (TXT-6), or this page's own for a reversed earlier receipt. */
  const failureText = (caught: unknown): string => {
    if (caught instanceof ApiRequestError && caught.code === 'TRANSACTION_ALREADY_REVERSED') {
      const number = caught.payload.params?.receiptNumber;
      if (number) return t('earlierReversed', { number: String(number) });
    }
    return caught instanceof ApiRequestError ? caught.message : t('failed');
  };

  /*
    The receipt the server just wrote — its RCP number and its moment — never
    the bill's reference and today's date (decree 5595/1982 art. 16: the
    receipt handed over is the numbered one).
  */
  const recorded: RecordedMovement | null = settled
    ? {
        receiptNumber: settled.receiptNumber,
        occurredAt: settled.occurredAt,
        received: settled.received,
        remaining: settled.remaining,
        changeGiven: settled.changeGiven,
        tender: null,
        method,
      }
    : null;
  const printable =
    settled && citizen
      ? receiptPayment(
          payment,
          citizen.payments.find((row) => row.id === payment.id),
          settled,
          method,
        )
      : null;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/fees`} label={t('back')} />

      <PageHeader
        icon={Banknote}
        title={t('title')}
        actions={
          <Badge variant="outline" className="px-3 py-1 text-sm font-semibold">
            {t('remainingBadge', { amount: formatLbp(settled ? settled.remaining : payment.remaining, locale) })}
          </Badge>
        }
      />

      {/* The success state: what was recorded, and the receipt — reopened, or read again if it failed. */}
      {settled ? (
        <Alert
          variant={settled.replayed || receiptState === 'failed' ? 'warning' : 'success'}
          live="status"
          title={
            receiptState === 'failed'
              ? t('receiptFailedTitle', { number: settled.receiptNumber })
              : settled.replayed
                ? t('replayedTitle', { number: settled.receiptNumber })
                : t('recordedTitle', { number: settled.receiptNumber })
          }
        >
          <div className="space-y-2">
            {settled.replayed ? (
              <p>{t('replayedBody', { amount: formatLbp(settled.received, locale) })}</p>
            ) : null}
            {receiptState === 'failed' ? <p>{t('receiptFailedBody')}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              {/* Reads the citizen's file again, for the receipt only: the payment is not touched. */}
              {receiptState !== 'idle' ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={receiptState === 'loading'}
                  onClick={() => void loadReceipt(payment.citizenId)}
                >
                  {receiptState === 'loading' ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                  {receiptState === 'loading' ? t('loadingReceipt') : t('retryReceipt')}
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost">
                <Link href={`${base}/fees`}>{t('backToFees')}</Link>
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {submitError ? (
        <Alert variant="destructive" live="alert">
          {submitError}
        </Alert>
      ) : null}

      {/*
        One fieldset around the form, so the success state locks every control
        at once — the method, the amount, the note and the button.
      */}
      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        {/* Full Page Width 2-Column Equal-Height Grid */}
        <div className="grid gap-6 lg:grid-cols-12 lg:items-stretch">
          {/* The form controls (8 of 12 columns). */}
          <div className="h-full lg:col-span-8">
            <div className="flex h-full flex-col justify-between space-y-5 rounded-xl border bg-card p-4 shadow-sm">
              <div className="space-y-5">
                {/* Payment Method */}
                <Field label={t('method')} htmlFor="settle-method" required>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {METHODS.map((option) => (
                      <ChoiceCard
                        key={option.value}
                        name="settle-method"
                        value={option.value}
                        checked={method === option.value}
                        onChange={(next) => {
                          setMethod(next as Method);
                          if (next !== 'WHISH_MONEY') setReference('');
                          if (next !== 'COLLECTOR') setCollectedById('');
                        }}
                        title={labels.paymentMethod[option.value]}
                        description={t(`methodBody.${option.value}`)}
                        icon={option.icon}
                      />
                    ))}
                  </div>
                </Field>

                {/* Method-specific fields */}
                {isWhish ? (
                  <Field label={t('reference')} htmlFor="settle-reference" required>
                    <Input
                      id="settle-reference"
                      dir="ltr"
                      className="text-start font-mono font-semibold"
                      placeholder="TRX-000000"
                      invalid={missingReference && reference !== ''}
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </Field>
                ) : null}

                {isCollector ? (
                  <Field label={t('collector')} htmlFor="settle-collector" required>
                    {collectorsFailed ? (
                      <Alert variant="warning">{t('collectorsFailed')}</Alert>
                    ) : pickable.length === 0 ? (
                      <Alert variant="warning">{t('noCollectors')}</Alert>
                    ) : (
                      <Select value={collectedById} onValueChange={setCollectedById}>
                        <SelectTrigger id="settle-collector">
                          <SelectValue placeholder={t('collectorPlaceholder')} />
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

                {/* Amount */}
                <div className="space-y-2">
                  <Field
                    label={t('amount')}
                    htmlFor="settle-amount"
                    required
                    error={tooMuch ? t('tooMuch', { amount: formatLbp(payment.remaining, locale) }) : undefined}
                  >
                    {/*
                      `CurrencyInput`, not an input with the unit absolutely placed
                      over it (PRIM-25). The old markup put «ل.ل» on top of the
                      digits: the field is `dir="ltr"` so `pe-16` reserved room on
                      its right, while the wrapper inherits the page's RTL so
                      `end-0` pinned the unit to the left — opposite sides, and the
                      unit landed on the «0». The primitive gives the unit a segment
                      of its own, which is the bug its own doc comment describes.
                    */}
                    <CurrencyInput
                      id="settle-amount"
                      unit={locale === 'en' ? 'LBP' : 'ل.ل'}
                      value={amount}
                      placeholder="0"
                      invalid={tooMuch}
                      inputClassName="text-xl font-bold"
                      onChange={(raw) => setAmount(formatTypedAmount(raw, 0))}
                    />
                  </Field>

                  {/* Amount Quick Presets */}
                  {payment.remaining > 1 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setAmount(formatTypedAmount(String(Math.round(payment.remaining)), 0))}
                      >
                        {t('fullBalance', { amount: formatLbp(payment.remaining, locale) })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setAmount(formatTypedAmount(String(Math.round(payment.remaining / 2)), 0))}
                      >
                        {t('half', { amount: formatLbp(Math.round(payment.remaining / 2), locale) })}
                      </Button>
                    </div>
                  ) : null}

                  {/* The amount in Arabic words, as the receipt writes it. */}
                  {received > 0 && !tooMuch && locale === 'ar' ? (
                    <p className="pt-1 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{t('inWords')}</span> {tafqeet(received)}
                    </p>
                  ) : null}

                  {isPartial && !locked ? (
                    <Alert variant="warning">
                      {t.rich('partial', {
                        amount: formatLbp(payment.remaining - received, locale),
                        b: (chunks) => <span className="font-semibold">{chunks}</span>,
                      })}
                    </Alert>
                  ) : null}
                </div>
              </div>

              {/* Note at bottom of left card */}
              <div className="pt-2">
                <Field label={t('note')} htmlFor="settle-note">
                  <Textarea
                    id="settle-note"
                    rows={2}
                    placeholder={t('notePlaceholder')}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          </div>

          {/* The summary and the button (4 of 12 columns). */}
          <div className="h-full lg:col-span-4">
            <div className="flex h-full flex-col justify-between rounded-xl border bg-card p-4 shadow-sm">
              {/* Top: Details List */}
              <div className="space-y-4">
                <h3 className="border-b pb-3 text-sm font-bold text-foreground">{t('details')}</h3>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('citizen')}</span>
                    <span className="font-semibold text-foreground">{payment.citizenName}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('charge')}</span>
                    <span className="font-semibold text-foreground">{payment.title}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('dueDate')}</span>
                    <span className="text-foreground">{formatDate(payment.dueDate)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('total')}</span>
                    <span className="tabular-nums text-foreground">{formatLbp(payment.amount, locale)}</span>
                  </div>
                  {/* After the payment, the server's figures: the bill as it now stands, not as it was loaded. */}
                  {paidSoFar > 0 ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{locked ? t('paidSoFar') : t('previouslyPaid')}</span>
                      <span className="font-semibold tabular-nums text-success">{formatLbp(paidSoFar, locale)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3 border-t pt-2 font-bold">
                    <span className="text-foreground">{t('remainingDue')}</span>
                    <span className="tabular-nums text-foreground">{formatLbp(stillDue, locale)}</span>
                  </div>
                </div>
              </div>

              {/* Bottom: Recording summary + Submit Button */}
              <div className="mt-6 space-y-3 border-t pt-4">
                {/* Before the press, what it would record; after it, what the server recorded. */}
                <div className="space-y-1 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
                  <span className="text-xs text-muted-foreground">{settled ? t('recorded') : t('toRecord')}</span>
                  <p className="text-xl font-bold tabular-nums text-primary">
                    {formatLbp(settled ? settled.received : valid ? received : 0, locale)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {settled ? t('receiptLine', { number: settled.receiptNumber }) : t(`via.${method}`)}
                  </p>
                </div>

                <Button
                  size="lg"
                  className="h-12 w-full text-base font-bold shadow-sm"
                  disabled={!valid || submitting || locked}
                  onClick={() => void submit()}
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-4" aria-hidden />
                  )}
                  {t('submit')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </fieldset>

      {/* The receipt; closing it goes back to the fees screen. */}
      <PaymentReceipt
        open={receiptOpen && printable !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReceiptOpen(false);
            router.push(`${base}/fees`);
          }
        }}
        tenant={tenant}
        // Only the money roles reach this page (`PAYMENT_SETTLE_ROLES`), each of them a working role.
        canSend
        citizen={citizen ?? ({} as CitizenProfile)}
        payment={printable}
        municipalityName={municipalityName}
        governorate={settings?.governorate}
        councilDecisionRef={settings?.councilDecisionRef}
        district={settings?.district}
        contactPhone={settings?.contactPhone}
        officeWhatsapp={settings?.whatsappNumber}
        recorded={recorded}
        locale={locale}
      />
    </div>
  );
}
