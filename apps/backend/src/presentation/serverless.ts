import 'reflect-metadata';
/**
 * First, and before `createApiApp` is imported — see `instrument.ts`. On this
 * entry point it also covers the cold-start boot failures the `catch` below
 * reports, which are the ones a serverless deployment is most likely to hit and
 * least likely to notice.
 */
import './instrument';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { createApiApp } from './bootstrap';
import { flushSentry, reportException } from './config/sentry';

/**
 * Serverless entry point (Vercel).
 *
 * The platform gives us one Node process per warm instance and a plain
 * (req, res) handler, so instead of `listen()` we `init()` the application and
 * hand back the Express instance the default adapter already created. Reaching
 * for `express()` ourselves would mean importing a package this workspace does
 * not declare — pnpm's strict linking refuses it, and rightly.
 */
type ExpressLike = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Module-scope, so the *promise* is shared: two requests arriving on a cold
 * instance before boot finishes must await the same NestFactory call. Caching
 * the resolved app instead would let the second request start a second full
 * bootstrap — two more Prisma pools against a connection budget that is already
 * the scarcest resource here.
 */
let app: Promise<ExpressLike> | null = null;

async function instance(): Promise<ExpressLike> {
  const nest = await createApiApp();
  await nest.init();
  return nest.getHttpAdapter().getInstance() as ExpressLike;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!app) {
    /**
     * A failed boot must not be cached. Env validation and the first registry
     * connection both happen in here; if either fails transiently, every later
     * request on this instance would otherwise replay the same rejected promise
     * until the instance is recycled.
     */
    app = instance().catch((error: unknown) => {
      app = null;
      throw error;
    });
  }

  try {
    const express = await app;

    /*
      Hand the request to Express, then wait for the response to finish before
      returning — so that anything `DomainExceptionFilter` reported can be
      flushed.

      Without this, `handler` resolves the moment Express is *handed* the
      request, Vercel treats the invocation as complete, and the instance is
      frozen with the Sentry transport's queue still full. Every 500 the filter
      captured would be dropped on the way out, and the symptom is the cruel
      one: an error reporter that works perfectly in `pnpm dev` (long-lived
      process, transport drains on its own timer) and silently reports nothing
      in production, which is the only environment it was installed for.

      `finish` for the ordinary path, `close` for a client that hung up
      mid-response; `once` on both, since whichever fires first is the end of
      this request either way.
    */
    await new Promise<void>((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      express(req, res);
    });

    await flushSentry();
  } catch (error: unknown) {
    Logger.error(
      'Failed to boot the API in the serverless handler',
      error instanceof Error ? error.stack : error,
    );

    /*
      The one failure `DomainExceptionFilter` can never see.

      A boot that throws in here never reaches Nest, so no filter runs and no
      correlation id exists — the request dies before the app that would have
      handled it. Reported directly, and flushed before responding, because
      Vercel freezes the instance the moment this response is sent: an event
      still in the transport queue is simply lost, which looks exactly like an
      error that never happened.
    */
    reportException(error, { method: req.method, route: 'serverless-boot' });
    await flushSentry();

    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ statusCode: 500, message: 'Service unavailable' }));
  }
}
