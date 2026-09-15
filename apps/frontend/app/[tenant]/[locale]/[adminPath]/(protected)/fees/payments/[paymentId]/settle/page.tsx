'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  CreditCard,
  Loader2,
  UserCheck,
} from 'lucide-react';
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
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { tafqeet } from '@/lib/tafqeet';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
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

export default function SettlePaymentPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; paymentId: string }>;
}) {
  const { tenant, locale, adminPath, paymentId } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const methods = [
    {
      value: 'CASH' as const,
      title: locale === 'en' ? 'Cash' : 'نقداً',
      description: locale === 'en' ? 'Direct receipt in office' : 'استلام مباشر في الصندوق',
      icon: Banknote,
    },
    {
      value: 'WHISH_MONEY' as const,
      title: locale === 'en' ? 'Whish Transfer' : 'تحويل Whish',
      description: locale === 'en' ? 'Verified account transfer' : 'تحويل مؤكد في الحساب',
      icon: CreditCard,
    },
    {
      value: 'COLLECTOR' as const,
      title: locale === 'en' ? 'Through Collector' : 'عبر المحصّل',
      description: locale === 'en' ? 'Field collection tour' : 'استلام في الجولة الميدانية',
      icon: UserCheck,
    },
  ];

  type Method = (typeof methods)[number]['value'];

  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payment, setPayment] = useState<AdminPaymentItem | null>(null);
  const [collectors, setCollectors] = useState<StaffSummary[]>([]);

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

  const [receipt, setReceipt] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  const load = useCallback(async () => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    const accessToken = session.accessToken;
    setToken(accessToken);
    setLoading(true);
    setLoadError(null);

    try {
      const row = await getPaymentById(tenant, accessToken, paymentId);
      setPayment(row);
      setAmount(String(Math.round(row.remaining)));
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      setLoadError(
        caught instanceof ApiRequestError && caught.status === 404
          ? (locale === 'en'
              ? 'No payment demand found with this ID — it may have been deleted or an invalid link was entered.'
              : 'لا توجد مطالبة بهذا المعرّف — قد تكون حُذفت أو أُدخل رابط غير صحيح.')
          : (locale === 'en' ? 'Failed to load payment demand data.' : 'تعذّر تحميل بيانات المطالبة.'),
      );
      return;
    } finally {
      setLoading(false);
    }

    getStaff(tenant, accessToken)
      .then(({ items }) => setCollectors(items))
      .catch(() => setCollectors([]));
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(locale === 'en' ? (config.name || config.nameAr) : (config.nameAr || config.name)))
      .catch(() => setMunicipalityName(tenant));
    getMunicipalitySettings(tenant, accessToken)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [tenant, base, paymentId, router, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <LoadingState fullHeight />
      </div>
    );
  }

  if (loadError || !payment) {
    return (
      <div className="w-full max-w-2xl mx-auto space-y-4 px-4 py-12 sm:px-6">
        <ErrorState description={loadError ?? undefined} onRetry={() => void load()} />
        <div className="flex justify-center">
          <Link
            href={`${base}/fees`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
            الرجوع إلى الرسوم والمدفوعات
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

  const submit = async () => {
    if (!token || !valid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await settlePayment(tenant, token, payment.id, {
        method,
        amount: received,
        whishTransactionRef: isWhish ? reference.trim() : undefined,
        collectedById: isCollector ? collectedById : undefined,
        note: note.trim() || undefined,
      });

      const profile = await getCitizenProfile(tenant, token, payment.citizenId);
      const settled = profile.payments.find((row) => row.id === payment.id);
      if (settled) {
        setReceipt({ citizen: profile, payment: settled, received });
      } else {
        router.push(`${base}/fees`);
      }
    } catch (caught) {
      logApiError(caught);
      setSubmitError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en' ? 'Failed to record payment.' : 'تعذّر تسجيل الدفعة.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Back link */}
      <div>
        <BackLink
          fallbackHref={`${base}/fees`}
          label={locale === 'en' ? 'Back' : 'رجوع'}
          className="text-sm"
        />
      </div>

      {/* Header */}
      <PageHeader
        icon={Banknote}
        title={locale === 'en' ? 'Record Payment' : 'تسجيل دفعة'}
        subtitle={`${payment.title} — ${payment.citizenName}`}
        actions={
          <Badge variant="outline" className="text-sm font-semibold px-3 py-1">
            {locale === 'en' ? 'Remaining Balance: ' : 'الرصيد المستحق: '}
            {formatLbp(payment.remaining, locale)}
          </Badge>
        }
      />

      {submitError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {submitError}
        </p>
      ) : null}

      {/* Full Page Width 2-Column Equal-Height Grid */}
      <div className="grid gap-6 lg:grid-cols-12 lg:items-stretch">
        {/* Left Column (8 cols): Form Controls */}
        <div className="h-full lg:col-span-8">
          <div className="flex flex-col justify-between h-full space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
            <div className="space-y-5">
              {/* Payment Method */}
              <Field label={locale === 'en' ? 'Payment Method' : 'طريقة الدفع'} htmlFor="settle-method" required>
                <div className="grid gap-3 sm:grid-cols-3">
                  {methods.map((option) => (
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
                      title={option.title}
                      description={option.description}
                      icon={option.icon}
                    />
                  ))}
                </div>
              </Field>

              {/* Method-specific fields */}
              {isWhish ? (
                <Field
                  label={locale === 'en' ? 'Transaction Reference Number' : 'رقم عملية التحويل'}
                  htmlFor="settle-reference"
                  required
                  hint={locale === 'en' ? 'As shown on Whish receipt.' : 'كما يظهر في إشعار تطبيق Whish.'}
                >
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
                <Field
                  label={locale === 'en' ? 'Collector' : 'المحصّل'}
                  htmlFor="settle-collector"
                  required
                  hint={locale === 'en' ? 'Staff member who collected the payment.' : 'الموظف الذي استلم المبلغ.'}
                >
                  {collectors.length === 0 ? (
                    <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning">
                      {locale === 'en' ? 'No staff accounts found.' : 'لا توجد حسابات موظفين لاختيار محصّل.'}
                    </p>
                  ) : (
                    <Select value={collectedById} onValueChange={setCollectedById}>
                      <SelectTrigger id="settle-collector">
                        <SelectValue placeholder={locale === 'en' ? 'Select collector…' : 'اختر المحصّل…'} />
                      </SelectTrigger>
                      <SelectContent>
                        {collectors
                          .filter((c) => c.isActive)
                          .map((collector) => (
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
                  label={locale === 'en' ? 'Received Amount (LBP)' : 'المبلغ المستلم (ل.ل)'}
                  htmlFor="settle-amount"
                  required
                  error={
                    tooMuch
                      ? (locale === 'en'
                          ? `Amount exceeds remaining balance (${formatLbp(payment.remaining, locale)})`
                          : `المبلغ أكبر من الرصيد المستحق (${formatLbp(payment.remaining, locale)})`)
                      : undefined
                  }
                >
                  <div className="relative flex items-center">
                    <Input
                      id="settle-amount"
                      inputMode="numeric"
                      dir="ltr"
                      className="text-start text-xl font-bold tabular-nums pe-16"
                      invalid={tooMuch}
                      value={amount ? Number(amount).toLocaleString('en-US') : ''}
                      onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                      placeholder="0"
                    />
                    <div className="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-4 text-xs font-bold text-muted-foreground">
                      {locale === 'en' ? 'LBP' : 'ل.ل'}
                    </div>
                  </div>
                </Field>

                {/* Amount Quick Presets */}
                {payment.remaining > 1 ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setAmount(String(Math.round(payment.remaining)))}
                    >
                      {locale === 'en' ? 'Full Balance' : 'كامل الرصيد'} ({formatLbp(payment.remaining, locale)})
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setAmount(String(Math.round(payment.remaining / 2)))}
                    >
                      {locale === 'en' ? 'Half' : 'النصف'} ({formatLbp(Math.round(payment.remaining / 2), locale)})
                    </Button>
                  </div>
                ) : null}

                {/* Tafqeet in Arabic Words */}
                {received > 0 && !tooMuch && locale === 'ar' ? (
                  <p className="text-xs text-muted-foreground pt-1">
                    <span className="font-semibold text-foreground">كتابةً:</span> {tafqeet(received)}
                  </p>
                ) : null}

                {isPartial ? (
                  <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                    {locale === 'en' ? (
                      <>
                        Partial payment — <span className="font-bold">{formatLbp(payment.remaining - received, locale)}</span> will remain due on this charge.
                      </>
                    ) : (
                      <>
                        دفعة جزئية — سيبقى <span className="font-bold">{formatLbp(payment.remaining - received, locale)}</span> مستحقاً على هذه المطالبة.
                      </>
                    )}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Note at bottom of left card */}
            <div className="pt-2">
              <Field label={locale === 'en' ? 'Notes' : 'ملاحظة'} htmlFor="settle-note" hint={locale === 'en' ? 'Optional' : 'اختياري'}>
                <Textarea
                  id="settle-note"
                  rows={2}
                  placeholder={locale === 'en' ? 'Any notes regarding this payment…' : 'أي ملاحظات حول الدفعة…'}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </div>

        {/* Right Column (4 cols): Summary & Submission */}
        <div className="h-full lg:col-span-4">
          <div className="flex flex-col justify-between h-full rounded-2xl border bg-card p-6 shadow-sm">
            {/* Top: Details List */}
            <div className="space-y-4">
              <h3 className="font-bold text-sm text-foreground border-b pb-3">
                {locale === 'en' ? 'Transaction Details' : 'تفاصيل العملية'}
              </h3>

              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{locale === 'en' ? 'Citizen:' : 'المواطن:'}</span>
                  <span className="font-semibold text-foreground">{payment.citizenName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{locale === 'en' ? 'Charge:' : 'المطالبة:'}</span>
                  <span className="font-semibold text-foreground">{payment.title}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{locale === 'en' ? 'Due Date:' : 'تاريخ الاستحقاق:'}</span>
                  <span className="text-foreground">{formatDate(payment.dueDate)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{locale === 'en' ? 'Total Charge:' : 'قيمة المطالبة:'}</span>
                  <span className="tabular-nums text-foreground">{formatLbp(payment.amount, locale)}</span>
                </div>
                {payment.paidAmount > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{locale === 'en' ? 'Previously Paid:' : 'المسدد سابقاً:'}</span>
                    <span className="tabular-nums text-success font-semibold">
                      {formatLbp(payment.paidAmount, locale)}
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t pt-2 font-bold">
                  <span className="text-foreground">{locale === 'en' ? 'Remaining Due:' : 'الرصيد المستحق:'}</span>
                  <span className="tabular-nums text-foreground">{formatLbp(payment.remaining, locale)}</span>
                </div>
              </div>
            </div>

            {/* Bottom: Recording summary + Submit Button */}
            <div className="mt-6 space-y-3 pt-4 border-t">
              <div className="rounded-xl bg-primary/5 border border-primary/20 p-3.5 space-y-1">
                <span className="text-xs text-muted-foreground">{locale === 'en' ? 'Amount to record:' : 'المبلغ المراد تسجيله:'}</span>
                <p className="text-xl font-bold tabular-nums text-primary">
                  {formatLbp(valid ? received : 0, locale)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {locale === 'en'
                    ? (isWhish ? 'Transfer via Whish' : isCollector ? 'Through Collector' : 'Cash in Office')
                    : (isWhish ? 'تحويلاً عبر Whish' : isCollector ? 'عبر المحصّل' : 'نقداً في الصندوق')}
                </p>
              </div>

              <Button
                size="lg"
                className="w-full font-bold text-base h-12 shadow-sm"
                disabled={!valid || submitting}
                onClick={() => void submit()}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin rtl:ml-2 ltr:mr-2" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-4 rtl:ml-2 ltr:mr-2" aria-hidden />
                )}
                {locale === 'en' ? 'Confirm & Record Payment' : 'تأكيد وتسجيل الدفعة'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Receipt Modal */}
      <PaymentReceipt
        open={receipt !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReceipt(null);
            router.push(`${base}/fees`);
          }
        }}
        tenant={tenant}
        citizen={receipt?.citizen ?? ({} as CitizenProfile)}
        payment={receipt?.payment ?? null}
        municipalityName={municipalityName}
        governorate={settings?.governorate}
        councilDecisionRef={settings?.councilDecisionRef}
        district={settings?.district}
        contactPhone={settings?.contactPhone}
        officeWhatsapp={settings?.whatsappNumber}
        receivedAmount={receipt?.received}
        locale={locale}
      />
    </div>
  );
}
