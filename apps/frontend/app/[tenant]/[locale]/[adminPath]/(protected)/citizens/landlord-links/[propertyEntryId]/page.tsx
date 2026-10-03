'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, FileText, Link2, UserRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  LandlordProposalCard,
  LandlordProposalResolved,
  useLandlordResolutions,
} from '@/components/admin/landlord-proposal-card';
import { ApiRequestError, getLandlordLink, type LandlordProposal } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { landlordLinkStatus, landlordLinkStatusView } from '@/lib/landlord-status';
import { hasRole, LANDLORD_LINK_ANSWER_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { cn } from '@/lib/utils';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';

/**
 * «فحص الرابط» — one owner claim from «روابط المالكين», on a page of its own.
 *
 * ## Layout
 *
 * The header says whose claim it is — the occupant, their filing reference,
 * the property and the day it was filed — with where it stands and the way to
 * the occupant's file.
 *
 * Under it, two columns on a reviewer's screen, one on a phone:
 *
 *  - **What is known**, at the start and pinned while the decision scrolls:
 *    the occupant (tenant or free occupant, شاغل بتسامح) and the property the
 *    claim is about. Facts only, read top to bottom (`SummaryList`).
 *  - **The decision**, the wide column: what the occupant said about the owner
 *    set apart as the thing to compare against, the registered people it could
 *    be — side by side when there are several — each with how their name and
 *    number compare, what a link would do, and the two answers. That is
 *    `LandlordProposalCard` in its `panel` layout, so the decision is made by
 *    the same code as everywhere else: choosing and confirming are two steps,
 *    nothing links itself.
 *
 * On a phone the facts come first and are short; the decision follows.
 *
 * The claim is read with the queue's own query (`GET landlord-links/:id`), so
 * this page and the row it was opened from cannot disagree. A claim that is no
 * longer open — linked or answered elsewhere since — says so, rather than
 * showing an error. One answered *on this page* is not that case: it keeps the
 * answer and its «تراجع» on screen whatever a later read returns.
 */
export default function LandlordLinkPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; propertyEntryId: string }>;
}) {
  const { tenant, locale, adminPath, propertyEntryId } = use(params);
  const en = locale === 'en';
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  // Every staff role may read the claim; only these answer it. The card keeps
  // the comparison for the others and names who answers in place of the buttons.
  const canAnswer = hasRole(LANDLORD_LINK_ANSWER_ROLES, user?.role);

  const query = useStaffQuery({
    queryKey: ['landlord-link', tenant, propertyEntryId],
    // A 404 is an answer — the claim is no longer open — not a failed read.
    queryFn: async (accessToken, signal) => {
      try {
        return await getLandlordLink(tenant, accessToken, propertyEntryId, signal);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 404) return null;
        throw caught;
      }
    },
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load this link.' : 'تعذّر تحميل هذا الرابط.',
  });
  const { resolved, resolve, undo, undoing } = useLandlordResolutions({ tenant, token: token ?? '', locale });
  const resolution = resolved[propertyEntryId];

  /*
    The claim as it stood when this page answered it. Once linked or
    dismissed the claim is closed, so the next read — a window-focus refetch,
    say — comes back 404 and `query.data` turns null. Without this the «تم
    الربط» panel and its «تراجع» would be replaced by «لم يعد مفتوحاً» moments
    after the officer answered, taking the undo with them. It stands in only
    while the answer is on screen; an undo re-reads the claim before it clears
    the answer (`useLandlordResolutions`), so the card returns with fresh data.
  */
  const [answered, setAnswered] = useState<LandlordProposal | null>(null);
  const proposal = query.data ?? (resolution ? answered : null);
  // Answered here: what the page shows is the answer, whatever a re-read says.
  const settled = Boolean(resolution && proposal);
  const queue = `${base}/citizens/landlord-links`;

  const reference = proposal ? (proposal.buildingCode ?? proposal.propertyNumber) : null;
  const view = proposal ? landlordLinkStatusView(landlordLinkStatus(proposal), locale) : null;
  const occupant = proposal?.filedBy ?? null;
  const fileHref = occupant ? `${base}/citizens/${occupant.citizenId}` : null;
  const dash = <span className="font-normal text-muted-foreground">—</span>;
  const units = proposal?.units.map((unit) => unit.unitCode).filter(Boolean) ?? [];

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={queue} label={en ? 'Back to owner links' : 'العودة إلى روابط المالكين'} />

      {/*
        Whose claim this is, by the identifiers a clerk is asked for: the
        occupant's name as the title, then their filing reference, the
        property, and the day it was filed. Where it stands sits beside the
        way to the occupant's file.
      */}
      <PageHeader
        icon={Link2}
        title={occupant?.name ?? (en ? 'Check link' : 'فحص الرابط')}
        subtitle={
          proposal ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{en ? 'Owner link check' : 'فحص رابط المالك'}</span>
              {occupant ? (
                <>
                  <span aria-hidden>·</span>
                  <bdi dir="ltr" className="font-mono">
                    {occupant.referenceNumber}
                  </bdi>
                </>
              ) : null}
              {reference ? (
                <>
                  <span aria-hidden>·</span>
                  <bdi dir="ltr" className="font-mono">
                    {reference}
                  </bdi>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {en ? 'Filed ' : 'قُدِّم '}
                {formatDate(proposal.filedAt)}
              </span>
            </span>
          ) : undefined
        }
        actions={
          proposal ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
              <span role="status" aria-live="polite" className="shrink-0">
                {resolution ? (
                  <Badge variant={resolution.kind === 'linked' ? 'soft-success' : 'soft-muted'} className="h-9 px-3 text-sm">
                    {resolution.kind === 'linked'
                      ? en
                        ? 'Linked'
                        : 'تم الربط'
                      : en
                        ? 'Answered — not them'
                        : 'سُجِّلت الإجابة — ليس هو'}
                  </Badge>
                ) : view ? (
                  <Badge
                    variant={view.tone === 'primary' ? 'soft-default' : 'soft-warning'}
                    className="h-9 gap-1.5 px-3 text-sm"
                  >
                    <view.icon className="size-4" aria-hidden />
                    {view.label}
                  </Badge>
                ) : null}
              </span>
              {fileHref ? (
                <Link
                  href={fileHref}
                  className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 basis-40 sm:flex-none sm:basis-auto')}
                >
                  <FileText className="size-4" aria-hidden />
                  {en ? 'Occupant’s file' : 'ملف الساكن'}
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {/* An answer given here outranks every read after it — error, 404 or otherwise. */}
      {!settled && query.error ? (
        <ErrorState title={query.error} onRetry={query.refetch} retryLabel={en ? 'Try again' : 'إعادة المحاولة'} />
      ) : !settled && (query.loading || (!query.data && query.data !== null)) ? (
        // The page's own shape, so nothing jumps when the claim arrives.
        <div className="grid gap-6 lg:grid-cols-12 lg:items-start" aria-busy="true">
          <div className="space-y-4 lg:col-span-4">
            {[0, 1].map((index) => (
              <Card key={index}>
                <CardContent className="space-y-3 p-4">
                  <Skeleton className="h-5 w-1/3" />
                  <SkeletonText lines={4} />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="lg:col-span-8">
            <CardContent className="space-y-4 p-4">
              <Skeleton className="h-5 w-1/4" />
              <Skeleton className="h-16 w-full" />
              <div className="grid gap-2 md:grid-cols-2">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : !proposal ? (
        <EmptyState
          icon={Link2}
          title={en ? 'This link is no longer open' : 'هذا الرابط لم يعد مفتوحاً'}
          description={
            en
              ? 'It was linked or answered since, or the occupancy has ended. The queue lists what is still waiting.'
              : 'رُبط أو أُجيب عنه منذ ذلك الحين، أو انتهى الإشغال. القائمة تعرض ما زال بانتظار القرار.'
          }
          action={
            <Link href={queue} className={buttonVariants({ variant: 'outline' })}>
              {en ? 'Back to owner links' : 'العودة إلى روابط المالكين'}
            </Link>
          }
        />
      ) : (
        // One height for both columns: whichever is taller, the other stretches to it.
        <div className="grid gap-6 lg:grid-cols-12">
          {/* What is known. */}
          <div className="flex flex-col gap-4 lg:col-span-4">
            <Card>
              <CardHeader className="border-b px-4 py-3.5">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <UserRound className="size-5 text-primary" aria-hidden />
                  <h2>{en ? 'The occupant' : 'الساكن'}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-2">
                <SummaryList>
                  <SummaryRow label={en ? 'Name' : 'الاسم'}>
                    {occupant && fileHref ? (
                      <Link href={fileHref} className="text-primary underline-offset-2 hover:underline">
                        {occupant.name}
                      </Link>
                    ) : (
                      dash
                    )}
                  </SummaryRow>
                  <SummaryRow label={en ? 'Filing reference' : 'رقم الطلب'} className="font-mono">
                    {occupant?.referenceNumber ?? dash}
                  </SummaryRow>
                  <SummaryRow label={en ? 'Standing' : 'صفة الإشغال'}>
                    {(labels.occupancyType as Record<string, string>)[proposal.occupancyType] ?? proposal.occupancyType}
                  </SummaryRow>
                  <SummaryRow label={en ? 'Filed on' : 'تاريخ التسجيل'} className="tabular-nums">
                    {formatDate(proposal.filedAt)}
                  </SummaryRow>
                </SummaryList>
              </CardContent>
            </Card>

            <Card className="flex-1">
              <CardHeader className="border-b px-4 py-3.5">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Building2 className="size-5 text-primary" aria-hidden />
                  <h2>{en ? 'The property' : 'العقار'}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-2">
                <SummaryList>
                  <SummaryRow label={en ? 'Property type' : 'نوع العقار'}>
                    {(labels.propertyType as Record<string, string>)[proposal.propertyType] ?? proposal.propertyType}
                  </SummaryRow>
                  <SummaryRow label={labels.citizenField.propertyNumber} className="font-mono">
                    {proposal.propertyNumber ?? dash}
                  </SummaryRow>
                  {proposal.buildingCode ? (
                    <SummaryRow label={en ? 'Building code' : 'رمز المبنى'} className="font-mono">
                      {proposal.buildingCode}
                    </SummaryRow>
                  ) : null}
                  {proposal.buildingName ? (
                    <SummaryRow label={en ? 'Building name' : 'اسم المبنى'}>{proposal.buildingName}</SummaryRow>
                  ) : null}
                  <SummaryRow
                    label={en ? 'Units a link would cover' : 'الوحدات التي يشملها الربط'}
                    className="font-mono"
                  >
                    {units.length > 0 ? units.join(en ? ', ' : '، ') : dash}
                  </SummaryRow>
                </SummaryList>
              </CardContent>
            </Card>
          </div>

          {/* The decision. */}
          <section className="flex flex-col gap-3 lg:col-span-8" aria-label={en ? 'The decision' : 'القرار'}>
            {resolution ? (
              <>
                <LandlordProposalResolved
                  resolution={resolution}
                  onUndo={() => void undo(resolution)}
                  undoing={undoing === propertyEntryId}
                  locale={locale}
                />
                <Link href={queue} className={buttonVariants({ variant: 'outline' })}>
                  {en ? 'Next link' : 'الرابط التالي'}
                </Link>
              </>
            ) : (
              <LandlordProposalCard
                tenant={tenant}
                token={token ?? ''}
                proposal={proposal}
                citizenHref={(id) => `${base}/citizens/${id}`}
                canAnswer={canAnswer}
                onResolved={(next) => {
                  setAnswered(proposal);
                  resolve(next);
                  // The queue and its count no longer hold this claim.
                  void queryClient.invalidateQueries({ queryKey: ['landlord-links'] });
                  void queryClient.invalidateQueries({ queryKey: ['landlord-links-summary'] });
                }}
                locale={locale}
                variant="panel"
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
