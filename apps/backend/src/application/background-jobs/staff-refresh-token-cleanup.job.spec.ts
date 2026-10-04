import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StaffRefreshTokenCleanupJob } from './staff-refresh-token-cleanup.job';
import { InternalCronController } from '../../presentation/controllers/internal-cron.controller';
import { TenantContextService } from '../../infrastructure/context/tenant-context.service';
import type { TenantRepository } from '../../domain/interfaces/tenant-repository.interface';
import type { TenantPrismaFactory } from '../../infrastructure/prisma/tenant-prisma.factory';

/**
 * The daily prune of refresh-token families past their session cap.
 *
 * Housekeeping, not a control — an expired family is already refused by the
 * refresh and by the guard — so the behaviour worth pinning is the one
 * `OtpCleanupJob` learned the hard way: one municipality's failure must not
 * stop the rest. Here that is not hypothetical on day one either: until 0059
 * reaches every schema, the table is missing in some of them, and the job must
 * say which and carry on.
 */
describe('StaffRefreshTokenCleanupJob', () => {
  const NOW = new Date('2026-09-27T03:00:00.000Z');

  const tenant = (slug: string) => ({
    id: `id-${slug}`,
    slug,
    schemaName: `tenant_${slug}`,
  });

  /**
   * The real `TenantContextService`, as in the OTP job's spec: a stub that
   * just called the callback would not prove each prune runs inside its own
   * municipality's scope.
   */
  function build(deleteMany: jest.Mock) {
    const schemasSeen: string[] = [];
    const scopesSeen: Array<string | undefined> = [];
    const context = new TenantContextService();

    const tenants = {
      listActive: jest
        .fn()
        .mockResolvedValue([tenant('albazourieh'), tenant('broken'), tenant('zahle')]),
    } as unknown as TenantRepository;

    const clients = {
      forSchema: (schemaName: string) => {
        schemasSeen.push(schemaName);
        return {
          staffRefreshToken: {
            deleteMany: (args: unknown) => {
              scopesSeen.push(context.peek()?.schemaName);
              return deleteMany(args);
            },
          },
        };
      },
    } as unknown as TenantPrismaFactory;

    return {
      job: new StaffRefreshTokenCleanupJob(tenants, context, clients),
      schemasSeen,
      scopesSeen,
    };
  }

  let errors: string[];
  let logged: string[];

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    errors = [];
    logged = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('prunes every tenant, each inside its own scope, when nothing fails', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const { job, schemasSeen, scopesSeen } = build(deleteMany);

    await job.pruneExpired();

    expect(schemasSeen).toEqual(['tenant_albazourieh', 'tenant_broken', 'tenant_zahle']);
    expect(scopesSeen).toEqual(['tenant_albazourieh', 'tenant_broken', 'tenant_zahle']);
    expect(deleteMany).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([]);
  });

  it('removes only rows whose cap is already behind it', async () => {
    // Strictly before now: a family whose cap is this instant is refused by
    // the refresh already, and gone tomorrow; nothing live is ever at risk.
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const { job } = build(deleteMany);

    await job.pruneExpired();

    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: NOW } } });
  });

  it('keeps going past a tenant whose schema 0059 has not reached', async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('relation "staff_refresh_tokens" does not exist'))
      .mockResolvedValueOnce({ count: 4 });
    const { job, schemasSeen } = build(deleteMany);

    await expect(job.pruneExpired()).resolves.toBeUndefined();

    expect(schemasSeen).toEqual(['tenant_albazourieh', 'tenant_broken', 'tenant_zahle']);
    expect(deleteMany).toHaveBeenCalledTimes(3);
  });

  it('names the municipality it skipped, so the gap is legible', async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockResolvedValueOnce({ count: 4 });
    const { job } = build(deleteMany);

    await job.pruneExpired();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'broken'");
    expect(errors[0]).toContain('pooler timeout');
  });

  it('reports only what it actually removed', async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockResolvedValueOnce({ count: 4 });
    const { job } = build(deleteMany);

    await job.pruneExpired();

    expect(logged.join('\n')).toContain('Pruned 5 expired staff refresh token(s) across 3 tenant(s)');
  });

  it('says nothing when there was nothing to prune', async () => {
    const { job } = build(jest.fn().mockResolvedValue({ count: 0 }));

    await job.pruneExpired();

    expect(logged).toEqual([]);
  });
});

/**
 * The HTTP door to the same job, for a deployment where `@Cron` does not fire.
 * It walks every municipality, so it must be exactly as shut as the others.
 */
describe('GET internal/cron/staff-refresh-cleanup', () => {
  function build(secret: string | undefined) {
    const job = { pruneExpired: jest.fn().mockResolvedValue(undefined) };
    const controller = new InternalCronController(
      { get: jest.fn().mockReturnValue(secret) } as unknown as ConfigService,
      {} as never,
      {} as never,
      job as unknown as StaffRefreshTokenCleanupJob,
    );
    return { controller, job };
  }

  it('runs the prune for the cron secret', async () => {
    const { controller, job } = build('cron-secret');

    await expect(controller.staffRefresh('Bearer cron-secret')).resolves.toEqual({
      job: 'staff-refresh-cleanup',
      status: 'ok',
    });
    expect(job.pruneExpired).toHaveBeenCalledTimes(1);
  });

  it('refuses anyone else, and runs nothing', async () => {
    const { controller, job } = build('cron-secret');

    await expect(controller.staffRefresh('Bearer guessed')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.staffRefresh(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(job.pruneExpired).not.toHaveBeenCalled();
  });

  it('stays shut when no secret is configured', async () => {
    const { controller, job } = build(undefined);

    await expect(controller.staffRefresh('Bearer ')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(job.pruneExpired).not.toHaveBeenCalled();
  });
});
