import type { Metadata } from 'next';
import { AdminShell } from '@/components/admin/admin-shell';
import { QueryProvider } from '@/components/query-provider';
import { StaffRouteGuard } from '@/components/admin/staff-route-guard';
import { NetworkBanner } from '@/components/ui/network-banner';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

/**
 * Points the browser at this municipality's own manifest.
 *
 * Declared on the protected layout rather than at the root because there is no
 * root-level answer: the manifest's `start_url` has to carry the tenant and
 * that tenant's obscure admin segment, both of which are route params here and
 * nowhere above. The login page sits outside this layout and deliberately gets
 * no manifest — offering to install the portal to someone who has not proved
 * they work for the municipality tells them it exists.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): Promise<Metadata> {
  const { tenant, locale, adminPath } = await params;

  return {
    manifest: `/${tenant}/${locale}/${adminPath}/manifest.webmanifest`,
    appleWebApp: {
      // iOS reads this rather than the manifest's `display`, and without it the
      // home-screen icon opens a Safari tab — which is the thing being
      // discarded in the first place.
      capable: true,
      statusBarStyle: 'default',
    },
  };
}

/**
 * The municipality's display name, for the header breadcrumb and the drawer.
 *
 * Fetched here rather than read from the session because it is public, cached
 * config — the same endpoint `TenantLayout` already calls, so Next dedupes the
 * two into one request — and because the header must be able to say which
 * municipality this is before a session exists at all.
 */
async function getTenantName(slug: string, locale: string = 'ar'): Promise<string | undefined> {
  try {
    const response = await fetch(`${API_URL}/t/${slug}/tenant/config`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return undefined;
    const config = (await response.json()) as { name?: string; nameAr?: string };
    return locale === 'en' ? (config.name ?? config.nameAr) : (config.nameAr ?? config.name);
  } catch {
    // The breadcrumb falls back to «البلدية» / "Municipality".
    return undefined;
  }
}

/**
 * Wraps every staff screen except login in the admin chrome.
 *
 * A route group (`(protected)`) rather than a real segment — it adds nothing
 * to the URL, so `/{tenant}/{locale}/{adminPath}/dashboard` is unchanged, but
 * it lets `login/page.tsx` sit outside this layout and render full-screen with
 * no navigation at all, matching a page whose whole point is to say nothing
 * about the portal to anyone without credentials.
 *
 * The gate lives here now, in `StaffRouteGuard`, rather than being repeated in
 * each screen's first effect: one place decides "no session → login" and "wrong
 * role → this role's own landing page", so a new page under this layout is
 * guarded by existing.
 *
 * Still a server component: the shell beneath it is the client boundary, so
 * the route params and the tenant name are resolved here and passed down as
 * props rather than re-fetched in the browser.
 */
export default async function ProtectedAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = await params;
  const tenantName = await getTenantName(tenant, locale);

  return (
    /* Outermost of the three, because it is the longest-lived: the staff read
       cache has to survive every navigation between screens, which is the whole
       reason it exists. See `QueryProvider` for why it is mounted here rather
       than at the root. */
    <QueryProvider>
      {/* One provider for every staff screen — Radix requires an ancestor
          provider, and it is also what keeps the hint delay consistent rather
          than per-table. 200ms: long enough not to fire while the cursor crosses
          a row of icons, short enough to feel immediate on the one being aimed
          at. */}
      <TooltipProvider delayDuration={200}>
        {/* Outside the shell rather than inside it: a toast raised by a page
            must outlive that page's own unmount, so the viewport holding it
            cannot be a descendant of the route being replaced. */}
        <ToastProvider>
          <AdminShell
            tenant={tenant}
            locale={locale}
            adminPath={adminPath}
            tenantName={tenantName}
          >
            {/* Inside the shell rather than around it: the chrome is what makes
                the redirect look like a page loading rather than a blank tab. */}
            {/* Above the page and inside the shell: a dropped signal is a fact
                about the whole screen, so it is said once here rather than by
                each page that happens to notice its own fetch failed. */}
            <NetworkBanner locale={locale} />
            <StaffRouteGuard tenant={tenant} base={`/${tenant}/${locale}/${adminPath}`}>
              {children}
            </StaffRouteGuard>
          </AdminShell>
        </ToastProvider>
      </TooltipProvider>
    </QueryProvider>
  );
}
