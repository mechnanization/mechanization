import { INestApplication, RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { NotFoundError } from '../application/common/exceptions';
import { SessionRevocationService } from '../application/features/identity/session-revocation.service';
import { StaffPresenceService } from '../application/features/identity/staff-presence.service';
import { TenantService } from '../application/features/tenant/tenant.service';
import { RegistryPrismaService } from '../infrastructure/prisma/registry-prisma.service';
import { TenantPrismaFactory } from '../infrastructure/prisma/tenant-prisma.factory';
import { APP_CONFIG } from '../application/common/app.config';
import { DiscoveredRoute, discoverRoutes } from './controllers/route-discovery';
import { METRICS_ROUTE } from './metrics.module';

/**
 * Tenant A's token on tenant B's URL, on every route the API serves, over HTTP.
 *
 * The tenant check is one comparison in `JwtAuthGuard` (`tenant-isolation.spec.ts`
 * tests it on a stub controller). What that cannot show is that every route
 * actually reaches it: mounted under `TenantMiddleware`, behind the global
 * guards, with no controller of its own answering first. So this boots the
 * real `AppModule` — every real controller, the real middleware mount, the
 * real guard order, the real exception filter — and asks every route
 * `discoverRoutes()` finds (the list `route-inventory.spec.ts` checks) with a
 * correctly signed, live token for another municipality. Each must answer 403
 * `TENANT_MISMATCH`. Task S7 of the 2026-11-14 security audit.
 *
 * Nothing here needs a database: the guard refuses before any pipe or handler
 * runs. The five providers that would reach one are stubbed — the tenant
 * registry (two municipalities, `alpha` and `beta`), the registry and tenant
 * clients, the session check (always live, so the tenant is the only reason
 * left to refuse) and presence. `GET auth/me` on the token's own municipality
 * is the control: it answers 200, so the 403s are the tenant's and not a bad
 * token's.
 */
const SECRET = 'cross-tenant-routes-spec-secret-0123456789abcdef';
const TENANT_A = 'alpha';
const TENANT_B = 'beta';
const SOME_ID = '00000000-0000-4000-8000-000000000001';

/** Set before `AppModule` is imported: `ConfigModule.forRoot` validates the environment on import. */
function configureEnvironment(): void {
  process.env.DATABASE_URL = 'postgresql://spec:spec@127.0.0.1:1/never_connected';
  process.env.DIRECT_URL = 'postgresql://spec:spec@127.0.0.1:1/never_connected';
  process.env.JWT_SECRET = SECRET;
  process.env.SCHEDULER_ENABLED = 'false';
}

const tenants: Record<string, { id: string; slug: string; schemaName: string; adminPathSegment: string }> = {
  [TENANT_A]: { id: 'tenant-alpha', slug: TENANT_A, schemaName: 'tenant_alpha', adminPathSegment: 'admin' },
  [TENANT_B]: { id: 'tenant-beta', slug: TENANT_B, schemaName: 'tenant_beta', adminPathSegment: 'admin' },
};

/** The route as a URL a client could send: every `:param` filled, the prefix applied. */
function urlOf(route: DiscoveredRoute, tenantSlug: string): string {
  const joined = [route.controllerPath, route.path]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  const filled = joined
    .replace(/:tenantSlug\b/g, tenantSlug)
    .replace(/:(\w+)\??/g, (_match, name: string) => (/(^id|Id)$/.test(name) ? SOME_ID : 'x1'))
    .replace(/\*/g, 'x1');
  const excluded = joined === METRICS_ROUTE.path.replace(/^\/+/, '');
  return excluded ? `/${filled}` : `/${APP_CONFIG.apiPrefix}/${filled}`;
}

describe('every route refuses another municipality’s token', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let mounted: DiscoveredRoute[];
  let unmounted: string[];

  const tokenFor = (claims: Record<string, unknown>) =>
    jwt.sign({ sub: SOME_ID, tenantSlug: TENANT_A, tokenVersion: 0, ...claims });

  const send = (route: DiscoveredRoute, url: string, token: string) => {
    const method = RequestMethod[route.method].toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const call = request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);
    return method === 'get' ? call : call.send({});
  };

  beforeAll(async () => {
    configureEnvironment();
    const { AppModule } = await import('../app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TenantService)
      .useValue({
        resolve: async (slug: string) => {
          const tenant = tenants[slug];
          if (!tenant) throw new NotFoundError('Municipality', slug);
          return tenant;
        },
      })
      .overrideProvider(RegistryPrismaService)
      .useValue({})
      .overrideProvider(TenantPrismaFactory)
      .useValue({ forSchema: () => ({}) })
      .overrideProvider(SessionRevocationService)
      .useValue({ isCurrent: async () => true, isFamilyLive: async () => true })
      .overrideProvider(StaffPresenceService)
      .useValue({ touch: async () => undefined })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    // As `createApiApp` does; the rest of its setup (helmet, compression, CORS) is not under test here.
    app.setGlobalPrefix(APP_CONFIG.apiPrefix, { exclude: [METRICS_ROUTE] });
    await app.init();
    jwt = app.get(JwtService);

    const registered = new Set<unknown>();
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) registered.add(wrapper.metatype);
    }
    const all = discoverRoutes();
    mounted = all.filter((route) => registered.has(route.controller));
    unmounted = [...new Set(all.filter((route) => !registered.has(route.controller)).map((r) => r.controller.name))];
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('mounts every controller on disk but the one left out on purpose', () => {
    // BackupController is unregistered by decision (presentation.module.ts). A
    // controller missing here for any other reason would also be missing from
    // the sweep below.
    expect(unmounted).toEqual(['BackupController']);
    expect(mounted.length).toBeGreaterThan(150);
  });

  it("accepts the token on its own municipality — the control", async () => {
    const response = await request(app.getHttpServer())
      .get(`/${APP_CONFIG.apiPrefix}/t/${TENANT_A}/auth/me`)
      .set('Authorization', `Bearer ${tokenFor({ kind: 'STAFF', role: 'SUPER_ADMIN' })}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tenantSlug: TENANT_A, kind: 'STAFF' });
  });

  it.each([
    ['a SUPER_ADMIN', { kind: 'STAFF', role: 'SUPER_ADMIN' }],
    ['a citizen', { kind: 'CITIZEN' }],
  ])("refuses %s of tenant A on every non-public route of tenant B with 403 TENANT_MISMATCH", async (_who, claims) => {
    const token = tokenFor(claims);
    const answered: string[] = [];

    for (const route of mounted.filter((candidate) => !candidate.isPublic)) {
      const url = urlOf(route, TENANT_B);
      const response = await send(route, url, token);
      if (response.status !== 403 || response.body?.code !== 'TENANT_MISMATCH') {
        answered.push(`${route.name} ${RequestMethod[route.method]} ${url} → ${response.status} ${response.body?.code ?? ''}`);
      }
    }

    expect(answered).toEqual([]);
  }, 120_000);
});
