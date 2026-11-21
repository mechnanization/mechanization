'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import {
  discardArrearsBatchSchema,
  getLabels,
  returnArrearsBatchSchema,
  type ArrearsBatchTotalRow,
} from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import {
  approveArrearsBatch,
  discardArrearsBatch,
  getArrearsBatchReview,
  returnArrearsBatch,
} from '@/lib/arrears-api';
import { formatLbp } from '@/lib/currency';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTableLabels } from '@/lib/use-table-labels';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ArrearsVerdicts } from './arrears-verdicts';

type Act = 'approve' | 'return' | 'discard';

/**
 * A submitted batch as the manager reviews it (old-debts-plan §4.5, task 8):
 * its totals by year and fee type, the lines the preparer kept or dropped by
 * hand with his reasons, the pages' total beside the file's, and the three
 * acts. Approval says in plain words what it does — N bills totalling X on M
 * citizens' files and in the portal — because it cannot be undone: the batch
 * is locked and the bills are raised. Returning needs what to fix, discarding
 * its reason (the contract's minimums).
 */
export function BatchReview({
  tenant,
  base,
  token,
  locale,
  batchId,
  onDone,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  batchId: string;
  onDone: () => void;
}) {
  const t = useTranslations('arrears.review');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [act, setAct] = useState<Act | null>(null);
  const [text, setText] = useState('');

  const review = useStaffQuery({
    queryKey: ['arrears-batch-review', tenant, batchId],
    queryFn: (session, signal) => getArrearsBatchReview(tenant, session, batchId, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadFailed'),
    fresh: true,
  });
  const tableLabels = useTableLabels({ empty: t('noLines') });
  const columns = useMemo<ColumnDef<ArrearsBatchTotalRow>[]>(
    () => [
      { id: 'year', header: t('year'), cell: ({ row }) => <bdi dir="ltr">{row.original.year}</bdi> },
      { id: 'fee', header: t('fee'), cell: ({ row }) => labels.arrearsFeeType[row.original.feeType] },
      { id: 'component', header: t('component'), cell: ({ row }) => labels.arrearsComponent[row.original.component] },
      {
        id: 'count',
        header: t('count'),
        meta: { align: 'end' as const },
        cell: ({ row }) => row.original.count.toLocaleString('en-US'),
      },
      {
        id: 'amount',
        header: t('amount'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <Money amount={row.original.amount} currency="LBP" locale={locale} exact />,
      },
    ],
    [t, labels, locale],
  );

  const note = act === 'return' ? returnArrearsBatchSchema.safeParse({ note: text }) : null;
  const reason = act === 'discard' ? discardArrearsBatchSchema.safeParse({ reason: text }) : null;

  const confirm = async (): Promise<void> => {
    if (!token || !act) return;
    try {
      if (act === 'approve') await approveArrearsBatch(tenant, token, batchId);
      else if (act === 'return' && note?.success) await returnArrearsBatch(tenant, token, batchId, note.data);
      else if (act === 'discard' && reason?.success) await discardArrearsBatch(tenant, token, batchId, reason.data);
      else return;
    } catch (caught) {
      logApiError(caught);
      throw caught;
    }
    toast.success(t(`${act}Done`));
    setAct(null);
    setText('');
    void queryClient.invalidateQueries({ queryKey: ['arrears-batches', tenant] });
    onDone();
  };

  if (review.error && !review.data) {
    return <ErrorState title={t('loadFailed')} description={review.refusal ?? review.error} onRetry={review.refetch} />;
  }
  if (!review.data) return <LoadingState />;
  const { batch, totals, byYearAndFee, flagged, bills } = review.data;
  const lbp = (amount: number) => <Money amount={amount} currency="LBP" locale={locale} exact wrap />;

  return (
    <div className="space-y-5">
      <StatStrip>
        <StatItem label={t('kept', { count: totals.kept.count })} value={lbp(totals.kept.amount)} />
        <StatItem label={t('dropped', { count: totals.dropped.count })} value={lbp(totals.dropped.amount)} />
        <StatItem label={t('unmatched', { count: totals.unmatched.count })} value={lbp(totals.unmatched.amount)} />
        <StatItem label={t('fileTotal')} value={lbp(totals.fileTotal)} />
        <StatItem
          label={t('controlTotal')}
          value={batch.controlTotal === null ? '—' : lbp(batch.controlTotal)}
          hint={batch.sourceNote ?? undefined}
        />
      </StatStrip>

      <DataTable
        columns={columns}
        data={byYearAndFee}
        labels={tableLabels}
        getRowId={(row) => `${row.year}|${row.feeType}|${row.component}`}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={false}
        error={null}
      />

      {flagged.length > 0 ? (
        <section className="space-y-2" aria-labelledby="arrears-flagged-heading">
          <h3 id="arrears-flagged-heading" className="text-base font-semibold">
            {t('flagged')}
          </h3>
          <ArrearsVerdicts lines={flagged} locale={locale} decisions={new Map()} onDecide={() => undefined} disabled readOnly />
        </section>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => setAct('discard')}>
          <Trash2 className="size-4" aria-hidden />
          {t('discard')}
        </Button>
        <Button variant="outline" onClick={() => setAct('return')}>
          <RotateCcw className="size-4" aria-hidden />
          {t('return')}
        </Button>
        <Button onClick={() => setAct('approve')}>
          <CheckCircle2 className="size-4" aria-hidden />
          {t('approve')}
        </Button>
      </div>

      <ConfirmDialog
        open={act !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAct(null);
            setText('');
          }
        }}
        destructive={act === 'discard'}
        title={act ? t(`${act}Title`) : ''}
        description={
          act === 'approve'
            ? t('approveBody', { count: bills.count, amount: formatLbp(bills.amount, locale), citizens: bills.citizens })
            : act
              ? t(`${act}Body`)
              : undefined
        }
        confirmLabel={act ? t(act) : ''}
        cancelLabel={t('keep')}
        busyLabel={t('busy')}
        confirmDisabled={act === 'return' ? !note?.success : act === 'discard' ? !reason?.success : false}
        onConfirm={confirm}
      >
        {act === 'return' || act === 'discard' ? (
          <Field label={t(act === 'return' ? 'note' : 'reason')} htmlFor="arrears-review-text" required>
            <Textarea id="arrears-review-text" value={text} maxLength={500} onChange={(event) => setText(event.target.value)} />
          </Field>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
