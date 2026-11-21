'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { getLabels, type ArrearsLineVerdict } from '@mechanization/shared-schemas';
import { DROP_REASON_MIN, lineKey, needsDecision, type LineDecision } from '@/lib/arrears';
import { formatDate } from '@/lib/dates';
import { useTableLabels } from '@/lib/use-table-labels';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { SegmentedControl } from '@/components/ui/segmented-control';

const STATUS_TONE = {
  KEEP: 'success',
  DROP: 'muted',
  UNMATCHED: 'warning',
  REFUSED: 'destructive',
} as const;

/**
 * The dry run's verdict on every line of the file (old-debts-plan §6), and,
 * on a flagged line, the accountant's keep or drop (`needsDecision`): a unit
 * read destroyed or not habitable (with the reading's date), a person not on
 * the register yet, an archived file. A drop needs its reason. A refused line
 * says why in words (`arrears.issue.*`) and is fixed in the file.
 */
export function ArrearsVerdicts({
  lines,
  locale,
  decisions,
  onDecide,
  disabled,
}: {
  lines: readonly ArrearsLineVerdict[];
  locale: string;
  decisions: ReadonlyMap<string, LineDecision>;
  onDecide: (key: string, decision: LineDecision | null) => void;
  disabled: boolean;
}) {
  const t = useTranslations('arrears.verdicts');
  const tIssue = useTranslations('arrears.issue');
  const labels = getLabels(locale);
  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<ArrearsLineVerdict>[]>(
    () => [
      {
        id: 'row',
        header: t('row'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.row.toLocaleString('en-US')}</span>,
      },
      {
        id: 'who',
        header: t('who'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{row.original.name ?? '—'}</p>
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{row.original.propertyNumber ?? '—'}</bdi>
              {row.original.unitCode ? (
                <>
                  {' · '}
                  <bdi dir="ltr">{row.original.unitCode}</bdi>
                </>
              ) : null}
            </p>
          </div>
        ),
      },
      {
        id: 'debt',
        header: t('debt'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => {
          const line = row.original;
          if (line.year === null) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="space-y-0.5">
              <p>
                {line.feeType ? labels.arrearsFeeType[line.feeType] : '—'} · <bdi dir="ltr">{line.year}</bdi>
              </p>
              {line.component ? (
                <p className="text-xs text-muted-foreground">{labels.arrearsComponent[line.component]}</p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'amount',
        header: t('amount'),
        meta: { align: 'end' as const },
        cell: ({ row }) =>
          row.original.amount === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Money amount={row.original.amount} currency="LBP" locale={locale} exact />
          ),
      },
      {
        id: 'verdict',
        header: t('verdict'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => {
          const line = row.original;
          const notes = [
            ...line.issues.map((issue) => tIssue(issue)),
            ...(line.flags.prescribed ? [t('prescribed')] : []),
            ...(line.flags.war
              ? [
                  t(line.flags.war.habitable === false ? 'warUninhabitable' : 'warDamaged', {
                    date: formatDate(line.flags.war.assessedAt),
                  }),
                ]
              : []),
            ...(line.flags.archived ? [t('archived')] : []),
            ...(line.flags.unitNotHeld ? [t('unitNotHeld')] : []),
            ...(line.dropReason && !line.flags.prescribed ? [t('droppedBecause', { reason: line.dropReason })] : []),
          ];
          return (
            <div className="space-y-1">
              <CellTag tone={STATUS_TONE[line.status]}>{t(`status.${line.status}`)}</CellTag>
              {notes.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
          );
        },
      },
      {
        id: 'decision',
        header: t('decision'),
        meta: { cellClassName: 'whitespace-normal min-w-56' },
        cell: ({ row }) => {
          const line = row.original;
          if (!needsDecision(line)) return null;
          const key = lineKey(line);
          const decision = decisions.get(key);
          const reason = decision?.choice === 'DROP' ? decision.reason : '';
          return (
            <div className="space-y-2">
              <SegmentedControl
                size="sm"
                aria-label={t('decisionFor', { row: line.row })}
                disabled={disabled}
                value={decision?.choice}
                onChange={(value) =>
                  onDecide(key, value === 'KEEP' ? { choice: 'KEEP' } : { choice: 'DROP', reason })
                }
                options={[
                  { value: 'KEEP', label: t('keep') },
                  { value: 'DROP', label: t('drop') },
                ]}
              />
              {decision?.choice === 'DROP' ? (
                <Input
                  aria-label={t('dropReason', { row: line.row })}
                  placeholder={t('dropReasonPlaceholder', { min: DROP_REASON_MIN })}
                  value={reason}
                  maxLength={500}
                  disabled={disabled}
                  onChange={(event) => onDecide(key, { choice: 'DROP', reason: event.target.value })}
                />
              ) : null}
            </div>
          );
        },
      },
    ],
    [t, tIssue, labels, locale, decisions, onDecide, disabled],
  );

  return (
    <DataTable
      columns={columns}
      data={[...lines]}
      labels={tableLabels}
      getRowId={(line) => lineKey(line)}
      searchable={false}
      sortable={false}
      loading={false}
      error={null}
    />
  );
}
