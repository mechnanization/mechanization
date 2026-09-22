import 'reflect-metadata';
/**
 * First, and the order is load-bearing.
 *
 * The failures most worth a report happen during boot — env validation refusing
 * a malformed secret, the registry connection never opening, a module throwing
 * in its constructor — so the SDK has to be running before `createApiApp` is
 * even imported, let alone called. See `instrument.ts`.
 */
import './instrument';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApiApp } from './bootstrap';
import { APP_CONFIG } from './config/app.config';
import { flushSentry, sentryEnabled } from './config/sentry';

/**
 * The long-lived process is the one that holds the `@Cron` timers, so it is the
 * one where the process clock is part of the contract.
 *
 * `periodKeyFor` builds every billing period key from `getUTC*`, and the jobs
 * pin `timeZone: 'UTC'` on their decorators, so a non-UTC `TZ` no longer moves
 * either. What it still moves is every `new Date()` a human reads in a log line
 * — enough to make two deployments disagree about when something happened, and
 * not enough to justify refusing to boot. Hence a warning, printed once.
 */
function warnOnNonUtcClock(): void {
  const tz = process.env.TZ?.trim();
  if (!tz || tz.toUpperCase() === 'UTC') return;

  Logger.warn(
    `TZ is '${tz}', not UTC — scheduled jobs still fire on UTC (pinned on the @Cron decorators), ` +
      'but logged timestamps will not match other deployments. See docs/deploy-vercel.md §4.',
    'Bootstrap',
  );
}

/**
 * Boots the API as a long-lived process. The configuration itself lives in
 * `bootstrap.ts`, shared with the serverless entry point.
 */
async function bootstrap(): Promise<void> {
  warnOnNonUtcClock();

  const app = await createApiApp();
  const port = app.get(ConfigService).get<number>('PORT') ?? 4000;

  await app.listen(port);

  Logger.log(`API listening on http://localhost:${port}/${APP_CONFIG.apiPrefix}`, 'Bootstrap');
  // Said out loud on every boot, because an error reporter that is quietly off
  // is indistinguishable from one that is on and finding nothing — and «verify,
  // then report» (AGENTS.md §5) applies to a monitoring tool as much as to a
  // migration.
  Logger.log(
    sentryEnabled() ? 'Sentry error reporting enabled' : 'Sentry disabled (no SENTRY_DSN)',
    'Bootstrap',
  );
}

bootstrap().catch(async (error: unknown) => {
  Logger.error('Failed to start the API', error instanceof Error ? error.stack : error);
  // A boot failure is the one report guaranteed to be lost otherwise: the
  // process exits before the transport's own timer would have flushed it.
  await flushSentry();
  process.exit(1);
});
