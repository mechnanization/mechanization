'use client';

import { use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Banknote, CalendarDays, Coins, Eraser, Loader2, Pencil, ReceiptText, RotateCcw, UserRound } from 'lucide-react';
import {
  ADJUSTMENT_REASON_MIN,
  BACKDATE_WINDOW_DAYS,
  canOverrideCashRules,
  daysBetween,
  getLabels,
  municipalToday,
  roundRate,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenProfile,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
  settlePayment,
} from '@/lib/api-client';
import { useStaffSession } from '@/lib/use-staff-session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate } from '@/lib/dates';
import { formatForeign, formatLbp, formatTypedAmount, parseAmount } from '@/lib/currency';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { PaymentReceipt, type RecordedMovement } from '@/components/admin/payment-receipt';
import { cn } from '@/lib/utils';

/** Mirrors `@Roles` on `PATCH fees/payments/:id/settle`; the server is the enforcement. */
const SETTLE_ROLES = ['SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT'];

/** What the citizen is paying in. «BOTH» is «20$ و200,000 ليرة» handed over together. */
type PayIn = 'LBP' | 'FOREIGN' | 'BOTH';

/** A fresh retry key: one per distinct payment the clerk is about to record. */
function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
      );
}

/**
 * «تسجيل دفعة نقدية» — cash taken at the counter against one ليرة bill.
 *
 * The clerk picks what the citizen is paying in — ليرة, the municipality's
 * second currency, or both at once — and types the amount. The rate is the
 * municipality's own from الإعدادات, shown with its date. Only a finance role
 * (SUPER_ADMIN, ACCOUNTANT) may take one payment at another rate, and then
 * with a reason; a payment dated before today also states why, and more than
 * `BACKDATE_WINDOW_DAYS` back is a finance correction. The server enforces all
 * of it (`cash-policy.ts`); the page explains it before the press.
 *
 * A note larger than the balance settles the bill and shows «الباقي» to hand
 * back. Everything here is a preview: the server works the credit and the
 * change out again, refuses what it must, and the receipt prints what the
 * server recorded — its receipt number and its date.
 */
