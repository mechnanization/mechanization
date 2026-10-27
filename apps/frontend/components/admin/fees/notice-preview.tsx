'use client';

import { useEffect, useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { getLabels, UNIT_STATUS, unitLevelsLabel } from '@mechanization/shared-schemas';
import type { FeeMatrixBracket, FeeNoticePreviewInput, FeeNoticePreviewResult } from '@mechanization/shared-schemas';
import { FormSection } from '@/components/admin/fees/form-section';
import { typesSummary } from '@/components/admin/fees/tiered-matrix-editor';
import { useUnassessableWords } from '@/components/admin/fees/unassessable-words';
import { Alert } from '@/components/ui/alert';
import { DataTable } from '@/components/ui/data-table';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Money } from '@/components/ui/money';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { previewFeeNotice } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTableLabels } from '@/lib/use-table-labels';

type Conflict = FeeNoticePreviewResult['conflicts'][number];
type Unassessable = FeeNoticePreviewResult['unassessable'][number];

/** A town-wide notice can name a thousand people: the lists page, never run on. */
const PAGE_SIZES = [15, 25, 50] as const;

const count = (value: number) => value.toLocaleString('en-US');

/**
 * «معاينة قبل الإصدار» — what issuing this notice now would bill, read by the
 * path the issue takes (`POST fees/notices/preview`) and written nowhere.
 *
 * Read afresh each time the review step mounts (`fresh`), never from a cached
 * answer, and reported to the wizard as no answer while a re-read is out: the
 * figure confirmed is the register's now, not when the step was last open.
 * «إصدار» waits for it (`onResult`).
 *
 * The answer is drawn by the review in three places (`NoticeReview`): its
 * figures pinned at the top (`PreviewFigures`), each bracket's count and
 * subtotal beside its definition (`PreviewBrackets`), and what goes unbilled
 * as rows of their own (`PreviewFindings`). The answer counts the people on a
 * conflict and names none (open question O2), and lists nobody it would bill,
 * so there is no per-citizen table: what the preview does not send, it cannot
 * show.
 */
export function useNoticePreview({
  tenant,
  base,
  token,
  input,
  onResult,
}: {
  tenant: string;
  base: string;
  token: string | null;
  input: FeeNoticePreviewInput;
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
    fresh: true,
  });

  const result = preview.data ?? null;
  const settled = preview.error || preview.fetching ? null : result;
  useEffect(() => {
    onResult(settled);
  }, [settled, onResult]);

  return { result, error: preview.error, refetch: preview.refetch };
}

export type NoticePreviewState = ReturnType<typeof useNoticePreview>;

/**
 * The figures the notice raises — citizens billed, shared unit bills, the
 * money — pinned to the top of the page's scroll from `sm` up while the rows
 * below are read, so the figure being confirmed stays in view. A fragment: the
 * strip sticks within the review that holds it, so it is the review's own
 * child, bled to the card's edges over its padding, on the card's surface.
 * Below `sm` the strip is two rows, a quarter of the screen held still, and
 * scrolls with the rest.
 */
export function PreviewFigures({ state, locale }: { state: NoticePreviewState; locale: string }) {
  const t = useTranslations('fees.preview');
  const { result, error, refetch } = state;

  /*
    One line for a screen reader, in place of a live region over the whole
    review, which read every row aloud on each answer. Mounted across loading
    and answer, so the change is what gets announced.
  */
  const status = (
    <p role="status" className="sr-only">
      {result
        ? t('announce', { billed: result.billedCitizens, shared: result.sharedBills })
        : error
          ? t('failed')
          : t('loading')}
    </p>
  );

  if (error) {
    return (
      <>
        {status}
        <ErrorState compact title={t('failed')} onRetry={refetch} retryLabel={t('retry')} />
      </>
    );
  }
  if (!result) {
    return (
      <>
        {status}
        <LoadingState compact label={t('loading')} />
      </>
    );
  }
  return (
    <>
      {status}
      {result.targetedCitizens === 0 ? <Alert variant="warning">{t('nobody')}</Alert> : null}
      {/* Over the lists' own sticky headers (`DataTable`'s is `z-10`), which pass under it rather than across the figures. */}
      <div className="-mx-4 bg-card px-4 sm:sticky sm:top-0 sm:z-20 sm:-mx-6 sm:border-b sm:px-6 sm:py-2">
        <StatStrip>
          <StatItem value={count(result.billedCitizens)} label={t('billedCitizens')} />
          {result.sharedBills > 0 ? <StatItem value={count(result.sharedBills)} label={t('sharedBills')} /> : null}
          <StatItem value={<Money amount={result.expectedRevenue} locale={locale} wrap />} label={t('revenue')} />
        </StatStrip>
      </div>
    </>
  );
}

