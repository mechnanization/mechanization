'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, CircleSlash, HelpCircle, Link2, RefreshCw, Search, UserRound, Wallet } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  confirmLandlordLink,
  getLandlordLinks,
  getLandlordLinkSummary,
  type LandlordProposal,
  type LandlordProposalCandidate,
} from '@/lib/api-client';
import {
  Consequences,
  landlordAnswerRolesNote,
  useLandlordResolutions,
} from '@/components/admin/landlord-proposal-card';
import { MatchLightLabel as Light } from '@/components/admin/match-light';
import {
  bestCandidate,
  filedBeforeOwner,
  landlordLinkStatus,
  nameLight,
  phoneLight,
  phoneLinkable,
} from '@/lib/landlord-status';
import { formatPhone } from '@/lib/phone';
import { hasRole, LANDLORD_LINK_ANSWER_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useUrlPagination } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ActionTooltip } from '@/components/ui/tooltip';

/**
 * Why «ربط» is not offered on a row, or null when it is. The row links only on
 * a matching phone number — the one certain match (`phoneLinkable`, the
 * status `READY`). A name, a property, or a shared line the name does not
 * settle is checked on «فحص».
 */
function quickLinkRefusal(proposal: LandlordProposal, en: boolean): string | null {
  switch (landlordLinkStatus(proposal)) {
    case 'READY':
      return null;
    case 'SEVERAL':
      return en ? 'Several people on this number — choose on «Check».' : 'عدة مرشحين على هذا الرقم — اختر في «فحص».';
    case 'NAME_ONLY':
      return en
        ? 'The number does not match — linking from here needs a matching number. Check on «Check».'
        : 'الرقم غير مطابق — الربط المباشر بالرقم المطابق فقط. تحقّق في «فحص».';
    case 'BY_PROPERTY':
      return en
        ? 'The occupant did not know the owner’s number — check on «Check».'
        : 'لم يعرف الساكن رقم المالك — تحقّق في «فحص».';
    case 'BLOCKED':
      return en ? 'No link can be made yet — see «Check».' : 'لا يمكن الربط بعد — راجع «فحص».';
  }
}