export default function SettleCashPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; citizenId: string; paymentId: string }>;
}) {
  const { tenant, locale, adminPath, citizenId, paymentId } = use(params);
  const router = useRouter();
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const citizenHref = `${base}/citizens/${encodeURIComponent(citizenId)}`;
  const today = useMemo(() => municipalToday(), []);

  const { token, user } = useStaffSession(tenant, base);
  const finance = canOverrideCashRules(user?.role);

  // A role that cannot settle has nothing to do here; the file is where it came from.
  useEffect(() => {
    if (user && !SETTLE_ROLES.includes(user.role)) router.replace(citizenHref);
  }, [user, router, citizenHref]);

  const profile = useStaffQuery({
    queryKey: ['citizen-profile', tenant, citizenId],
    queryFn: (tok) => getCitizenProfile(tenant, tok, citizenId),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the bill.' : 'تعذّر تحميل الفاتورة.',
  });
  const settingsQuery = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (tok) => getMunicipalitySettings(tenant, tok),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the exchange rate.' : 'تعذّر تحميل سعر الصرف.',
  });
  const settings = settingsQuery.data ?? null;
  const [municipalityName, setMunicipalityName] = useState(tenant);
  useEffect(() => {
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(config.nameAr || config.name))
      .catch(() => setMunicipalityName(tenant));
  }, [tenant]);

  const citizen = profile.data ?? null;
  const payment = useMemo(
    () => citizen?.payments.find((candidate) => candidate.id === paymentId) ?? null,
    [citizen, paymentId],
  );

  const [payIn, setPayIn] = useState<PayIn>('LBP');
  const [lbp, setLbp] = useState('');
  const [foreignRaw, setForeignRaw] = useState('');
  /** A rate typed for this payment only (finance roles); null means the municipality's. */
  const [rateOverride, setRateOverride] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RecordedMovement | null>(null);

  /*
    Double submission: `busy` disables the button after React re-renders, but
    a fast second press lands before that. The ref stops it synchronously. The
    request id survives a failed attempt, so a retry after a lost response is
    recognised by the server as the same payment; any change to the figures
    makes it a new one.
  */
  const inFlight = useRef(false);
  const requestId = useRef(newRequestId());
  useEffect(() => {
    requestId.current = newRequestId();
  }, [payIn, lbp, foreignRaw, rateOverride, paidOn]);

  /** The municipality's second currency and its rate — the only pair the counter takes. */
  const foreignCurrency = settings?.secondaryCurrency === 'EUR' ? 'EUR' : 'USD';
  const foreignUnit = foreignCurrency === 'EUR' ? '€' : '$';
  const officialRate =
    settings?.secondaryCurrency === foreignCurrency && settings.exchangeRate ? settings.exchangeRate : null;
  const usesForeign = payIn !== 'LBP';
  const exchangeRate = roundRate(rateOverride !== null ? parseAmount(rateOverride) : (officialRate ?? 0));

  const local = payIn === 'FOREIGN' ? 0 : parseAmount(lbp);
  const foreign = payIn === 'LBP' ? 0 : parseAmount(foreignRaw);
  const remaining = payment ? payment.remaining : 0;
  // The server's arithmetic, shown before it is sent.
  const worth = Math.round(local + foreign * exchangeRate);
  const change = foreign > 0 && local <= remaining + 0.5 && worth > remaining + 0.5 ? Math.round(worth - remaining) : 0;
  const credit = change > 0 ? remaining : worth;
  const after = remaining - credit;
  const settlesIt = credit > 0 && Math.abs(after) <= 0.5;

  const rateOverridden = foreign > 0 && (officialRate === null || exchangeRate !== roundRate(officialRate));
  const backdatedDays = paidOn && paidOn < today ? daysBetween(paidOn, today) : 0;
  const needsReason = rateOverridden || backdatedDays > 0;

  const problem: string | null = (() => {
    if (usesForeign && exchangeRate <= 0) {
      return finance
        ? en
          ? `Enter the ${foreignCurrency} rate for this payment.`
          : 'أدخل سعر الصرف لهذه الدفعة.'
        : en
          ? `No official ${foreignCurrency} rate is set. An accountant or the system administrator sets it in Settings.`
          : 'لا يوجد سعر صرف معتمد. يحدّده المحاسب أو مدير النظام من الإعدادات.';
    }
    if (worth <= 0) return en ? 'Enter the amount paid.' : 'أدخل المبلغ المدفوع.';
    if (worth > remaining + 0.5 && change === 0) {
      return en
        ? `The pounds alone are ${formatLbp(worth - remaining, locale)} more than is owed.`
        : `المبلغ بالليرة يزيد عن المستحق بـ ${formatLbp(worth - remaining, locale)}.`;
    }
    if (!paidOn) return en ? 'Choose the payment date.' : 'اختر تاريخ الدفع.';
    if (backdatedDays > BACKDATE_WINDOW_DAYS && !finance) {
      return en
        ? `A payment more than ${BACKDATE_WINDOW_DAYS} days back is a correction for an accountant or the system administrator.`
        : `دفعة بتاريخ يسبق اليوم بأكثر من ${BACKDATE_WINDOW_DAYS} يوماً تصحيحٌ يعود للمحاسب أو مدير النظام.`;
    }
    if (needsReason && reason.trim().length < ADJUSTMENT_REASON_MIN) {
      return rateOverridden
        ? en
          ? 'Write why this payment is taken at another rate.'
          : 'اكتب سبب اعتماد سعر صرف غير السعر المعتمد.'
        : en
          ? 'Write why this payment is dated before today.'
          : 'اكتب سبب تسجيل الدفعة بتاريخ سابق.';
    }
    return null;
  })();

  /**
   * The whole balance in the chosen currency. In the foreign currency alone,
   * rounded up to the cent — the few ليرة over come back as change; with both,
   * whole cents in the foreign currency and the rest in ليرة, exactly.
   */
  const fillWhole = () => {
    if (payIn === 'LBP') {
      setLbp(formatTypedAmount(String(Math.round(remaining)), 0));
      return;
    }
    if (exchangeRate <= 0) return;
    if (payIn === 'FOREIGN') {
      setForeignRaw(formatTypedAmount(String(Math.ceil((remaining / exchangeRate) * 100) / 100), 2));
      return;
    }
    const whole = Math.floor((remaining / exchangeRate) * 100) / 100;
    const rest = Math.max(0, Math.round(remaining - whole * exchangeRate));
    setForeignRaw(formatTypedAmount(String(whole), 2));
    setLbp(rest > 0 ? formatTypedAmount(String(rest), 0) : '');
  };

  const submit = async () => {
    if (!token || !payment || problem || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await settlePayment(tenant, token, payment.id, {
        method: 'CASH',
        tendered: {
          local,
          foreign,
          foreignCurrency,
          // Omitted at the official rate, so the server takes its own figure.
          ...(rateOverridden ? { exchangeRate } : {}),
        },
        // Only when it was not today, so a same-day payment keeps its real time.
        ...(paidOn !== today ? { paidOn } : {}),
        ...(needsReason ? { adjustmentReason: reason.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        clientRequestId: requestId.current,
      });
      setReceipt({
        receiptNumber: result.receiptNumber,
        occurredAt: result.occurredAt,
        received: result.received,
        remaining: result.remaining,
        changeGiven: result.changeGiven,
        tender:
          foreign > 0
            ? {
                local,
                foreign,
                foreignCurrency,
                exchangeRate: result.exchangeRate ?? exchangeRate,
                officialExchangeRate: result.officialExchangeRate,
              }
            : null,
      });
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : en
            ? 'Could not record the payment. Nothing was taken twice — press again to retry.'
            : 'تعذّر تسجيل الدفعة. لن تُسجَّل مرتين — اضغط مجدداً لإعادة المحاولة.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (profile.error) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <BackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} />
        <ErrorState
          description={profile.error}
          onRetry={() => void profile.refetch()}
          retryLabel={en ? 'Try again' : 'إعادة المحاولة'}
        />
      </div>
    );
  }
  if (!citizen) return <LoadingState fullHeight label={en ? 'Loading the bill…' : 'جارٍ تحميل الفاتورة…'} />;

  /** This payment, in the currency it is being made in. */
  const paidAs =
    [foreign > 0 ? formatForeign(foreign, foreignCurrency) : null, local > 0 ? formatLbp(local, locale) : null]
      .filter(Boolean)
      .join(' + ') || formatLbp(0, locale);

  const statusLabel = payment
    ? (labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus)
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} />

      {/*
        Who is paying, for what, and how much is left — the three things the
        clerk checks against the person at the counter before taking a note.
      */}
      <PageHeader
        icon={Banknote}
        title={en ? 'Record cash payment' : 'تسجيل دفعة نقدية'}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              href={citizenHref}
              className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:text-primary hover:underline"
            >
              <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{citizen.fullName}</span>
            </Link>
            {payment ? (
              <Badge variant="soft-muted" className="max-w-full gap-1.5">
                <ReceiptText className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{payment.title}</span>
              </Badge>
            ) : null}
          </span>
        }
        actions={
          payment ? (
            <div className="text-end">
              <p className="text-xs font-medium text-muted-foreground">{en ? 'Outstanding' : 'المتبقي'}</p>
              <p className="text-2xl font-bold leading-tight tabular-nums">{formatLbp(remaining, locale)}</p>
              <p className="text-xs text-muted-foreground">
                {statusLabel} · {en ? 'due ' : 'استحقاق '}
                {formatDate(payment.dueDate)}
              </p>
            </div>
          ) : null
        }
      />

      {!payment ? (
        <EmptyState
          icon={ReceiptText}
          title={en ? 'This bill is not on the citizen’s file' : 'هذه الفاتورة غير موجودة في ملف المواطن'}
          description={en ? 'It may have been cancelled or merged. Open the file to see current bills.' : 'ربما أُلغيت أو دُمجت. افتح الملف لرؤية الفواتير الحالية.'}
          action={
            <Link href={citizenHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              {en ? 'Open the citizen file' : 'فتح ملف المواطن'}
            </Link>
          }
        />
      ) : payment.paymentStatus === 'PAID' && !receipt ? (
        <EmptyState
          icon={Banknote}
          title={en ? 'This bill is already paid in full' : 'هذه الفاتورة مسدّدة بالكامل'}
          description={en ? 'Nothing is owed on it.' : 'لا مبلغ مستحقاً عليها.'}
        />
      ) : payment.currency !== 'LBP' && !receipt ? (
        /*
          This page takes ليرة and the municipality's second currency against a
          ليرة bill. A bill raised in another currency is settled in that
          currency, from the fees page's own settle screen.
        */
        <EmptyState
          icon={ReceiptText}
          title={en ? `This bill is in ${payment.currency}` : `هذه الفاتورة بعملة ${payment.currency}`}
          description={en ? 'Record its payment from the fees page.' : 'سجّل دفعتها من صفحة الرسوم.'}
          action={
            <Link
              href={`${base}/fees/payments/${encodeURIComponent(payment.id)}/settle`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {en ? 'Open it in fees' : 'فتحها في صفحة الرسوم'}
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ── The form ──────────────────────────────────────────────── */}
          <Card>
            <CardContent className="flex flex-col gap-5 p-5">
              <div className="space-y-2">
                <h2 className="font-semibold">{en ? 'Paid in' : 'عملة الدفع'}</h2>
                <SegmentedControl
                  aria-label={en ? 'Paid in' : 'عملة الدفع'}
                  value={payIn}
                  onChange={(next) => {
                    setPayIn(next as PayIn);
                    if (next === 'LBP') setForeignRaw('');
                    if (next === 'FOREIGN') setLbp('');
                  }}
                  options={[
                    { value: 'LBP', label: en ? 'Lebanese pounds' : 'ليرة لبنانية' },
                    {
                      value: 'FOREIGN',
                      label: foreignCurrency === 'EUR' ? (en ? 'Euros' : 'يورو') : en ? 'US dollars' : 'دولار أميركي',
                    },
                    { value: 'BOTH', label: en ? 'Both' : `ليرة + ${foreignUnit}` },
                  ]}
                />
              </div>

              {/* The rate: the municipality's, shown not typed. A finance role may change it for one payment. */}
              {usesForeign ? (
                rateOverride === null && officialRate ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                    <span>
                      <span className="text-muted-foreground">{en ? 'Official rate: ' : 'السعر المعتمد: '}</span>
                      <bdi dir="ltr" className="font-semibold tabular-nums">
                        1 {foreignUnit} = {formatLbp(officialRate, locale)}
                      </bdi>
                      {settings?.exchangeRateUpdatedAt ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          ({en ? 'set ' : 'حُدِّث '}
                          {formatDate(settings.exchangeRateUpdatedAt)})
                        </span>
                      ) : null}
                    </span>
                    {finance ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1.5"
                        onClick={() => setRateOverride(formatTypedAmount(String(officialRate), 4))}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                        {en ? 'Another rate for this payment' : 'سعر آخر لهذه الدفعة'}
                      </Button>
                    ) : null}
                  </div>
                ) : !finance ? (
                  settingsQuery.loading ? null : (
                    <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-sm text-warning">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        {en
                          ? `No official ${foreignCurrency} rate is set, so this counter cannot take ${foreignCurrency}. An accountant or the system administrator sets it in Settings.`
                          : 'لا يوجد سعر صرف معتمد، فلا يمكن قبض العملة الأجنبية هنا. يحدّده المحاسب أو مدير النظام من الإعدادات.'}
                      </span>
                    </p>
                  )
                ) : (
                  <Field
                    label={
                      en
                        ? `Rate for this payment (LBP per 1 ${foreignUnit})`
                        : `سعر الصرف لهذه الدفعة (ليرة لكل 1 ${foreignUnit})`
                    }
                    htmlFor="tender-rate"
                    required
                    // A rate is a value the credit is computed from — what `caution` is for.
                    caution={
                      officialRate
                        ? en
                          ? `The official rate is ${formatLbp(officialRate, locale)}. Another rate is recorded with its reason and shown on the receipt.`
                          : `السعر المعتمد ${formatLbp(officialRate, locale)}. أي سعر آخر يُسجَّل مع سببه ويُطبع على الوصل.`
                        : en
                          ? 'No official rate is set; the rate you enter is recorded with its reason.'
                          : 'لا يوجد سعر معتمد؛ يُسجَّل السعر الذي تدخله مع سببه.'
                    }
                  >
                    <div className="flex gap-2">
                      <CurrencyInput
                        id="tender-rate"
                        unit="ل.ل"
                        value={rateOverride ?? ''}
                        onChange={(raw) => setRateOverride(formatTypedAmount(raw, 4))}
                        placeholder={en ? 'e.g. 89,500' : 'مثال: 89,500'}
                        className="flex-1"
                      />
                      {officialRate ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          title={en ? 'Back to the official rate' : 'العودة إلى السعر المعتمد'}
                          aria-label={en ? 'Back to the official rate' : 'العودة إلى السعر المعتمد'}
                          onClick={() => setRateOverride(null)}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </Field>
                )
              ) : null}

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">{en ? 'Amount' : 'المبلغ'}</h2>
                  <div className="flex flex-wrap gap-1.5">
                    <QuickButton icon={Coins} onClick={fillWhole} disabled={usesForeign && exchangeRate <= 0}>
                      {en ? 'Whole balance' : 'كامل المتبقي'}
                    </QuickButton>
                    <QuickButton
                      icon={Eraser}
                      onClick={() => {
                        setLbp('');
                        setForeignRaw('');
                      }}
                    >
                      {en ? 'Clear' : 'مسح'}
                    </QuickButton>
                  </div>
                </div>
                <div className={cn('grid gap-4', payIn === 'BOTH' && 'sm:grid-cols-2')}>
                  {payIn !== 'LBP' ? (
                    <Field label={en ? `In ${foreignCurrency}` : `بالـ${foreignUnit}`} htmlFor="tender-foreign" optionalLabel="">
                      <CurrencyInput
                        id="tender-foreign"
                        unit={foreignUnit}
                        value={foreignRaw}
                        onChange={(raw) => setForeignRaw(formatTypedAmount(raw, 2))}
                        placeholder={en ? 'e.g. 20' : 'مثال: 20'}
                        disabled={exchangeRate <= 0}
                      />
                      <Equivalent>
                        {foreign > 0 && exchangeRate > 0 ? `= ${formatLbp(Math.round(foreign * exchangeRate), locale)}` : null}
                      </Equivalent>
                    </Field>
                  ) : null}
                  {payIn !== 'FOREIGN' ? (
                    <Field label={en ? 'In Lebanese pounds' : 'بالليرة'} htmlFor="tender-lbp" optionalLabel="">
                      <CurrencyInput
                        id="tender-lbp"
                        unit="ل.ل"
                        value={lbp}
                        onChange={(raw) => setLbp(formatTypedAmount(raw, 0))}
                        placeholder={en ? 'e.g. 500,000' : 'مثال: 500,000'}
                      />
                      <Equivalent>
                        {local > 0 && exchangeRate > 0 ? `≈ ${formatForeign(local / exchangeRate, foreignCurrency)}` : null}
                      </Equivalent>
                    </Field>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={en ? 'Payment date' : 'تاريخ الدفع'}
                  htmlFor="tender-date"
                  required
                >
                  <DatePicker id="tender-date" value={paidOn} onChange={setPaidOn} max={today} locale={en ? 'en' : 'ar'} />
                </Field>
                <Field label={en ? 'Note' : 'ملاحظة'} htmlFor="tender-note">
                  <Textarea
                    id="tender-note"
                    rows={1}
                    maxLength={500}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={en ? 'e.g. paid by his son at the counter' : 'مثال: دفعها ابنه على الشباك'}
                    className="min-h-10 resize-none"
                  />
                </Field>
              </div>

              {needsReason ? (
                <Field
                  label={
                    rateOverridden
                      ? en
                        ? 'Why another rate'
                        : 'سبب اعتماد سعر آخر'
                      : en
                        ? `Why it is dated ${backdatedDays} day${backdatedDays === 1 ? '' : 's'} before today`
                        : `سبب تسجيلها بتاريخ يسبق اليوم بـ ${backdatedDays} يوماً`
                  }
                  htmlFor="tender-reason"
                  required
                >
                  <Textarea
                    id="tender-reason"
                    rows={2}
                    maxLength={300}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={
                      en
                        ? 'e.g. collected on the round of 28 September, entered today'
                        : 'مثال: قُبضت في جولة 28 أيلول وأُدخلت اليوم'
                    }
                    className="resize-none"
                  />
                </Field>
              ) : null}
            </CardContent>
          </Card>

          {/* ── The summary, the button at its foot ── */}
          <Card>
            <CardContent className="flex h-full flex-col gap-4 p-5">
              <div>
                <h2 className="mb-1 font-semibold">{en ? 'The bill' : 'الفاتورة'}</h2>
                <SummaryList>
                  <SummaryRow label={en ? 'Due' : 'الاستحقاق'}>{formatDate(payment.dueDate)}</SummaryRow>
                  <SummaryRow label={en ? 'Status' : 'الحالة'}>{statusLabel}</SummaryRow>
                  <SummaryRow label={en ? 'Billed' : 'قيمة الفاتورة'} className="tabular-nums">
                    {formatLbp(payment.amount, locale)}
                  </SummaryRow>
                  {payment.paidAmount > 0 ? (
                    <SummaryRow label={en ? 'Paid so far' : 'المسدَّد سابقاً'} className="tabular-nums">
                      {formatLbp(payment.paidAmount, locale)}
                    </SummaryRow>
                  ) : null}
                  <SummaryRow label={en ? 'Outstanding' : 'المتبقي'} className="tabular-nums">
                    {formatLbp(remaining, locale)}
                  </SummaryRow>
                </SummaryList>
              </div>

              <div className="rounded-lg bg-muted/50 px-3">
                <SummaryList>
                  <SummaryRow label={en ? 'Handed over' : 'المبلغ المستلم'} className="tabular-nums">
                    <span className="flex flex-col items-end">
                      <span>{paidAs}</span>
                      {foreign > 0 && worth > 0 ? (
                        <span className="text-xs font-normal text-muted-foreground">= {formatLbp(worth, locale)}</span>
                      ) : null}
                    </span>
                  </SummaryRow>
                  {change > 0 ? (
                    <SummaryRow label={en ? 'Change to hand back' : 'الباقي للمواطن'} className="tabular-nums text-info">
                      {formatLbp(change, locale)}
                    </SummaryRow>
                  ) : null}
                  <SummaryRow
                    label={en ? 'Left after it' : 'المتبقي بعدها'}
                    className={cn('tabular-nums', settlesIt && 'text-success')}
                  >
                    {settlesIt ? (en ? 'Paid in full' : 'مسدّدة بالكامل') : formatLbp(Math.max(after, 0), locale)}
                  </SummaryRow>
                  <SummaryRow label={en ? 'Paid on' : 'تاريخ الدفع'}>
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
                      {paidOn ? formatDate(paidOn) : '—'}
                    </span>
                  </SummaryRow>
                </SummaryList>
              </div>

              {problem && (worth > 0 || (usesForeign && exchangeRate <= 0 && !settingsQuery.loading)) ? (
                <p role="alert" className="text-sm text-destructive">
                  {problem}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="mt-auto space-y-2">
                <Button type="button" className="w-full" onClick={() => void submit()} disabled={busy || Boolean(problem)}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Banknote className="size-4" aria-hidden />}
                  {en ? 'Record payment' : 'سجّل الدفعة'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => router.push(citizenHref)} disabled={busy}>
                  {en ? 'Cancel' : 'إلغاء'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* The receipt, straight after; closing it goes back to the citizen's file. */}
          <PaymentReceipt
            open={receipt !== null}
            onOpenChange={(open) => {
              if (!open) router.push(citizenHref);
            }}
            tenant={tenant}
            locale={locale}
            citizen={citizen}
            payment={receipt ? { ...payment, remaining: receipt.remaining } : null}
            recorded={receipt}
            municipalityName={municipalityName}
            governorate={settings?.governorate}
            councilDecisionRef={settings?.councilDecisionRef}
            district={settings?.district}
            contactPhone={settings?.contactPhone}
            officeWhatsapp={settings?.whatsappNumber}
          />
        </div>
      )}
    </div>
  );
}

/** The other currency's worth of a field, under it — kept a line tall so the fields beside it do not jump. */
function Equivalent({ children }: { children: ReactNode }) {
  return <p className="mt-1 h-4 text-xs tabular-nums text-muted-foreground">{children}</p>;
}

function QuickButton({
  icon: Icon,
  onClick,
  disabled,
  children,
}: {
  icon: typeof Coins;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onClick} disabled={disabled}>
      <Icon className="size-3.5" aria-hidden />
      {children}
    </Button>
  );
}
