'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The boundary for everything under a municipality and a locale — which is the
 * whole application.
 *
 * It sits *inside* `[locale]/layout.tsx`, so `NextIntlClientProvider` has
 * already run and this can be translated properly. An error in that layout
 * itself bubbles past this to `app/global-error.tsx`, which is why that file
 * cannot rely on translations and this one can.
 *
 * `reset()` re-renders the segment without a full page load. That matters more
 * here than it looks: an officer in the field has a queue of unsent
 * registrations in IndexedDB, and while a reload would not lose them, the
 * offline engine would have to re-read and re-drain the whole queue. Retrying
 * the segment keeps the session and the queue exactly where they were.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common');

  useEffect(() => {
    /*
      Reported once per error, keyed on the error object.

      This is the boundary that catches client render failures — the category
      that previously reached nobody at all. A server-side failure at least left
      a line in a Vercel log; a component throwing in an officer's browser left
      nothing anywhere, which is the gap this whole change is about.
    */
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-4 text-center">
        <AlertTriangle className="mx-auto size-10 text-destructive" aria-hidden />

        <h1 className="text-xl font-bold">{t('error')}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('errorBody')}</p>

        {/*
          The digest is Next.js's opaque id for a server error — it replaces the
          message in production so internals never reach a browser, and the same
          value is on the Sentry event. Quoting it is what lets a clerk on the
          phone be connected to the exact report without the screen printing a
          stack trace to do it.
        */}
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground/70" dir="ltr">
            {t('errorReference')}: {error.digest}
          </p>
        ) : null}

        <Button onClick={reset}>{t('retry')}</Button>
      </div>
    </div>
  );
}
