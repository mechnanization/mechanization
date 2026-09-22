import * as Sentry from '@sentry/nextjs';
import { SHARED_SENTRY_OPTIONS } from '@/lib/sentry-options';

/**
 * Sentry for the **edge** runtime, which in this app means `middleware.ts`.
 *
 * Small surface and a high-consequence one: the middleware builds the
 * Content-Security-Policy that keeps an injected script from reading the staff
 * token out of `localStorage`. A middleware that throws is a page served
 * without that header, so a silent failure here is a security regression rather
 * than a broken screen.
 *
 * Loaded by `instrumentation.ts`, never imported directly.
 */
Sentry.init({
  ...SHARED_SENTRY_OPTIONS,
  debug: false,
});
