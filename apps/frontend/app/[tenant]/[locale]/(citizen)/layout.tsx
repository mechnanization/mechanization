import { notFound } from 'next/navigation';
import { fetchTenantConfig } from '@/lib/tenant-config.server';
import { ThemeToggle } from '@/components/theme-toggle';
import { LanguageSwitcher } from '@/components/language-switcher';

/**
 * The citizen portal's chrome: municipality header, a `max-w-3xl` reading
 * column, and a support-phone footer.
 *
 * Scoped to this route group on purpose — `/login`, `/my-account`,
 * `/payments` and the landing page all want a citizen reading their own phone
 * at arm's length. The staff portal under `[adminPath]/**` sits outside this
 * group entirely and provides its own full-width shell.
 */
export default async function CitizenLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = await params;
  const config = await fetchTenantConfig(tenant);
  if (!config) notFound();

  const { branding } = config;

  return (
    <>
      <header className="border-b bg-background">
        <div className="container flex items-center gap-4 py-4">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt="" className="h-12 w-12 object-contain" />
          ) : (
            <div
              aria-hidden
              className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground"
            >
              {config.nameAr.slice(0, 2)}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight">
              {locale === 'en' ? (config.name || config.nameAr) : (config.nameAr || config.name)}
            </p>
            <p className="text-sm text-muted-foreground">
              {locale === 'en' ? 'Property & Residency Registry' : 'تسجيل العقارات والوحدات السكنية'}
            </p>
          </div>

          {/* `ms-auto` rather than `justify-between` on the row: the header has
              three children at some widths and only the toggle should be
              pushed to the far edge. */}
          <div className="ms-auto flex items-center gap-2 shrink-0">
            <LanguageSwitcher currentLocale={locale} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container max-w-3xl py-8">{children}</main>

      <footer className="mt-16 border-t py-6 text-center text-sm text-muted-foreground">
        {config.supportPhone ? (
          <p>
            {locale === 'en' ? 'For assistance, contact the municipality: ' : 'للمساعدة اتصل بالبلدية: '}
            <a
              className="font-medium text-primary hover:underline"
              href={`tel:${config.supportPhone}`}
            >
              {config.supportPhone}
            </a>
          </p>
        ) : null}
      </footer>
    </>
  );
}
