'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Building2,
  Coins,
  Hash,
  Map as MapIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { loadSession } from '@/lib/session';
import { settingsCopy, type SettingsCopy } from '@/lib/settings-i18n';
import { PageHeader } from '@/components/ui/page-header';
import { ProfileSection } from '@/components/admin/settings/profile-section';
import { FinanceSection } from '@/components/admin/settings/finance-section';
import { NumberingSection } from '@/components/admin/settings/numbering-section';
import { UsersSection } from '@/components/admin/settings/users-section';
import { CadastreSection } from '@/components/admin/settings/cadastre-section';
import { SettingsTabs } from '@/components/admin/settings/settings-ui';
import { Skeleton } from '@/components/ui/skeleton';

type SectionId =
  | 'profile'
  | 'finance'
  | 'numbering'
  | 'cadastre'
  | 'users';

interface SectionDef {
  id: SectionId;
  icon: LucideIcon;
  label: (copy: SettingsCopy) => string;
}

/**
 * The settings sections, in the order a municipality sets them up.
 *
 * No backup section: backups are taken on the AWS side, and the page that
 * downloaded and restored snapshots from here is withdrawn until it is rebuilt
 * on top of them. `BackupSection` is kept, unrendered, for that rebuild; its
 * endpoints are unregistered in `PresentationModule`.
 */
const SECTIONS: SectionDef[] = [
  { id: 'profile', icon: Building2, label: (copy) => copy.nav.profile },
  { id: 'finance', icon: Coins, label: (copy) => copy.nav.finance },
  { id: 'numbering', icon: Hash, label: (copy) => copy.nav.numbering },
  { id: 'cadastre', icon: MapIcon, label: (copy) => copy.nav.cadastre },
  { id: 'users', icon: UsersRound, label: (copy) => copy.nav.users },
];

/**
 * إعدادات البلدية — every configuration surface the municipality owns.
 *
 * Restricted to SUPER_ADMIN. Personal account security (passwords, 2FA,
 * email) has its own dedicated page at `/account` available to all staff.
 */
export default function SettingsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const copy = settingsCopy(locale);

  const [token, setToken] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>('profile');

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    if (session.user.role !== 'SUPER_ADMIN') {
      router.replace(`${base}/dashboard`);
      return;
    }
    setToken(session.accessToken);
  }, [tenant, base, router]);

  if (!token) {
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
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-[28rem] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          icon={SettingsIcon}
          title={copy.page.title}
          subtitle={copy.page.subtitle}
        />

        {/* Quick link to personal account security */}
        <Link
          href={`${base}/account`}
          className="inline-flex items-center gap-2 rounded-lg border border-border/80 bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-2xs"
        >
          <ShieldCheck className="size-4 text-primary" />
          <span>{locale === 'en' ? 'My Account & Security' : 'أمان الحساب الشخصي'}</span>
        </Link>
      </div>

      <div className="space-y-4">
        <SettingsTabs
          items={SECTIONS.map((section) => ({
            id: section.id,
            icon: section.icon,
            label: section.label(copy),
          }))}
          active={active}
          onSelect={setActive}
          label={copy.nav.label}
        />

        <div className="min-w-0">
          {active === 'profile' ? (
            <ProfileSection tenant={tenant} token={token} copy={copy} />
          ) : null}
          {active === 'finance' ? (
            <FinanceSection tenant={tenant} token={token} locale={locale} copy={copy} />
          ) : null}
          {active === 'numbering' ? (
            <NumberingSection tenant={tenant} token={token} copy={copy} />
          ) : null}
          {active === 'cadastre' ? (
            <CadastreSection tenant={tenant} token={token} copy={copy} />
          ) : null}
          {active === 'users' ? (
            <UsersSection tenant={tenant} token={token} copy={copy} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
