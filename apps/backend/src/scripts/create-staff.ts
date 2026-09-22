/**
 * Creates one staff account in a provisioned municipality, and enrols its
 * second factor.
 *
 *   pnpm staff:create --slug ashrafieh --email admin@ashrafieh.gov.lb \
 *     --password '<strong-password>' --first-name مدير --last-name النظام
 *
 *   pnpm staff:create --slug ashrafieh --email admin@ashrafieh.gov.lb --reset-totp
 *
 * This exists because `IdentityService.loginStaff` no longer provisions a
 * profile on the fly. It used to: a login against a municipality the account
 * had no row in created one, taking the role from Supabase `user_metadata` and
 * defaulting it to SUPER_ADMIN — which made every account in the shared
 * Supabase project an administrator of every municipality it had not yet
 * visited. Removing that left `tenant:provision` with no way to produce the
 * first account, and this is that way: an explicit, deliberate act, the same
 * shape as provisioning itself.
 *
 * A SUPER_ADMIN cannot sign in without a confirmed authenticator, so the secret
 * is issued here and printed once. `--reset-totp` reissues it for an account
 * whose secret never reached its owner — the only recovery path for a role that
 * cannot log in to re-enrol itself.
 */
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';

type Role =
  | 'SUPER_ADMIN'
  | 'AUDITOR'
  | 'FIELD_INSPECTOR'
  | 'COLLECTOR'
  | 'ACCOUNTANT'
  | 'ADMINISTRATIVE_OFFICER';
const ROLES: readonly Role[] = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
];

interface Args {
  slug: string;
  email: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  role: Role;
  resetTotp: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const slug = get('--slug');
  const email = get('--email');
  const resetTotp = argv.includes('--reset-totp');
  const role = (get('--role') ?? 'SUPER_ADMIN') as Role;

  if (!slug || !email) {
    throw new Error(
      'Usage: staff:create --slug <slug> --email <email> ' +
        '[--password <password> --first-name <name> --last-name <name>] ' +
        `[--role ${ROLES.join('|')}] [--reset-totp]`,
    );
  }
  if (!ROLES.includes(role)) {
    throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  }
  // Everything but a reset is a creation, and a creation needs all of it.
  if (!resetTotp && (!get('--password') || !get('--first-name') || !get('--last-name'))) {
    throw new Error('--password, --first-name and --last-name are required when creating');
  }

  return {
    slug,
    email: email.trim().toLowerCase(),
    password: get('--password'),
    firstName: get('--first-name'),
    lastName: get('--last-name'),
    role,
    resetTotp,
  };
}

/**
 * DDL-free, but still the direct connection: this runs from an operator's
 * terminal rather than the API, so there is no pooled client to reuse and no
 * reason to take a slot in the pooler the running app depends on.
 */
function tenantClient(schemaName: string): TenantPrismaClient {
  const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
  url.searchParams.set('schema', schemaName);
  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}


export async function createStaff(args: Args): Promise<void> {
  const slug = TenantSlug.parse(args.slug);
  const registry = new RegistryPrismaClient();

  try {
    const tenant = await registry.tenant.findUnique({ where: { slug: slug.value } });
    if (!tenant) {
      throw new Error(`No municipality '${slug.value}' — run tenant:provision first`);
    }
    if (!tenant.provisionedAt) {
      throw new Error(`'${slug.value}' is registered but not provisioned — re-run tenant:provision`);
    }

    const db = tenantClient(tenant.schemaName);

    try {
      const existing = await db.user.findFirst({
        where: { email: args.email, kind: 'STAFF' },
        select: { id: true, role: true },
      });

      if (args.resetTotp) {
        if (!existing) throw new Error(`No staff account '${args.email}' in '${slug.value}'`);

        const secret = authenticator.generateSecret();
        await db.user.update({
          where: { id: existing.id },
          data: { totpSecret: secret, totpConfirmedAt: new Date() },
        });

        report(args.email, secret, slug.value, existing.role as Role);
        return;
      }

      if (existing) {
        throw new Error(
          `'${args.email}' already holds an account in '${slug.value}' — use --reset-totp to reissue its second factor`,
        );
      }

      /**
       * The authenticator secret is issued at creation for SUPER_ADMIN, because
       * that role is refused a session until enrolment is confirmed and the
       * enrolment endpoint is itself behind a session. Other roles enrol
       * themselves later, from inside the dashboard.
       */
      const secret = args.role === 'SUPER_ADMIN' ? authenticator.generateSecret() : null;
      const passwordHash = await bcrypt.hash(args.password!, 12);

      await db.user.create({
        data: {
          kind: 'STAFF',
          tenantSlug: slug.value,
          email: args.email,
          passwordHash,
          role: args.role,
          firstName: args.firstName!,
          lastName: args.lastName!,
          ...(secret ? { totpSecret: secret, totpConfirmedAt: new Date() } : {}),
        },
      });

      report(args.email, secret, slug.value, args.role);
      console.log(`  sign in at: /${slug.value}/ar/${tenant.adminPathSegment}`);
    } finally {
      await db.$disconnect();
    }
  } finally {
    await registry.$disconnect();
  }
}

/** Printed once. Nothing reads the secret back out of the database afterwards. */
function report(email: string, secret: string | null, slug: string, role: Role): void {
  console.log(`\n✓ ${role} '${email}' ready in '${slug}'`);
  if (!secret) {
    console.log('  no authenticator issued — this role enrols itself from the dashboard');
    return;
  }
  console.log(`  authenticator secret: ${secret}`);
  console.log(`  otpauth URI: ${authenticator.keyuri(email, `Baladiya ${slug}`, secret)}`);
  console.log('\n  Hand this to its owner over a channel you trust, then delete it.');
  console.log('  It is not recoverable — reissue with --reset-totp if it is lost.');
}

if (require.main === module) {
  createStaff(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
