'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, RefreshCw, Wallet } from 'lucide-react';
import { getLandlordLinks, getLandlordLinkSummary, type Session } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import {
  LandlordProposalCard,
  LandlordProposalResolved,
} from '@/components/admin/landlord-proposal-card';

/**
 * «روابط المالكين» — the standing queue of owner claims nobody has answered.
 *
 * Every مستأجر card names an owner and gives a number for them. Where that
 * number belongs to a citizen the register already holds, the two records
 * describe one person and nothing in the system knew it. This screen is where
 * somebody says so.
 *
 * ## Why a queue exists at all when the form already asks
 *
 * Because the form can only ask the officer who is *there*. Two cases escape
 * it, and they are the common ones:
 *
 *  - The owner registers **months later**. When the tenant was filed there was
 *    no citizen to match, so no question was put; the match only comes into
 *    existence when the owner's own record does.
 *  - Nobody answered. «لاحقاً» is a legitimate response from an officer who
 *    does not know, and it has to lead somewhere other than silence.
 *
 * ## Every row here is derived, and that is the point
 *
 * Nothing on this screen is stored as a proposal. A row is any card whose
 * landlord number matches a citizen and which nobody has resolved — computed on
 * each read, so it appears the moment a match becomes true and disappears the
 * moment somebody settles it, with no generated table to fall out of step.
 */
export default function LandlordLinksPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const en = locale === 'en';

  const [session, setSession] = useState<Session | null>(null);
  /**
   * Rows settled in this visit, kept on screen as a tick rather than removed.
   *
   * A row that vanishes the instant it is answered gives the officer no
   * confirmation of what they just did, and on a list of twenty the rows below
   * jump up under the cursor — which is how the next one gets answered by
   * accident. They clear on the next refetch.
   */
  const [resolved, setResolved] = useState<Record<string, 'linked' | 'dismissed'>>({});

  useEffect(() => {
    const existing = loadSession(tenant);
    if (!existing || existing.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setSession(existing);
  }, [tenant, base, router]);

  const query = useStaffQuery({
    queryKey: ['landlord-links', tenant],
    queryFn: (accessToken) => getLandlordLinks(tenant, accessToken),
    tenant,
    base,
    token: session?.accessToken ?? null,
    errorMessage: en ? 'Failed to load owner links.' : 'تعذّر تحميل روابط المالكين.',
  });

  /*
    What the register knows and still does not bill, on the same screen as the
    work that shrinks it.

    A confirmed link now adds the property to the owner's file, which is what
    puts it on a bill — so this figure is the *remainder*: owners whose only
    card on the building was filed as a مستأجر, structures that cannot carry the
    link, citizens with no registration to hang a card on. Every one of them is
    revenue the municipality can name and is not collecting, and a clerk working
    this queue should be able to watch the number come down.
  */
  const summary = useStaffQuery({
    queryKey: ['landlord-links-summary', tenant],
    queryFn: (accessToken) => getLandlordLinkSummary(tenant, accessToken),
    tenant,
    base,
    token: session?.accessToken ?? null,
    errorMessage: en ? 'Failed to load the summary.' : 'تعذّر تحميل الملخّص.',
  });

  const proposals = query.data ?? [];

  const refresh = () => {
    setResolved({});
    query.refetch();
    summary.refetch();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Link2}
        title={en ? 'Owner links' : 'روابط المالكين'}
        subtitle={
          en
            ? 'Tenancy cards whose named owner matches a registered citizen. A phone number is not an identity — confirm only what you recognise.'
            : 'بطاقات إشغال يطابق فيها رقم المالك المذكور مواطناً مسجَّلاً. الرقم ليس هوية — أكِّد ما تعرفه فقط.'
        }
        actions={
          <div className="flex items-center gap-2">
            {/*
              The size of the job, beside the control that refreshes it.

              An officer opening this screen is deciding whether to work it now
              or after lunch, and that decision is the count. It sits in the
              header rather than in a tile of its own because it is one number
              and a tile would make it a section.
            */}
            {!query.loading && proposals.length > 0 ? (
              <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary tabular-nums">
                {en ? `${proposals.length} pending` : `${proposals.length} بانتظار المراجعة`}
              </span>
            ) : null}
            <Button variant="outline" onClick={refresh} disabled={query.fetching}>
              <RefreshCw className={cn('size-4', query.fetching && 'animate-spin')} aria-hidden />
              {en ? 'Refresh' : 'تحديث'}
            </Button>
          </div>
        }
      />

      {/*
        What the register knows and does not bill — context for the work, not a
        section of it.

        Deliberately a single bordered notice rather than a card with a heading:
        it is one sentence and a caveat, it is read once on arrival, and giving
        it a card of its own would make it compete with the queue underneath for
        the top of the page. The number leads because the number is the point.
      */}
      {summary.data && summary.data.units > 0 ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/[0.07] px-3.5 py-3">
          <Wallet className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="text-sm leading-relaxed">
              {en ? (
                <>
                  <span className="font-semibold tabular-nums">{summary.data.units}</span> unit(s)
                  across{' '}
                  <span className="font-semibold tabular-nums">{summary.data.owners}</span> owner(s)
                  are recorded as owned but sit on no bill.
                </>
              ) : (
                <>
                  <span className="font-semibold tabular-nums">{summary.data.units}</span> وحدة لدى{' '}
                  <span className="font-semibold tabular-nums">{summary.data.owners}</span> مالك
                  مسجَّلة كمملوكة ولا تظهر في أي فاتورة.
                </>
              )}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {en
                ? 'Their owner filed no property card naming that building — an owner-borne fee (الأرصفة, المجاري) charges from the cards a citizen filed. Confirming a link here adds the property to the owner’s file, which is what puts it on a bill.'
                : 'مالكوها لم يقدّموا بطاقة عقار تذكر ذلك المبنى — والرسوم التي يتحمّلها المالك (الأرصفة، المجاري) تُحتسب من البطاقات المقدَّمة. تأكيد الربط هنا يضيف العقار إلى ملف المالك، وهو ما يُدخله في الفاتورة.'}
            </p>
          </div>
        </div>
      ) : null}

      {query.loading ? (
        <LoadingState
          label={en ? 'Loading owner links…' : 'جارٍ تحميل روابط المالكين…'}
          fullHeight
        />
      ) : query.error ? (
        <ErrorState description={query.error} onRetry={() => query.refetch()} />
      ) : proposals.length === 0 ? (
        <EmptyState
          title={en ? 'Nothing to link' : 'لا توجد روابط معلّقة'}
          description={
            en
              ? 'No unresolved tenancy card names a number that belongs to a registered citizen. New matches appear here as owners register.'
              : 'لا توجد بطاقة إشغال غير محسومة تذكر رقماً يعود لمواطن مسجَّل. تظهر المطابقات الجديدة هنا كلما سُجِّل مالك.'
          }
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) =>
            resolved[proposal.propertyEntryId] ? (
              <LandlordProposalResolved
                key={proposal.propertyEntryId}
                outcome={resolved[proposal.propertyEntryId]!}
                locale={locale}
              />
            ) : (
              <LandlordProposalCard
                key={proposal.propertyEntryId}
                tenant={tenant}
                token={session?.accessToken ?? ''}
                proposal={proposal}
                citizenHref={(id) => `${base}/citizens/${id}`}
                onResolved={(id, outcome) =>
                  setResolved((current) => ({ ...current, [id]: outcome }))
                }
                locale={locale}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
