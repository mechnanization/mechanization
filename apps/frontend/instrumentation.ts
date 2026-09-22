import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook — the framework calls this once per server
 * runtime, before anything else is loaded.
 *
 * The dynamic imports are required rather than stylistic: the Node and edge
 * runtimes cannot both be bundled into one module, so each config is pulled in
 * only when its own runtime is the one starting.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Server-side errors Next.js catches before any of this app's code sees them.
 *
 * Without this export, an error thrown during a server render is handled by the
 * framework, turned into the nearest `error.tsx`, and never reported — the
 * component tree that failed is the one place an error boundary cannot observe
 * itself. This is the hook that closes that gap, and it is the reason a
 * `global-error.tsx` alone is not enough.
 */
export const onRequestError = Sentry.captureRequestError;
