import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';

export interface TenantScope {
  tenantId: string;
  tenantSlug: string;
  schemaName: string;
  /** The client bound to this municipality's schema. Repositories read it here. */
  prisma: TenantPrismaClient;
  /**
   * Set while `runInTenantTransaction` is running `prisma` as a transaction.
   *
   * Side effects that must not happen for writes that may yet roll back — an
   * audit row, a cache invalidation — queue themselves here instead of running
   * against a transaction client that may already be closed by the time they
   * reach the database. See `tenant-transaction.ts`.
   */
  transaction?: { afterCommit: Array<() => unknown> };
}

/**
 * Carries the resolved municipality — and its database client — through the
 * whole request without threading either through every call signature.
 *
 * The client living in the scope rather than being passed as an argument is the
 * point: there is no parameter for a handler to fill in with the wrong tenant's
 * client, because there is no parameter.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantScope>();

  run<T>(scope: TenantScope, callback: () => T): T {
    return this.storage.run(scope, callback);
  }

  /** Returns undefined on platform routes that legitimately have no tenant. */
  peek(): TenantScope | undefined {
    return this.storage.getStore();
  }

  require(): TenantScope {
    const scope = this.storage.getStore();
    if (!scope) {
      // A programming error, not a user error: this route was mounted without
      // TenantMiddleware. Failing loudly beats querying whatever schema the
      // pooled connection happened to be left pointing at.
      throw new Error(
        'Tenant context is missing. This route must run behind TenantMiddleware.',
      );
    }
    return scope;
  }

  /** The tenant-scoped client. Every repository method starts here. */
  get prisma(): TenantPrismaClient {
    return this.require().prisma;
  }

  get tenantSlug(): string {
    return this.require().tenantSlug;
  }

  /**
   * The Postgres schema this request's data lives in.
   *
   * Read by every raw query, which writes it into its SQL rather than leaning
   * on `search_path` — see `tenant-schema-ref.ts`. A plain property and not a
   * pre-built SQL fragment on purpose: a test stubbing this service fakes a
   * string, and a fragment it forgot to fake would interpolate as `undefined`
   * and become a bound parameter — a `syntax error at or near "$1"` instead of
   * a missing-schema error naming what is wrong.
   */
  get schemaName(): string {
    return this.require().schemaName;
  }


  get tenantId(): string {
    return this.require().tenantId;
  }
}
