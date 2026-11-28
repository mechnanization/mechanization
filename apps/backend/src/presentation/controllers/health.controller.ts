import { Controller, Get } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { DEFAULT_THROTTLE } from '../http/throttlers';
import { RegistryPrismaService } from '../../infrastructure/prisma/registry-prisma.service';
import { Public } from '../decorators/public.decorator';

/**
 * Platform-level, deliberately outside the `/t/:tenantSlug` prefix — it must
 * answer before any municipality is resolved, so a load balancer can tell the
 * process is alive even if the registry is unreachable.
 */
@Controller()
export class HealthController {
  constructor(private readonly registry: RegistryPrismaService) {}

  /**
   * Not throttled: it does no work, and the deploy polls it every two seconds
   * to decide whether a release goes live. A 429 here would read as a dead
   * process (SEC-07).
   */
  @Public()
  @SkipThrottle()
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** The default bar: it asks the registry, and nginx serves it to the internet like every path (SEC-07). */
  @Public()
  @Throttle(DEFAULT_THROTTLE)
  @Get('health/ready')
  async ready() {
    try {
      await this.registry.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      // No error detail: readiness probes are often reachable from further
      // afield than the rest of the API.
      return { status: 'degraded' };
    }
  }
}
