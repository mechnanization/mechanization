import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from '../app.module';
import { APP_CONFIG } from './config/app.config';
import { AppLogger } from './config/app-logger';
import { METRICS_ROUTE, useHttpMetrics } from './metrics.module';

/**
 * Builds the configured application without starting a listener.
 *
 * Split out of `main.ts` because there are now two ways this API runs: a
 * long-lived process that calls `listen()` (Docker, `pnpm dev`), and a Vercel
 * serverless function that only calls `init()` and hands the underlying Express
 * instance to the platform. Both need *identical* middleware, prefix and CORS
 * configuration — duplicating it was how the two would quietly drift, and the
 * drift that costs the most is a CORS or helmet difference that only appears in
 * production.
 */
export async function createApiApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    logger: new AppLogger(),
    /**
     * Keeps the untouched request bytes on `request.rawBody`.
     *
     * The Whish callback is authenticated by an HMAC over exactly what the
     * provider sent. Re-serialising the parsed object changes key order and
     * whitespace, so a signature computed over the bytes would never match one
     * computed over `JSON.stringify(req.body)` — this is the difference between
     * a verified webhook and one that always fails.
     */
    rawBody: true,
  });
  const config = app.get(ConfigService);

  // First, so the request clock covers every layer below and a request any of
  // them rejects is still counted. See `useHttpMetrics`.
  useHttpMetrics(app);

  // `/metrics` is the one route outside the prefix. See `APP_CONFIG.metricsPath`.
  app.setGlobalPrefix(APP_CONFIG.apiPrefix, { exclude: [METRICS_ROUTE] });
  app.use(helmet());
  app.use(compression());

  /**
   * Body limit, raised from body-parser's 100 KB default.
   *
   * The citizen import posts a batch of spreadsheet rows as JSON, and Arabic
   * text is two bytes a character in UTF-8 — a couple of hundred rows across
   * twenty-nine columns clears 100 KB comfortably, which surfaced as a 500
   * (`PayloadTooLargeError`) rather than as anything the clerk could act on.
   *
   * 1 MB rather than the "just make it big" 50 MB: the client sends the file
   * in fixed-size batches, so no single request needs more than a few hundred
   * KB, and an unbounded limit on every other route is a memory-exhaustion
   * surface bought for no benefit. `useBodyParser` is Nest's own API — reaching
   * for `express.json()` directly would mean importing a package this app does
   * not declare, which pnpm's strict linking is right to refuse.
   */
  app.useBodyParser('json', { limit: '1mb' });

  app.enableCors({
    origin: config.get<string[]>('CORS_ORIGINS') ?? ['http://localhost:3000'],
    credentials: true,
  });

  /**
   * No global ValidationPipe: validation is Zod's job, through
   * `ZodValidationPipe` with schemas shared with the frontend. Running
   * class-validator alongside it would mean two sources of truth for what a
   * valid submission is.
   */

  // Lets Prisma clients and the tenant client cache close cleanly on SIGTERM.
  app.enableShutdownHooks();

  return app;
}
