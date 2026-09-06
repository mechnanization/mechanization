'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  Building2,
  CalendarDays,
  Check,
  Clock,
  Copy,
  CreditCard,
  FileDigit,
  Flag,
  HeartHandshake,
  Home,
  IdCard,
  Loader2,
  LogOut,
  MessageCircle,
  MessageSquareWarning,
  Phone,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getMyPayments,
  getMySummary,
  logApiError,
  startWhishCheckout,
} from '@/lib/api-client';
import type { CitizenPaymentItem, MyCitizenSummary } from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** A bill is settled, or it is not — everything else is a shade of "not". */
function isSettled(payment: CitizenPaymentItem): boolean {
  return payment.paymentStatus === 'PAID';
}

/**
 * First letters of the first two words, for the avatar.
 *
 * Arabic has no case, so this is not "initials" in the Latin sense — it is the
 * opening letter of the given name and of the family name, which is what a
 * clerk writes on a folder tab.
 */
function initials(fullName: string | undefined): string {
  if (!fullName) return '—';
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return `${first}${last}`;
}

/**
 * One labelled fact in the profile grid.
 *
 * Renders nothing at all when the municipality holds no value — an empty row
 * saying «الحالة الاجتماعية —» tells a citizen nothing and makes the grid
 * ragged. The grid is a `<dl>` because that is what a list of labelled values
 * is, and a screen reader then reads the label with its value rather than
 * announcing nine loose strings.
 */
