'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheck, FileQuestion, FileText, UserRound, Users } from 'lucide-react';
import { getLabels, seesAllStaffWork } from '@mechanization/shared-schemas';
import { getReviewQueue, type ReviewQueueItem } from '@/lib/api-client';
import { formatPhone } from '@/lib/phone';
import { CITIZEN_RECORD_EDIT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { WORKLIST_OWNER_PARAM, WorklistOwnerFilter } from '@/components/admin/worklist-owner-filter';

/** Whose work, in the URL — see `WorklistOwnerFilter`. */
const URL_STATE = { owner: WORKLIST_OWNER_PARAM };

/**
 * «يتطلب مراجعة» — the records filed with fields left «غير مؤكَّد», oldest
 * first, each one a «فحص الملف» away from being finished.
 *
 * Its own page and its own read (`GET /citizens/review-queue`) rather than the
 * register with a filter: the people working this queue finish records, so the
 * table is who the record is, how to reach them and how much is open — not
 * fees, arrears or identity documents, which the register carries and this
 * queue's payload does not.
 *
 * Every staff role reaches it, as they reach the register (`nav.ts`); the
 * server's `@Roles` on `review-queue` are the register's. «فحص الملف» is
 * narrower — it reads the record's form, which AUDITOR, ACCOUNTANT and VIEWER
 * are refused (`CITIZEN_RECORD_EDIT_ROLES`, CODE-4) — so those roles get the
 * citizen's file to read instead of a button that can only fail.
 *
 * Each officer's queue is their own; the roles that see everyone's work see
 * who filed each record, and may narrow to one officer or to the records whose
 * officer is gone (`WorklistOwnerFilter`).
 */
export default function ReviewQueuePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const t = useTranslations('reviewQueue');
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  /*
    `user` is null on the first paint, before the session is read. Taken as a
    reviewer until then, so the header and the subtitle do not flip from
    «الملف» to «فحص الملف» on every load for the roles this page is for. The
    first fetch waits for the token, which arrives with the role; only a
    cached page shown on a return visit can paint an auditor's rows with
    «فحص الملف» for that frame, and its page says the role cannot review.
  */
  const canReview = user ? hasRole(CITIZEN_RECORD_EDIT_ROLES, user.role) : true;
  const seesAll = user ? seesAllStaffWork(user.role) : true;

  // The page in the URL and the search in tab storage — a search here is a
  // citizen's name or number, which never goes in a URL (`tab-search.ts`).
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });
  /** The committed term — set on Enter, not as the clerk types. */
  const [search, setSearch] = useTabSearch(tenant, 'citizens-review');
  const [{ owner }, setUrl] = useUrlState(URL_STATE);
  const narrow = (next: string) => {
    setUrl({ owner: next });
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const query = useStaffQuery({
    queryKey: ['citizens', tenant, 'review-queue', search, owner, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getReviewQueue(
        tenant,
        accessToken,
        {
          search: search || undefined,
          owner: seesAll && owner ? owner : undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    keepPrevious: true,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const ownerName = owner ? (items.find((row) => row.filedById === owner)?.filedByName ?? null) : null;

  /*
    An empty queue is the good outcome, so it says so — not «لا يوجد مواطنون
    مسجّلون بعد», which would be false here.
  */
  const tableLabels = useTableLabels({
    searchPlaceholder: t('searchPlaceholder'),
    empty: t('empty'),
    emptyHint: t('emptyHint'),
  });

  const columns = useMemo<ColumnDef<ReviewQueueItem>[]>(
    () => [
      {
        id: 'citizen',
        header: t('columns.citizen'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate" title={row.original.fullName}>
                {row.original.fullName}
              </span>
            </p>
            {/* What tells two «محمد خليل»s apart (UX-4); omitted, not guessed, when never asked. */}
            {row.original.motherName ? (
              <p className="truncate ps-5 text-xs text-muted-foreground" title={row.original.motherName}>
                {t('mother', { name: row.original.motherName })}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'reference',
        header: t('columns.reference'),
        cell: ({ row }) =>
          row.original.referenceNumber ? (
            <CellTag className="font-mono" dir="ltr">
              {row.original.referenceNumber}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => {
          const open = row.original.openFieldCount;
          return (
            <CellTag tone="warning" className="tabular-nums" title={t('openFields', { count: open })}>
              <FileQuestion className="size-3.5 shrink-0" aria-hidden />
              {`${labels.citizenRecordStatus.REQUIRES_REVIEW} (${open})`}
            </CellTag>
          );
        },
      },
      {
        id: 'phone',
        header: t('columns.phone'),
        cell: ({ row }) =>
          row.original.phone ? (
            <a
              href={`tel:${row.original.phone}`}
              dir="ltr"
              className="whitespace-nowrap text-xs tabular-nums text-primary underline-offset-2 hover:underline"
            >
              {formatPhone(row.original.phone)}
            </a>
          ) : row.original.hasNoPhone ? (
            // An answer, not a gap — this file is not waiting for a number.
            <CellTag tone="muted">{t('noPhone')}</CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      ...(seesAll
        ? ([
            {
              id: 'filedBy',
              header: t('columns.filedBy'),
              cell: ({ row }) =>
                row.original.filedByName && row.original.filedById ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-sm"
                    onClick={() => narrow(row.original.filedById!)}
                    aria-label={t('narrowTo', { name: row.original.filedByName })}
                  >
                    {row.original.filedByName}
                  </Button>
                ) : (
                  <CellTag tone="muted">—</CellTag>
                ),
            },
          ] satisfies ColumnDef<ReviewQueueItem>[])
        : []),
      {
        id: 'review',
        header: canReview ? t('columns.review') : t('columns.file'),
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) =>
          canReview ? (
            <Link
              href={`${base}/citizens/review/${row.original.id}`}
              aria-label={t('reviewFileOf', { name: row.original.fullName })}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}
            >
              <ClipboardCheck className="size-3.5" aria-hidden />
              {t('reviewFile')}
            </Link>
          ) : (
            // Read-only: the citizen's file, which every staff role may open.
            <Link
              href={`${base}/citizens/${row.original.id}`}
              aria-label={t('openFileOf', { name: row.original.fullName })}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}
            >
              <FileText className="size-3.5" aria-hidden />
              {t('openFile')}
            </Link>
          ),
      },
    ],
    // `narrow` closes over setters that never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, base, labels, canReview, seesAll],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={FileQuestion}
        title={t('title')}
        subtitle={t('subtitle', { scope: seesAll ? 'all' : 'mine', review: canReview ? 'yes' : 'no' })}
        actions={
          <Link href={`${base}/citizens`} className={buttonVariants({ variant: 'outline' })}>
            <Users className="size-4" aria-hidden />
            {t('wholeRegister')}
          </Link>
        }
      />

      {seesAll ? <WorklistOwnerFilter value={owner} onChange={narrow} ownerName={ownerName} /> : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <FileQuestion className="size-5 text-warning" aria-hidden />
            {t('waiting')}
            {query.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({total})</span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* One frame: the card's (BAN-4), as `buildings/page.tsx` does. */}
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<ClipboardCheck className="size-10 text-muted-foreground/60" />}
            manualPagination
            manualFiltering
            sortable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            searchValue={search}
            onSearchChange={setSearch}
          />
        </CardContent>
      </Card>
    </div>
  );
}
