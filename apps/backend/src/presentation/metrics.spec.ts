import {
  Controller,
  Get,
  Global,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  NotFoundException,
  Param,
  Post,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { register } from 'prom-client';
import request from 'supertest';
import { SessionRevocationService } from '../application/features/identity/session-revocation.service';
import { createApiApp } from './bootstrap';
import { APP_CONFIG } from './config/app.config';
import { Public } from './decorators/public.decorator';
import { DomainExceptionFilter } from './filters/domain-exception.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ABORTED_STATUS, UNMATCHED_ROUTE } from './middleware/http-metrics.middleware';
import { MetricsModule } from './metrics.module';

/**
 * `GET /metrics` and the HTTP metrics, driven over HTTP through the real
 * `createApiApp`: its prefix exclusion, recorder mount, helmet, compression,
 * 1 MB body limit and CORS all run as written. Only `AppModule` is swapped, for
 * one holding the real `MetricsModule`, global guards and filter, plus a few
 * stand-in controllers; the real one needs a database.
 *
 * The claims pinned hardest are the ones whose failure is silent:
 *  - the endpoint is closed unless a token is configured, whatever the
 *    spelling of the path, because nothing in front of it can be relied on to
 *    close it (nginx forwards every path; the Vercel build has no nginx);
 *  - it lives at `/metrics`, not `/api/v1/metrics`;
 *  - every request is counted, including the ones rejected before a handler;
 *  - the `route` label is the matched pattern or one fixed value, never a raw
 *    path, so request traffic cannot grow the series count.
 */
jest.mock('../app.module', () => ({
  get AppModule() {
    return MockAppModule;
  },
}));

const TOKEN = 't'.repeat(64);
const settings: Record<string, string | undefined> = {};

@Global()
@Module({
  providers: [{ provide: ConfigService, useValue: { get: (key: string) => settings[key] } }],
  exports: [ConfigService],
})
class SettingsModule {}

@Public()
@Controller('things')
class ThingsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }

  @Post()
  create() {
    return { ok: true };
  }
}

/** The one route under a tight limit, so the throttle test spends its own budget. */
@Public()
@Throttle({ default: { ttl: 60_000, limit: 2 } })
@Controller('limited')
class LimitedController {
  @Get()
  get() {
    return { ok: true };
  }
}

/** The one route here that needs a session, to show JwtAuthGuard is live. */
@Controller('private')
class PrivateController {
  @Get()
  get() {
    return { ok: true };
  }
}

let enterSlow: () => void = () => undefined;
let releaseSlow: () => void = () => undefined;

@Public()
@Controller('slow')
class SlowController {
  @Get()
  async get() {
    enterSlow();
    await new Promise<void>((resolve) => (releaseSlow = resolve));
    return { ok: true };
  }
}

/**
 * Stands in for `TenantMiddleware`: mounted on the same pattern, and rejects
 * the slug the way the real one rejects a municipality that does not exist.
 */
class RejectingTenantMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: (error?: unknown) => void): void {
    next(new NotFoundException("Municipality 'admin' was not found"));
  }
}

@Module({
  imports: [
    SettingsModule,
    MetricsModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1_000 }]),
  ],
  controllers: [ThingsController, LimitedController, PrivateController, SlowController],
  providers: [
    { provide: JwtService, useValue: new JwtService({ secret: 'x'.repeat(40) }) },
    {
      provide: SessionRevocationService,
      useValue: { isCurrent: jest.fn().mockResolvedValue(true) },
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class MockAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RejectingTenantMiddleware)
      .forRoutes({ path: 't/:tenantSlug/*', method: RequestMethod.ALL });
  }
}

type Sample = { name: string; labels: Record<string, string>; value: number };

/** Parses the exposition format just far enough to find samples. */
function samples(body: string): Sample[] {
  return body
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
      if (!match) throw new Error(`Unparseable exposition line: ${line}`);
      const labels: Record<string, string> = {};
      for (const [, key, value] of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
        labels[key] = value;
      }
      return { name: match[1], labels, value: Number(match[3]) };
    });
}

