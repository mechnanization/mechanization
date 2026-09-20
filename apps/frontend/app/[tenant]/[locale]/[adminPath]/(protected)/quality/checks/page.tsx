'use client';

import { use, useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { QUALITY_CHECK_ROLES } from '@mechanization/shared-schemas';
import { getOfficerQuality } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { QualityScreen } from '@/components/admin/quality/quality-screen';
import { ChecksPanel } from '@/components/admin/quality/checks-panel';

/**
 * «التحقق الميداني» — a share of each officer's records, re-checked on the
 * ground by somebody else.
 */
export default function QualityChecksPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';

  return (
    <QualityScreen
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      icon={ClipboardList}
      title={en ? 'Field re-checks' : 'التحقق الميداني'}
      subtitle={
        en
          ? 'A sample of each officer’s records, checked again at the door by someone else.'
          : 'عيّنة من سجلات كل موظف، يُعاد التحقق منها على الباب بواسطة موظف آخر.'
      }
    >
      {({ token, base }) => <ChecksBody tenant={tenant} base={base} locale={locale} token={token} />}
    </QualityScreen>
  );
}

/** Whom a re-check can be handed to: the server refuses anyone else. */
function ChecksBody({
  tenant,
  base,
  locale,
  token,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string;
}): React.JSX.Element {
  const staff = useStaffQuery({
    queryKey: ['quality-officers', tenant, 'all'],
    queryFn: (tok, signal) => getOfficerQuality(tenant, tok, {}, signal),
    tenant,
    base,
    token,
    errorMessage: '',
  });

  const checkers = useMemo(
    () =>
      (staff.data?.officers ?? [])
        .filter(
          (person) =>
            person.isActive && (QUALITY_CHECK_ROLES as readonly string[]).includes(person.role ?? ''),
        )
        .map((person) => ({ id: person.id, name: person.name })),
    [staff.data],
  );

  return (
    <ChecksPanel tenant={tenant} base={base} locale={locale} token={token} canReview officers={checkers} />
  );
}
