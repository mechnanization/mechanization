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
  DoorClosed,
  FileDigit,
  FileQuestion,
  Flag,
  HeartHandshake,
  Home,
  IdCard,
  Key,
  Layers,
  Loader2,
  LogOut,
  MapPin,
  MessageCircle,
  MessageSquareWarning,
  Phone,
  Ruler,
  Sun,
  User,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels, isUnoccupied, OWNER_BILLED_WHILE_ABSENT } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getMyPayments,
  getMySummary,
  logApiError,
  startWhishCheckout,
} from '@/lib/api-client';
import type {
  CitizenPaymentItem,
  CitizenProfileProperty,
  CitizenProfileUnit,
  MyCitizenSummary,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatLbp } from '@/lib/currency';
import { formatDate, formatMonthList } from '@/lib/dates';
import { describeAssessment } from '@/lib/fee-assessment';
import { flagFieldLabel } from '@/lib/field-flags';
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
          /*
            Words wrap, numbers truncate.

            `truncate` on everything was right while every value here was a
            phone number or a masked document tail — short, LTR, and no worse
            for being clipped. اسم الأم وشهرتها is neither: it is three Arabic
            words in a third-width cell, and a name silently cut at the edge is
            the one value on this page a person is here to check character by
            character.
          */
          className={cn('font-medium', mono ? 'truncate font-mono' : 'break-words')}
          dir={mono ? 'ltr' : undefined}
          // `text-start` restores reading order for the LTR values above,
          // which would otherwise be flush-right inside this RTL column.
          style={mono ? { textAlign: 'start' } : undefined}
        >
          {value}
        </dd>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
                {/*
                  نوع الملف, said plainly. Somebody registered as living outside
                  the town is asked for less and billed differently, and this
                  page otherwise gave no hint that the municipality holds them
                  as anything other than an ordinary household — so the page
                  looked to them like a household file missing half its fields.
                */}
                {summary?.residence === 'NON_RESIDENT_OWNER' ? (
                  <Badge variant="soft-info">
                    {labels.citizenResidence.NON_RESIDENT_OWNER}
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
            {/*
              اسم الأم وشهرتها — first among the details, because it is what the
              municipality now uses to tell this person from a namesake, and
              because a wrong one is invisible to everybody except them. Absent
              on a file recorded before it was asked for, where `Detail` drops
              the row rather than printing a dash the reader would take for an
              answer.
            */}
            <Detail
              icon={User}
              label={locale === 'en' ? "Mother's Full Name" : 'اسم الأم وشهرتها'}
              value={summary?.motherName}
            />
            {/*
              «غير مقيم في البلدة» — where they live, and who holds their keys
              here. The municipality asks for these instead of a household, and
              until now this page showed neither: the one person who could say
              the cousin's number had changed was shown a file that did not
              mention him.

              Gated on نوع الملف rather than on the values being present, which
              is not the same test. Converting a record back to a household file
              keeps `residencePlace` and the local contact rather than erasing
              them (`citizenColumnsForEdit`) — right for the data, wrong for a
              page that would then tell a household living in the town that
              their «مكان الإقامة» is somewhere else.
            */}
            {summary?.residence === 'NON_RESIDENT_OWNER' ? (
              <>
                <Detail
                  icon={Home}
                  label={locale === 'en' ? 'Place of Residence' : 'مكان الإقامة'}
                  value={summary.residencePlace}
                />
                <Detail
                  icon={User}
                  label={locale === 'en' ? 'Local Contact' : 'جهة الاتصال المحلية'}
                  value={summary.localContactName}
                />
                <Detail
                  icon={Phone}
                  label={locale === 'en' ? 'Local Contact Phone' : 'هاتف جهة الاتصال المحلية'}
                  value={summary.localContactPhone}
                  mono
                />
              </>
            ) : null}
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
            {/*
              إجمالي المسجلين في القيد earns a row only where it differs from
              the household actually in the house. Beside it used to sit a
              *second* copy of عدد الأبناء المتزوجين under a longer label, so a
              split household read the same figure twice and was invited to
              take them for two different counts.
            */}
            {summary?.totalRegisteredMembers != null &&
            summary?.actualHouseholdMembers != null &&
            summary.totalRegisteredMembers > summary.actualHouseholdMembers ? (
              <Detail
                icon={Users}
                label={locale === 'en' ? 'Total Registered (Civil Record)' : 'إجمالي المسجلين في القيد'}
                value={String(summary.totalRegisteredMembers)}
              />
            ) : null}
            <Detail
              icon={Users}
              label={
                locale === 'en' ? 'Married Children (Independent)' : 'الأبناء المتزوجون المستقلون'
              }
              value={
                summary?.marriedChildrenCount != null ? String(summary.marriedChildrenCount) : null
              }
            />
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

      {/*
        ── What the municipality could not establish ──

        Above the bills, because it is the only block on this page the reader
        can actually resolve, and resolving it is usually free. An officer marks
        a field «غير مؤكَّد» when they could not establish it at the door — a
        phone nobody answered with, a رقم عقار nobody at home knew — and it then
        sits in «يتطلب مراجعة» until somebody supplies it. The person who can
        supply it is reading this page.

        Field names only. The reason each was flagged is a note one officer left
        the next about a household, and it is neither addressed to them nor
        always a thing to read back to them.
      */}
      {summary?.unestablishedFields?.length ? (
        <Card className="border-warning/50 ring-1 ring-warning/20">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileQuestion className="size-5 text-warning" aria-hidden />
              {locale === 'en' ? 'Incomplete Information' : 'معلومات ناقصة في ملفّك'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4 sm:p-5">
            <p className="text-sm text-muted-foreground">
              {locale === 'en'
                ? 'The municipality could not record the following. Bring them to the municipality — or send them on WhatsApp — and your file is complete.'
                : 'لم تتمكّن البلدية من تسجيل ما يلي. أحضرها إلى البلدية — أو أرسلها عبر واتساب — ليكتمل ملفّك.'}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {summary.unestablishedFields.map((path) => (
                <li
                  key={path}
                  className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-xs font-medium"
                >
                  {flagFieldLabel(path, locale)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

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
              {summary.properties.map((property) => (
                <PropertyRow key={property.id} property={property} locale={locale} />
              ))}
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

/**
 * One property in the citizen's own name, as they should be able to check it.
 *
 * The reason this is more than a label and a badge: a per-unit fee is assessed
 * from precisely these rows, and the bill above says «6 محل تجاري × 100,000».
 * Six is checkable only against a list of six. Until now this showed «6 وحدة»
 * and stopped, so the one number a resident could dispute was the one they
 * could not see the workings of.
 */
function PropertyRow({
  property,
  locale,
}: {
  property: CitizenProfileProperty;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const facts = [
    property.unitArea ? `${property.unitArea} ${en ? 'm²' : 'م²'}` : null,
    property.floor ? `${en ? 'Floor ' : 'الطابق '}${property.floor}` : null,
    property.side,
    property.landType ? (labels.landType[property.landType as never] ?? property.landType) : null,
    property.unitType ? (labels.unitType[property.unitType as never] ?? property.unitType) : null,
    // أسهم — a share of ownership, so it belongs on an owner's card and on no
    // other. A tenant shown «1200/2400» would read it as a claim they own half.
    property.occupancyType === 'OWNER' && property.shares != null
      ? `${en ? 'Shares ' : 'الأسهم '}${property.shares}/2400`
      : null,
    property.tentLocation,
  ].filter(Boolean) as string[];

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            {labels.propertyType[property.propertyType as never] ?? property.propertyType}
            {property.buildingName ? ` — ${property.buildingName}` : ''}
          </p>
          {/*
            Both halves of this line can be absent — an officer marks الحي or
            رقم العقار «غير مؤكَّد» when nobody at the door could say. Printed
            unconditionally they produced «· رقم العقار » trailing into nothing,
            which reads as a broken page rather than as a gap the reader can
            close by telling the municipality the number.
          */}
          <p className="text-sm text-muted-foreground">
            {property.neighborhood ? <span>{property.neighborhood}</span> : null}
            {property.neighborhood && property.propertyNumber ? ' · ' : null}
            {property.propertyNumber ? (
              <>
                {en ? 'Parcel #' : 'رقم العقار '}
                <span className="font-mono" dir="ltr">
                  {property.propertyNumber}
                </span>
              </>
            ) : null}
            {!property.propertyNumber ? (
              <span className="text-warning">
                {en ? 'Parcel number not recorded' : 'رقم العقار غير مسجَّل'}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex w-fit shrink-0 flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            {labels.occupancyType[property.occupancyType as never] ?? property.occupancyType}
          </Badge>
          {/*
            «متضررة من الحرب وغير مسكونة». Shown to the citizen and not only to
            staff: it is how the municipality has classified the building their
            property is in, and somebody whose home is recorded as uninhabited
            when they are living in it — or as standing when it is not — is the
            only person who can say so.
          */}
          {property.buildingLifecycleStatus === 'WAR_DAMAGED_UNINHABITED' ? (
            <Badge variant="soft-destructive">
              {labels.buildingLifecycle.WAR_DAMAGED_UNINHABITED}
            </Badge>
          ) : null}
        </div>
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

      {/*
        حالة الوحدة on a card with no units of its own — a house or a flat.

        Shown to the citizen because it is a fact about their property that
        changes what they are billed, and a resident who can see «شاغرة» is a
        resident who can say when it stops being true. That is the only
        correction mechanism this field has.
      */}
      {property.unitStatus ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={unitStatusTone(property.unitStatus)}>
            {labels.unitStatus[property.unitStatus as never] ?? property.unitStatus}
          </Badge>
          {ownerBilledNote(property.unitStatus, locale) ? (
            <span className="text-xs text-muted-foreground">
              {ownerBilledNote(property.unitStatus, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      {property.units.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {property.units.map((unit) => (
            <MyUnitRow key={unit.id} unit={unit} locale={locale} />
          ))}
        </ul>
      ) : null}

      {property.landlordName ? (
        <p className="text-xs text-muted-foreground">
          {en ? 'Owner: ' : 'المالك: '}
          {property.landlordName}
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
}

/**
 * One unit inside a building on the citizen's file.
 *
 * Every field is nullable and null means «لم تُسجَّل», never zero — a per-unit
 * «غير مؤكَّد» flag blanks the field it excuses. So each is rendered only where
 * there is something to render; a row that printed «الطابق » with nothing after
 * it would be telling the reader their file is broken when it is merely
 * incomplete, and the incompleteness is already named on the card above.
 */
function MyUnitRow({ unit, locale }: { unit: CitizenProfileUnit; locale: string }) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  /*
    The census's own status wins where it has one — that is the order billing
    reads them in (`unitStatus ?? ownerDeclaredStatus` in the matrix). Showing
    the card's version to a citizen whose bill was computed from the census's
    would be showing them the one that does not decide anything.
  */
  const status = unit.censusUnitStatus ?? unit.unitStatus;
  const months = unit.presenceMonths?.length ? formatMonthList(unit.presenceMonths, locale) : null;

  return (
    <li className="space-y-1 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          {unit.unitType
            ? (labels.unitType[unit.unitType as never] ?? unit.unitType)
            : (en ? 'Unit' : 'وحدة')}
        </span>
        {(unit.unitPostedNumber ?? unit.unitCode) ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="font-mono" dir="ltr">
              {unit.unitPostedNumber ?? unit.unitCode}
            </span>
          </span>
        ) : null}
        {unit.floor ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Layers className="size-3 shrink-0" aria-hidden />
            {en ? `Floor ${unit.floor}` : `الطابق ${unit.floor}`}
          </span>
        ) : null}
        {unit.unitArea != null ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Ruler className="size-3 shrink-0" aria-hidden />
            {unit.unitArea} {en ? 'm²' : 'م²'}
          </span>
        ) : null}
        {unit.side ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <MapPin className="size-3 shrink-0" aria-hidden />
            {unit.side}
          </span>
        ) : null}
        {unit.sharedRights.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Key className="size-3 shrink-0" aria-hidden />
            {unit.sharedRights.join(', ')}
          </span>
        ) : null}
        {status ? (
          <Badge variant={unitStatusTone(status)}>
            {labels.unitStatus[status as never] ?? status}
          </Badge>
        ) : null}
      </div>

      {/*
        A vacancy the municipality has confirmed, said to the person it affects.

        This is why no occupancy fee is falling on this flat, and a confirmation
        recorded in error is corrected by exactly one thing happening: whoever
        actually lives there saying so. Telling them requires telling them it
        exists — and the date, because «منذ آذار» is what makes it checkable.
      */}
      {unit.vacancy ? (
        <p className="flex flex-wrap items-center gap-x-2 rounded-md bg-warning/5 px-2 py-1 text-warning">
          <DoorClosed className="size-3 shrink-0" aria-hidden />
          {en
            ? `The municipality recorded this unit as vacant on ${formatDate(unit.vacancy.observedAt)} — if that is not the case, please tell the municipality.`
            : `سجّلت البلدية هذه الوحدة شاغرة بتاريخ ${formatDate(unit.vacancy.observedAt)} — إن لم تكن كذلك، يرجى إبلاغ البلدية.`}
        </p>
      ) : null}

      {status === 'SEASONAL' ? (
        <p className="flex flex-wrap items-center gap-x-2 px-2 text-muted-foreground">
          <Sun className="size-3 shrink-0" aria-hidden />
          <span>{ownerBilledNote('SEASONAL', locale)}</span>
          {months ? (
            <span>
              {en ? 'Recorded as present: ' : 'أشهر الحضور المسجَّلة: '}
              {months}
            </span>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Vacant and under-construction wear the warning tone; «مسكن موسمي» does not.
 *
 * It sits in neither `UNOCCUPIED_UNIT_STATUS` nor `OCCUPIED_BY_OTHERS`
 * deliberately (`OWNER_BILLED_WHILE_ABSENT`) — nobody lives there most of the
 * year *and the owner is still billed* — so the amber that means "no fee is
 * falling here" would be saying the opposite of what is true.
 */
function unitStatusTone(status: string): 'warning' | 'soft-info' | 'secondary' {
  if ((OWNER_BILLED_WHILE_ABSENT as readonly string[]).includes(status)) return 'soft-info';
  return isUnoccupied(status) ? 'warning' : 'secondary';
}

/**
 * Why a home nobody lives in is still billed — in the second person.
 *
 * A building is presumed occupied until a تصريح بالشغور is filed (هيئة التشريع
 * والاستشارات 725/2003) and the fee is owed on actual occupancy (Law 60/1988,
 * Art. 11). Most owners of a seasonal home do not know the declaration exists,
 * and the bill is the moment they most want to.
 */
function ownerBilledNote(status: string, locale: string): string | undefined {
  if (!(OWNER_BILLED_WHILE_ABSENT as readonly string[]).includes(status)) return undefined;
  return locale === 'en'
    ? 'Recorded as a seasonal home — the occupancy fee stays with the owner unless a vacancy declaration is filed with the municipality.'
    : 'مسجَّلة كمسكن موسمي — يبقى رسم الإشغال على المالك ما لم يُقدَّم تصريح بالشغور إلى البلدية.';
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
              const breakdown = describeAssessment(payment.assessment, locale);
              return (
                <li
                  key={payment.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{payment.title}</p>
                    {/*
                      «ليش عليّ هالمبلغ؟» — the only question anyone asks about a
                      bill, answered on the bill.

                      The server has sent this breakdown to this very route
                      since per-unit billing existed; the page showed the total
                      alone, so the person holding the bill was the one party
                      with no way to check it. «6 محل تجاري × 100,000 ل.ل» is
                      checkable against the properties listed further down this
                      same page — and a wrong count there is exactly what a
                      resident can come in and have corrected.
                    */}
                    {breakdown ? (
                      <p className="text-xs text-muted-foreground">
                        <bdi>{breakdown}</bdi>
                      </p>
                    ) : null}
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
