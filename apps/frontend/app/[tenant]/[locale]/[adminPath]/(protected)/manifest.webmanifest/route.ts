import { NextResponse } from 'next/server';
import { tenantDisplayName } from '@/lib/tenant-config.server';

/**
 * The web app manifest — per municipality, and per admin path.
 *
 * Not `app/manifest.ts` at the root, which is Next's convention and would be
 * one file for the whole portal. A manifest's `start_url` is where the icon on
 * the home screen leads, and this portal has no single such place: every staff
 * route is `/{tenant}/{locale}/{adminPath}/…`, the tenant differs per
 * municipality, and `adminPath` is deliberately obscure per tenant. A root
 * manifest could only point at `/`, which rewrites to a 404.
 *
 * It also means the icon on a field officer's phone is *their* municipality's,
 * and that installing the portal for two municipalities gives two apps rather
 * than one that opens the wrong register.
 *
 * Why install at all: a standalone home-screen app is far less likely to be
 * discarded by the browser than a tab, and when it is killed it relaunches
 * into the shell the service worker holds. That is the difference between
 * "survives a dropped connection" and "works for an afternoon in a settlement".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenant: string; locale: string; adminPath: string }> },
) {
  const { tenant, locale, adminPath } = await params;
  const base = `/${tenant}/${locale}/${adminPath}`;
  const name = await tenantDisplayName(tenant, locale);

  const title = name
    ? locale === 'en'
      ? `${name} — Registry`
      : `${name} — السجل البلدي`
    : locale === 'en'
      ? 'Municipal Registry'
      : 'السجل البلدي';

  return NextResponse.json(
    {
      name: title,
      // What fits under an icon. The municipality's own name is the useful
      // half — a field officer may hold two of these.
      short_name: name ?? (locale === 'en' ? 'Registry' : 'السجل'),
      description:
        locale === 'en'
          ? 'Municipal citizens registry — register households in the field, with or without a connection.'
          : 'سجل المواطنين البلدي — تسجيل الأسر ميدانياً، باتصال أو بدونه.',

      /*
        Straight into the entry form rather than the dashboard.

        Someone who put this on their home screen did it to register people. A
        launch that lands on analytics costs a tap and a wait on a connection
        that may not be there, and it is the wrong screen to be looking at in a
        settlement.
      */
      start_url: `${base}/citizens/new`,
      scope: base,

      display: 'standalone',
      orientation: 'portrait',
      dir: locale === 'en' ? 'ltr' : 'rtl',
      lang: locale,

      background_color: '#f8fafc',
      theme_color: '#1d4ed8',

      /*
        One 1536px source, declared at its real size rather than lied about.

        Android scales down happily and this clears Chrome's installability
        floor several times over. `maskable` so the launcher may crop it to
        whatever shape the device uses instead of framing it in a white box.
      */
      icons: [
        {
          src: '/logo.png',
          sizes: '1536x1536',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],

      shortcuts: [
        {
          name: locale === 'en' ? 'Register a citizen' : 'تسجيل مواطن جديد',
          url: `${base}/citizens/new`,
        },
        {
          name: locale === 'en' ? 'Citizens registry' : 'سجل المواطنين',
          url: `${base}/citizens`,
        },
      ],
    },
    {
      headers: {
        'content-type': 'application/manifest+json; charset=utf-8',
        // Short rather than immutable: the municipality's name and branding can
        // change, and a manifest pinned for a year would outlive a rebrand.
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}