/** The roles `GET landlord-links/summary` answers — asking as anyone else is a 403. */
const SUMMARY_ROLES = new Set(['SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'VIEWER']);

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
 * for the phone, each in its own column — and two actions: «فحص», the
 * claim's own page, and «ربط», which links from the row after a confirmation,
 * offered only where there is nothing to choose (one person, found by the
 * number). Choosing between people wants room the row does not have, so that
 * stays on «فحص».
 *
 * Every staff role opens the queue; only `LANDLORD_LINK_ANSWER_ROLES` answer
 * it. The others get «فحص» alone — a read of the claim — and no «ربط».
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
  // Every staff role reads the queue; only these answer it (`POST …/confirm`).
  // The rest see «فحص» and no «ربط» — a button the server can only refuse.
  const canAnswer = hasRole(LANDLORD_LINK_ANSWER_ROLES, user?.role);

  // In the URL (`?page=` / `?limit=`), so a reload or Back from a citizen's
  // file returns to the same page of the queue.
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const queryClient = useQueryClient();
  const { resolve } = useLandlordResolutions({ tenant, token: token ?? '', locale });
  const [linking, setLinking] = useState<{ proposal: LandlordProposal; candidate: LandlordProposalCandidate } | null>(
    null,
  );

  /*
    «ربط» from the row: the same call «فحص» makes, after a confirmation that
    says who and what. The toast carries the undo; the row leaves the queue on
    the refetch.
  */
  /*
    One request per confirmation (STA-4). `ConfirmDialog` guards with `busy`
    state, so a second tap in the same frame still calls this. It gets the
    request already in flight rather than an early return: an early return
    reads to the dialog as success and closes it, and a refusal of the first
    request would then land in a dialog nobody can see.
  */
  const linkInFlight = useRef<Promise<void> | null>(null);
  const link = (): Promise<void> => {
    if (linkInFlight.current) return linkInFlight.current;
    if (!linking || !token) return Promise.resolve();
    const { proposal, candidate } = linking;
    const run = async () => {
      try {
        await confirmLandlordLink(tenant, token, proposal.propertyEntryId, candidate.id);
      } catch (caught) {
        throw new Error(
          caught instanceof ApiRequestError
            ? caught.payload.message
            : en
              ? 'The owner was not linked. Check the connection and try again.'
              : 'لم يتم ربط المالك. تحقّق من الاتصال وحاول مرة أخرى.',
        );
      }
      resolve({
        kind: 'linked',
        propertyEntryId: proposal.propertyEntryId,
        ownerName: candidate.name,
        candidateIds: [candidate.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['landlord-links'] });
      void queryClient.invalidateQueries({ queryKey: ['landlord-links-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['landlord-link', tenant, proposal.propertyEntryId] });
    };
    const pending = run().finally(() => {
      linkInFlight.current = null;
    });
    linkInFlight.current = pending;
    return pending;
  };

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
                {typed || (proposal.landlordPhone ? (en ? 'No name given' : 'لم يذكر اسماً') : en ? 'Does not know the owner' : 'لا يعرف المالك')}
              </p>
              {proposal.landlordPhone ? (
                <p dir="ltr" className="text-xs tabular-nums text-muted-foreground rtl:text-end">
                  {formatPhone(proposal.landlordPhone)}
                </p>
              ) : typed ? (
                <p className="text-xs text-muted-foreground">{en ? 'No phone given' : 'لم يذكر رقماً'}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{en ? 'No name or phone' : 'لا اسم ولا رقم'}</p>
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
        header: en ? 'Registered owner' : 'المالك المسجَّل',
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
              {candidate.matchedBy === 'PROPERTY' ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Building2 className="size-3 shrink-0" aria-hidden />
                  {en ? 'Registered owner of this property' : 'مالك مسجَّل لهذا العقار'}
                </p>
              ) : null}
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
        id: 'nameMatch',
        header: en ? 'Name match' : 'تطابق الاسم',
        cell: ({ row }) => {
          const candidate = bestCandidate(row.original);
          return candidate ? <Light light={nameLight(row.original, candidate, locale)} /> : <CellTag tone="muted">—</CellTag>;
        },
      },
      {
        id: 'phoneMatch',
        header: en ? 'Phone match' : 'تطابق الهاتف',
        cell: ({ row }) => {
          const candidate = bestCandidate(row.original);
          return candidate ? <Light light={phoneLight(row.original, candidate, locale)} /> : <CellTag tone="muted">—</CellTag>;
        },
      },
      {
        id: 'actions',
        header: en ? 'Actions' : 'الإجراءات',
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const proposal = row.original;
          const typed = proposal.landlordName?.trim() || (en ? 'this owner' : 'هذا المالك');
          const candidate = phoneLinkable(proposal);
          const refusal = quickLinkRefusal(proposal, en);
          const refusalId = `link-refusal-${proposal.propertyEntryId}`;
          const linkLabel = en ? 'Link' : 'ربط';
          return (
            <div className="flex items-center justify-end gap-2">
              <Link
                href={`${base}/citizens/landlord-links/${proposal.propertyEntryId}`}
                aria-label={en ? `Check the link to ${typed}` : `فحص رابط ${typed}`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}
              >
                <Search className="size-3.5" aria-hidden />
                {en ? 'Check' : 'فحص'}
              </Link>
              {!canAnswer ? null : refusal ? (
                /*
                  Closed, with the reason one hover or one Tab away (PRIM-19).
                  A disabled button takes no focus and shows no tooltip, so the
                  focusable wrapper carries the name, the state and the reason;
                  the button inside is only the picture of it.
                */
                <>
                  <ActionTooltip label={refusal}>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-disabled="true"
                      aria-label={linkLabel}
                      aria-describedby={refusalId}
                      className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Button
                        type="button"
                        size="sm"
                        aria-hidden
                        tabIndex={-1}
                        disabled
                        className="pointer-events-none h-8 gap-1.5 text-xs"
                      >
                        <Link2 className="size-3.5" aria-hidden />
                        {linkLabel}
                      </Button>
                    </span>
                  </ActionTooltip>
                  <span id={refusalId} className="sr-only">
                    {refusal}
                  </span>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  disabled={!candidate || !token}
                  aria-label={candidate ? (en ? `Link ${candidate.name} as owner` : `ربط ${candidate.name} مالكاً`) : undefined}
                  onClick={() => candidate && setLinking({ proposal, candidate })}
                >
                  <Link2 className="size-3.5" aria-hidden />
                  {linkLabel}
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [en, base, locale, occupancyLabels, token, canAnswer],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Link2}
        title={en ? 'Owner links' : 'روابط المالكين'}
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
              ? 'When the occupant knew neither the owner’s name nor number, the register offers whoever is recorded as the owner of that same property — the flat’s recorded owner, or a citizen who filed the building as theirs. Those are checked on «Check».'
              : 'إذا لم يعرف الساكن اسم المالك ولا رقمه، يقترح النظام من هو مسجَّل مالكاً للعقار نفسه — مالك الوحدة في سجل المباني، أو مواطن سجّل المبنى ملكاً له. تُفحص هذه في «فحص».'}
          </li>
          <li>
            {en
              ? '«Link» on a row is offered only when the phone matches — the one certain match. Everything else is decided on «Check».'
              : 'زر «ربط» في الصف متاح فقط عند تطابق رقم الهاتف — وهو التطابق المؤكَّد. غير ذلك يُقرَّر في «فحص».'}
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
          {/* Said once, so a reviewer reads a row with no «ربط» as their role, not a fault. */}
          {user && !canAnswer ? (
            <p className="mt-1 text-xs text-muted-foreground">{landlordAnswerRolesNote(locale)}</p>
          ) : null}
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

      <ConfirmDialog
        open={linking !== null}
        onOpenChange={(open) => !open && setLinking(null)}
        destructive={false}
        title={
          linking
            ? en
              ? `Link ${linking.candidate.name} as the owner?`
              : `ربط ${linking.candidate.name} مالكاً؟`
            : ''
        }
        description={
          linking
            ? en
              ? `${linking.proposal.filedBy?.name ?? 'The occupant'} named «${linking.proposal.landlordName?.trim() || '—'}» as the owner of ${linking.proposal.buildingCode ?? linking.proposal.propertyNumber ?? 'this property'}.`
              : `ذكر ${linking.proposal.filedBy?.name ?? 'الساكن'} أن «${linking.proposal.landlordName?.trim() || '—'}» مالك ${linking.proposal.buildingCode ?? linking.proposal.propertyNumber ?? 'هذا العقار'}.`
            : undefined
        }
        confirmLabel={en ? 'Link' : 'ربط'}
        cancelLabel={en ? 'Cancel' : 'إلغاء'}
        busyLabel={en ? 'Working…' : 'جارٍ التنفيذ…'}
        onConfirm={link}
      >
        {linking ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{en ? 'Name match' : 'تطابق الاسم'}</dt>
              <dd>
                <Light light={nameLight(linking.proposal, linking.candidate, locale)} />
              </dd>
              <dt className="text-muted-foreground">{en ? 'Phone match' : 'تطابق الهاتف'}</dt>
              <dd>
                <Light light={phoneLight(linking.proposal, linking.candidate, locale)} />
              </dd>
            </dl>
            <Consequences
              candidate={linking.candidate}
              units={linking.proposal.units.map((unit) => unit.unitCode).filter(Boolean) as string[]}
              locale={locale}
            />
            <p className="text-xs text-muted-foreground">
              {en ? 'You can undo it from the toast or from either file.' : 'يمكن التراجع عنه من الإشعار أو من ملف أيٍّ منهما.'}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
