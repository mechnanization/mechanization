/**
 * Side-effect module: starts error reporting, and nothing else.
 *
 * It exists as its own file because *import order* is the requirement, and a
 * bare `initSentry()` call sitting between the imports of `main.ts` does not
 * reliably express it. Under CommonJS it happens to work; under ESM the imports
 * hoist above it and the SDK starts after the app has already been constructed,
 * which is the difference between catching a failed env validation and never
 * hearing about it. A module whose *import* is the call has the same meaning
 * under both, and is the pattern Sentry documents for exactly this reason.
 *
 * Both entry points import this first — `main.ts` for the long-lived process,
 * `serverless.ts` for the Vercel function. Anything that boots the Nest app
 * without importing it gets an app with no error reporting, silently, so a new
 * entry point needs this line as its first.
 */
import { initSentry } from './config/sentry';

initSentry();
