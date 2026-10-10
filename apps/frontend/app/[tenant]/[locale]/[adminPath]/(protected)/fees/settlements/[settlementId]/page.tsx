'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { ReceiptText } from 'lucide-react';
import { getMunicipalitySettings, getPaymentSettlement, getTenantConfig } from '@/lib/api-client';
import { RECEIPT_SEND_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { BackLink } from '@/components/ui/back-link';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { BulkPaymentReceipt } from '@/components/admin/bulk-settle/bulk-payment-receipt';

/**
 * «وصل قبض بلدي مجمّع» — one consolidated receipt, by its settlement's id.
 *
 * Where «تسديد الفواتير المحددة» lands once the server has answered: the
 * dialog puts its answer under this page's key before it navigates, so the
 * receipt is on screen at once with nothing to fetch, and a reload or a later
 * visit reads it again (`GET fees/settlements/:id`, `FEE_READ_ROLES`, the roles
 * that reach /fees). A page rather than a dialog because a receipt is reprinted
 * and handed over: it has an address (BAN-10), and it prints as a document
 * (PRIM-28).
 */
export default function SettlementReceiptPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; settlementId: string }>;
}) {
  const { tenant, locale, adminPath, settlementId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('bulkSettle.reprint');
  const { token, user } = useStaffSession(tenant, base);

  const receiptQuery = useStaffQuery({
    queryKey: ['fees-settlement', tenant, settlementId],
    queryFn: (accessToken, signal) => getPaymentSettlement(tenant, accessToken, settlementId, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  // The heading's governorate, district and office numbers. A receipt without them is still the receipt.
  const settingsQuery = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (accessToken) => getMunicipalitySettings(tenant, accessToken),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const configQuery = useStaffQuery({
    queryKey: ['tenant-config', tenant],
    queryFn: () => getTenantConfig(tenant),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    reference: true,
  });

  const receipt = receiptQuery.data;
  const settings = settingsQuery.data ?? null;
  const config = configQuery.data;
  // The municipality's own name on its heading, as the single receipt prints it.
  const municipalityName = config ? config.nameAr || config.name : tenant;

  if (!token || (receiptQuery.loading && !receipt)) {
    return (
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <LoadingState fullHeight label={t('loading')} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/fees`} label={t('back')} />
      <PageHeader icon={ReceiptText} title={receipt ? t('title', { number: receipt.number }) : t('titleLoading')} />

      {receiptQuery.error && receipt ? (
        <RefreshFailedAlert message={receiptQuery.error} onRetry={receiptQuery.refetch} />
      ) : null}

      {receipt ? (
        <BulkPaymentReceipt
          receipt={receipt}
          locale={locale}
          municipalityName={municipalityName}
          governorate={settings?.governorate}
          district={settings?.district}
          contactPhone={settings?.contactPhone}
          officeWhatsapp={settings?.whatsappNumber}
          canSend={hasRole(RECEIPT_SEND_ROLES, user?.role)}
        />
      ) : (
        <ErrorState title={receiptQuery.error ?? t('loadError')} onRetry={receiptQuery.refetch} retryLabel={t('retry')} />
      )}
    </div>
  );
}
