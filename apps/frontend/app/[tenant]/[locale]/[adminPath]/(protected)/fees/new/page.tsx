'use client';

import { use, useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Receipt } from 'lucide-react';
import { FEE_ISSUE_ROLES } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getFeeFilterOptions,
  issueFeeNotice,
  logApiError,
} from '@/lib/api-client';
import { heldKey, keyIsSpent, spendKey } from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { IssueFeeForm, IssueFeeFormSkeleton, type IssueFeeValues } from '@/components/admin/issue-fee-form';
import { IssueResultPanel, type IssueFeeNoticeResult } from '@/components/admin/fees/issue-result-panel';
import { issuePayload } from '@/lib/fee-notice-draft';
import { Alert } from '@/components/ui/alert';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/**
 * «إصدار رسم جديد» — the wizard at its own address.
 *
 * It was a dialog over the fees register. A fee notice decides what every
 * household in the town owes, is built over three steps and is read back before
 * the last button, which is exactly the task BAN-10 says does not belong in a
 * modal. A route also means the browser's back button works and a half-filled
 * wizard survives a stray click.
 *
 * The page owns the write and everything that follows it — the counts of what
 * went unbilled, which are the part a clerk has to act on, kept on screen in
 * `IssueResultPanel` — while the form owns the steps and the fields.
 *
 * It sits under `/fees`, so `canAccessPath` matches that nav row by prefix.
 * Issuing is narrower than reading, so the page checks `FEE_ISSUE_ROLES` and
 * says who may do it; the API is what enforces it (CODE-4).
 */
export default function IssueFeePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const feesHref = `${base}/fees`;
  const t = useTranslations('fees.issuePage');
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The issue the server confirmed, shown in place of the wizard. */
  const [issued, setIssued] = useState<{ values: IssueFeeValues; result: IssueFeeNoticeResult } | null>(null);
  /** A fresh wizard after «إصدار رسم آخر»: a new key remounts it empty. */
  const [formKey, setFormKey] = useState(0);
  const clearError = useCallback(() => setError(null), []);
  /*
    Synchronous, unlike `submitting`, which lands a render after a fast second
    press. And not released by a success: the dialog this page replaced closed
    itself, while a page stays mounted until the next route is ready — seconds on
    a village connection — and a second press there would issue the notice again
    and bill every household twice. Only «إصدار رسم آخر» releases it, with a new
    wizard whose notice takes a new key.
  */
  const inFlight = useRef(false);

  const canIssue = user ? hasRole(FEE_ISSUE_ROLES, user.role) : false;

  /**
   * Titles already in use, so the wizard can warn before a second notice repeats one.
   *
   * The key the fees register and the payments ledger read and invalidate: under
   * `reference` it is fetched once a session, and a key of its own here was
   * never refreshed, so the notice just issued was missing from the next one's
   * warning (M3).
   */
  const titlesQuery = useStaffQuery({
    queryKey: ['fee-filter-options', tenant],
    queryFn: (accessToken, signal) => getFeeFilterOptions(tenant, accessToken, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const issue = async (values: IssueFeeValues): Promise<void> => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await issueFeeNotice(tenant, token, {
        // The notice the preview was read for, field for field, and the scope warnings the clerk confirmed (`issuePayload`).
        ...issuePayload(values),
        // Kept across every failure and edit, spent once the server confirms the notice exists.
        clientRequestId: heldKey(tenant, 'fee-notice:new'),
      });
      spendKey(tenant, 'fee-notice:new');
      /*
        The screens a notice changes read again: the register's bills and its
        context, the notices list, and the titles in use (STA-3). Not awaited —
        the answer is already in hand, and a re-read must not hold it back.
      */
      void Promise.all(
        ['fee-filter-options', 'fee-notices', 'fees-payments', 'fees-context'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key, tenant] }),
        ),
      );
      /*
        A retry the server answered from the first notice: nothing new was
        billed, and the counts are not repeated. Said with a warning, never the
        fresh-success toast, naming the notice the key issued — its title, which
        the server only replays when it matches (`FEE_NOTICE_REQUEST_REUSED`
        otherwise), and its id — and that it stands as first issued.
      */
      if (res.replayed) {
        toast.warning(t('alreadyIssuedTitle', { title: values.title }), {
          description: t('alreadyIssuedBody', { count: res.issued, id: res.noticeId }),
        });
        // The wizard stays locked from here: the page is leaving (see `inFlight`).
        router.push(feesHref);
        return;
      }
      toast.success(t('issued', { count: res.issued }));
      /*
        The rest — what went unbilled and why, the citizens nobody could
        assess, the shared units — stays on screen in the panel that replaces
        the wizard, rather than in toasts that close themselves (S8). The
        wizard is gone with it, so `inFlight` stays held until «إصدار رسم آخر».
      */
      setIssued({ values, result: res });
      setSubmitting(false);
    } catch (caught) {
      logApiError(caught);
      // A key whose notice exists is spent; every other failure keeps it, so a retry is answered from the first.
      if (keyIsSpent(caught)) spendKey(tenant, 'fee-notice:new');
      // Shown inside the wizard, on the review step the clerk pressed from (TXT-6).
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  // The citizen picker searches the register as the clerk types (`useCitizenSearch`), so it waits on nothing here.
  const ready = Boolean(token) && Boolean(titlesQuery.data);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={feesHref} label={t('back')} />

      <PageHeader icon={Receipt} title={t('title')} />

      {titlesQuery.error && !titlesQuery.data ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={titlesQuery.error} onRetry={titlesQuery.refetch} />
          </CardContent>
        </Card>
      ) : !user || !ready ? (
        <IssueFeeFormSkeleton label={t('loading')} />
      ) : !canIssue ? (
        <Alert variant="warning" title={t('notAllowedTitle')}>
          {t('notAllowedBody')}
        </Alert>
      ) : issued ? (
        <IssueResultPanel
          title={issued.values.title.trim()}
          frequency={issued.values.frequency}
          result={issued.result}
          noticesHref={`${feesHref}/notices`}
          feesHref={feesHref}
          locale={locale}
          onIssueAnother={() => {
            // A new notice under a new key: the last one's was spent when the server confirmed it.
            inFlight.current = false;
            setIssued(null);
            setFormKey((key) => key + 1);
          }}
        />
      ) : (
        <IssueFeeForm
          key={formKey}
          tenant={tenant}
          base={base}
          token={token}
          submitting={submitting}
          error={error}
          onSubmit={issue}
          onEdit={clearError}
          backHref={feesHref}
          locale={locale}
          existingTitles={titlesQuery.data?.titles ?? []}
        />
      )}
    </div>
  );
}