/**
 * The sum over every series of `name` carrying these labels, as PromQL's
 * `sum()` would give it, or `undefined` when there is no such series.
 */
function valueOf(body: string, name: string, labels: Record<string, string>): number | undefined {
  const matching = samples(body).filter(
    (sample) =>
      sample.name === name &&
      Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  );
  return matching.length ? matching.reduce((total, sample) => total + sample.value, 0) : undefined;
}

describe('GET /metrics', () => {
  let app: NestExpressApplication;
  let server: http.Server;
  const authorised = `Bearer ${TOKEN}`;

  const scrape = async (): Promise<string> => {
    const response = await request(server)
      .get('/metrics')
      .set('Authorization', authorised)
      .expect(200);
    return response.text;
  };

  const unmatched = async (statusCode: string): Promise<number> =>
    valueOf(await scrape(), 'http_requests_total', {
      route: UNMATCHED_ROUTE,
      status_code: statusCode,
    }) ?? 0;

  beforeAll(async () => {
    app = await createApiApp();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    settings.METRICS_TOKEN = TOKEN;
  });

  describe('the door', () => {
    it('is closed when no token is configured: 404, whatever is sent', async () => {
      settings.METRICS_TOKEN = undefined;

      await request(server).get('/metrics').expect(404);
      await request(server).get('/metrics').set('Authorization', 'Bearer ').expect(404);
      await request(server).get('/metrics').set('Authorization', authorised).expect(404);
    });

    it('refuses a scrape with no token, a wrong one, or the right one without "Bearer"', async () => {
      await request(server).get('/metrics').expect(403);
      await request(server).get('/metrics').set('Authorization', `Bearer ${'u'.repeat(64)}`).expect(403);
      await request(server).get('/metrics').set('Authorization', `Bearer ${TOKEN}x`).expect(403);
      await request(server).get('/metrics').set('Authorization', TOKEN).expect(403);
    });

    it('holds on every spelling Express routes to it, which an nginx prefix rule does not match', async () => {
      for (const path of ['/METRICS', '/Metrics/', '/metrics/']) {
        await request(server).get(path).expect(403);
        await request(server).get(path).set('Authorization', authorised).expect(200);
      }
    });

    it('serves the exposition format to the right token', async () => {
      const response = await request(server)
        .get('/metrics')
        .set('Authorization', authorised)
        .expect(200);

      // Express reorders the parameters; Prometheus reads them, not their order.
      expect(response.headers['content-type']).toMatch(/^text\/plain;/);
      expect(response.headers['content-type']).toContain('version=0.0.4');
      expect(response.text).toContain('# TYPE http_requests_total counter');
    });

    it('is at /metrics, outside the API prefix', async () => {
      await request(server)
        .get(`/${APP_CONFIG.apiPrefix}/metrics`)
        .set('Authorization', authorised)
        .expect(404);
    });

    it('is not blocked by the global JwtAuthGuard, which is live on other routes', async () => {
      await request(server).get('/api/v1/private').expect(401);
      await scrape();
    });

    it('is not throttled, although the throttler is live on other routes', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await request(server).get('/api/v1/limited')).status);
      }
      expect(statuses).toEqual([200, 200, 429]);

      for (let i = 0; i < 5; i++) await scrape();
    });
  });

  describe('the HTTP metrics', () => {
    it('labels a request with the route pattern, never the concrete path', async () => {
      await request(server).get('/api/v1/things/pattern-411').expect(200);
      await request(server).get('/api/v1/things/pattern-412').expect(200);

      const body = await scrape();
      const labels = { method: 'GET', route: '/api/v1/things/:id', status_code: '200' };

      expect(valueOf(body, 'http_requests_total', labels)).toBeGreaterThanOrEqual(2);
      expect(valueOf(body, 'http_request_duration_seconds_count', labels)).toBeGreaterThanOrEqual(2);
      expect(
        valueOf(body, 'http_request_duration_seconds_bucket', { ...labels, le: '120' }),
      ).toBeGreaterThanOrEqual(2);
      expect(body).not.toContain('pattern-411');
    });

    it('folds every unmatched path into one series, inside the prefix or out of it', async () => {
      const before = await unmatched('404');

      for (const probe of ['/api/v1/wp-login.php', '/api/v1/admin/config.json', '/.env', '/']) {
        await request(server).get(probe).expect(404);
      }

      expect(await unmatched('404')).toBe(before + 4);
      const body = await scrape();
      expect(body).not.toContain('wp-login');
      expect(body).not.toContain('config.json');
      expect(body).not.toContain('route="/.env"');
    });

    it('does not mistake a middleware mount for the route', async () => {
      // Nest mounts each middleware as an Express route of its own. A request no
      // handler answered ends on one of those mounts: here, an unknown
      // municipality rejected by the tenant middleware, a method no handler
      // takes, and the bare prefix.
      const before = await unmatched('404');

      await request(server).get('/api/v1/t/admin/tenant/config').expect(404);
      await request(server).put('/api/v1/things/7').expect(404);
      await request(server).get('/api/v1').expect(404);

      expect(await unmatched('404')).toBe(before + 3);
      const body = await scrape();
      expect(body).not.toContain('route="/api/v1/*"');
      expect(body).not.toContain('route="/api/v1$"');
      expect(body).not.toContain('route="/api/v1/t/:tenantSlug/*"');
    });

    it('counts a body the parser rejected, which never reaches a handler', async () => {
      // Over the 1 MB limit `createApiApp` sets, and malformed. Both die in the
      // body parser, ahead of every Nest middleware.
      const oversized = await request(server)
        .post('/api/v1/things')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ rows: 'x'.repeat(1_100_000) }));
      const malformed = await request(server)
        .post('/api/v1/things')
        .set('Content-Type', 'application/json')
        .send('{"rows": ');

      expect(oversized.status).toBeGreaterThanOrEqual(400);
      expect(malformed.status).toBe(400);

      const body = await scrape();
      for (const status of new Set([oversized.status, malformed.status])) {
        expect(
          valueOf(body, 'http_requests_total', {
            method: 'POST',
            route: UNMATCHED_ROUTE,
            status_code: String(status),
          }),
        ).toBeGreaterThanOrEqual(1);
      }
    });

    it('counts refusals under the route they were refused on', async () => {
      await request(server).get('/api/v1/private').expect(401);

      const body = await scrape();
      expect(
        valueOf(body, 'http_requests_total', { route: '/api/v1/private', status_code: '401' }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('records a request the client hung up on, as aborted', async () => {
      const { port } = server.address() as AddressInfo;
      const entered = new Promise<void>((resolve) => (enterSlow = resolve));

      const client = http.get({ host: '127.0.0.1', port, path: '/api/v1/slow' });
      client.on('error', () => undefined);
      await entered;
      client.destroy();

      const aborted = { route: '/api/v1/slow', status_code: ABORTED_STATUS };
      let count: number | undefined;
      for (let i = 0; i < 50 && count === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        count = valueOf(await register.metrics(), 'http_requests_total', aborted);
      }
      releaseSlow();

      expect(count).toBe(1);
      expect(
        valueOf(await register.metrics(), 'http_request_duration_seconds_count', aborted),
      ).toBe(1);
    });
  });

  it("includes Node's default process metrics", async () => {
    const body = await scrape();

    for (const name of [
      'process_cpu_seconds_total',
      'process_resident_memory_bytes',
      'nodejs_eventloop_lag_seconds',
      'nodejs_heap_size_used_bytes',
    ]) {
      expect(body).toContain(`# TYPE ${name} `);
    }
  });
});