/**
 * «جدول الفئات» read back as one table: each bracket as the clerk set it — its
 * units, its range with both ends included, its fee — beside what the preview
 * counts under it, the units and their subtotal. The counts read «—» while the
 * preview is out or has failed: the definitions stand without them.
 */
export function PreviewBrackets({
  brackets,
  counts,
  locale,
  action,
}: {
  /** The table as sent (`toMatrix`): an extension's types are the dwellings among its base's. */
  brackets: readonly FeeMatrixBracket[];
  counts: FeeNoticePreviewResult['brackets'] | null;
  locale: string;
  action?: React.ReactNode;
}) {
  const t = useTranslations('fees.issueForm.review');
  const tMatrix = useTranslations('fees.matrix');
  const tPreview = useTranslations('fees.preview');
  const byCode = new Map((counts ?? []).map((row) => [row.code, row]));
  const missing = <span className="text-muted-foreground">—</span>;

  return (
    <FormSection title={t('brackets')} action={action}>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>{t('bracket')}</TableHead>
              <TableHead>{t('units')}</TableHead>
              <TableHead>{t('area')}</TableHead>
              <TableHead className="text-end">{t('fee')}</TableHead>
              <TableHead className="text-end">{tPreview('unitCount')}</TableHead>
              <TableHead className="text-end">{tPreview('subtotal')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {brackets.map((bracket, index) => {
              const counted = byCode.get(bracket.code);
              return (
                <TableRow key={`${bracket.code}-${index}`}>
                  <TableCell>
                    <span className="font-mono font-medium">{bracket.code}</span>
                    <span className="text-muted-foreground"> — {bracket.labelAr}</span>
                  </TableCell>
                  <TableCell>
                    {t('unitsLine', {
                      types: typesSummary(bracket.unitTypes, locale, tMatrix),
                      levels: unitLevelsLabel(bracket.levels, locale) ?? tMatrix('oneLevel'),
                    })}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {bracket.maxArea === null
                      ? t('rangeOpen', { min: count(bracket.minArea) })
                      : t('rangeBounded', {
                          min: count(bracket.minArea),
                          // Read back as typed, both ends included: the sent ceiling is the metre after (`toMatrix`).
                          max: count(bracket.maxArea - 1),
                        })}
                  </TableCell>
                  <TableCell className="text-end">
                    <Money amount={bracket.amount} locale={locale} exact />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {counted ? count(counted.unitCount) : missing}
                  </TableCell>
                  <TableCell className="text-end">
                    {counted ? <Money amount={counted.subtotal} locale={locale} /> : missing}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </FormSection>
  );
}

/**
 * What the notice leaves unbilled, a row each, and only those that have any:
 * the units it does not charge, by reason; the shared units its brackets
 * cannot agree on; the citizens it cannot assess, by name. The two lists grow
 * with the town, so they are searched and paged (`DataTable`, PRIM-3) rather
 * than drawn whole.
 */
export function PreviewFindings({ result, locale }: { result: FeeNoticePreviewResult; locale: string }) {
  const t = useTranslations('fees.preview');
  const unitStatus = getLabels(locale).unitStatus;
  const notCharged = [
    // «من يشمل الإشعار» (0100) first, by state — «شاغرة: 12» — in the order the scope step asks them.
    ...UNIT_STATUS.map((state) => ({
      key: `state-${state}`,
      label: t('notCharged.outOfScope', { state: unitStatus[state] }),
      count: result.notCharged.outOfScopeByState[state] ?? 0,
    })),
    { key: 'residence', label: t('notCharged.residenceLeftOut'), count: result.notCharged.residenceLeftOut },
    { key: 'excluded', label: t('notCharged.excluded'), count: result.notCharged.excludedUnits },
    { key: 'held', label: t('notCharged.held'), count: result.notCharged.heldUnits },
    { key: 'uninhabitable', label: t('notCharged.uninhabitable'), count: result.notCharged.uninhabitableUnits },
    { key: 'feeExempt', label: t('notCharged.feeExempt'), count: result.notCharged.feeExemptUnits },
    { key: 'coOwnerPaid', label: t('notCharged.coOwnerPaid'), count: result.notCharged.coOwnerPaidUnits },
  ].filter((entry) => entry.count > 0);

  return (
    <>
      {notCharged.length > 0 ? (
        <FormSection title={t('notChargedTitle')}>
          <FactRow>
            {notCharged.map((entry) => (
              <FactCell key={entry.key} label={entry.label} value={count(entry.count)} />
            ))}
          </FactRow>
        </FormSection>
      ) : null}

      {result.conflicts.length > 0 ? (
        <FormSection title={t('conflictTable.title', { count: result.conflicts.length })}>
          <Alert variant="warning">{t('conflictTable.why')}</Alert>
          <ConflictList rows={result.conflicts} />
        </FormSection>
      ) : null}

      {result.unassessable.length > 0 ? (
        <FormSection title={t('unassessable', { count: result.unassessable.length })}>
          <UnassessableList rows={result.unassessable} locale={locale} />
        </FormSection>
      ) : null}
    </>
  );
}

/**
 * Shared units billed to nobody because their people's records put them in
 * different brackets (`splitSharedUnitBills`): by unit and parcel, searchable
 * by either and by bracket code.
 */
function ConflictList({ rows }: { rows: readonly Conflict[] }) {
  const t = useTranslations('fees.preview');
  const labels = useTableLabels({
    searchAriaLabel: t('conflictTable.search'),
    searchPlaceholder: t('conflictTable.search'),
    emptySearch: t('conflictTable.emptySearch'),
  });
  const columns = useMemo<ColumnDef<Conflict>[]>(
    () => [
      {
        id: 'unit',
        header: t('conflictTable.unit'),
        accessorFn: (row) => row.unitCode ?? '',
        cell: ({ row }) => (
          <span dir="ltr" className="font-mono">
            {row.original.unitCode ?? '—'}
          </span>
        ),
        meta: { mobile: 'primary' },
      },
      {
        id: 'parcel',
        header: t('conflictTable.parcel'),
        accessorFn: (row) => row.propertyNumber ?? '',
        cell: ({ row }) => (
          <span dir="ltr" className="font-mono">
            {row.original.propertyNumber ?? '—'}
          </span>
        ),
      },
      {
        id: 'brackets',
        header: t('conflictTable.brackets'),
        accessorFn: (row) => row.bracketCodes.join(t('separator')),
        cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span>,
      },
      {
        id: 'registered',
        header: t('conflictTable.registered'),
        accessorFn: (row) => row.citizenCount,
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.citizenCount)}</span>,
        meta: { align: 'end' },
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={rows as Conflict[]}
      labels={labels}
      getRowId={(row) => row.unitId}
      pageSizeOptions={PAGE_SIZES}
      sortable={false}
    />
  );
}

/**
 * The citizens the issue would skip: who, the unit that stopped them with its
 * type, area and levels, and why, with what to do about it
 * (`useUnassessableWords`). Searchable by any of it.
 */
function UnassessableList({ rows, locale }: { rows: readonly Unassessable[]; locale: string }) {
  const t = useTranslations('fees.preview');
  const words = useUnassessableWords(locale);
  const labels = useTableLabels({
    searchAriaLabel: t('unassessableTable.search'),
    searchPlaceholder: t('unassessableTable.search'),
    emptySearch: t('unassessableTable.emptySearch'),
  });
  const worded = useMemo(() => rows.map((row) => ({ ...row, words: words(row) })), [rows, words]);
  const columns = useMemo<ColumnDef<(typeof worded)[number]>[]>(
    () => [
      {
        id: 'name',
        header: t('unassessableTable.name'),
        accessorFn: (row) => row.name,
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
        meta: { mobile: 'primary' },
      },
      {
        id: 'unit',
        header: t('unassessableTable.unit'),
        accessorFn: (row) => [row.words.where, row.words.facts].filter(Boolean).join(' '),
        cell: ({ row }) =>
          row.original.words.where ? (
            <span className="block space-y-0.5">
              <span className="block">{row.original.words.where}</span>
              {row.original.words.facts ? (
                <span className="block text-xs text-muted-foreground">{row.original.words.facts}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'why',
        header: t('unassessableTable.why'),
        accessorFn: (row) => [row.words.why, row.words.fix].filter(Boolean).join(' '),
        cell: ({ row }) => (
          <span className="block max-w-md space-y-0.5">
            <span className="block">{row.original.words.why}</span>
            {row.original.words.fix ? (
              <span className="block text-xs text-muted-foreground">{row.original.words.fix}</span>
            ) : null}
          </span>
        ),
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={worded}
      labels={labels}
      getRowId={(row) => row.citizenId}
      pageSizeOptions={PAGE_SIZES}
      sortable={false}
    />
  );
}
