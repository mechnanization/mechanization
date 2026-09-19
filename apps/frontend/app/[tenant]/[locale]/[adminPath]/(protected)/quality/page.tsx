'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardCheck, ClipboardList, ShieldQuestion, UsersRound } from 'lucide-react';
import { QUALITY_CHECK_ROLES } from '@mechanization/shared-schemas';
import { type Session } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { getOfficerQuality } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { ChecksPanel } from '@/components/admin/quality/checks-panel';
import { FindingsList } from '@/components/admin/quality/findings-list';
import { OfficerQuality } from '@/components/admin/quality/officer-quality';
import { ReviewQueue } from '@/components/admin/quality/review-queue';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';

const REVIEWER_ROLES = ['SUPER_ADMIN', 'AUDITOR', 'ADMINISTRATIVE_OFFICER'];

type Tab = 'reviews' | 'findings' | 'checks' | 'officers';

/**
 * «مراجعة الجودة» — the second pair of eyes, in four views.
 *
 * Records waiting for a decision; what the register itself says is probably
 * wrong; the sample re-checked on the ground; and how each officer's filings
 * are faring. They are one page because they are one job — and because the same
 * person doing it needs to move between "what is wrong" and "who to talk to"
 * without losing the thread.
 *
 * An officer's own side of this lives on «أرباحي والمسح الميداني»: records sent
 * back to them, and checks they can do.
 */
export default function QualityPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('reviews');

  useEffect(() => {
    const existing = loadSession(tenant);
    if (!existing || existing.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    if (!REVIEWER_ROLES.includes(existing.user.role ?? '')) {
      // An officer's own tasks live on their profile; this screen is oversight.
      router.replace(`${base}/inspector/profile`);
      return;
    }
    setSession(existing);
  }, [tenant, base, router]);

  /*
    Who has filed anything — the names the two selects offer.

    From the quality endpoint rather than the staff list, which is SUPER_ADMIN's
    alone: an AUDITOR may review records and would otherwise be handed an empty
    select by a 403.
  */
  const staff = useStaffQuery({
    queryKey: ['quality-officer-names', tenant],
    queryFn: (token, signal) => getOfficerQuality(tenant, token, {}, signal),
    tenant,
    base,
    token: session?.accessToken ?? null,
    errorMessage: '',
  });

  const officers = useMemo(
    () => (staff.data?.officers ?? []).map((person) => ({ id: person.id, name: person.name })),
    [staff.data],
  );

  // Whom a re-check can be handed to: the server refuses anyone else.
  const checkers = useMemo(
    () =>
      (staff.data?.officers ?? [])
        .filter((person) => person.isActive && (QUALITY_CHECK_ROLES as readonly string[]).includes(person.role ?? ''))
        .map((person) => ({ id: person.id, name: person.name })),
    [staff.data],
  );

  if (!session) return null;
  const token = session.accessToken;

  return (
    <div className="w-full space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={ClipboardCheck}
        title={en ? 'Quality review' : 'مراجعة الجودة'}
        subtitle={
          en
            ? 'A second pair of eyes on what the field filed — and what the register itself says is probably wrong.'
            : 'عين ثانية على ما سجَّله الميدان — وما يقول السجل نفسه إنه غالباً خطأ.'
        }
      />

      {/*
        Two by two on a phone, one row from `sm` up.
        Four Arabic labels of this length share 390px at about 85px each, which
        truncates «ملاحظات الجودة» to «ملاحظـ…» — four tabs nobody can tell
        apart. Wrapping them is the honest use of the space.
      */}
      <SegmentedControl
        className="grid grid-cols-2 gap-1 sm:inline-flex sm:gap-0"
        value={tab}
        onChange={(value) => setTab(value as Tab)}
        options={[
          { value: 'reviews', label: en ? 'Records' : 'السجلات', icon: ClipboardCheck },
          { value: 'findings', label: en ? 'Findings' : 'ملاحظات الجودة', icon: ShieldQuestion },
          { value: 'checks', label: en ? 'Field re-checks' : 'التحقق الميداني', icon: ClipboardList },
          { value: 'officers', label: en ? 'By officer' : 'حسب الموظف', icon: UsersRound },
        ]}
      />

      {tab === 'reviews' ? (
        <ReviewQueue tenant={tenant} base={base} locale={locale} token={token} officers={officers} />
      ) : tab === 'findings' ? (
        <FindingsList tenant={tenant} base={base} locale={locale} token={token} />
      ) : tab === 'checks' ? (
        <ChecksPanel tenant={tenant} base={base} locale={locale} token={token} canReview officers={checkers} />
      ) : (
        <OfficerQuality tenant={tenant} base={base} locale={locale} token={token} />
      )}
    </div>
  );
}
