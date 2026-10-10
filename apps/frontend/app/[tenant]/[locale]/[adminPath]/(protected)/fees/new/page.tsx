'use client';

import { use, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Receipt } from 'lucide-react';
import { FEE_ISSUE_ROLES } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getFeeFilterOptions,
  issueFeeNotice,
  listCitizens,
  logApiError,
} from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { IssueFeeForm, type IssueFeeValues } from '@/components/admin/issue-fee-form';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
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
 * went unbilled, which are the part a clerk has to act on — while the form owns
 * the steps and the fields.
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
  const tFees = useTranslations('fees');
  const router = useRouter();
  const toast = useToast();
  const { token, user } = useStaffSession(tenant, base);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
    Synchronous, unlike `submitting`, which lands a render after a fast second
    press. And never released on success: the dialog this page replaced closed
    itself, while a page stays mounted until the next route is ready — seconds on
    a village connection — and a second press there would issue the notice again
    and bill every household twice.
  */
  const inFlight = useRef(false);

  const canIssue = user ? hasRole(FEE_ISSUE_ROLES, user.role) : false;

  /** The citizen picker's list. A file «دمج ملفين» folded into another is charged on the file that stays. */
  const citizensQuery = useStaffQuery({
    queryKey: ['fees-issue-citizens', tenant],
    queryFn: async (accessToken, signal) => {
      const res = await listCitizens(tenant, accessToken, { limit: 200 }, signal);
      return res.items.filter((row) => !row.mergedIntoId);
    },
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  /** Titles already in use, so the wizard can warn before a second notice repeats one. */
  const titlesQuery = useStaffQuery({
    queryKey: ['fees-filter-options', tenant],
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
        title: values.title,
        amount: Number(values.amount.replace(/\D/g, '')),
        basis: values.basis,
        bearer: values.bearer,
        frequency: values.frequency,
        targetType: values.targetType,
        targetCategory: values.targetCategory || undefined,
        targetCitizenId: values.targetCitizenId || undefined,
        dueDate: values.dueDate,
        instructions: values.instructions || undefined,
      });
      toast.success(t('issued', { count: res.issued }));

      /*
        The skipped are named, not buried.

        A clerk told only that two hundred invoices were raised has no way to
        know that eleven buildings went unbilled because nobody has been inside
        them. This is the shortfall made visible so someone can act on it.
      */
      if (res.unassessable && res.unassessable.length > 0) {
        toast.error(
          t('unassessable', { count: res.unassessable.length }) +
            res.unassessable.map((entry) => entry.name).join('، '),
        );
      }

      /*
        And so is what the bearer rule left out, for the same reason: a clerk who
        has just said this fee falls on المالك rather than الشاغل has changed what
        the town owes, and the size of that change is knowable only right here.
      */
      if (res.exemptedUnits) toast.info(t('exempted', { count: res.exemptedUnits }));

      /*
        Held, not exempt — and not charged on this notice's period at all: the
        period's invoice is written once. Said plainly so a clerk who wants the
        period recovered knows it is a manual charge.
      */
      if (res.heldUnits) toast.info(t('held', { count: res.heldUnits }));

      /*
        Held too, for a different reason: flats read «غير صالحة للسكن» are not
        charged an occupant-borne fee until a re-inspection reads them habitable.
        A one-off fee has no next period for the charge to resume in.
      */
      if (res.uninhabitableUnits) {
        toast.info(
          tFees(values.frequency === 'ONCE' ? 'issue.uninhabitableOnce' : 'issue.uninhabitable', {
            count: res.uninhabitableUnits,
          }),
        );
      }
      // «معفاة من الرسوم» (0077): the mosque on a waqf parcel, a public building.
      if (res.feeExemptUnits) {
        toast.info(tFees('issue.feeExempt', { count: res.feeExemptUnits }));
      }
      /*
        Not held and not exempt: a co-owned flat «مالك مسؤول» pays for in full.
        Said so the other owners' bills do not read as missing a unit.
      */
      if (res.coOwnerPaidUnits) {
        toast.info(tFees('issue.coOwnerPaid', { count: res.coOwnerPaidUnits }));
      }

      // «معفاة من الرسوم» (0077): the mosque on a waqf parcel, a public building.
      if (res.feeExemptUnits) toast.info(tFees('issue.feeExempt', { count: res.feeExemptUnits }));

      /*
        Not held and not exempt: a co-owned flat «مالك مسؤول» pays for in full.
        Said so the other owners' bills do not read as missing a unit.
      */
      if (res.coOwnerPaidUnits) toast.info(tFees('issue.coOwnerPaid', { count: res.coOwnerPaidUnits }));

      // The wizard stays locked from here: the page is leaving (see `inFlight`).
      router.push(feesHref);
    } catch (caught) {
      logApiError(caught);
      // Shown inside the wizard, on the review step the clerk pressed from (TXT-6).
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const ready = Boolean(token) && Boolean(citizensQuery.data) && Boolean(titlesQuery.data);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={feesHref} label={t('back')} />

      <PageHeader icon={Receipt} title={t('title')} />

      {citizensQuery.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={citizensQuery.error} onRetry={citizensQuery.refetch} />
          </CardContent>
        </Card>
      ) : !user || !ready ? (
        <Skeleton className="mx-auto h-96 w-full max-w-2xl rounded-lg" />
      ) : !canIssue ? (
        <Alert variant="warning" title={t('notAllowedTitle')}>
          {t('notAllowedBody')}
        </Alert>
      ) : (
        <IssueFeeForm
          citizens={citizensQuery.data ?? []}
          submitting={submitting}
          error={error}
          onSubmit={issue}
          backHref={feesHref}
          locale={locale}
          existingTitles={titlesQuery.data?.titles ?? []}
        />
      )}
    </div>
  );
}
