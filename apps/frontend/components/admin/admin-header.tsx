'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  BadgeDollarSign,
  ChevronLeft,
  Languages,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  ShieldCheck,
  Sun,
  User,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { activeNavItem, localizedLabel } from '@/components/admin/nav';
import { NotificationsBell } from '@/components/admin/notifications-bell';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getLabels } from '@mechanization/shared-schemas';
import type { Session } from '@/lib/api-client';
import { clearSession } from '@/lib/session';

/**
 * The bar across the top of every staff screen.
 *
 * There was no header at all before this: the sidebar carried navigation, the
 * theme toggle, the language switch and sign-out, and each page re-stated its
 * own name in its `PageHeader` with nothing above it. That left three problems
 * this fixes together — a phone had no way to reach navigation once the rail
 * was hidden, there was no persistent place for a search that spans sections,
 * and "which municipality am I signed into, as whom" was answerable only by
 * opening a page that happened to say so.
 *
 * Sticky rather than fixed: the sidebar is a flex sibling, so a fixed header
 * would need its inset-inline-start hard-coded to the rail's width and kept in
 * sync with the collapse toggle. Sticky inside the scrolling column costs none
 * of that and behaves correctly at every rail width.
 */
export function AdminHeader({
  tenant,
  locale,
  adminPath,
  tenantName,
  session,
  onOpenDrawer,
  onOpenSearch,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  tenantName: string | undefined;
  session: Session | null;
  onOpenDrawer: () => void;
  onOpenSearch: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const role = session?.user.role;
  const active = activeNavItem(pathname, base, role);

  // Nothing theme-dependent renders until after hydration: the server cannot
  // know the stored choice, so marking the current radio item on the first
  // render is a guaranteed mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /** A detail route — `/citizens/:id` — sits one level under its section. */
  const onDetailRoute = Boolean(active && pathname !== `${base}${active.path}`);

  /*
   * What the last crumb says.
   *
   * It read «التفاصيل» for every sub-route, which is wrong on exactly the two
   * that are not details: `/citizens/new` is a blank form and
   * `/citizens/:id/edit` is that form filled in. A clerk halfway through
   * entering a resident was told they were looking at that resident's details,
   * which is the one thing the page is not.
   */
  const leafLabel = ((): string => {
    const last = (pathname ?? '').split('/').filter(Boolean).pop();
    if (last === 'new') return locale === 'en' ? 'New' : 'جديد';
    if (last === 'edit') return locale === 'en' ? 'Edit' : 'تعديل';
    return locale === 'en' ? 'Details' : 'التفاصيل';
  })();

  function switchLanguage(): void {
    const other = locale === 'ar' ? 'en' : 'ar';
    // Swaps only the locale segment, so switching language keeps whatever page
    // (and sub-route, e.g. a citizen's id) is open rather than bouncing back
    // to the dashboard.
    router.push((pathname ?? base).replace(`/${tenant}/${locale}/`, `/${tenant}/${other}/`));
  }

  function signOut(): void {
    clearSession(tenant);
    router.replace(`${base}/login`);
  }

  const rawDisplayName = session?.user.name ?? '';
  const labels = getLabels(locale);
  // If the stored username is the default 'مدير النظام' or blank, translate it
  const displayName =
    locale === 'en' && (rawDisplayName === 'مدير النظام' || !rawDisplayName)
      ? (role ? labels.staffRole?.[role as never] ?? 'System Administrator' : 'Administrator')
      : (rawDisplayName || (locale === 'en' ? 'User' : 'مستخدم'));

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 lg:hidden"
        onClick={onOpenDrawer}
        aria-label={locale === 'en' ? 'Open Menu' : 'فتح القائمة'}
      >
        <Menu className="size-5" />
      </Button>

      {/* Breadcrumb. The municipality's own name is the root rather than a
          generic "الرئيسية": with one portal per tenant, the thing a clerk
          needs confirmed at a glance is *which* municipality's records are on
          screen — the answer to "am I about to edit the wrong town". */}
      <nav aria-label={locale === 'en' ? 'Breadcrumb' : 'مسار التنقل'} className="flex min-w-0 items-center gap-1.5 text-sm">
        <Link
          href={`${base}/dashboard`}
          className="hidden shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          {tenantName ?? (locale === 'en' ? 'Municipality' : 'البلدية')}
        </Link>
        {active ? (
          <>
            <ChevronLeft className="size-4 shrink-0 text-muted-foreground/60 rtl:rotate-180" aria-hidden />
            <Link
              href={`${base}${active.path}`}
              className={
                onDetailRoute
                  ? 'hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground sm:inline'
                  : 'truncate font-medium text-foreground'
              }
            >
              {localizedLabel(active, locale)}
            </Link>
          </>
        ) : null}
        {onDetailRoute ? (
          <>
            <ChevronLeft className="size-4 shrink-0 text-muted-foreground/60 rtl:rotate-180" aria-hidden />
            <span className="truncate font-medium text-foreground">{leafLabel}</span>
          </>
        ) : null}
      </nav>

      <div className="flex-1" />

      {/* Global search launcher: Cmd/Ctrl+K or click.
          Search covers citizens by name/phone/file-number, properties by
          cadastral number, and navigation items. */}
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenSearch}
        className="hidden h-9 w-64 items-center justify-between text-muted-foreground hover:text-foreground md:flex"
        aria-label={locale === 'en' ? 'Global search' : 'بحث عام في السجل'}
      >
        <span className="flex items-center gap-2 text-xs">
          <Search className="size-3.5" />
          <span>{locale === 'en' ? 'Search…' : 'بحث في السجل…'}</span>
        </span>
        <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground">
          <span className="text-xs">Ctrl</span>K
        </kbd>
      </Button>

      {/* Language Switcher */}
      <div className="px-1">
        <LanguageSwitcher variant="toggle" currentLocale={locale} />
      </div>

      {/* Sits before the account menu rather than after it: this is work
          arriving, and the account menu is the one control on this bar
          that is never about the municipality's records. */}
      <NotificationsBell
        tenant={tenant}
        token={session?.accessToken}
        role={role}
        base={base}
        locale={locale}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="shrink-0 gap-2 px-2" aria-label={locale === 'en' ? 'My Account' : 'حسابي'}>
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <User className="size-4" />
            </span>
            <span className="hidden max-w-[12rem] truncate text-sm md:inline">{displayName}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="space-y-0.5">
            <span className="block truncate text-sm font-semibold text-foreground">
              {displayName}
            </span>
            {role ? (
              <span className="block text-xs font-normal">
                {labels.staffRole?.[role as never] ?? role}
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => router.push(`${base}/inspector/profile`)}>
            <BadgeDollarSign className="size-4" aria-hidden />
            <span>{locale === 'en' ? 'My Earnings & Field Work' : 'أرباحي والمسح الميداني'}</span>
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => router.push(`${base}/account`)}>
            <ShieldCheck className="size-4" aria-hidden />
            <span>{locale === 'en' ? 'Account Security' : 'أمان الحساب'}</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>{locale === 'en' ? 'Theme' : 'المظهر'}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={mounted ? (theme ?? 'system') : undefined}
            onValueChange={setTheme}
          >
            {[
              { value: 'light', label: locale === 'en' ? 'Light' : 'فاتح', icon: Sun },
              { value: 'dark', label: locale === 'en' ? 'Dark' : 'داكن', icon: Moon },
              { value: 'system', label: locale === 'en' ? 'System' : 'النظام', icon: Monitor },
            ].map((option) => {
              const Icon = option.icon;
              return (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <Icon className="size-4" aria-hidden />
                  <span>{option.label}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={switchLanguage}>
            <Languages aria-hidden />
            <span>{locale === 'ar' ? 'English' : 'عربي'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={signOut}>
            <LogOut aria-hidden />
            <span>{locale === 'en' ? 'Sign out' : 'تسجيل الخروج'}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

