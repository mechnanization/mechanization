'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheck, FileQuestion, UserRound, Users } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getReviewQueue, type ReviewQueueItem } from '@/lib/api-client';
import { formatPhone } from '@/lib/phone';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';

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
 * server's `@Roles` on `review-queue` are the register's.
 */
export default function ReviewQueuePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const { token } = useStaffSession(tenant, base);

  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  /** The committed term — set on Enter, not as the clerk types. */
  const [search, setSearch] = useState('');

  const query = useStaffQuery({
    queryKey: ['citizens', 'review-queue', tenant, search, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getReviewQueue(
        tenant,
        accessToken,
        {
          search: search || undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the review queue.' : 'تعذّر تحميل قائمة المراجعة.',
    keepPrevious: true,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  /*
    An empty queue is the good outcome, so it says so — not «لا يوجد مواطنون
    مسجّلون بعد», which would be false here.
  */
  const tableLabels = useTableLabels(
    en
      ? {
          searchPlaceholder: 'Search by name, reference or phone',
          empty: 'No records are waiting for review.',
          emptyHint: 'A record saved with fields left to confirm appears here.',
        }
      : {
          searchPlaceholder: 'ابحث بالاسم أو الرقم المرجعي أو الهاتف',
          empty: 'لا سجلات بانتظار المراجعة.',
          emptyHint: 'يظهر هنا كل سجل يُحفظ بحقول لم تُؤكَّد بعد.',
        },
  );

  const columns = useMemo<ColumnDef<ReviewQueueItem>[]>(
    () => [
      {
        id: 'citizen',
        header: en ? 'Citizen' : 'المواطن',
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
                {en ? `Mother: ${row.original.motherName}` : `الأم: ${row.original.motherName}`}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'reference',
        header: en ? 'Reference no.' : 'الرقم المرجعي',
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
        header: en ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const open = row.original.openFieldCount;
          return (
            <CellTag
              tone="warning"
              className="tabular-nums"
              title={
                en
                  ? `${open} field(s) left unconfirmed`
                  : `عدد الحقول غير المؤكَّدة: ${open}`
              }
            >
              <FileQuestion className="size-3.5 shrink-0" aria-hidden />
              {`${labels.citizenRecordStatus.REQUIRES_REVIEW} (${open})`}
            </CellTag>
          );
        },
      },
      {
        id: 'phone',
        header: en ? 'Phone' : 'الهاتف',
        cell: ({ row }) =>
          row.original.phone ? (
            <a
              href={`tel:${row.original.phone}`}
              dir="ltr"
              className="whitespace-nowrap text-xs tabular-nums text-primary underline-offset-2 hover:underline"
            >
              {formatPhone(row.original.phone)}
            </a>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      {
        id: 'review',
        header: en ? 'Review file' : 'فحص الملف',
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => (
          <Link
            href={`${base}/citizens/review/${row.original.id}`}
            aria-label={en ? `Review ${row.original.fullName}'s file` : `فحص ملف ${row.original.fullName}`}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}
          >
            <ClipboardCheck className="size-3.5" aria-hidden />
            {en ? 'Review file' : 'فحص الملف'}
          </Link>
        ),
      },
    ],
    [en, base, labels],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={FileQuestion}
        title={en ? 'Requires review' : 'يتطلب مراجعة'}
        subtitle={
          en
            ? 'Records filed with fields the officer could not establish, oldest first. Review a file to complete it.'
            : 'سجلات حُفظت بحقول لم يتمكّن الموظف من التثبّت منها، الأقدم أولاً. افحص الملف لاستكماله.'
        }
        actions={
          <Link href={`${base}/citizens`} className={buttonVariants({ variant: 'outline' })}>
            <Users className="size-4" aria-hidden />
            {en ? 'Whole register' : 'سجل المواطنين كاملاً'}
          </Link>
        }
      />

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <FileQuestion className="size-5 text-warning" aria-hidden />
            {en ? 'Waiting for review' : 'بانتظار المراجعة'}
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
