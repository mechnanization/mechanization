'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  FileText,
  Home,
  Layers,
  MapPin,
  Receipt,
  Ruler,
  Tent,
  Trees,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { ApiRequestError, getMySummary, logApiError } from '@/lib/api-client';
import type { MyCitizenSummary } from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatLbp } from '@/lib/currency';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { LoadingState } from '@/components/ui/states';

const PROPERTY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  BUILDING: Building2,
  HOUSE: Home,
  LAND: Trees,
  TENT: Tent,
};

export default function MyAccount({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();
  const labels = getLabels(locale);

  const [summary, setSummary] = useState<MyCitizenSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session) {
      router.replace(`/${tenant}/${locale}/login`);
      return;
    }

    getMySummary(tenant, session.accessToken)
      .then(setSummary)
      .catch((caught: unknown) => {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`/${tenant}/${locale}/login`);
          return;
        }
        setError(locale === 'en' ? 'Failed to load your file data. Please try again.' : 'تعذّر تحميل بياناتك. حاول مرة أخرى.');
      });
  }, [tenant, locale, router]);

  const unpaid = summary?.payments.filter((payment) => payment.paymentStatus !== 'PAID') ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            {locale === 'en' ? 'My Account' : 'حسابي'}
          </h1>
          {summary ? (
            <p className="text-muted-foreground">
              {locale === 'en' ? `Welcome, ${summary.fullName}` : `أهلاً ${summary.fullName}`}
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
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      {summary === null && !error ? <LoadingState /> : null}

      {summary ? (
        <>
          {summary.referenceNumber ? (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="space-y-1 p-5">
                <p className="text-sm text-muted-foreground">
                  {locale === 'en' ? 'Your Reference Number' : 'رقمك المرجعي'}
                </p>
                <p className="text-2xl font-bold tracking-widest text-primary" dir="ltr">
                  {summary.referenceNumber}
                </p>
                <p className="pt-1 text-sm text-muted-foreground">
                  {locale === 'en'
                    ? 'Quote this number whenever contacting the municipality.'
                    : 'اذكر هذا الرقم عند مراجعة البلدية.'}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* Outstanding Fees */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Receipt className="size-5 text-primary" aria-hidden />
              {locale === 'en' ? 'Outstanding Fees' : 'الرسوم المستحقة'}
            </h2>

            {summary.payments.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  {locale === 'en' ? 'No outstanding fees on file.' : 'لا توجد رسوم مسجّلة عليك.'}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm text-muted-foreground">
                      {locale === 'en' ? 'Total Unpaid' : 'المجموع غير المسدَّد'}
                    </span>
                    <Money
                      amount={summary.fees.outstandingTotal}
                      className="text-2xl font-bold"
                      locale={locale}
                    />
                  </div>

                  {summary.fees.overdueTotal > 0 ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      {locale === 'en'
                        ? `${formatLbp(summary.fees.overdueTotal, locale)} is past the due date.`
                        : `منها ${formatLbp(summary.fees.overdueTotal, locale)} تجاوزت تاريخ الاستحقاق.`}
                    </p>
                  ) : null}

                  {unpaid.length > 0 ? (
                    <ul className="divide-y rounded-lg border">
                      {unpaid.slice(0, 4).map((payment) => (
                        <li
                          key={payment.id}
                          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3 text-sm"
                        >
                          <span className="min-w-0 truncate">{payment.title}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            {payment.paymentStatus === 'OVERDUE' ? (
                              <Badge variant="destructive">
                                {locale === 'en' ? 'Overdue' : 'متأخرة'}
                              </Badge>
                            ) : null}
                            <Money amount={payment.amount} exact className="font-medium" locale={locale} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <Link
                    href={`/${tenant}/${locale}/payments`}
                    className={buttonVariants({ size: 'lg', className: 'w-full' })}
                  >
                    {locale === 'en' ? 'View Invoices & Pay' : 'عرض الفواتير والدفع'}
                  </Link>
                </CardContent>
              </Card>
            )}
          </section>

          {/* Properties */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Building2 className="size-5 text-primary" aria-hidden />
              {locale === 'en' ? `My Properties (${summary.properties.length})` : `عقاراتي (${summary.properties.length})`}
            </h2>

            {summary.properties.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  {locale === 'en'
                    ? 'No registered properties found under your name. Visit the municipality to register.'
                    : 'لا توجد عقارات مسجّلة باسمك. راجع البلدية لتسجيل عقارك.'}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {summary.properties.map((property) => {
                  const Icon = PROPERTY_ICON[property.propertyType] ?? Building2;
                  return (
                    <Card key={property.id}>
                      <CardContent className="flex items-start gap-3 p-4">
                        <span
                          aria-hidden
                          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                        >
                          <Icon className="size-5" />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          {/*
                            A card whose رقم العقار was never established says
                            so. Printed unconditionally it produced «العقار رقم »
                            trailing into nothing, which reads as a broken page
                            rather than as the gap it is — and the reader is the
                            one person who can close it.
                          */}
                          <p className="font-semibold">
                            {property.propertyNumber ? (
                              <>
                                {locale === 'en' ? 'Parcel #' : 'العقار رقم '}
                                <span dir="ltr" className="font-mono">
                                  {property.propertyNumber}
                                </span>
                              </>
                            ) : (
                              <span className="text-warning">
                                {locale === 'en'
                                  ? 'Parcel number not recorded'
                                  : 'رقم العقار غير مسجَّل'}
                              </span>
                            )}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary">
                              {labels.propertyType[property.propertyType as never] ??
                                property.propertyType}
                            </Badge>
                            <Badge
                              variant={
                                property.occupancyType === 'TENANT' ? 'warning' : 'outline'
                              }
                            >
                              {labels.occupancyType[property.occupancyType as never] ??
                                property.occupancyType}
                            </Badge>
                          </div>
                          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            {property.neighborhood ? (
                              <span className="inline-flex items-center gap-1.5">
                                <MapPin className="size-3.5 shrink-0" aria-hidden />
                                {property.neighborhood}
                              </span>
                            ) : null}
                            {property.unitArea != null ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Ruler className="size-3.5 shrink-0" aria-hidden />
                                {property.unitArea} {locale === 'en' ? 'm²' : 'م²'}
                              </span>
                            ) : null}
                            {property.unitCount > 0 ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Layers className="size-3.5 shrink-0" aria-hidden />
                                {property.unitCount} {locale === 'en' ? 'units' : 'وحدة'}
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/*
              The way to «ملفّي», which until now nothing linked to.

              Signing in lands a citizen here, and this page is a summary by
              design: a parcel number, an area, a unit count. The whole record —
              اسم الأم, every unit with the status it is billed on, any vacancy
              the municipality has confirmed, and the breakdown behind each
              amount — lives one route away at `/my-file`, and there was no way
              to reach it except by typing the URL. "Check your file and tell us
              what is wrong" is the paragraph below; this is the door it means.
            */}
            <Link
              href={`/${tenant}/${locale}/my-file`}
              className={buttonVariants({ variant: 'outline', className: 'w-full' })}
            >
              <FileText className="size-4" aria-hidden />
              {locale === 'en' ? 'View my full file' : 'عرض ملفّي الكامل'}
            </Link>

            <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {locale === 'en'
                ? 'If you notice any inaccuracies in your registered file or properties, please visit the municipality with your reference number to correct them.'
                : 'إذا لاحظت خطأً في بياناتك أو عقاراتك، يرجى مراجعة البلدية مع رقمك المرجعي لتصحيحها.'}
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
