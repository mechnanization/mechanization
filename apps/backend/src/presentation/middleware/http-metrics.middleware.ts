import { Injectable, NestMiddleware } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { NextFunction, Request, Response } from 'express';
import { Counter, Histogram } from 'prom-client';

const REQUESTS_TOTAL = 'http_requests_total';
const REQUEST_DURATION = 'http_request_duration_seconds';
const LABEL_NAMES = ['method', 'route', 'status_code'] as const;
type HttpLabel = (typeof LABEL_NAMES)[number];

/**
 * The `route` label for a request that never reached a handler: a path nothing
 * is registered at, a municipality slug that does not exist, a body too large
 * to parse, a CORS preflight.
 *
 * Deliberately a single value. The obvious fallback, the raw path, hands this
 * label's cardinality to whoever sends requests: every scanner probe and every
 * mistyped id becomes a new time series, held in this process's memory for as
 * long as it runs and never released.
 */
export const UNMATCHED_ROUTE = '<unmatched>';

/**
 * The `status_code` label for a request whose connection closed before the
 * response was written. That is a client that hung up (nginx logs 499), and also
 * nginx giving up on this process at its own proxy timeout (the client sees a
 * 504). Recorded rather than dropped: these are the slow requests, and leaving
 * them out would flatter the latency histogram exactly when it matters. An
 * error-rate query wants `status_code=~"5..|aborted"`.
 */
export const ABORTED_STATUS = 'aborted';

export const httpMetricProviders = [
  makeCounterProvider({
    name: REQUESTS_TOTAL,
    help: 'Total number of HTTP requests. status_code is "aborted" when the connection closed before a response.',
    labelNames: LABEL_NAMES,
  }),
  /**
   * Out to 120 s, because this app has operations designed to run that long: a
   * backup restore is one 120 s transaction, and tenant transactions default to
   * 60 s. With buckets ending at 5 s, every quantile above 5 s would read as
   * exactly 5.
   */
  makeHistogramProvider({
    name: REQUEST_DURATION,
    help: 'HTTP request duration in seconds. status_code is "aborted" when the connection closed before a response.',
    labelNames: LABEL_NAMES,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 30, 60, 120],
  }),
];

/**
 * Request rate, latency and error rate per route, for Prometheus.
 *
 * Mounted by `useHttpMetrics` as the first Express layer, so the clock covers
 * everything from the body arriving to the response leaving, and every request
 * is counted, including the ones rejected before a handler runs.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    @InjectMetric(REQUESTS_TOTAL) private readonly requests: Counter<HttpLabel>,
    @InjectMetric(REQUEST_DURATION) private readonly duration: Histogram<HttpLabel>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const stopTimer = this.duration.startTimer();
    let recorded = false;

    const record = (statusCode: string): void => {
      if (recorded) return;
      recorded = true;

      const labels = { method: req.method, route: routeOf(req), status_code: statusCode };
      this.requests.inc(labels);
      stopTimer(labels);
    };

    // `finish` for a response that was sent; `close` without it for a client
    // that hung up first. Whichever comes first is the end of this request.
    res.once('finish', () => record(String(res.statusCode)));
    res.once('close', () =>
      record(res.writableFinished ? String(res.statusCode) : ABORTED_STATUS),
    );

    next();
  }
}

/**
 * The route *pattern* of the handler that answered
 * (`/api/v1/t/:tenantSlug/citizens/:id`), never the concrete path.
 *
 * `req.route` is the last Express route the request matched, and that is not
 * always a handler. Nest mounts each middleware as an Express route of its own,
 * registered for every HTTP method. A request no handler matched therefore
 * ends with `req.route` on the last mount it passed (`/api/v1/*`, or
 * `/api/v1/t/:tenantSlug/*` for an unknown municipality) rather than unset.
 * Express creates a fresh route for every `app.get(…)`/`app.post(…)`, so a
 * handler's route carries exactly one method, and that is the test. An `@All()`
 * handler (`_all`) would fail it and count as unmatched; there are none.
 *
 * `req.baseUrl` is deliberately not prepended: Nest registers every route with
 * its full path, and while a path-mounted middleware runs, Express sets
 * `baseUrl` to the *concrete* matched prefix, ids included.
 */
function routeOf(req: Request): string {
  const route = req.route as { path?: unknown; methods?: Record<string, boolean> } | undefined;
  const methods = Object.keys(route?.methods ?? {});
  const isHandler = methods.length === 1 && methods[0] !== '_all';

  return isHandler && typeof route?.path === 'string' ? route.path : UNMATCHED_ROUTE;
}
