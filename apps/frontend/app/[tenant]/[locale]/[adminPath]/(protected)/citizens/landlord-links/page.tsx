'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { HelpCircle, Link2, RefreshCw, UserRound, Wallet } from 'lucide-react';
import { getLandlordLinks, getLandlordLinkSummary, type LandlordProposal } from '@/lib/api-client';
import { landlordLinkStatus, landlordLinkStatusView } from '@/lib/landlord-status';
import { formatPhone } from '@/lib/phone';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';

/** The roles `GET landlord-links/summary` answers — asking as anyone else is a 403. */
const SUMMARY_ROLES = new Set(['SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER']);

/**
 * «روابط المالكين» — tenancy cards whose named owner is a registered citizen,
 * waiting for somebody to say which citizen.
 *
 * ## Why a queue exists when the form already asks
 *
 * The form asks the officer who is *there*. Two cases escape it, and they are
 * the common ones: the owner registers months after the tenant (when the tenant
 * was filed there was nobody to match), and an officer who did not know
 * answered «لاحقاً». Nothing is stored as a proposal — every row is the match
 * computed on this read — so a row appears the moment an owner registers on
 * the number and leaves the moment somebody answers it.
 *
 * ## Layout
 *
 * A table, as «يتطلب مراجعة» is (UX-1): who the owner is said to be, the
 * property, where the claim stands, the number — and «فحص الرابط» to the claim's
 * own page, where the question is answered. The question itself (which of these
 * people is the owner) wants room the row does not have, so it is not asked in
 * the row.
 */
