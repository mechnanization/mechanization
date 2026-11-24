'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The boundary for one staff page, drawn inside the shell (ERR-07).
 *
 * Until this file, the nearest boundary was `[locale]/error.tsx`, which sits
 * *above* `ProtectedAdminLayout`: a page that threw replaced the shell with it,
 * sidebar and header included, and the only way to another screen was a
 * reload. A boundary placed beside this folder's `layout.tsx` catches what the
 * pages below it throw while the layout stays mounted, so the navigation is
 * still there. It does not catch an error in the layout itself; that still
 * bubbles to `[locale]/error.tsx` and `global-error.tsx`.
 *
 * What survives a reload anyway — the offline queue (IndexedDB) and the held
 * retry keys (module state) — is untouched by this, which is the other reason
 * to prefer `reset()` to a reload: the session and the page's own providers
 * stay where they were.
 *
 * The words are `messages.common`, as `[locale]/error.tsx` takes them: this
 * renders inside `NextIntlClientProvider`, so they follow the page's locale.
 */
export default function StaffPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common');
  const { tenant, locale, adminPath } = useParams<{
    tenant: string;
    locale: string;
    adminPath: string;
  }>();

  useEffect(() => {
    // This boundary now catches what `[locale]/error.tsx` used to, so it
    // reports it: a render failure in an officer's browser would otherwise
    // reach nobody.
    Sentry.captureException(error);
  }, [error]);

  return (
    <div role="alert" className="flex min-h-[50vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-4 text-center">
        <AlertTriangle className="mx-auto size-10 text-destructive" aria-hidden />

        <h1 className="text-xl font-bold">{t('error')}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('errorBody')}</p>

        {/* Next's opaque id for the failure, also on the Sentry event: what a clerk can quote on the phone. */}
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground/70" dir="ltr">
            {t('errorReference')}: {error.digest}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset}>{t('retry')}</Button>
          <Button asChild variant="outline">
            <Link href={`/${tenant}/${locale}/${adminPath}`}>{t('errorHome')}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
