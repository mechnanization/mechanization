'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  Receipt,
  Wallet,
  XCircle,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  declarePayment,
  getMunicipalitySettings,
  getMyPayments,
  logApiError,
  startWhishCheckout,
} from '@/lib/api-client';
import type { CitizenPaymentItem, MunicipalitySettings } from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatLbp } from '@/lib/currency';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PayDialog } from '@/components/citizen/pay-dialog';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';

const STATUS_TONE: Record<string, string> = {
  UNPAID: 'border-warning/30 bg-warning/10 text-warning',
  OVERDUE: 'border-destructive/30 bg-destructive/10 text-destructive',
  PENDING_REVIEW: 'border-warning/30 bg-warning/10 text-warning',
  PAID: 'border-success/30 bg-success/10 text-success',
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  UNPAID: Clock,
  OVERDUE: AlertTriangle,
  PENDING_REVIEW: Clock,
  PAID: CheckCircle2,
};

export default function CitizenPayments({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();
  const labels = getLabels(locale);

  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [items, setItems] = useState<CitizenPaymentItem[]>([]);
  const [settings, setSettings] = useState<MunicipalitySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [paying, setPaying] = useState<CitizenPaymentItem | null>(null);
  const [payingOnlineId, setPayingOnlineId] = useState<string | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [declareError, setDeclareError] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'CITIZEN') {
      router.replace(`/${tenant}/${locale}/payments/login`);
      return;
    }
    setToken(session.accessToken);
    setName(session.user.name);
  }, [tenant, locale, router]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [paymentsResult, settingsResult] = await Promise.all([
        getMyPayments(tenant, token),
        getMunicipalitySettings(tenant, token),
      ]);
      setItems(paymentsResult.items);
      setSettings(settingsResult);
      setError(null);
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`/${tenant}/${locale}/payments/login`);
        return;
      }
      setError(locale === 'en' ? 'Failed to load your fees and dues.' : 'تعذّر تحميل مستحقاتك.');
    } finally {
      setLoading(false);
    }
  }, [tenant, token, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitDeclaration = useCallback(
    async (input: { method: string; whishTransactionRef?: string }) => {
      if (!token || !paying) return;
      setDeclaring(true);
      setDeclareError(null);
      try {
        await declarePayment(tenant, token, paying.id, input);
        setPaying(null);
        await load();
      } catch (caught) {
        logApiError(caught);
        setDeclareError(
          caught instanceof ApiRequestError
            ? caught.message
            : (locale === 'en' ? 'Failed to record payment declaration.' : 'تعذّر تسجيل الدفعة.'),
        );
      } finally {
        setDeclaring(false);
      }
    },
    [tenant, token, paying, load, locale],
  );

  const payWithWhish = useCallback(
    async (paymentId: string) => {
      if (!token) return;
      setPayingOnlineId(paymentId);
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
        setPayingOnlineId(null);
      }
    },
    [tenant, token, locale],
  );

  if (!token) return null;

  const outstanding = items.filter(
    (item) => item.paymentStatus === 'UNPAID' || item.paymentStatus === 'OVERDUE',
  );
  const unpaidTotal = outstanding.reduce((total, item) => total + item.amount, 0);
  const paidTotal = items
    .filter((item) => item.paymentStatus === 'PAID')
    .reduce((total, item) => total + item.amount, 0);
  const nextDue = outstanding
    .map((item) => item.dueDate)
    .sort()
    .at(0);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Receipt className="size-7 text-primary" aria-hidden />
            {locale === 'en' ? 'Fees & Payments' : 'الرسوم والمدفوعات'}
          </h1>
          {name ? (
            <p className="text-muted-foreground">
              {locale === 'en' ? `Welcome, ${name}` : `أهلاً ${name}`}
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            clearSession(tenant);
            router.push(`/${tenant}/${locale}`);
          }}
        >
          {locale === 'en' ? 'Sign Out' : 'خروج'}
        </Button>
      </header>

      {error ? (
        <Alert tone="error">
          {error}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label={locale === 'en' ? 'Total Dues' : 'إجمالي المستحقات'}
          value={formatLbp(unpaidTotal, locale)}
          icon={<Wallet className="size-6" aria-hidden />}
          tone={unpaidTotal > 0 ? 'text-destructive' : 'text-muted-foreground'}
          loading={loading}
        />
        <SummaryCard
          label={locale === 'en' ? 'Earliest Due Date' : 'أقرب موعد استحقاق'}
          value={nextDue ? formatDate(nextDue) : '—'}
          icon={<CalendarClock className="size-6" aria-hidden />}
          loading={loading}
        />
        <SummaryCard
          label={locale === 'en' ? 'Total Paid' : 'إجمالي المسدّد'}
          value={formatLbp(paidTotal, locale)}
          icon={<BadgeCheck className="size-6" aria-hidden />}
          tone="text-success"
          loading={loading}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {locale === 'en' ? 'My Fee Invoices' : 'مطالباتي'}
        </h2>

        {loading ? (
          <p className="text-muted-foreground">
            {locale === 'en' ? 'Loading…' : 'جارٍ التحميل…'}
          </p>
        ) : null}

        {!loading && items.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 p-8 text-center">
              <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
              <p className="text-lg font-medium">
                {locale === 'en' ? 'No outstanding fees on file.' : 'لا توجد رسوم مستحقة عليك.'}
              </p>
              <p className="text-sm text-muted-foreground">
                {locale === 'en'
                  ? 'Any newly issued fees by the municipality will appear here.'
                  : 'ستظهر هنا أي رسوم تصدرها البلدية لاحقاً.'}
              </p>
            </CardContent>
          </Card>
        ) : null}

        <div className="space-y-3">
          {items.map((item) => {
            const Icon = STATUS_ICON[item.paymentStatus] ?? Clock;
            const payable =
              item.paymentStatus === 'UNPAID' || item.paymentStatus === 'OVERDUE';

            return (
              <Card key={item.id}>
                <CardContent className="space-y-3 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-semibold">{item.title}</p>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <CalendarClock className="size-3.5" aria-hidden />
                          {locale === 'en' ? 'Due ' : 'استحقاق '}
                          {formatDate(item.dueDate)}
                        </span>
                        {item.frequency ? (
                          <Badge variant="outline">
                            {labels.feeFrequency[item.frequency as never] ?? item.frequency}
                          </Badge>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <p className="text-xl font-bold">{formatLbp(item.amount, locale)}</p>
                      <Badge
                        variant="outline"
                        className={cn('gap-1.5 py-1', STATUS_TONE[item.paymentStatus])}
                      >
                        <Icon className="size-3.5" aria-hidden />
                        {labels.paymentStatus[item.paymentStatus as never] ?? item.paymentStatus}
                      </Badge>
                    </div>
                  </div>

                  {item.reviewNote && item.paymentStatus !== 'PAID' ? (
                    <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                      {item.reviewNote}
                    </p>
                  ) : null}

                  {item.paymentStatus === 'PENDING_REVIEW' ? (
                    <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                      {locale === 'en'
                        ? 'Your payment declaration was received. A staff member will confirm it after verifying the transfer.'
                        : 'تم استلام إبلاغك بالدفع. سيؤكّده موظف البلدية بعد التحقق من وصول المبلغ.'}
                    </p>
                  ) : null}

                  {payable ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        size="sm"
                        disabled={payingOnlineId === item.id}
                        onClick={() => void payWithWhish(item.id)}
                      >
                        {payingOnlineId === item.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <CreditCard className="size-4" aria-hidden />
                        )}
                        {locale === 'en' ? 'Pay with Whish' : 'ادفع عبر Whish'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPaying(item)}>
                        <Wallet className="size-4" aria-hidden />
                        {locale === 'en' ? 'Other Methods' : 'طرق أخرى'}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <PayDialog
        payment={paying}
        settings={settings}
        submitting={declaring}
        error={declareError}
        locale={locale}
        onOpenChange={(open) => {
          if (!open) {
            setPaying(null);
            setDeclareError(null);
          }
        }}
        onDeclare={(input) => void submitDeclaration(input)}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  tone = 'text-foreground',
  loading,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={cn('truncate text-xl font-bold', tone)}>{loading ? '—' : value}</p>
        </div>
        <span className="rounded-lg bg-accent p-3 text-muted-foreground">{icon}</span>
      </CardContent>
    </Card>
  );
}
