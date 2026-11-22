'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { getRequestForm, type RequestFormView } from '@/lib/request-forms-api';
import { hasRole, REQUEST_SETTINGS_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { FormBuilder } from '@/components/admin/request-forms/form-builder';
import { FormSettings } from '@/components/admin/request-forms/form-settings';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { PageHeader } from '@/components/ui/page-header';

/**
 * One request form: its settings and its questions (open decisions §24, docs/request-forms-plan.md §6). Read by everyone who
 * reads requests; the manager alone writes (`REQUEST_SETTINGS_ROLES`), and the server refuses anyone else whatever the screen
 * shows (CODE-4).
 */
export default function RequestFormPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; formId: string }>;
}) {
  const { tenant, locale, adminPath, formId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.forms.builder');
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canManage = user ? hasRole(REQUEST_SETTINGS_ROLES, user.role) : false;
  const queryKey = ['request-forms', tenant, 'form', formId] as const;

  const query = useStaffQuery({
    queryKey,
    queryFn: (accessToken, signal) => getRequestForm(tenant, accessToken, formId, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    fresh: true,
  });
  const form = query.data;

  const setForm = (next: RequestFormView) => queryClient.setQueryData(queryKey, next);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/requests/forms`} label={t('back')} />
      <PageHeader icon={FileText} title={form ? (locale === 'en' && form.nameEn ? form.nameEn : form.nameAr) : t('back')} />

      {query.loading && !form ? <LoadingState /> : null}
      {query.error && !form ? <ErrorState description={query.error} onRetry={query.refetch} /> : null}

      {form && token ? (
        <>
          {/* Remounted on every answer from the server, so the local questions start from what it holds. */}
          <FormSettings
            key={`settings-${form.updatedAt}`}
            tenant={tenant}
            token={token}
            locale={locale}
            form={form}
            canManage={canManage}
            onSaved={setForm}
          />
          <FormBuilder
            key={`${form.draft?.id ?? 'none'}-${form.draft?.revision ?? 0}-${form.current?.id ?? 'none'}-${form.enabled}-${form.archivedAt ?? ''}`}
            tenant={tenant}
            token={token}
            locale={locale}
            base={base}
            form={form}
            canManage={canManage}
            onForm={setForm}
            onReload={() => void query.refetch()}
          />
        </>
      ) : null}
    </div>
  );
}
