'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminSidebar, SidebarNav } from '@/components/admin/admin-sidebar';
import { CommandPalette } from '@/components/admin/command-palette';
import { loadSession } from '@/lib/session';
import type { Session } from '@/lib/api-client';
import { useServiceWorker } from '@/lib/use-service-worker';
import { cn } from '@/lib/utils';

/**
 * The admin chrome: rail or drawer, header, and the page beneath them.
 *
 * The layout this replaces was two flex children — a permanently-mounted
 * 256px sidebar and a scrolling `<main>` — with no breakpoint anywhere in it.
 * That is fine on a laptop and unusable below one: on a 390px phone the rail
 * took two thirds of the viewport and left a data table 134px to render into,
 * and folding it to the 72px icon rail only moved the problem. Navigation
 * moves into a drawer below `lg`, and the width it was occupying goes to the
 * content.
 *
 * A client component because the drawer, the palette and the session are all
 * client state. The layout that renders it stays a server component, so the
 * route params are still resolved on the server and passed down as props.
 */
export function AdminShell({
  tenant,
  locale,
  adminPath,
  tenantName,
  children,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  tenantName: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const base = `/${tenant}/${locale}/${adminPath}`;

  /*
   * Installs the app shell on this device.
   *
   * Mounted at the chrome rather than on the entry form, so simply having
   * opened the portal once is enough to be covered later. An officer who only
   * thinks about it when they are already out of signal is too late — that is
   * the moment the shell is needed, not the moment it can be fetched.
   */
  useServiceWorker(base);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [session, setSession] = React.useState<Session | null>(null);

  /*
   * Re-read on every route change rather than once on mount. Signing out and
   * back in as a different role, or a session expiring mid-visit, has to
   * change which rows the sidebar offers without requiring a full reload —
   * the alternative is an auditor looking at a «الموظفون» link that can only
   * refuse them.
   */
  React.useEffect(() => {
    setSession(loadSession(tenant));
  }, [tenant, pathname]);

  // Close the drawer when the viewport grows past the breakpoint. Rotating a
  // tablet into landscape otherwise leaves the scrim over a layout that has
  // already put the rail back, with no visible way to dismiss it.
  React.useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Escape closes the drawer; Ctrl/⌘+K opens the palette from anywhere.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawerOpen(false);
      if (event.key?.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
        // The browser's own "search the page" is the shortcut being displaced,
        // and this is the search a clerk actually wants on a register of
        // twenty thousand people — the page holds one screen of them.
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Body scroll stays locked while the drawer is open, or the page behind
  // scrolls under the reader's finger as they swipe the panel.
  React.useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  const role = session?.user.role;

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <AdminSidebar tenant={tenant} locale={locale} adminPath={adminPath} role={role} />

      {/* Drawer. Mounted only while open so its links are not in the tab order
          of a page that is not showing them. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="إغلاق القائمة"
            className="absolute inset-0 cursor-default bg-black/60 animate-in fade-in"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="القائمة"
            className={cn(
              // Pinned to the inline-start edge, so it slides from the right
              // in this RTL portal and the left in an LTR one — the side the
              // rail occupies at desktop width, in both.
              'absolute inset-y-0 start-0 flex w-[17rem] max-w-[85vw] flex-col bg-card shadow-2xl',
              'animate-in duration-200 rtl:slide-in-from-right ltr:slide-in-from-left',
            )}
          >
            <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center">
                <img src="/logo.png" alt="" className="size-9 object-contain" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {locale === 'en' ? 'Municipality Portal' : 'لوحة البلدية'}
                </p>
                {tenantName ? (
                  <p className="truncate text-xs text-muted-foreground">{tenantName}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="إغلاق القائمة"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <X className="size-5" />
              </button>
            </div>
            <SidebarNav base={base} role={role} locale={locale} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <AdminHeader
          tenant={tenant}
          locale={locale}
          adminPath={adminPath}
          tenantName={tenantName}
          session={session}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenSearch={() => setPaletteOpen(true)}
        />
        {/* `min-w-0` on both this and the flex column above it: without it a
            wide table's intrinsic width wins the flex negotiation and pushes
            the whole column past the viewport, which is how a page ends up
            scrolling horizontally as a whole instead of inside its table. */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-background">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        base={base}
        locale={locale}
        tenant={tenant}
        token={session?.accessToken}
        role={role}
      />
    </div>
  );
}
