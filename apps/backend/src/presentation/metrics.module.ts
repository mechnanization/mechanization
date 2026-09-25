import { INestApplication, Module, RequestMethod } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { NextFunction, Request, Response } from 'express';
import { APP_CONFIG } from './config/app.config';
import { MetricsController } from './controllers/metrics.controller';
import { HttpMetricsMiddleware, httpMetricProviders } from './middleware/http-metrics.middleware';

/** The one route outside `APP_CONFIG.apiPrefix`. `bootstrap.ts` excludes it. */
export const METRICS_ROUTE = {
  path: APP_CONFIG.metricsPath,
  method: RequestMethod.GET,
};

/**
 * Prometheus exposition: the scrape endpoint, Node's default process metrics
 * (CPU, memory, event-loop lag, GC), and the two HTTP metrics.
 *
 * The counters live in this process's memory. That assumes one process answers
 * the port. Under pm2 cluster mode with more than one instance, each scrape
 * would read whichever worker answered; `main.ts` warns at boot if pm2 starts a
 * second instance.
 */
@Module({
  imports: [
    PrometheusModule.register({
      path: `/${APP_CONFIG.metricsPath}`,
      controller: MetricsController,
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: [...httpMetricProviders, HttpMetricsMiddleware],
  exports: [HttpMetricsMiddleware],
})
export class MetricsModule {}

/**
 * Mounts the HTTP recorder as a plain Express layer. `createApiApp` calls this
 * before anything else it registers.
 *
 * Not through `MiddlewareConsumer`: Nest mounts consumer middleware after
 * helmet, compression, the body parsers and CORS, and only under `/api/v1`. A
 * request any of those ends (a body over the 1 MB limit, malformed JSON, a
 * preflight) or a path outside the prefix would never reach it. That leaves out
 * exactly the failures worth graphing, including the oversized body this app
 * answers with a 500.
 */
export function useHttpMetrics(app: INestApplication): void {
  const recorder = app.get(HttpMetricsMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => recorder.use(req, res, next));
}
