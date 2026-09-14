'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, HelpCircle, Link2, RefreshCw, Wallet } from 'lucide-react';
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
  useLandlordResolutions,
} from '@/components/admin/landlord-proposal-card';

const PAGE_SIZE = 20;

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
 * One column, capped at a reading width. Each card is one question and is read
 * top to bottom; stretched across a wide monitor the claim and the people it
 * could be ended up a screen's width apart, which is the comparison this page
 * exists to make easy.
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
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const existing = loadSession(tenant);
    if (!existing || existing.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setSession(existing);
  }, [tenant, base, router]);

  const token = session?.accessToken ?? null;
  const { resolved, resolve, undo, undoing, clear } = useLandlordResolutions({
    tenant,
    token: token ?? '',
    locale,
  });

  const query = useStaffQuery({
    queryKey: ['landlord-links', tenant, offset],
    queryFn: (accessToken, signal) =>
      getLandlordLinks(tenant, accessToken, { limit: PAGE_SIZE, offset }, signal),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: en ? 'Failed to load owner links.' : 'تعذّر تحميل روابط المالكين.',
  });

  const canSeeSummary = Boolean(session?.user.role && SUMMARY_ROLES.has(session.user.role));
  const summary = useStaffQuery({
    queryKey: ['landlord-links-summary', tenant],
    queryFn: (accessToken) => getLandlordLinkSummary(tenant, accessToken),
    tenant,
    base,
    token: canSeeSummary ? token : null,
    errorMessage: en ? 'Failed to load the summary.' : 'تعذّر تحميل الملخّص.',
  });

  const proposals = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const pending = proposals.filter((proposal) => !resolved[proposal.propertyEntryId]).length;

  /*
    A refresh re-reads the queue, so the settled placeholders go: the claims
    they stood for are no longer in it. Stepping back a page when the current
    one has emptied keeps the reader from landing on «nothing here» at page 3.
  */
  const refresh = () => {
    clear();
    if (offset > 0 && offset >= total - Object.keys(resolved).length) {
      setOffset(Math.max(0, offset - PAGE_SIZE));
    }
    query.refetch();
    if (canSeeSummary) summary.refetch();
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Link2}
        title={en ? 'Owner links' : 'روابط المالكين'}
        subtitle={
          en
            ? 'Tenants named an owner whose number belongs to a registered citizen. Say who the owner is, and the property goes onto their file and bill.'
            : 'مستأجرون ذكروا رقم مالك يعود لمواطن مسجَّل. حدِّد من هو المالك ليُضاف العقار إلى ملفه ويدخل في فواتيره.'
        }
        actions={
          <>
            {!query.loading && total > 0 ? (
              <span className="rounded-md bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary tabular-nums">
                {en ? `${total} waiting` : `${total} بانتظار القرار`}
              </span>
            ) : null}
            <Button
              variant="outline"
              onClick={refresh}
              disabled={query.fetching}
              className="h-10"
            >
              <RefreshCw
                className={cn('size-4', query.fetching && 'animate-spin motion-reduce:animate-none')}
                aria-hidden
              />
              {en ? 'Refresh' : 'تحديث'}
            </Button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-4xl space-y-4">
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
                ? 'Whenever an owner is registered — before or after the tenant — the register compares that phone with the citizen’s phone and WhatsApp. Nothing is linked automatically.'
                : 'عند تسجيل أي مالك — قبل المستأجر أو بعده — يقارن النظام ذلك الرقم برقم المواطن وواتسابه. لا يُربط شيء تلقائياً.'}
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
                    <span className="font-semibold tabular-nums">{summary.data.units}</span> owned
                    unit(s) across{' '}
                    <span className="font-semibold tabular-nums">{summary.data.owners}</span> owner(s)
                    are on no bill
                  </>
                ) : (
                  <>
                    <span className="font-semibold tabular-nums">{summary.data.units}</span> وحدة
                    مملوكة لدى{' '}
                    <span className="font-semibold tabular-nums">{summary.data.owners}</span> مالك لا
                    تدخل في أي فاتورة
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

        {query.loading ? (
          <LoadingState label={en ? 'Loading owner links…' : 'جارٍ تحميل روابط المالكين…'} fullHeight />
        ) : query.error ? (
          <ErrorState description={query.error} onRetry={() => query.refetch()} />
        ) : proposals.length === 0 ? (
          <EmptyState
            title={en ? 'Nothing waiting' : 'لا شيء بانتظار القرار'}
            description={
              en
                ? 'No tenant card names a number that belongs to a registered citizen. New matches appear here as owners are registered.'
                : 'لا توجد بطاقة مستأجر تذكر رقماً يعود لمواطن مسجَّل. تظهر المطابقات الجديدة هنا كلما سُجِّل مالك.'
            }
          />
        ) : (
          <>
            <p className="sr-only" aria-live="polite">
              {en ? `${pending} on this page still need an answer.` : `${pending} في هذه الصفحة بانتظار الإجابة.`}
            </p>
            <ul className="space-y-4">
              {proposals.map((proposal) => {
                const resolution = resolved[proposal.propertyEntryId];
                return (
                  <li key={proposal.propertyEntryId}>
                    {resolution ? (
                      <LandlordProposalResolved
                        resolution={resolution}
                        onUndo={() => void undo(resolution)}
                        undoing={undoing === proposal.propertyEntryId}
                        locale={locale}
                      />
                    ) : (
                      <LandlordProposalCard
                        tenant={tenant}
                        token={token ?? ''}
                        proposal={proposal}
                        citizenHref={(id) => `${base}/citizens/${id}`}
                        onResolved={resolve}
                        locale={locale}
                      />
                    )}
                  </li>
                );
              })}
            </ul>

            {total > PAGE_SIZE ? (
              <nav
                aria-label={en ? 'Pages' : 'الصفحات'}
                className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
              >
                <p className="text-sm text-muted-foreground tabular-nums">
                  {/* The range isolated LTR, or the bidi algorithm reads «1–20» as «20–1». */}
                  <bdi dir="ltr">{`${from}–${to}`}</bdi>
                  {en ? ` of ${total}` : ` من ${total}`}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="h-10"
                    disabled={offset === 0 || query.fetching}
                    onClick={() => {
                      clear();
                      setOffset(Math.max(0, offset - PAGE_SIZE));
                    }}
                  >
                    <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
                    {en ? 'Previous' : 'السابق'}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10"
                    disabled={offset + PAGE_SIZE >= total || query.fetching}
                    onClick={() => {
                      clear();
                      setOffset(offset + PAGE_SIZE);
                    }}
                  >
                    {en ? 'Next' : 'التالي'}
                    <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
                  </Button>
                </div>
              </nav>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
