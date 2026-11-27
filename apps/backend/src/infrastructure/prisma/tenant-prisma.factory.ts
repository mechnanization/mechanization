import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isTenantSchemaName } from '../../domain/value-objects/tenant-schema-name';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';

/**
 * Hands out a PrismaClient bound to one municipality's Postgres schema.
 *
 * This is the whole tenant-isolation mechanism. v1 used shared tables plus RLS
 * keyed on `SET app.current_tenant_id`, which has to be re-set correctly on
 * every request — and behind pgbouncer a connection is reused across requests,
 * so a missed or stale SET reads another municipality's rows silently rather
 * than failing. Here the schema is part of the connection string, so a leak
 * requires handing out the wrong client object, which is visible in code review
 * in a way a missing session variable is not.
 */
@Injectable()
export class TenantPrismaFactory implements OnModuleDestroy {
  private readonly logger = new Logger(TenantPrismaFactory.name);
  private readonly clients = new Map<string, TenantPrismaClient>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Cached per schema — one connection pool per municipality rather than one per
   * request. At tens of tenants this is a handful of pools; if this ever reaches
   * hundreds, an LRU with idle eviction is the change to make here, and nowhere
   * else.
   */
  forSchema(schemaName: string): TenantPrismaClient {
    // Interpolated into a connection string, where it cannot be a bound parameter.
    if (!isTenantSchemaName(schemaName)) {
      throw new Error(`Refusing to open a client for unsafe schema name '${schemaName}'`);
    }

    const existing = this.clients.get(schemaName);
    if (existing) return existing;

    const client = new TenantPrismaClient({
      datasources: { db: { url: this.connectionUrlFor(schemaName) } },
    });

    this.clients.set(schemaName, client);
    this.logger.log(`Opened tenant client for schema '${schemaName}'`);
    return client;
  }

  /**
   * Rewrites the base DATABASE_URL's `schema` parameter. Built with the URL API
   * rather than string concatenation because the pooled Supabase URL already
   * carries `?pgbouncer=true&connection_limit=N`, and appending a second `?`
   * would produce a connection string that fails only under load.
   */
  private connectionUrlFor(schemaName: string): string {
    const base = this.config.getOrThrow<string>('DATABASE_URL');
    const url = new URL(base);
    url.searchParams.set('schema', schemaName);
    return url.toString();
  }

  /** Test seam: lets an isolation test assert the cache never crosses tenants. */
  get cachedSchemas(): string[] {
    return [...this.clients.keys()];
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.$disconnect()));
    this.clients.clear();
  }
}
