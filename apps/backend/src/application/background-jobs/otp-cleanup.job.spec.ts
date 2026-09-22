import { Logger } from '@nestjs/common';
import { OtpCleanupJob } from './otp-cleanup.job';
import { TenantContextService } from '../../infrastructure/context/tenant-context.service';
import type { TenantRepository } from '../../domain/interfaces/tenant-repository.interface';
import type { TenantPrismaFactory } from '../../infrastructure/prisma/tenant-prisma.factory';

/**
 * Failure isolation, which is the only interesting behaviour in this job.
 *
 * The loop walks every municipality in whatever order the registry returns.
 * Without a per-tenant guard, one unreachable schema — mid-migration, or a
 * pooler timeout — rejected out of the `@Cron` handler and every tenant *after
 * it in that order* was silently skipped. Silently is the operative word: an
 * unhandled rejection inside a scheduled job is not a request anyone is
 * watching, the prune is not something anyone checks, and expired OTP
 * challenges simply accumulate in the schemas that happened to sort late.
 *
 * `RecurringBillingJob` already had the guard. These tests pin that the two
 * cross-tenant jobs now fail the same way, because "some jobs isolate and some
 * do not" is exactly the sort of thing that is true again in six months.
 */
describe('OtpCleanupJob', () => {
  const tenant = (slug: string) => ({
    id: `id-${slug}`,
    slug,
    schemaName: `tenant_${slug}`,
  });

  /**
   * The real `TenantContextService` rather than a stub: it is an
   * `AsyncLocalStorage` wrapper with no dependencies, and a stub that just
   * calls the callback would not prove the scope is entered per tenant — which
   * is the other half of what the `try` has to wrap.
   */
  function build(deleteMany: jest.Mock) {
    const slugsSeen: string[] = [];
    const context = new TenantContextService();

    const tenants = {
      listActive: jest
        .fn()
        .mockResolvedValue([tenant('albazourieh'), tenant('broken'), tenant('zahle')]),
    } as unknown as TenantRepository;

    const clients = {
      forSchema: (schemaName: string) => {
        slugsSeen.push(schemaName);
        return { otpChallenge: { deleteMany } };
      },
    } as unknown as TenantPrismaFactory;

    return { job: new OtpCleanupJob(tenants, context, clients), slugsSeen };
  }

  let errors: string[];

  beforeEach(() => {
    errors = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('prunes every tenant when nothing fails', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const { job, slugsSeen } = build(deleteMany);

    await job.pruneExpiredChallenges();

    expect(slugsSeen).toEqual(['tenant_albazourieh', 'tenant_broken', 'tenant_zahle']);
    expect(deleteMany).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([]);
  });

  it('keeps going past a tenant whose schema is unreachable', async () => {
    /*
      The defect, stated as a test. `zahle` sorts after `broken`, so before the
      guard existed it was never visited at all — and nothing said so.
    */
    const deleteMany = jest.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve({ count: 1 });
    });
    const { job, slugsSeen } = build(deleteMany);

    deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('relation "otp_challenges" does not exist'))
      .mockResolvedValueOnce({ count: 4 });

    await expect(job.pruneExpiredChallenges()).resolves.toBeUndefined();

    expect(slugsSeen).toEqual(['tenant_albazourieh', 'tenant_broken', 'tenant_zahle']);
    expect(deleteMany).toHaveBeenCalledTimes(3);
  });

  it('names the municipality it skipped, so the gap is legible', async () => {
    /*
      Counting the survivors is not enough. A prune that quietly drops one
      municipality looks identical in the logs to one that had nothing to
      prune, so the failure has to carry the slug — the same shape
      RecurringBillingJob logs.
    */
    const deleteMany = jest.fn();
    const { job } = build(deleteMany);

    deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockResolvedValueOnce({ count: 4 });

    await job.pruneExpiredChallenges();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'broken'");
    expect(errors[0]).toContain('pooler timeout');
  });

  it('reports only what it actually removed', async () => {
    const deleteMany = jest.fn();
    const { job } = build(deleteMany);
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockResolvedValueOnce({ count: 4 });

    await job.pruneExpiredChallenges();

    // 5, not 5-plus-whatever-`broken`-would-have-had: the count is of rows
    // deleted, and the skipped tenant is in the error line above it.
    expect(logged.join('\n')).toContain('Pruned 5 expired OTP challenge(s)');
  });
});
