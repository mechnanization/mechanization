/**
 * One-time (and safe to repeat) provisioning of a municipality's existing staff
 * on Day3ati, the News partner API.
 *
 *   pnpm --filter @mechanization/backend day3ati:backfill-staff --slug albazourieh
 *   pnpm --filter @mechanization/backend day3ati:backfill-staff --slug albazourieh --apply
 *
 * From now on `Day3atiStaffSyncService` creates, updates and removes a user's
 * Day3ati account as the user changes. It cannot know about the people who were
 * already here, and a change made while Day3ati was down is only retried on the
 * account's next change, so this walks every staff account of one municipality
 * and brings Day3ati to the state the sync rules describe (`planStaffSync`):
 * an active administrator or administrative officer has a `news_editor` account,
 * a deactivated one has none, every other role is not sent at all.
 *
 * Without `--apply` it is a dry run: it reads our accounts, says what it would
 * send, and calls Day3ati for nothing. It prints counts and staff ids only,
 * never a name.
 *
 * Which database it reads and which Day3ati it calls are whatever
 * `apps/backend/.env` says, so it follows the same rule as every script here:
 * run it against staging only with a temporary env file and a tunnel
 * (docs/database-environments.md). `pnpm day3ati:backfill-staff` against the
 * local database sends the seeded staff to whatever `DAY3ATI_*` names.
 * Day3ati settings that are not all set are refused before anything is read.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';
import { applyStaffSync, planStaffSync, type StaffSyncPlan } from '../application/features/day3ati/staff-sync';
import { Day3atiIntegrationClient } from '../infrastructure/day3ati/day3ati-integration.client';
import { Day3atiTokenService } from '../infrastructure/day3ati/day3ati-token.service';

interface Args {
  slug: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const index = argv.indexOf('--slug');
  const slug = index >= 0 ? argv[index + 1] : undefined;
  if (!slug) throw new Error('Usage: day3ati:backfill-staff --slug <slug> [--apply]');
  return { slug, apply: argv.includes('--apply') };
}

function tenantClient(schemaName: string): TenantPrismaClient {
  const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
  url.searchParams.set('schema', schemaName);
  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}

/** Resolves to whether every account was brought in step (always true for a dry run). */
export async function backfillDay3atiStaff(args: Args): Promise<boolean> {
  // The settings come from the same env file the database url does (Node 24's own loader; no dotenv here).
  try {
    process.loadEnvFile('.env');
  } catch {
    // No file: the settings may already be in the environment.
  }

  const config = new ConfigService();
  const tokens = new Day3atiTokenService(config);
  const integration = new Day3atiIntegrationClient(config, tokens);
  if (!integration.isConfigured) {
    throw new Error('Day3ati is not configured: set DAY3ATI_API_BASE_URL, DAY3ATI_TOKEN_URL, DAY3ATI_CLIENT_ID and DAY3ATI_CLIENT_SECRET');
  }

  const slug = TenantSlug.parse(args.slug);
  const registry = new RegistryPrismaClient();

  try {
    const tenant = await registry.tenant.findUnique({ where: { slug: slug.value } });
    if (!tenant) throw new Error(`Unknown municipality '${slug.value}' — provision it first`);

    const db = tenantClient(tenant.schemaName);
    const mode = args.apply ? '' : '[dry run] ';

    try {
      // Deleted accounts were never sent and are not now; a deactivated one is, so a stale account is removed.
      const staff = await db.user.findMany({
        where: { kind: 'STAFF', deletedAt: null },
        select: { id: true, role: true, isActive: true, firstName: true, lastName: true },
        orderBy: { createdAt: 'asc' },
      });

      const counts = { upsert: 0, remove: 0, none: 0, failed: 0, tenantNotMapped: 0 };

      for (const row of staff) {
        const plan: StaffSyncPlan = planStaffSync({
          action: 'STAFF_CREATED',
          user: {
            role: row.role,
            isActive: row.isActive,
            fullName: `${row.firstName ?? ''} ${row.lastName ?? ''}`,
          },
        });
        counts[plan.kind] += 1;
        if (plan.kind === 'none') continue;

        console.log(`${mode}${plan.kind === 'upsert' ? 'PUT   ' : 'DELETE'} ${row.id} (${row.role})`);
        if (!args.apply) continue;

        const result = await applyStaffSync(integration, tenant.slug, row.id, plan);
        if (result.outcome === 'failed') {
          counts.failed += 1;
          console.error(`  failed: ${result.code}`);
        } else if (result.outcome === 'tenant_not_mapped') {
          counts.tenantNotMapped += 1;
          console.error(`  Day3ati has no village for '${tenant.slug}' (integration.tenant_not_mapped): stopping.`);
          break;
        }
      }

      console.log(
        `${mode}${staff.length} staff accounts read: ${counts.upsert} to create or update, ` +
          `${counts.remove} to remove, ${counts.none} not sent` +
          (args.apply ? `; ${counts.failed} failed` : ''),
      );
      return counts.failed === 0 && counts.tenantNotMapped === 0;
    } finally {
      await db.$disconnect();
    }
  } finally {
    await registry.$disconnect();
  }
}

if (require.main === module) {
  backfillDay3atiStaff(parseArgs(process.argv.slice(2)))
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
