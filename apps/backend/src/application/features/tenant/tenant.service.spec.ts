import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/registry-client';
import { Tenant, TenantProps } from '../../../domain/entities/tenant.entity';
import { NotFoundError } from '../../../domain/errors/domain-error';
import { TenantRepository } from '../../../domain/interfaces/tenant-repository.interface';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantService } from './tenant.service';

const PROPS: TenantProps = {
  id: 'tenant-1',
  slug: 'albazourieh',
  name: 'Albazourieh',
  nameAr: 'البازورية',
  schemaName: 'tenant_albazourieh',
  adminPathSegment: 'admin-portal-a91f',
  referencePrefix: 'ALB',
  config: null,
  isActive: true,
  provisionedAt: new Date('2024-01-01T00:00:00.000Z'),
};

/** The shape Prisma raises when the pooler cannot be reached — from whichever
 *  of the two generated clients happens to have thrown it. */
function unreachable(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Can't reach database server at `aws-1-ap-south-1.pooler.supabase.com:5432`",
    { code: 'P1001', clientVersion: '5.22.0' },
  );
}

/**
 * `TenantService.resolve` gates every tenant-scoped request via
 * `TenantMiddleware`, so this is the query where a database blip becomes a
 * 500 on the whole portal rather than on one screen — which is exactly what a
 * pooler outage did. These tests are about the fallback that exists because
 * of that: once a slug has resolved successfully at least once, a later
 * connection failure serves that remembered record instead of failing the
 * request outright.
 */
describe('TenantService.resolve — last-known-good fallback', () => {
  function build(repository: Partial<TenantRepository>) {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisCacheService;
    const config = { getOrThrow: jest.fn().mockReturnValue(300) } as unknown as ConfigService;
    const service = new TenantService(repository as TenantRepository, cache, config);
    return { service, cache };
  }

  it('remembers a tenant after resolving it once', async () => {
    const findBySlug = jest.fn().mockResolvedValue(Tenant.rehydrate(PROPS));
    const { service } = build({ findBySlug });

    const tenant = await service.resolve('albazourieh');
    expect(tenant.slug).toBe('albazourieh');
    expect(findBySlug).toHaveBeenCalledTimes(1);
  });

  it('serves the remembered record when the registry is unreachable on a later request', async () => {
    const findBySlug = jest
      .fn()
      .mockResolvedValueOnce(Tenant.rehydrate(PROPS))
      .mockRejectedValueOnce(unreachable());
    const { service } = build({ findBySlug });

    // First call succeeds and populates the fallback.
    await service.resolve('albazourieh');
    // Second call hits the registry (cache mocked to always miss) and fails —
    // this is the moment the middleware previously turned into a 500.
    const tenant = await service.resolve('albazourieh');

    expect(tenant.slug).toBe('albazourieh');
    expect(tenant.schemaName).toBe('tenant_albazourieh');
  });

  it('still throws when there is nothing remembered to fall back to', async () => {
    const findBySlug = jest.fn().mockRejectedValue(unreachable());
    const { service } = build({ findBySlug });

    await expect(service.resolve('zahle')).rejects.toThrow();
  });

  /**
   * The one case the fallback must not paper over: a slug that is genuinely
   * gone, not merely unreachable. Answering a decommissioned municipality from
   * memory would keep serving a portal nobody administers any more.
   */
  it('does not fall back for a slug that no longer exists', async () => {
    const findBySlug = jest
      .fn()
      .mockResolvedValueOnce(Tenant.rehydrate(PROPS))
      .mockResolvedValueOnce(null);
    const { service } = build({ findBySlug });

    await service.resolve('albazourieh');
    await expect(service.resolve('albazourieh')).rejects.toThrow(NotFoundError);
  });

  it('does not fall back for a non-connection error', async () => {
    const findBySlug = jest
      .fn()
      .mockResolvedValueOnce(Tenant.rehydrate(PROPS))
      .mockRejectedValueOnce(new Error('boom'));
    const { service } = build({ findBySlug });

    await service.resolve('albazourieh');
    await expect(service.resolve('albazourieh')).rejects.toThrow('boom');
  });
});
