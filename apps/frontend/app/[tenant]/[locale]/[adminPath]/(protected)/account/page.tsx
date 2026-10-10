'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, User } from 'lucide-react';
import { loadSession, type Session } from '@/lib/session';
import { settingsCopy } from '@/lib/settings-i18n';
import { PageHeader } from '@/components/ui/page-header';
import { SecuritySection } from '@/components/admin/settings/security-section';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { getLabels } from '@mechanization/shared-schemas';

/**
 * Account Security page — accessible to all logged-in staff members.
 *
 * Provides personal credential management: email change, password reset,
 * TOTP/2FA authenticator enrollment, and login session monitoring.
 */
export default function AccountSecurityPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const copy = settingsCopy(locale);
  const labels = getLabels(locale);

  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const loaded = loadSession(tenant);
    if (!loaded || loaded.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setSession(loaded);
  }, [tenant, base, router]);

  if (!session) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-[24rem] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const role = session.user.role;
  const roleLabel = role ? labels.staffRole?.[role as never] ?? role : '';

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={ShieldCheck}
        title={locale === 'en' ? 'Account Security' : 'أمان الحساب'}
      />

      {/* User profile summary card */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
        <div className="flex items-center gap-3.5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
            <User className="size-6" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {session.user.name || (locale === 'en' ? 'Staff Member' : 'موظف البلدية')}
              </h2>
              {role ? (
                <Badge variant="secondary" className="rounded-md font-medium text-xs">
                  {roleLabel}
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {locale === 'en' ? 'Signed in as' : 'مسجّل الدخول كـ'}{' '}
              <span className="font-mono font-medium text-foreground">{session.user.id}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="min-w-0">
        <SecuritySection
          tenant={tenant}
          token={session.accessToken}
          userId={session.user.id}
          locale={locale}
          copy={copy}
          base={base}
        />
      </div>
    </div>
  );
}