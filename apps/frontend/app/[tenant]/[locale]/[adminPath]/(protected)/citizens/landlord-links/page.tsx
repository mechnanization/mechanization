'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { CircleSlash, HelpCircle, Link2, RefreshCw, UserRound, Wallet } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getLandlordLinks, getLandlordLinkSummary, type LandlordProposal } from '@/lib/api-client';
import {
  bestCandidate,
  filedBeforeOwner,
  landlordLinkStatus,
  nameLight,
  phoneLight,
  type MatchLight,
} from '@/lib/landlord-status';
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

/**
 * One match light: a dot in the light's colour and its word beside it —
 * never the colour alone (COL-3).
 */
function Light({ label, light }: { label: string; light: MatchLight }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          light.tone === 'success' && 'bg-success',
          light.tone === 'warning' && 'bg-warning',
          light.tone === 'destructive' && 'bg-destructive',
          light.tone === 'muted' && 'bg-muted-foreground/50',
        )}
      />
      <span
        className={cn(
          'font-medium',
          light.tone === 'success' && 'text-success',
          light.tone === 'warning' && 'text-warning',
          light.tone === 'destructive' && 'text-destructive',
          light.tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {light.label}
      </span>
    </span>
  );
}

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
 * A table, as «يتطلب مراجعة» is (UX-1): the occupant (tenant or free
 * occupant), who they said the owner is and on what number, the property,
 * the registered person it most likely is with a light for the name and one
 * for the phone — and «فحص الرابط» to the claim's own page, where the
 * question is answered. The question itself (which of these
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

  const occupancyLabels = getLabels(locale).occupancyType as Record<string, string>;
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const tableLabels = useTableLabels(
    en
      ? {
          empty: 'Nothing waiting',
          emptyHint:
            'No occupant’s card names an owner who is a registered citizen. New matches appear here as owners are registered.',
        }
      : {
          empty: 'لا شيء بانتظار القرار',
          emptyHint:
            'لا توجد بطاقة ساكن تذكر مالكاً هو مواطن مسجَّل. تظهر المطابقات الجديدة هنا كلما سُجِّل مالك.',
        },
  );

  const columns = useMemo<ColumnDef<LandlordProposal>[]>(
    () => [
      {
        id: 'occupant',
        header: en ? 'Occupant' : 'الساكن',
        meta: { mobile: 'primary' },
        cell: ({ row }) => {
          const proposal = row.original;
          const name = proposal.filedBy?.name ?? (en ? 'Unknown' : 'غير معروف');
          const standing = occupancyLabels[proposal.occupancyType] ?? proposal.occupancyType;
          return (
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate" title={name}>
                  {name}
                </span>
              </p>
              {/* Tenant or free occupant — the queue is every resident who is not the owner. */}
              <p className="truncate ps-5 text-xs text-muted-foreground">{standing}</p>
            </div>
          );
        },
      },
      {
        id: 'claim',
        header: en ? 'Said the owner is' : 'ذكر أن المالك',
        cell: ({ row }) => {
          const proposal = row.original;
          const typed = proposal.landlordName?.trim();
          return (
            <div className="min-w-0 space-y-0.5">
              <p className={cn('truncate text-sm', typed ? 'font-medium' : 'text-muted-foreground')} title={typed}>
                {typed || (en ? 'No name given' : 'لم يذكر اسماً')}
              </p>
              {proposal.landlordPhone ? (
                <p dir="ltr" className="text-xs tabular-nums text-muted-foreground rtl:text-end">
                  {formatPhone(proposal.landlordPhone)}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{en ? 'No phone given' : 'لم يذكر رقماً'}</p>
              )}
            </div>
          );
        },
      },
      {
        id: 'property',
        header: en ? 'Property no.' : 'رقم العقار',
        cell: ({ row }) => {
          const proposal = row.original;
          const reference = proposal.buildingCode ?? proposal.propertyNumber;
          const blocked = landlordLinkStatus(proposal) === 'BLOCKED';
          return (
            <div className="min-w-0 space-y-0.5">
              {reference ? (
                <CellTag className="font-mono" dir="ltr" title={proposal.buildingName ?? undefined}>
                  {reference}
                </CellTag>
              ) : (
                <CellTag tone="muted">—</CellTag>
              )}
              {/* A link that cannot be made yet stays visible without a status column of its own. */}
              {blocked ? (
                <p
                  className="flex items-center gap-1 text-xs text-warning"
                  title={proposal.blocked?.message ?? proposal.candidates.find((c) => c.blocked)?.blocked?.message}
                >
                  <CircleSlash className="size-3 shrink-0" aria-hidden />
                  {en ? 'Cannot link yet' : 'لا يمكن الربط بعد'}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'match',
        header: en ? 'Registered owner · match' : 'المالك المسجَّل والتطابق',
        cell: ({ row }) => {
          const proposal = row.original;
          const candidate = bestCandidate(proposal);
          if (!candidate) return <CellTag tone="muted">—</CellTag>;
          const others = proposal.candidates.length - 1;
          return (
            <div className="min-w-0 space-y-1">
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm font-medium">
                <span className="truncate" title={candidate.name}>
                  {candidate.name}
                </span>
                {others > 0 ? (
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {en ? `+${others} more` : `+${others} آخر`}
                  </span>
                ) : null}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Light label={en ? 'Name' : 'الاسم'} light={nameLight(proposal, candidate, locale)} />
                <Light label={en ? 'Phone' : 'الهاتف'} light={phoneLight(proposal, candidate, locale)} />
              </div>
              {/* The case this queue is for: the occupant came first, the owner registered since. */}
              {filedBeforeOwner(proposal, candidate) ? (
                <p className="text-xs text-muted-foreground">
                  {en ? 'Occupant registered before the owner' : 'سُجِّل الساكن قبل المالك'}
                </p>
              ) : null}
            </div>
          );
        },
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
    [en, base, locale, occupancyLabels],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Link2}
        title={en ? 'Owner links' : 'روابط المالكين'}
        subtitle={
          en
            ? 'Tenants and free occupants named an owner who is now a registered citizen — usually because they were registered before the owner. Check each link and say who the owner is, and the property goes onto their file and bill.'
            : 'مستأجرون وشاغلون بتسامح ذكروا مالكاً أصبح مواطناً مسجَّلاً — غالباً لأنهم سُجِّلوا قبله. افحص كل رابط وحدِّد من هو المالك ليُضاف العقار إلى ملفه ويدخل في فواتيره.'
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
              ? 'Every tenant or free occupant’s card records the owner’s name and phone as the occupant gave them — even when the owner is not registered yet.'
              : 'كل بطاقة مستأجر أو شاغل بتسامح تحفظ اسم المالك ورقم هاتفه كما ذكرهما الساكن — حتى لو لم يكن المالك مسجَّلاً بعد.'}
          </li>
          <li>
            {en
              ? 'When the owner is registered later, the register compares that phone with the citizen’s phone and WhatsApp, and the name with the citizen’s name — the lights in the table. Nothing is linked automatically.'
              : 'عندما يُسجَّل المالك لاحقاً، يقارن النظام ذلك الرقم برقم المواطن وواتسابه، والاسم باسمه — وهي الأضواء في الجدول. لا يُربط شيء تلقائياً.'}
          </li>
          <li>
            {en
              ? 'You choose the owner. The property is added to their file and bill, and the owner field on the occupant’s card locks to their registered name.'
              : 'أنت تختار المالك. يُضاف العقار إلى ملفه وفواتيره، وتُقفل خانة المالك في بطاقة الساكن على اسمه المسجَّل.'}
          </li>
          <li>
            {en
              ? 'A link can be undone from either file. Undoing removes exactly what the link added, and keeps anything somebody has edited since.'
              : 'يمكن إلغاء الربط من ملف الساكن أو المالك. الإلغاء يزيل ما أضافه الربط فقط، ويُبقي ما عدّله أحد بعده.'}
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