function Detail({
  icon: Icon,
  label,
  value,
  hint,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  hint?: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 p-4 sm:border-b sm:border-e last:sm:border-e-0">
      <span
        aria-hidden
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          className={cn('truncate font-medium', mono && 'font-mono')}
          dir={mono ? 'ltr' : undefined}
          // `text-start` restores reading order for the LTR values above,
          // which would otherwise be flush-right inside this RTL column.
          style={mono ? { textAlign: 'start' } : undefined}
        >
          {value}
        </dd>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * ملفّي — a citizen's whole record on one page.
 *
 * Everything a citizen needs from the municipality, in the order they ask for
 * it: who they are, what they owe, anything the office wrote back to them, the
 * bills still open, the ones settled, and the properties in their name.
 *
 * Purely a *view*. It carries no way in — the landing page owns that, and a
 * visitor arriving here without a session is sent back to it. Holding a second
 * sign-in form here would mean two sets of rules for one act, and the citizen
 * who typed the URL directly would meet the stricter one, which is backwards.
 *
 * Declaring a payment stays on `/payments`, next to the Whish instructions it
 * needs. This page reports; that one acts.
 */
export default function MyFilePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}`;
  const labels = getLabels(locale);

  const [token, setToken] = useState<string | null>(null);
  const [summary, setSummary] = useState<MyCitizenSummary | null>(null);
  const [payments, setPayments] = useState<CitizenPaymentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Copies the رقم مرجعي — the one thing a citizen is asked to quote. */
  const copyReference = useCallback((value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, []);

  /**
   * The way in is the landing page, not this one.
   *
   * This page used to carry its own رقم مرجعي + phone form. Now that the front
   * door asks for the reference and nothing else, a second form here would be a
   * second set of rules for the same act — and the one a citizen reached by
   * typing the URL directly would be the stricter of the two, which is exactly
   * backwards.
   */
  useEffect(() => {
    const session = loadSession(tenant);
    if (session?.user.kind === 'CITIZEN') setToken(session.accessToken);
    else router.replace(base);
  }, [tenant, base, router]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [summaryResult, paymentsResult] = await Promise.all([
        getMySummary(tenant, token),
        getMyPayments(tenant, token),
      ]);
      setSummary(summaryResult);
      setPayments(paymentsResult.items);
      setError(null);
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(base);
        return;
      }
      setError(
        locale === 'en'
          ? 'Failed to load your file. Please try again later.'
          : 'تعذّر تحميل ملفّك. يرجى المحاولة لاحقاً.',
      );
    } finally {
      setLoading(false);
    }
  }, [tenant, token, base, router, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(() => {
    clearSession(tenant);
    router.replace(base);
  }, [tenant, base, router]);

  const payWithWhish = useCallback(
    async (paymentId: string) => {
      if (!token) return;
      setPayingId(paymentId);
      setError(null);
      try {
        const { redirectUrl } = await startWhishCheckout(tenant, token, paymentId);
        window.location.href = redirectUrl;
      } catch (caught) {
        logApiError(caught);
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : (locale === 'en' ? 'Failed to start Whish checkout.' : 'تعذّر بدء الدفع عبر Whish.'),
        );
        setPayingId(null);
      }
    },
    [tenant, token, locale],
  );

  if (!token) return null;

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        {locale === 'en' ? 'Loading your file…' : 'جارٍ تحميل ملفّك…'}
      </div>
    );
  }

  const outstanding = payments.filter((payment) => !isSettled(payment));
  const settled = payments.filter(isSettled);
  const notes = payments.filter((payment) => payment.reviewNote);

  return (
    <div className="space-y-6">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* ── Who this is ──
          A tinted banner rather than another white card: it is the one block on
          the page that identifies the reader, and it should not look like the
          fourth section of a list. */}
      <Card className="overflow-hidden">
        <div className="border-b bg-primary/5 p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span
              aria-hidden
              className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground"
            >
              {initials(summary?.fullName)}
            </span>

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
                  {summary?.fullName ?? '—'}
                </h1>
                {summary && !summary.isActive ? (
                  <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
                    {locale === 'en' ? 'Disabled Account' : 'حساب معطّل'}
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {summary?.referenceNumber ? (
                  <button
                    type="button"
                    onClick={() => copyReference(summary.referenceNumber!)}
                    className="inline-flex items-center gap-2 rounded-md border bg-background px-2.5 py-1 font-mono text-sm transition-colors hover:bg-accent"
                    dir="ltr"
                    title={locale === 'en' ? 'Copy reference number' : 'نسخ الرقم المرجعي'}
                  >
                    {summary.referenceNumber}
                    {copied ? (
                      <Check className="size-3.5 text-success" aria-hidden />
                    ) : (
                      <Copy className="size-3.5 text-muted-foreground" aria-hidden />
                    )}
                  </button>
                ) : null}
                {summary?.registeredAt ? (
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <CalendarDays className="size-3.5" aria-hidden />
                    {locale === 'en' ? 'Registered ' : 'مسجّل منذ '}
                    {formatDate(summary.registeredAt)}
                  </span>
                ) : null}
              </div>
            </div>

            <Button variant="outline" onClick={signOut} className="w-full sm:w-auto">
              <LogOut className="size-4" aria-hidden />
              {locale === 'en' ? 'Sign Out' : 'خروج'}
            </Button>
          </div>
        </div>

        {/* ── The details themselves ── */}
        <CardContent className="p-0">
          <dl className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-y-0 md:grid-cols-3">
            <Detail icon={Phone} label={locale === 'en' ? 'Phone Number' : 'رقم الهاتف'} value={summary?.phone} mono />
            <Detail icon={MessageCircle} label={locale === 'en' ? 'WhatsApp' : 'واتساب'} value={summary?.whatsapp} mono />
            <Detail
              icon={IdCard}
              label={
                summary?.identityDocType
                  ? (labels.identityDocType[summary.identityDocType as never] ?? (locale === 'en' ? 'Identity Document' : 'وثيقة الإثبات'))
                  : (locale === 'en' ? 'Identity Document' : 'وثيقة الإثبات')
              }
              value={summary?.identityDocNumberMasked}
              mono
              hint={locale === 'en' ? 'Last 3 digits only' : 'آخر ثلاثة أرقام فقط'}
            />
            <Detail
              icon={Flag}
              label={locale === 'en' ? 'Nationality' : 'الجنسية'}
              value={
                summary?.nationality ??
                (summary?.isLebanese ? (locale === 'en' ? 'Lebanese' : 'لبناني') : null)
              }
            />
            <Detail
              icon={Home}
              label={locale === 'en' ? 'Residency Status' : 'صفة الإقامة'}
              value={
                summary?.residentStatus
                  ? (labels.residentStatus[summary.residentStatus as never] ?? summary.residentStatus)
                  : null
              }
            />
            <Detail
              icon={HeartHandshake}
              label={locale === 'en' ? 'Marital Status' : 'الحالة الاجتماعية'}
              value={
                summary?.maritalStatus
                  ? (labels.maritalStatus[summary.maritalStatus as never] ?? summary.maritalStatus)
                  : null
              }
            />
            <Detail
              icon={Users}
              label={
                locale === 'en'
                  ? 'Family Members (Living in House)'
                  : 'عدد أفراد الأسرة (المقيمين في المنزل)'
              }
              value={
                summary?.actualHouseholdMembers
                  ? String(summary.actualHouseholdMembers)
                  : summary?.totalRegisteredMembers
                    ? String(summary.totalRegisteredMembers)
                    : null
              }
            />
            {summary?.totalRegisteredMembers != null &&
            summary?.actualHouseholdMembers != null &&
            summary.totalRegisteredMembers > summary.actualHouseholdMembers ? (
              <>
                <Detail
                  icon={Users}
                  label={locale === 'en' ? 'Total Registered (Civil Record)' : 'إجمالي المسجلين في القيد'}
                  value={String(summary.totalRegisteredMembers)}
                />
                <Detail
                  icon={Users}
                  label={locale === 'en' ? 'Married Children (Independent)' : 'الأبناء المتزوجون المستقلون'}
                  value={String(summary.marriedChildrenCount)}
                />
              </>
            ) : null}
            <Detail
              icon={FileDigit}
              label={locale === 'en' ? 'Civil Record Number' : 'رقم السجل'}
              value={summary?.civilRecordNumberMasked}
              mono
            />
            <Detail
              icon={Building2}
              label={locale === 'en' ? 'Properties Count' : 'عدد العقارات'}
              value={summary ? String(summary.properties.length) : null}
            />
          </dl>
        </CardContent>
      </Card>

      {/* ── What is owed, at a glance ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={locale === 'en' ? 'Amount Due' : 'المستحق عليك'}
          value={formatLbp(summary?.fees.outstandingTotal ?? 0, locale)}
          icon={<Wallet className="size-5" aria-hidden />}
          tone={
            (summary?.fees.outstandingTotal ?? 0) > 0 ? 'destructive' : 'success'
          }
        />
        <StatCard
          label={locale === 'en' ? 'Settled' : 'المسدَّد'}
          value={formatLbp(summary?.fees.paidTotal ?? 0, locale)}
          icon={<BadgeCheck className="size-5" aria-hidden />}
          tone="success"
        />
        <StatCard
          label={locale === 'en' ? 'Overdue' : 'متأخّرات'}
          value={formatLbp(summary?.fees.overdueTotal ?? 0, locale)}
          hint={
            (summary?.fees.overdueCount ?? 0) > 0
              ? (locale === 'en'
                  ? `${summary?.fees.overdueCount} claims past due date`
                  : `${summary?.fees.overdueCount} مطالبة تجاوزت موعدها`)
              : (locale === 'en' ? 'No overdue claims' : 'لا متأخّرات')
          }
          icon={<Clock className="size-5" aria-hidden />}
          tone={(summary?.fees.overdueTotal ?? 0) > 0 ? 'destructive' : undefined}
        />
      </div>

      {/* ── Notes from the municipality ── */}
      {notes.length > 0 ? (
        <Card className="border-warning/50 ring-1 ring-warning/20">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-lg">
              <MessageSquareWarning className="size-5 text-warning" aria-hidden />
              {locale === 'en' ? 'Notes from Municipality' : 'ملاحظات من البلدية'}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {notes.map((payment) => (
                <li key={payment.id} className="space-y-1 p-4">
                  <p className="text-sm font-medium">{payment.title}</p>
                  <p className="text-sm text-muted-foreground">{payment.reviewNote}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Bills still open ── */}
      <PaymentList
        title={locale === 'en' ? 'Outstanding Fees' : 'رسوم مستحقة عليك'}
        icon={Wallet}
        items={outstanding}
        empty={locale === 'en' ? 'No outstanding fees — your file is fully settled.' : 'لا توجد رسوم مستحقة — ملفّك مسدَّد بالكامل.'}
        onPay={payWithWhish}
        payingId={payingId}
        locale={locale}
      />

      {/* ── Bills settled ── */}
      <PaymentList
        title={locale === 'en' ? 'Settled Fees' : 'رسوم سدّدتها'}
        icon={BadgeCheck}
        items={settled}
        empty={locale === 'en' ? 'No recorded payments yet.' : 'لم تُسجَّل أي دفعة بعد.'}
        locale={locale}
      />

      {/* ── What is registered in their name ── */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Building2 className="size-5" aria-hidden />
            {locale === 'en' ? 'Registered Properties' : 'عقاراتك المسجّلة'}{' '}
            {summary ? `(${summary.properties.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!summary || summary.properties.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {locale === 'en' ? 'No registered properties.' : 'لا توجد عقارات مسجّلة.'}
            </p>
          ) : (
            <ul className="divide-y">
              {summary.properties.map((property) => {
                const facts = [
                  property.unitArea ? `${property.unitArea} ${locale === 'en' ? 'm²' : 'م²'}` : null,
                  property.floor ? `${locale === 'en' ? 'Floor ' : 'الطابق '}${property.floor}` : null,
                  property.side,
                  property.landType
                    ? (labels.landType[property.landType as never] ?? property.landType)
                    : null,
                  property.unitType
                    ? (labels.unitType[property.unitType as never] ?? property.unitType)
                    : null,
                  property.unitCount > 0
                    ? `${property.unitCount} ${locale === 'en' ? 'units' : 'وحدة'}`
                    : null,
                  // Shown to the citizen because it is a fact about their
                  // property that can change what they are billed — a resident
                  // who can see «شاغرة» here is a resident who can tell the
                  // municipality when it stops being true, which is the only
                  // correction mechanism this field has.
                  property.unitStatus
                    ? (labels.unitStatus[property.unitStatus as never] ?? property.unitStatus)
                    : null,
                  property.tentLocation,
                ].filter(Boolean) as string[];

                return (
                  <li key={property.id} className="space-y-2 p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {labels.propertyType[property.propertyType as never] ??
                            property.propertyType}
                          {property.buildingName ? ` — ${property.buildingName}` : ''}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {property.neighborhood} · {locale === 'en' ? 'Parcel #' : 'رقم العقار '}
                          <span className="font-mono" dir="ltr">
                            {property.propertyNumber}
                          </span>
                        </p>
                      </div>
                      <Badge variant="secondary" className="w-fit shrink-0">
                        {labels.occupancyType[property.occupancyType as never] ??
                          property.occupancyType}
                      </Badge>
                    </div>

                    {facts.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {facts.map((fact) => (
                          <span
                            key={fact}
                            className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {fact}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {property.landlordName ? (
                      <p className="text-xs text-muted-foreground">
                        {locale === 'en' ? 'Owner: ' : 'المالك: '}{property.landlordName}
                        {property.landlordPhone ? (
                          <>
                            {' · '}
                            <span className="font-mono" dir="ltr">
                              {property.landlordPhone}
                            </span>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="pb-4 text-center text-sm text-muted-foreground">
        {locale === 'en'
          ? 'For inquiries or objections regarding any amount, please visit the municipality.'
          : 'للاستفسار أو الاعتراض على أي مبلغ، يرجى مراجعة البلدية.'}
      </p>
    </div>
  );
}

/** One headline figure. */
function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: 'destructive' | 'success';
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p
            className={cn(
              'truncate text-xl font-bold tabular-nums',
              tone === 'destructive' && 'text-destructive',
              tone === 'success' && 'text-success',
            )}
          >
            {value}
          </p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            tone === 'destructive'
              ? 'bg-destructive/10 text-destructive'
              : tone === 'success'
                ? 'bg-success/10 text-success'
                : 'bg-accent text-muted-foreground',
          )}
        >
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}

/**
 * One list of bills.
 */
function PaymentList({
  title,
  icon: Icon,
  items,
  empty,
  onPay,
  payingId,
  locale = 'ar',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: CitizenPaymentItem[];
  empty: string;
  onPay?: (paymentId: string) => void;
  payingId?: string | null;
  locale?: string;
}) {
  const labels = getLabels(locale);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="size-5" aria-hidden />
          {title} {items.length > 0 ? `(${items.length})` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {items.map((payment) => {
              const settled = isSettled(payment);
              const partly = !settled && payment.paidAmount > 0;
              return (
                <li
                  key={payment.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{payment.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {settled && payment.paidAt ? (
                        <>
                          {locale === 'en' ? 'Paid on ' : 'سُدّد في '}
                          {formatDate(payment.paidAt)}
                        </>
                      ) : (
                        <>
                          {locale === 'en' ? 'Due ' : 'استحقاق '}
                          {formatDate(payment.dueDate)}
                          {partly
                            ? (locale === 'en'
                                ? ` · Paid ${formatLbp(payment.paidAmount, locale)} of ${formatLbp(payment.amount, locale)}`
                                : ` · سدّدت ${formatLbp(payment.paidAmount, locale)} من ${formatLbp(payment.amount, locale)}`)
                            : ''}
                        </>
                      )}
                      {settled && payment.paymentMethod
                        ? ` · ${labels.paymentMethod[payment.paymentMethod as never] ?? ''}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums">
                      {formatLbp(settled ? payment.amount : payment.remaining, locale)}
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        payment.paymentStatus === 'PAID'
                          ? 'border-success/40 bg-success/10 text-success'
                          : payment.paymentStatus === 'OVERDUE'
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : payment.paymentStatus === 'PENDING_REVIEW'
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'text-muted-foreground'
                      }
                    >
                      {labels.paymentStatus[payment.paymentStatus as never] ??
                        payment.paymentStatus}
                    </Badge>

                    {onPay && payment.paymentStatus !== 'PENDING_REVIEW' ? (
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={payingId === payment.id}
                        onClick={() => onPay(payment.id)}
                      >
                        {payingId === payment.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <CreditCard className="size-4" aria-hidden />
                        )}
                        {locale === 'en' ? 'Pay with Whish' : 'ادفع عبر Whish'}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
