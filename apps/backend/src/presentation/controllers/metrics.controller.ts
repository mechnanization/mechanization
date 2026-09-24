import { Controller, ForbiddenException, Get, Headers, NotFoundException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../decorators/public.decorator';

/**
 * `GET /metrics`, the Prometheus scrape endpoint, outside `/api/v1` (see
 * `APP_CONFIG.metricsPath`).
 *
 * It exposes the process's internals and every route pattern with its traffic,
 * so it must not be public. Nothing in front of it can be relied on for that:
 *  - nginx on the Lightsail box forwards every path to this process, not just
 *    `/api/v1`. A deny rule there is worth having, but Express matches routes
 *    case-insensitively and with or without a trailing slash, so this handler
 *    also answers `/METRICS` and `/Metrics/`, which a plain `location /metrics`
 *    does not match;
 *  - the serverless build (`vercel.json`) runs this same application with no
 *    nginx in front at all.
 *
 * So `METRICS_TOKEN` is the whole door, and unset means closed: the route
 * answers 404. `InternalCronController` answers 503 for its unset secret
 * instead; that works there but not here, because `DomainExceptionFilter`
 * reports every status ≥ 500 to Sentry, and a scanner probing `/metrics` on a
 * deployment that never meant to serve it is not an incident.
 *
 * `@Public()` because the scraper holds no session. `@SkipThrottle()` because,
 * behind nginx with no `trust proxy`, every request reaches the throttler from
 * nginx's own address. A scrape would compete with all real traffic for one
 * bucket, and it would be the thing dropped at peak, which is exactly when the
 * graph matters.
 */
@Public()
@SkipThrottle()
@Controller()
export class MetricsController extends PrometheusController {
  constructor(private readonly config: ConfigService) {
    super();
  }

  /**
   * The response stays at parameter 0, where the base class declares it. Nest
   * reads route-argument metadata through the prototype chain, so the base
   * class's `@Res()` at index 0 is inherited by this override. Moving it would
   * leave two decorators claiming one slot.
   */
  @Get()
  async index(
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
  ): Promise<string> {
    this.authorise(authorization);
    return super.index(response);
  }

  private authorise(header: string | undefined): void {
    const token = this.config.get<string>('METRICS_TOKEN');

    if (!token) {
      throw new NotFoundException();
    }

    // Digests first, because `timingSafeEqual` throws on inputs of different
    // lengths, and the length check that avoids it would itself leak the length.
    if (!timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))) {
      throw new ForbiddenException();
    }
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