export default function LandlordLinksPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const en = locale === 'en';
  const { token, user } = useStaffSession(tenant, base);

  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const query = useStaffQuery({
    queryKey: ['landlord-links', tenant, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getLandlordLinks(
        tenant,
        accessToken,
        { limit: pagination.pageSize, offset: pagination.pageIndex * pagination.pageSize },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: en ? 'Failed to load owner links.' : 'تعذّر تحميل روابط المالكين.',
  });

  const canSeeSummary = Boolean(user?.role && SUMMARY_ROLES.has(user.role));
  const summary = useStaffQuery({
    queryKey: ['landlord-links-summary', tenant],
    queryFn: (accessToken) => getLandlordLinkSummary(tenant, accessToken),
    tenant,
    base,
    token: canSeeSummary ? token : null,
    errorMessage: en ? 'Failed to load the summary.' : 'تعذّر تحميل الملخّص.',
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const tableLabels = useTableLabels(
    en
      ? {
          empty: 'Nothing waiting',
          emptyHint:
            'No tenant card names a number that belongs to a registered citizen. New matches appear here as owners are registered.',
        }
      : {
          empty: 'لا شيء بانتظار القرار',
          emptyHint:
            'لا توجد بطاقة مستأجر تذكر رقماً يعود لمواطن مسجَّل. تظهر المطابقات الجديدة هنا كلما سُجِّل مالك.',
        },
  );

  const columns = useMemo<ColumnDef<LandlordProposal>[]>(
    () => [
      {
        id: 'landlord',
        header: en ? 'Owner / landlord' : 'المالك / المؤجر',
        meta: { mobile: 'primary' },
        cell: ({ row }) => {
          const proposal = row.original;
          const typed = proposal.landlordName?.trim() || (en ? 'No name given' : 'بلا اسم');
          return (
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate" title={typed}>
                  {typed}
                </span>
              </p>
              {/* Who named them — the claim is the tenant's word, so the tenant is part of it. */}
              {proposal.filedBy ? (
                <p className="truncate ps-5 text-xs text-muted-foreground" title={proposal.filedBy.name}>
                  {en ? `Named by ${proposal.filedBy.name}` : `ذكره ${proposal.filedBy.name}`}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'reference',
        header: en ? 'Reference no.' : 'الرقم المرجعي',
        cell: ({ row }) => {
          const reference = row.original.buildingCode ?? row.original.propertyNumber;
          return reference ? (
            <CellTag className="font-mono" dir="ltr" title={row.original.buildingName ?? undefined}>
              {reference}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          );
        },
      },
      {
        id: 'status',
        header: en ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const view = landlordLinkStatusView(landlordLinkStatus(row.original), locale);
          const Icon = view.icon;
          return (
            <CellTag tone={view.tone} title={row.original.blocked?.message}>
              <Icon className="size-3.5 shrink-0" aria-hidden />
              {view.label}
            </CellTag>
          );
        },
      },
      {
        id: 'phone',
        header: en ? 'Phone' : 'الهاتف',
        cell: ({ row }) =>
          row.original.landlordPhone ? (
            <a
              href={`tel:${row.original.landlordPhone}`}
              dir="ltr"
              className="whitespace-nowrap text-xs tabular-nums text-primary underline-offset-2 hover:underline"
            >
              {formatPhone(row.original.landlordPhone)}
            </a>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      {
        id: 'inspect',
        header: en ? 'Check link' : 'فحص الرابط',
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const typed = row.original.landlordName?.trim() || (en ? 'this owner' : 'هذا المالك');
          return (
            <Link
              href={`${base}/citizens/landlord-links/${row.original.propertyEntryId}`}
              aria-label={en ? `Check the link to ${typed}` : `فحص رابط ${typed}`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}
            >
              <Link2 className="size-3.5" aria-hidden />
              {en ? 'Check link' : 'فحص الرابط'}
            </Link>
          );
        },
      },
    ],
    [en, base, locale],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Link2}
        title={en ? 'Owner links' : 'روابط المالكين'}
        subtitle={
          en
            ? 'Tenants named an owner who is a registered citizen. Check each link and say who the owner is, and the property goes onto their file and bill.'
            : 'مستأجرون ذكروا مالكاً هو مواطن مسجَّل. افحص كل رابط وحدِّد من هو المالك ليُضاف العقار إلى ملفه ويدخل في فواتيره.'
        }
        actions={
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.fetching} className="h-10">
            <RefreshCw
              className={cn('size-4', query.fetching && 'animate-spin motion-reduce:animate-none')}
              aria-hidden
            />
            {en ? 'Refresh' : 'تحديث'}
          </Button>
        }
      />

      <details className="group rounded-lg border bg-card px-4 py-3 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
          <HelpCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {en ? 'How does the register find these?' : 'كيف يعرف النظام بهذه الروابط؟'}
        </summary>
        <ol className="mt-3 list-decimal space-y-1.5 ps-5 leading-relaxed text-muted-foreground">
          <li>
            {en
              ? 'Every tenant card records the owner’s name and phone as the tenant gave them.'
              : 'كل بطاقة مستأجر تحفظ اسم المالك ورقم هاتفه كما ذكرهما المستأجر.'}
          </li>
          <li>
            {en
              ? 'Whenever an owner is registered — before or after the tenant — the register compares that phone with the citizen’s phone and WhatsApp, and the name with the citizen’s name. Nothing is linked automatically.'
              : 'عند تسجيل أي مالك — قبل المستأجر أو بعده — يقارن النظام ذلك الرقم برقم المواطن وواتسابه، والاسم باسمه. لا يُربط شيء تلقائياً.'}
          </li>
          <li>
            {en
              ? 'You choose the owner. The property is added to their file and bill, and the owner field on the tenant’s card locks to their registered name.'
              : 'أنت تختار المالك. يُضاف العقار إلى ملفه وفواتيره، وتُقفل خانة المالك في بطاقة المستأجر على اسمه المسجَّل.'}
          </li>
          <li>
            {en
              ? 'A link can be undone from either file. Undoing removes exactly what the link added, and keeps anything somebody has edited since.'
              : 'يمكن إلغاء الربط من ملف المستأجر أو المالك. الإلغاء يزيل ما أضافه الربط فقط، ويُبقي ما عدّله أحد بعده.'}
          </li>
        </ol>
      </details>

      {/*
        What the register knows and does not bill — context for the work, one
        line, not a banner competing with the queue for the top of the page.
      */}
      {summary.data && summary.data.units > 0 ? (
        <details className="rounded-lg border bg-card px-4 py-3 text-sm">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
            <Wallet className="size-4 shrink-0 text-warning" aria-hidden />
            <span>
              {en ? (
                <>
                  <span className="font-semibold tabular-nums">{summary.data.units}</span> owned unit(s) across{' '}
                  <span className="font-semibold tabular-nums">{summary.data.owners}</span> owner(s) are on no bill
                </>
              ) : (
                <>
                  <span className="font-semibold tabular-nums">{summary.data.units}</span> وحدة مملوكة لدى{' '}
                  <span className="font-semibold tabular-nums">{summary.data.owners}</span> مالك لا تدخل في أي فاتورة
                </>
              )}
            </span>
            <span className="text-xs font-medium text-primary">{en ? 'Why?' : 'لماذا؟'}</span>
          </summary>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            {en
              ? 'Their owner is recorded on the unit in the buildings register but has no ownership card for that building on their own file, and owner-borne fees are charged from those cards. Linking the tenants’ cards below adds them.'
              : 'مالكوها مسجَّلون على الوحدة في سجل المباني لكن لا بطاقة «مالك» لذلك المبنى في ملفاتهم، والرسوم التي يتحمّلها المالك تُحتسب من تلك البطاقات. ربط بطاقات المستأجرين أدناه يضيفها.'}
          </p>
        </details>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Link2 className="size-5 text-primary" aria-hidden />
            {en ? 'Waiting for a decision' : 'بانتظار القرار'}
            {query.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({total})</span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* One frame: the card's (BAN-4). */}
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.propertyEntryId}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<Link2 className="size-10 text-muted-foreground/60" />}
            manualPagination
            manualFiltering
            sortable={false}
            searchable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
          />
        </CardContent>
      </Card>
    </div>
  );
}
