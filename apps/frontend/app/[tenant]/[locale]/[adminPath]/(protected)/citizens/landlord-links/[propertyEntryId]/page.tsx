'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, FileText, Link2, UserRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  LandlordProposalCard,
  LandlordProposalResolved,
  useLandlordResolutions,
} from '@/components/admin/landlord-proposal-card';
import { ApiRequestError, getLandlordLink } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { landlordLinkStatus, landlordLinkStatusView } from '@/lib/landlord-status';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { cn } from '@/lib/utils';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';

/**
 * «فحص الرابط» — one owner claim from «روابط المالكين», on a page of its own:
 *
 *  1. **The owner**, first: the claim as the tenant made it, the registered
 *     people it could be — each with their name, father's and mother's names,
 *     phone and reference — how each name compares, what a link would do, and
 *     the decision itself. That is `LandlordProposalCard`, the same card the
 *     queue used to stack, so the decision is made exactly as before: choosing
 *     and confirming are two steps, nothing links itself.
 *  2. **The property and the tenant** under it: what the claim is about.
 *
 * The claim is read with the queue's own query (`GET landlord-links/:id`), so
 * this page and the row it was opened from cannot disagree. A claim that is no
 * longer open — linked or answered elsewhere since — says so, rather than
 * showing an error.
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
  const { token } = useStaffSession(tenant, base);

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
  const proposal = query.data ?? null;

  const { resolved, resolve, undo, undoing } = useLandlordResolutions({ tenant, token: token ?? '', locale });
  const resolution = resolved[propertyEntryId];
  const queue = `${base}/citizens/landlord-links`;

  const typed = proposal?.landlordName?.trim() || (en ? 'No name given' : 'بلا اسم');
  const reference = proposal ? (proposal.buildingCode ?? proposal.propertyNumber) : null;
  const view = proposal ? landlordLinkStatusView(landlordLinkStatus(proposal), locale) : null;
  const dash = <span className="font-normal text-muted-foreground">—</span>;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={queue} label={en ? 'Back to owner links' : 'العودة إلى روابط المالكين'} />

      {/*
        The owner as the tenant named them is the heading — the person this
        page is about — with «فحص الرابط» and the property's reference under it.
        Where the claim stands sits beside the way to the tenant's file.
      */}
      <PageHeader
        icon={Link2}
        title={proposal ? typed : en ? 'Check link' : 'فحص الرابط'}
        subtitle={
          proposal ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{en ? 'Check link' : 'فحص الرابط'}</span>
              {reference ? (
                <>
                  <span aria-hidden>·</span>
                  <bdi className="font-mono">{reference}</bdi>
                </>
              ) : null}
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
              {proposal.filedBy ? (
                <Link
                  href={`${base}/citizens/${proposal.filedBy.citizenId}`}
                  className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 basis-40 sm:flex-none sm:basis-auto')}
                >
                  <FileText className="size-4" aria-hidden />
                  {en ? 'Tenant’s file' : 'ملف المستأجر'}
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {query.error ? (
        <ErrorState title={query.error} onRetry={query.refetch} retryLabel={en ? 'Try again' : 'إعادة المحاولة'} />
      ) : query.loading || !query.data && query.data !== null ? (
        <Card>
          <CardContent className="p-4">
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : !proposal ? (
        <EmptyState
          icon={Link2}
          title={en ? 'This link is no longer open' : 'هذا الرابط لم يعد مفتوحاً'}
          description={
            en
              ? 'It was linked or answered since, or the tenancy has ended. The queue lists what is still waiting.'
              : 'رُبط أو أُجيب عنه منذ ذلك الحين، أو انتهى الإيجار. القائمة تعرض ما زال بانتظار القرار.'
          }
          action={
            <Link href={queue} className={buttonVariants({ variant: 'outline' })}>
              {en ? 'Back to owner links' : 'العودة إلى روابط المالكين'}
            </Link>
          }
        />
      ) : (
        <>
          {/* 1 — The owner: who the tenant named, who that could be, and the decision. */}
          <section className="space-y-3" aria-labelledby="link-owner">
            <h2 id="link-owner" className="flex items-center gap-2 text-base font-semibold">
              <UserRound className="size-5 text-primary" aria-hidden />
              {en ? 'The owner' : 'المالك'}
            </h2>
            {resolution ? (
              <div className="space-y-3">
                <LandlordProposalResolved
                  resolution={resolution}
                  onUndo={() => void undo(resolution)}
                  undoing={undoing === propertyEntryId}
                  locale={locale}
                />
                <Link href={queue} className={buttonVariants({ variant: 'outline' })}>
                  {en ? 'Next link' : 'الرابط التالي'}
                </Link>
              </div>
            ) : (
              <LandlordProposalCard
                tenant={tenant}
                token={token ?? ''}
                proposal={proposal}
                citizenHref={(id) => `${base}/citizens/${id}`}
                onResolved={(next) => {
                  resolve(next);
                  // The queue and its count no longer hold this claim.
                  void queryClient.invalidateQueries({ queryKey: ['landlord-links'] });
                  void queryClient.invalidateQueries({ queryKey: ['landlord-links-summary'] });
                }}
                locale={locale}
              />
            )}
          </section>

          {/* 2 — What the claim is about: the property, and the tenant who made it. */}
          <Card>
            <CardHeader className="border-b px-4 py-3.5">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="size-5 text-primary" aria-hidden />
                <h2>{en ? 'The property and the tenant' : 'العقار والمستأجر'}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <SummaryList>
                <SummaryRow label={en ? 'Tenant' : 'المستأجر'}>
                  {proposal.filedBy ? (
                    <Link
                      href={`${base}/citizens/${proposal.filedBy.citizenId}`}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {proposal.filedBy.name}
                    </Link>
                  ) : (
                    dash
                  )}
                </SummaryRow>
                <SummaryRow label={en ? 'Filing reference' : 'رقم الطلب'} className="font-mono">
                  {proposal.filedBy?.referenceNumber ?? dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Standing' : 'صفة الإشغال'}>
                  {(labels.occupancyType as Record<string, string>)[proposal.occupancyType] ?? proposal.occupancyType}
                </SummaryRow>
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
                <SummaryRow label={en ? 'Units a link would cover' : 'الوحدات التي يشملها الربط'} className="font-mono">
                  {proposal.units.length > 0
                    ? proposal.units.map((unit) => unit.unitCode ?? '—').join(en ? ', ' : '، ')
                    : dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Filed on' : 'تاريخ التسجيل'} className="tabular-nums">
                  {formatDate(proposal.filedAt)}
                </SummaryRow>
              </SummaryList>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
