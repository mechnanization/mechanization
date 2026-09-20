import { TenantContextService, type TenantScope } from '../../../infrastructure/context/tenant-context.service';
import { DataQualityService } from './data-quality.service';
import { RecordReviewService } from './record-review.service';

/**
 * When the quality caches are cleared, relative to the commit.
 *
 * The rule is `ReportingService.onDashboardDataChanged`'s, and it is the kind
 * that cannot be seen in a screenshot: a clear that runs while the transaction
 * is still open is a clear another reader can undo. Their scan re-caches the
 * findings the write is about to fix, and — because the clear has already
 * happened — nothing clears it again. The screen shows the fixed duplicate for
 * the whole TTL, which is the staleness the invalidation exists to prevent,
 * reached by invalidating too early.
 */

function scope(over: Partial<TenantScope> = {}): TenantScope {
  return {
    tenantId: 'tenant-1',
    tenantSlug: 'albazourieh',
    schemaName: 'tenant_albazourieh',
    prisma: {} as never,
    ...over,
  };
}

function harness() {
  const context = new TenantContextService();
  const invalidated: string[] = [];
  const cache = {
    get: async () => null,
    set: async () => undefined,
    invalidatePrefix: async (prefix: string) => {
      invalidated.push(prefix);
    },
  };
  const config = { get: () => 180 };
  const quality = new DataQualityService(context, {} as never, {} as never, cache as never, config as never);
  const reviews = new RecordReviewService(context, {} as never, cache as never, config as never);
  return { context, invalidated, quality, reviews };
}

describe('the quality caches, cleared around a transaction', () => {
  it('clears at once outside one', async () => {
    const { context, invalidated, quality, reviews } = harness();

    await context.run(scope(), async () => {
      await quality.onRegisterChanged();
      await reviews.onQueueChanged();
    });

    expect(invalidated).toEqual(['quality:albazourieh:', 'quality:albazourieh:queue:']);
  });

  it('waits for the commit inside one', async () => {
    const { context, invalidated, quality, reviews } = harness();
    const afterCommit: Array<() => unknown> = [];

    await context.run(scope({ transaction: { afterCommit } }), async () => {
      await quality.onRegisterChanged();
      await reviews.onQueueChanged();
    });

    // Nothing yet — the write it was told about has not landed.
    expect(invalidated).toEqual([]);
    expect(afterCommit).toHaveLength(2);

    for (const task of afterCommit) await task();
    expect(invalidated).toEqual(['quality:albazourieh:', 'quality:albazourieh:queue:']);
  });

  it('does nothing at all with no tenant on the scope', async () => {
    // A platform route, or a listener reached from outside a request. Reading
    // `tenantSlug` there throws, and a failed clear must never fail a write.
    const { invalidated, quality, reviews } = harness();

    await expect(quality.onRegisterChanged()).resolves.toBeUndefined();
    await expect(reviews.onQueueChanged()).resolves.toBeUndefined();
    expect(invalidated).toEqual([]);
  });
});
