'use client';

import { use, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Landmark, Search } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getParcelDues, type ParcelDuesBill } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { param, useUrlState } from '@/lib/use-url-state';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
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
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('parcelDues');
  const inputId = useId();

  const { token } = useStaffSession(tenant, base);
  const [{ parcel }, setUrlState] = useUrlState(PARCEL_URL_STATE);
  const [typed, setTyped] = useState(parcel);

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
      <PageHeader icon={Landmark} title={t('title')} />

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const next = typed.trim();
          // Asked again about the same parcel: the URL does not change, so ask the server again.
          if (next === parcel) void duesQuery.refetch();
          else setUrlState({ parcel: next });
        }}
      >
        <Field label={t('propertyNumber')} htmlFor={inputId} required className="sm:w-64">
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

      {/*
        What this page is and is not, before the first search: the header has no
        subtitle (PageHeader), and «للقراءة فقط: لا يصدر شهادة» is worth reading once.
      */}
      {!parcel ? (
        <p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
      ) : duesQuery.loading ? (
        <LoadingState label={t('loading')} />
      ) : duesQuery.error ? (
        <ErrorState description={duesQuery.error} onRetry={() => duesQuery.refetch()} />
      ) : nothing ? (
        <EmptyState icon={Landmark} title={t('nothingOwed', { number: parcel })} description={t('nothingOwedBody')} />
      ) : data ? (
        <div className="space-y-6">
          <section className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">{t('total')}</p>
            <p className="text-2xl font-semibold">
              <Money amount={data.total} locale={locale} exact />
            </p>
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
              <FactRow className="sm:ms-auto sm:w-72">
                <FactCell
                  label={t('unlinkedTotal')}
                  value={<Money amount={data.unlinkedTotal} locale={locale} exact />}
                  className="font-semibold"
                />
              </FactRow>
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
      <FactRow className="shrink-0 sm:w-60">
        {bill.onParcel !== undefined ? (
          <FactCell
            label={t('onParcel')}
            value={<Money amount={bill.onParcel} locale={locale} exact />}
            className="font-semibold"
          />
        ) : null}
        {bill.onParcel === undefined || bill.wholeBill === false ? (
          <FactCell
            label={t('remaining')}
            value={<Money amount={bill.remaining} locale={locale} exact />}
            className={bill.onParcel === undefined ? 'font-semibold' : undefined}
          />
        ) : null}
      </FactRow>
    </li>
  );
}
