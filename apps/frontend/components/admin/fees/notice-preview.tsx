'use client';

import { useEffect } from 'react';
import { UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getLabels, type FeeNoticePreviewInput, type FeeNoticePreviewResult } from '@mechanization/shared-schemas';
import { Alert } from '@/components/ui/alert';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Money } from '@/components/ui/money';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { previewFeeNotice } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';

/**
 * «معاينة قبل الإصدار» — what issuing this notice now would bill, read by the
 * path the issue takes (`POST fees/notices/preview`) and written nowhere.
 *
 * Shown on the wizard's last step, for every basis, before «إصدار»: the
 * citizens billed, the shared unit bills, the money, each bracket's units, what
 * is not charged and why, and the citizens who cannot be assessed, by name. The
 * wizard issues only once this has answered (`onResult`), so the clerk has
 * seen the figure the notice will raise.
 */
export function NoticePreview({
  tenant,
  base,
  token,
  input,
  locale,
  onResult,
}: {
  tenant: string;
  base: string;
  token: string | null;
  input: FeeNoticePreviewInput;
  locale: string;
  /** The preview's answer, or null while it is read or after it failed. */
  onResult: (result: FeeNoticePreviewResult | null) => void;
}) {
  const t = useTranslations('fees.preview');
  const preview = useStaffQuery({
    // The whole notice: any change to it is a different preview.
    queryKey: ['fee-notice-preview', tenant, JSON.stringify(input)],
    queryFn: (accessToken, signal) => previewFeeNotice(tenant, accessToken, input, signal),
    tenant,
    base,
    token,
    errorMessage: t('failed'),
  });

  const result = preview.data ?? null;
  useEffect(() => {
    onResult(preview.error ? null : result);
  }, [result, preview.error, onResult]);

  if (preview.error) {
    return <ErrorState compact title={t('failed')} onRetry={preview.refetch} retryLabel={t('retry')} />;
  }
  if (!result) return <LoadingState compact label={t('loading')} />;

  const notCharged = [
    { key: 'excluded', count: result.notCharged.excludedUnits },
    { key: 'held', count: result.notCharged.heldUnits },
    { key: 'uninhabitable', count: result.notCharged.uninhabitableUnits },
    { key: 'feeExempt', count: result.notCharged.feeExemptUnits },
    { key: 'coOwnerPaid', count: result.notCharged.coOwnerPaidUnits },
    { key: 'outsideTable', count: result.notCharged.outsideTableUnits },
  ].filter((entry) => entry.count > 0);
  const labels = getLabels(locale);

  return (
    <section aria-label={t('title')} className="space-y-4" aria-live="polite">
      <h3 className="text-sm font-semibold">{t('title')}</h3>

      {result.targetedCitizens === 0 ? (
        <Alert variant="warning">
          {t('nobody')}
        </Alert>
      ) : null}

      <StatStrip>
        <StatItem value={result.billedCitizens.toLocaleString('en-US')} label={t('billedCitizens')} />
        {result.sharedBills > 0 ? (
          <StatItem value={result.sharedBills.toLocaleString('en-US')} label={t('sharedBills')} />
        ) : null}
        <StatItem value={<Money amount={result.expectedRevenue} locale={locale} wrap />} label={t('revenue')} />
      </StatStrip>

      {result.brackets.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('bracket')}</TableHead>
                <TableHead className="text-end">{t('units')}</TableHead>
                <TableHead className="text-end">{t('subtotal')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.brackets.map((bracket) => (
                <TableRow key={bracket.code}>
                  <TableCell>
                    <span className="font-mono">{bracket.code}</span> — {bracket.label}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{bracket.unitCount.toLocaleString('en-US')}</TableCell>
                  <TableCell className="text-end">
                    <Money amount={bracket.subtotal} locale={locale} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {notCharged.length > 0 ? (
        <FactRow>
          {notCharged.map((entry) => (
            <FactCell key={entry.key} label={t(`notCharged.${entry.key}`)} value={entry.count.toLocaleString('en-US')} />
          ))}
        </FactRow>
      ) : null}

      {/*
        What the table does not price, by type (D11): not charged by this notice.
        Shown before «إصدار» so a type the clerk meant to charge and forgot to put
        in the table is caught here, not by the residents it was meant for.
      */}
      {result.outsideTable.length > 0 ? (
        <Alert variant="info">
          <p>{t('outsideTable', { count: result.notCharged.outsideTableUnits })}</p>
          <ul className="mt-1 list-disc ps-5">
            {result.outsideTable.map((row) => (
              <li key={row.unitType ?? 'none'}>
                {t('outsideTableLine', {
                  type: row.unitType
                    ? (labels.unitType[row.unitType as keyof typeof labels.unitType] ?? row.unitType)
                    : t('outsideTableNoType'),
                  count: row.count,
                })}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {result.conflicts.length > 0 ? (
        <Alert variant="warning">
          <p>{t('conflicts', { count: result.conflicts.length })}</p>
          <ul className="mt-1 list-disc ps-5">
            {result.conflicts.map((conflict) => (
              <li key={conflict.unitId}>
                {t('conflictLine', {
                  unit: conflict.unitCode ?? '—',
                  parcel: conflict.propertyNumber ?? '—',
                  brackets: conflict.bracketCodes.join(t('separator')),
                  count: conflict.citizenCount,
                })}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {result.unassessable.length > 0 ? (
        <CollapsibleSection icon={UserX} title={t('unassessable', { count: result.unassessable.length })}>
          <ul className="divide-y text-sm">
            {result.unassessable.map((entry) => (
              <li key={entry.citizenId} className="py-2">
                <p className="font-medium">{entry.name}</p>
                <p className="text-xs text-muted-foreground">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      ) : null}
    </section>
  );
}
