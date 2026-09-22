'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * The last boundary: a render error in the root layout itself.
 *
 * Next.js replaces the *entire* document when this renders, which is why it has
 * to supply its own `<html>` and `<body>` — the root layout is the thing that
 * failed, so none of its markup is available. That also means none of the app's
 * providers ran: no `next-intl`, so `useTranslations` would throw a second time
 * inside the handler for the first. The copy here is therefore hard-coded in
 * both languages rather than translated, and shown together.
 *
 * Reaching this screen means the shell is broken, not a page — so it offers a
 * reload and nothing else. A link into the app would be a link into the same
 * failure.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The one error the `error.tsx` boundaries below can never catch, because
    // they live inside the layout that failed.
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#0b0b0c',
          color: '#f4f4f5',
          padding: '1.5rem',
        }}
      >
        <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            تعذّر تحميل التطبيق
          </h1>
          <p style={{ opacity: 0.75, lineHeight: 1.7, marginBottom: '0.25rem' }}>
            حدث خطأ غير متوقع. يرجى إعادة تحميل الصفحة، وإن تكرر الأمر راجع البلدية.
          </p>
          <p
            lang="en"
            dir="ltr"
            style={{ opacity: 0.6, lineHeight: 1.7, marginBottom: '1.5rem', fontSize: '0.875rem' }}
          >
            Something went wrong while loading the application. Please reload the page.
          </p>

          {/*
            The digest, not the message.

            Next.js replaces server error messages with an opaque digest in
            production precisely so internals do not reach a browser, and the
            same digest is on the Sentry event — so quoting it is what connects
            a citizen at a counter to the report, without the screen having to
            show a stack trace to do it.
          */}
          {error.digest ? (
            <p
              dir="ltr"
              style={{ opacity: 0.45, fontSize: '0.75rem', fontFamily: 'monospace' }}
            >
              {error.digest}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1.5rem',
              padding: '0.625rem 1.5rem',
              // 48px: this is reachable on a phone, standing up, by an officer
              // whose app has just died.
              minHeight: '48px',
              borderRadius: '0.5rem',
              border: '1px solid rgba(244,244,245,0.25)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            إعادة التحميل · Reload
          </button>
        </main>
      </body>
    </html>
  );
}
