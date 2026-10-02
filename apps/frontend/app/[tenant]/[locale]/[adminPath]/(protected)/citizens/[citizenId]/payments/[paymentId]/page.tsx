'use client';

import { use, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  Coins,
  Eraser,
  Loader2,
  Pencil,
  ReceiptText,
  RotateCcw,
  UserRound,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenProfile,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
  settlePayment,
  type CitizenProfile,
  type MunicipalitySettings,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatDate } from '@/lib/dates';
import { formatLbp } from '@/lib/currency';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { PaymentReceipt, type Tender } from '@/components/admin/payment-receipt';
import { cn } from '@/lib/utils';

const SETTLE_ROLES = ['SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT'];

/** What the citizen is paying in. «BOTH» is «20$ و200,000 ليرة» handed over together. */
type PayIn = 'LBP' | 'USD' | 'BOTH';

/** A typed amount as a number, separators ignored. */
function parseAmount(raw: string): number {
  const value = Number(raw.replace(/[,\s]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What a clerk types, as it should read: «100000» → «100,000», as they type.
 * Digits only for ليرة, which has no fractions to pay in; up to two decimals
 * for dollars. Anything else typed is dropped rather than shown and refused.
 */
function formatTyped(raw: string, decimals: 0 | 2): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0 || rest.length === 0) return grouped;
  return `${grouped || '0'}.${rest.join('').slice(0, decimals)}`;
}

/** A number in the same shape, for a value the page fills in itself. */
function formatNumber(value: number, decimals: 0 | 2): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function formatUsd(value: number): string {
  return `${formatNumber(value, 2)} $`;
}

/** Today on the clerk's own calendar — not UTC's, which is a day behind here after midnight. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * «تسجيل دفعة نقدية» — cash taken at the counter against one bill.
 *
 * The clerk picks what the citizen is paying in — ليرة, dollars, or both at
 * once — and types the amount; the dollar rate is the municipality's own, read
 * from الإعدادات, and only changed for one payment deliberately. Amounts take
 * their thousands separators as they are typed, and the summary states the
 * payment in the currency it was made in, with its ليرة worth beside it.
 *
 * The form and the summary are one height, side by side. The total here is a
 * preview: the server works the credit out again from the same figures,
 * refuses anything above the balance, and stores the notes beside the credit
 * (migration 0064).
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
  const today = useMemo(() => localToday(), []);

  const [token, setToken] = useState<string | null>(null);
  const [citizen, setCitizen] = useState<CitizenProfile | null>(null);
  const [settings, setSettings] = useState<MunicipalitySettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [municipalityName, setMunicipalityName] = useState(tenant);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [payIn, setPayIn] = useState<PayIn>('LBP');
  const [lbp, setLbp] = useState('');
  const [usd, setUsd] = useState('');
  /** A rate typed for this payment only; null means the municipality's. */
  const [rateOverride, setRateOverride] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ received: number; remaining: number; tender: Tender | null } | null>(
    null,
  );

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    if (!SETTLE_ROLES.includes(session.user.role ?? '')) {
      router.replace(citizenHref);
      return;
    }
    setToken(session.accessToken);

    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(config.nameAr || config.name))
      .catch(() => setMunicipalityName(tenant));
    getMunicipalitySettings(tenant, session.accessToken)
      .then(setSettings)
      .catch(() => setSettings(null))
      .finally(() => setSettingsLoaded(true));
    getCitizenProfile(tenant, session.accessToken, citizenId)
      .then(setCitizen)
      .catch((caught: unknown) => {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setLoadError(en ? 'Could not load the bill.' : 'تعذّر تحميل الفاتورة.');
      });
  }, [tenant, base, citizenId, citizenHref, router, en]);

  const payment = useMemo(
    () => citizen?.payments.find((candidate) => candidate.id === paymentId) ?? null,
    [citizen, paymentId],
  );

  /** The municipality's dollar rate, from الإعدادات — only when its second currency is the dollar. */
  const officialRate =
    settings?.secondaryCurrency === 'USD' && settings.exchangeRate ? settings.exchangeRate : null;
  const usesDollars = payIn !== 'LBP';
  const exchangeRate = rateOverride !== null ? parseAmount(rateOverride) : (officialRate ?? 0);

  const local = payIn === 'USD' ? 0 : parseAmount(lbp);
  const foreign = payIn === 'LBP' ? 0 : parseAmount(usd);
  // The same arithmetic the server does, shown before it is sent.
  const credit = Math.round(local + foreign * exchangeRate);
  const remaining = payment ? payment.remaining : 0;
  const after = remaining - credit;
  const settlesIt = credit > 0 && Math.abs(after) <= 0.5;

  const problem =
    usesDollars && exchangeRate <= 0
      ? en
        ? 'There is no dollar rate to convert with.'
        : 'لا يوجد سعر صرف للدولار للتحويل به.'
      : credit <= 0
        ? en
          ? 'Enter the amount paid.'
          : 'أدخل المبلغ المدفوع.'
        : credit > remaining + 0.5
          ? en
            ? `That is ${formatLbp(credit - remaining, locale)} more than is owed.`
            : `المبلغ يزيد عن المستحق بـ ${formatLbp(credit - remaining, locale)}.`
          : !paidOn
            ? en
              ? 'Choose the payment date.'
              : 'اختر تاريخ الدفع.'
            : null;

  /** The whole balance in the chosen currency — in dollars to the cent below it, the rest in ليرة. */
  const fillWhole = () => {
    if (payIn === 'LBP') {
      setLbp(formatNumber(remaining, 0));
      return;
    }
    if (exchangeRate <= 0) return;
    const dollars = Math.floor((remaining / exchangeRate) * 100) / 100;
    const rest = Math.max(0, Math.round(remaining - dollars * exchangeRate));
    setUsd(formatNumber(dollars, 2));
    // In dollars only, the cents' worth the dollars cannot reach stays owed.
    setLbp(payIn === 'BOTH' && rest > 0 ? formatNumber(rest, 0) : '');
  };

  const submit = async () => {
    if (!token || !payment || problem) return;
    setBusy(true);
    setError(null);
    const tender: Tender | null = foreign > 0 ? { local, foreign, foreignCurrency: 'USD', exchangeRate } : null;
    try {
      const result = await settlePayment(tenant, token, payment.id, {
        method: 'CASH',
        tendered: { local, foreign, foreignCurrency: 'USD', ...(foreign > 0 ? { exchangeRate } : {}) },
        // Only when it was not today, so a same-day payment keeps its real time.
        ...(paidOn !== today ? { paidOn } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setReceipt({ received: result.received, remaining: result.remaining, tender });
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : en
            ? 'Could not record the payment.'
            : 'تعذّر تسجيل الدفعة.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <BackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} className="text-sm" />
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive">
          {loadError}
        </p>
      </div>
    );
  }
  if (!citizen) return <LoadingState />;

  /** This payment, in the currency it is being made in. */
  const paidAs =
    payIn === 'LBP'
      ? formatLbp(local, locale)
      : payIn === 'USD'
        ? formatUsd(foreign)
        : [foreign > 0 ? formatUsd(foreign) : null, local > 0 ? formatLbp(local, locale) : null]
            .filter(Boolean)
            .join(' + ') || formatUsd(0);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} className="text-sm" />

      {/*
        Who is paying, for what, and how much is left — the three things the
        clerk checks against the person at the counter before taking a note.
        The name leads back to their file; the balance is the figure the form
        below is filled against, so it is the large one.
      */}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-b pb-5">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
          >
            <Banknote className="size-7" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <h1 className="truncate text-xl font-bold leading-tight md:text-2xl">
              {en ? 'Record cash payment' : 'تسجيل دفعة نقدية'}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Link
                href={citizenHref}
                className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:text-primary hover:underline"
              >
                <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{citizen.fullName}</span>
              </Link>
              {payment ? (
                <Badge variant="outline" className="h-6 max-w-full gap-1.5 px-2 font-normal">
                  <ReceiptText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{payment.title}</span>
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        {payment ? (
          <div className="text-end">
            <p className="text-xs font-medium text-muted-foreground">{en ? 'Outstanding' : 'المتبقي'}</p>
            <p className="font-mono text-2xl font-bold leading-tight tabular-nums">{formatLbp(remaining, locale)}</p>
            <p className="text-xs text-muted-foreground">
              {labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus}
              {' · '}
              {en ? 'due ' : 'استحقاق '}
              {formatDate(payment.dueDate)}
            </p>
          </div>
        ) : null}
      </header>

      {!payment ? (
        <p role="alert" className="rounded-xl border bg-card p-4 text-muted-foreground">
          {en ? 'This bill is not on the citizen’s file.' : 'هذه الفاتورة غير موجودة في ملف المواطن.'}
        </p>
      ) : payment.paymentStatus === 'PAID' && !receipt ? (
        <p className="rounded-xl border border-success/30 bg-success/5 p-4 text-success">
          {en ? 'This bill is already paid in full.' : 'هذه الفاتورة مسدّدة بالكامل.'}
        </p>
      ) : payment.currency !== 'LBP' && !receipt ? (
        /*
          This page takes ليرة, dollars at the municipality's rate, or both —
          against a ليرة bill. A bill raised in another currency is settled in
          that currency, from the fees page's own settle screen.
        */
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <p className="text-sm">
            {en
              ? `This bill is in ${payment.currency}. Record its payment from the fees page.`
              : `هذه الفاتورة بعملة ${payment.currency}. سجّل دفعتها من صفحة الرسوم.`}
          </p>
          <Link
            href={`${base}/fees/payments/${encodeURIComponent(payment.id)}/settle`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {en ? 'Open it in fees' : 'فتحها في صفحة الرسوم'}
          </Link>
        </div>
      ) : (
        /* One height: the two cards stretch to the taller of them. */
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ── The form ──────────────────────────────────────────────── */}
          <section className="flex flex-col gap-5 rounded-xl border bg-card p-5 shadow-sm">
            <div className="space-y-2">
              <h2 className="font-semibold">{en ? 'Paid in' : 'عملة الدفع'}</h2>
              <SegmentedControl
                aria-label={en ? 'Paid in' : 'عملة الدفع'}
                value={payIn}
                onChange={(next) => {
                  setPayIn(next as PayIn);
                  if (next === 'LBP') setUsd('');
                  if (next === 'USD') setLbp('');
                }}
                options={[
                  { value: 'LBP', label: en ? 'Lebanese pounds' : 'ليرة لبنانية' },
                  { value: 'USD', label: en ? 'US dollars' : 'دولار أميركي' },
                  { value: 'BOTH', label: en ? 'Both' : 'ليرة + دولار' },
                ]}
              />
            </div>

            {/* The rate: the municipality's, shown not typed — editable for one payment on purpose. */}
            {usesDollars ? (
              officialRate && rateOverride === null ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                  <span>
                    <span className="text-muted-foreground">{en ? 'Rate: ' : 'سعر الصرف: '}</span>
                    <span className="font-mono font-semibold">1 $ = {formatLbp(officialRate, locale)}</span>
                    {settings?.exchangeRateUpdatedAt ? (
                      <span className="ms-2 text-xs text-muted-foreground">
                        ({en ? 'set ' : 'حُدِّث '}
                        {formatDate(settings.exchangeRateUpdatedAt)})
                      </span>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 text-xs"
                    onClick={() => setRateOverride(formatNumber(officialRate, 0))}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    {en ? 'Change for this payment' : 'تعديل لهذه الدفعة'}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {!officialRate && settingsLoaded ? (
                    <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-sm">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                      <span>
                        {en
                          ? 'No dollar rate is set for this municipality. Enter one for this payment, or '
                          : 'لم يُحدَّد سعر صرف للدولار لهذه البلدية. أدخله لهذه الدفعة، أو '}
                        <Link href={`${base}/settings`} className="font-medium text-primary underline-offset-4 hover:underline">
                          {en ? 'set it in Settings' : 'حدّده من الإعدادات'}
                        </Link>
                        .
                      </span>
                    </p>
                  ) : null}
                  <Field label={en ? 'Rate for this payment (LBP per $1)' : 'سعر الصرف لهذه الدفعة (ليرة لكل 1$)'} htmlFor="tender-rate" required>
                    <div className="flex gap-2">
                      <CurrencyInput
                        id="tender-rate"
                        unit="ل.ل"
                        value={rateOverride ?? ''}
                        onChange={(raw) => setRateOverride(formatTyped(raw, 0))}
                        placeholder={en ? 'e.g. 89,500' : 'مثال: 89,500'}
                        className="flex-1"
                      />
                      {officialRate ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-10 shrink-0"
                          title={en ? "Back to the municipality's rate" : 'العودة إلى سعر البلدية'}
                          aria-label={en ? "Back to the municipality's rate" : 'العودة إلى سعر البلدية'}
                          onClick={() => setRateOverride(null)}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </Field>
                </div>
              )
            ) : null}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">{en ? 'Amount' : 'المبلغ'}</h2>
                <div className="flex flex-wrap gap-1.5">
                  <QuickButton icon={Coins} onClick={fillWhole} disabled={usesDollars && exchangeRate <= 0}>
                    {en ? 'Whole balance' : 'كامل المتبقي'}
                  </QuickButton>
                  <QuickButton
                    icon={Eraser}
                    onClick={() => {
                      setLbp('');
                      setUsd('');
                    }}
                  >
                    {en ? 'Clear' : 'مسح'}
                  </QuickButton>
                </div>
              </div>
              <div className={cn('grid gap-4', payIn === 'BOTH' && 'sm:grid-cols-2')}>
                {payIn !== 'LBP' ? (
                  <Field label={en ? 'In dollars' : 'بالدولار'} htmlFor="tender-usd" optionalLabel="">
                    <CurrencyInput
                      id="tender-usd"
                      unit="$"
                      value={usd}
                      onChange={(raw) => setUsd(formatTyped(raw, 2))}
                      placeholder={en ? 'e.g. 20' : 'مثال: 20'}
                    />
                    <Equivalent>
                      {foreign > 0 && exchangeRate > 0 ? `= ${formatLbp(Math.round(foreign * exchangeRate), locale)}` : null}
                    </Equivalent>
                  </Field>
                ) : null}
                {payIn !== 'USD' ? (
                  <Field label={en ? 'In Lebanese pounds' : 'بالليرة'} htmlFor="tender-lbp" optionalLabel="">
                    <CurrencyInput
                      id="tender-lbp"
                      unit="ل.ل"
                      value={lbp}
                      onChange={(raw) => setLbp(formatTyped(raw, 0))}
                      placeholder={en ? 'e.g. 500,000' : 'مثال: 500,000'}
                    />
                    <Equivalent>
                      {local > 0 && exchangeRate > 0 ? `≈ ${formatUsd(local / exchangeRate)}` : null}
                    </Equivalent>
                  </Field>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={en ? 'Payment date' : 'تاريخ الدفع'} htmlFor="tender-date" required>
                <DatePicker
                  id="tender-date"
                  value={paidOn}
                  onChange={setPaidOn}
                  max={today}
                  locale={en ? 'en' : 'ar'}
                />
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
          </section>

          {/* ── The summary, as tall as the form, the button at its foot ── */}
          <aside className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
            <div>
              <h2 className="mb-1 font-semibold">{en ? 'The bill' : 'الفاتورة'}</h2>
              <SummaryList>
                <SummaryRow label={en ? 'Due' : 'الاستحقاق'}>{formatDate(payment.dueDate)}</SummaryRow>
                <SummaryRow label={en ? 'Status' : 'الحالة'}>
                  {labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus}
                </SummaryRow>
                <SummaryRow label={en ? 'Billed' : 'قيمة الفاتورة'} className="font-mono">
                  {formatLbp(payment.amount, locale)}
                </SummaryRow>
                {payment.paidAmount > 0 ? (
                  <SummaryRow label={en ? 'Paid so far' : 'المسدَّد سابقاً'} className="font-mono">
                    {formatLbp(payment.paidAmount, locale)}
                  </SummaryRow>
                ) : null}
                <SummaryRow label={en ? 'Outstanding' : 'المتبقي'} className="font-mono">
                  {formatLbp(remaining, locale)}
                </SummaryRow>
              </SummaryList>
            </div>

            <div className="rounded-lg bg-muted/50 px-3">
              <SummaryList>
                <SummaryRow label={en ? 'This payment' : 'هذه الدفعة'} className="font-mono text-base">
                  <span className="flex flex-col items-end">
                    <span>{paidAs}</span>
                    {usesDollars && credit > 0 ? (
                      <span className="text-xs font-normal text-muted-foreground">= {formatLbp(credit, locale)}</span>
                    ) : null}
                  </span>
                </SummaryRow>
                <SummaryRow
                  label={en ? 'Left after it' : 'المتبقي بعدها'}
                  className={cn('font-mono', after < -0.5 ? 'text-destructive' : settlesIt ? 'text-success' : undefined)}
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

            {problem && (credit > 0 || (usesDollars && exchangeRate <= 0 && settingsLoaded)) ? (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="mt-auto space-y-2">
              <Button type="button" className="w-full" onClick={() => void submit()} disabled={busy || Boolean(problem)}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Banknote className="size-4" aria-hidden />}
                {en ? 'Record payment' : 'تسجيل الدفعة'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => router.push(citizenHref)} disabled={busy}>
                {en ? 'Cancel' : 'إلغاء'}
              </Button>
            </div>
          </aside>

          {/* The receipt, straight after; closing it goes back to the citizen's file. */}
          <PaymentReceipt
            open={receipt !== null}
            onOpenChange={(open) => {
              if (!open) router.push(citizenHref);
            }}
            tenant={tenant}
            citizen={citizen}
            payment={receipt ? { ...payment, remaining: receipt.remaining } : null}
            receivedAmount={receipt?.received}
            tendered={receipt?.tender ?? null}
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

/**
 * An amount with its currency in a segment of its own — never laid over the
 * number, which is what put «ل.ل» on top of the «0» in an LTR field on an RTL
 * page. The digits are LTR; the segment sits at the field's start.
 */
function CurrencyInput({
  id,
  unit,
  value,
  onChange,
  placeholder,
  className,
}: {
  id: string;
  unit: string;
  value: string;
  onChange: (raw: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-10 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
        className,
      )}
    >
      <span className="flex min-w-12 shrink-0 items-center justify-center border-e bg-muted px-3 text-sm font-medium text-muted-foreground">
        {unit}
      </span>
      <Input
        id={id}
        inputMode="decimal"
        dir="ltr"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full flex-1 rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
}

/** The other currency's worth of a field, under it — kept a line tall so the fields beside it do not jump. */
function Equivalent({ children }: { children: ReactNode }) {
  return <p className="mt-1 h-4 font-mono text-xs text-muted-foreground">{children}</p>;
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
    <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onClick} disabled={disabled}>
      <Icon className="size-3.5" aria-hidden />
      {children}
    </Button>
  );
}
