'use client';

import { use, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Landmark, Search } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getParcelDues, type ParcelDuesBill } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { param, useUrlState } from '@/lib/use-url-state';
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

/** The parcel asked about, in the query string: a reload or a shared link asks again. */
const PARCEL_URL_STATE = { parcel: param.string() };

/**
 * «المستحق على عقار» — what is still owed on one رقم العقار, before a براءة
 * ذمّة: every open bill with a unit on the parcel, whoever's file it is on, and
 * the parcel's part of each by the bill's own lines; then, apart, the open
 * bills of the parcel's people that name no unit. Read-only — it certifies
 * nothing (the decision of 2026-10-07: answer «is anything owed», no
 * certificate yet).
 */
export default function ParcelDuesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('parcelDues');
  const inputId = useId();

  const [token, setToken] = useState<string | null>(null);
  const [{ parcel }, setUrlState] = useUrlState(PARCEL_URL_STATE);
  const [typed, setTyped] = useState(parcel);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
  }, [tenant, base, router]);

  useEffect(() => setTyped(parcel), [parcel]);

  const duesQuery = useStaffQuery({
    queryKey: ['parcel-dues', tenant, parcel],
    queryFn: (accessToken, signal) => getParcelDues(tenant, accessToken, parcel, signal),
    tenant,
    base,
    token: parcel ? token : null,
    errorMessage: t('failed'),
  });
  const data = parcel ? duesQuery.data : undefined;
  const nothing = data && data.bills.length === 0 && data.unlinked.length === 0;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={Landmark} title={t('title')} subtitle={t('subtitle')} />

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setUrlState({ parcel: typed.trim() });
        }}
      >
        <Field label={t('propertyNumber')} htmlFor={inputId} className="sm:w-64">
          <Input
            id={inputId}
            dir="ltr"
            inputMode="numeric"
            className="text-start"
            placeholder={t('placeholder')}
            value={typed}
            maxLength={40}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!typed.trim()} className="h-10">
          <Search className="size-4" aria-hidden />
          {t('search')}
        </Button>
      </form>

      {!parcel ? null : duesQuery.loading ? (
        <LoadingState label={t('loading')} />
      ) : duesQuery.error ? (
        <ErrorState description={duesQuery.error} onRetry={() => duesQuery.refetch()} />
      ) : nothing ? (
        <EmptyState icon={Landmark} title={t('nothingOwed', { number: parcel })} description={t('nothingOwedBody')} />
      ) : data ? (
        <div className="space-y-6">
          <section className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">{t('total')}</p>
            <p className="text-2xl font-semibold tabular-nums">{formatLbp(data.total, locale)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('totalHint')}</p>
          </section>

          {data.bills.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">{t('billsTitle')}</h2>
              <ul className="divide-y rounded-lg border">
                {data.bills.map((bill) => (
                  <DuesRow key={bill.paymentId} bill={bill} base={base} locale={locale} />
                ))}
              </ul>
            </section>
          ) : null}

          {data.unlinked.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">{t('unlinkedTitle')}</h2>
              <p className="text-xs text-muted-foreground">{t('unlinkedHint')}</p>
              <ul className="divide-y rounded-lg border">
                {data.unlinked.map((bill) => (
                  <DuesRow key={bill.paymentId} bill={bill} base={base} locale={locale} />
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                {t('unlinkedTotal', { amount: formatLbp(data.unlinkedTotal, locale) })}
              </p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DuesRow({
  bill,
  base,
  locale,
}: {
  bill: Omit<ParcelDuesBill, 'onParcel' | 'unitCodes' | 'wholeBill'> & Partial<ParcelDuesBill>;
  base: string;
  locale: string;
}) {
  const t = useTranslations('parcelDues');
  const overdue = bill.paymentStatus === 'OVERDUE';
  return (
    <li className="flex flex-col gap-1.5 p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{bill.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <Link href={`${base}/citizens/${encodeURIComponent(bill.citizenId)}`} className="text-primary hover:underline">
            {bill.citizenName}
          </Link>
          <span>
            · {t('due')}: {formatDate(bill.dueDate)}
          </span>
          {overdue ? <Badge variant="soft-destructive">{getLabels(locale).paymentStatus.OVERDUE}</Badge> : null}
          {bill.unitCodes && bill.unitCodes.length > 0 ? (
            <span>
              · {t('units')}:{' '}
              <bdi dir="ltr" className="font-mono">
                {bill.unitCodes.join(', ')}
              </bdi>
            </span>
          ) : null}
        </p>
        {bill.wholeBill === false ? <p className="text-xs text-warning">{t('partOfBill')}</p> : null}
      </div>
      <dl className="shrink-0 space-y-0.5 text-end tabular-nums">
        {bill.onParcel !== undefined ? (
          <div>
            <dt className="text-xs text-muted-foreground">{t('onParcel')}</dt>
            <dd className="font-semibold">{formatLbp(bill.onParcel, locale)}</dd>
          </div>
        ) : null}
        {bill.onParcel === undefined || bill.wholeBill === false ? (
          <div>
            <dt className="text-xs text-muted-foreground">{t('remaining')}</dt>
            <dd className={bill.onParcel === undefined ? 'font-semibold' : undefined}>
              {formatLbp(bill.remaining, locale)}
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}
