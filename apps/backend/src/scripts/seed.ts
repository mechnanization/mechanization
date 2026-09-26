/**
 * Local development seed: two provisioned municipalities, staff at every role,
 * and a register shaped like production's — citizens, filings, cards, reviews,
 * field re-checks and invoices. What is generated, and why it passes the app's
 * own validation, is in seed-register.ts.
 *
 *   pnpm db:seed                      1,500 citizens in Al-Bazourieh, 375 in Zahle
 *   pnpm db:seed --citizens=3000      Al-Bazourieh at 3,000; Zahle gets a quarter
 *
 * It runs only against the local database (municipality_db_local on loopback).
 * It creates staff accounts whose password it prints, and a register of
 * invented people; neither belongs anywhere else.
 *
 * Re-running is safe. Every id is derived, so rows that exist are skipped and
 * only what is missing is written.
 *
 * Two tenants rather than one is deliberate — with a single municipality, a
 * tenant-isolation bug looks exactly like working software.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';
import { migrateTenantSchema } from '../infrastructure/prisma/tenant-migrator';
import { importCadastre } from './import-parcels';
import { generateRegister, type Register, type SeedStaff } from './seed-register';

export const TENANTS = [
  {
    slug: 'albazourieh',
    name: 'Al-Bazourieh',
    nameAr: 'البازورية',
    prefix: 'BZR',
    adminPathSegment: 'admin-portal-a91f',
    region: 'south' as const,
    index: 0,
    /** The survey office's file, relative to apps/backend. */
    cadastre: 'data/bazoreyye.kmz',
    share: 1,
  },
  {
    slug: 'zahle',
    name: 'Zahle',
    nameAr: 'زحلة',
    prefix: 'ZHL',
    adminPathSegment: 'admin-portal-4c7d',
    region: 'bekaa' as const,
    index: 1,
    cadastre: null,
    share: 0.25,
  },
];

const DEFAULT_CITIZENS = 1500;

/** Development only. Production staff are created by the provisioning flow. */
const DEV_PASSWORD = 'Password123!';

/** Every role, and four field inspectors so officer statistics have a spread. */
const STAFF = [
  { key: 'admin', local: 'admin', role: 'SUPER_ADMIN', firstName: 'مدير', lastName: 'النظام' },
  { key: 'auditor', local: 'auditor', role: 'AUDITOR', firstName: 'مدقق', lastName: 'الحسابات' },
  { key: 'officer', local: 'officer', role: 'ADMINISTRATIVE_OFFICER', firstName: 'موظف', lastName: 'إداري' },
  { key: 'accountant', local: 'accountant', role: 'ACCOUNTANT', firstName: 'محاسب', lastName: 'البلدية' },
  { key: 'collector', local: 'collector', role: 'COLLECTOR', firstName: 'جابي', lastName: 'البلدية' },
  { key: 'inspector1', local: 'inspector', role: 'FIELD_INSPECTOR', firstName: 'مفتش', lastName: 'ميداني' },
  { key: 'inspector2', local: 'inspector2', role: 'FIELD_INSPECTOR', firstName: 'حسين', lastName: 'قاسم' },
  { key: 'inspector3', local: 'inspector3', role: 'FIELD_INSPECTOR', firstName: 'زينب', lastName: 'فقيه' },
  { key: 'inspector4', local: 'inspector4', role: 'FIELD_INSPECTOR', firstName: 'علي', lastName: 'سرور' },
] as const;

/**
 * Variables that point a process at a shared service. The seed needs none of
 * them, and the cadastre import would upload over the real cartography bucket
 * if AWS_REGION and S3_CADASTRE_BUCKET were set. Cleared twice: at start, and
 * after Prisma has loaded apps/backend/.env.
 */
export function clearRemoteCredentials(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(AWS_|S3_|SUPABASE_)/.test(key)) delete process.env[key];
  }
}

/**
 * Refuses anything but the local database. The guard in scripts/db/ covers
 * `pnpm dev`; this script is run on its own, and it writes a known password.
 */
export function localDatabaseUrl(): string {
  const raw = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set. apps/backend/.env names the local database.');
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (database !== 'municipality_db_local' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(
      `The seed runs only against the local database (municipality_db_local on this machine). ` +
        `The connection names '${database}' on '${host}'. It creates staff accounts with a published ` +
        `password and a register of invented people, which belong nowhere else.`,
    );
  }
  return raw;
}

export function requestedCitizens(): number {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith('--citizens='))?.split('=')[1];
  const spaced = argv.includes('--citizens') ? argv[argv.indexOf('--citizens') + 1] : undefined;
  const raw = inline ?? spaced ?? process.env.SEED_CITIZENS;
  if (raw === undefined) return DEFAULT_CITIZENS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 50 || n > 50_000) {
    throw new Error(`--citizens must be a whole number between 50 and 50000 (got '${raw}')`);
  }
  return n;
}

/** A Prisma client bound to one municipality's schema. */
export function tenantClient(connectionString: string, schemaName: string): TenantPrismaClient {
  const url = new URL(connectionString);
  url.searchParams.set('schema', schemaName);
  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}

type Tenant = (typeof TENANTS)[number];

async function seedStaff(
  db: TenantPrismaClient,
  tenant: Tenant,
): Promise<{ ids: SeedStaff; totpSecret: string | null }> {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  /*
    The admin's TOTP secret: a fresh one only when the row is first created.
    `update: {}` means a re-run never touches an existing row, so what gets
    printed is what the row actually holds. An admin whose 2FA was reset in
    the app has none, and printing a newly generated secret for them would
    send someone to an authenticator code that can never work.
  */
  const adminEmail = `admin@${tenant.slug}.gov.lb`;
  const existingAdmin = await db.user.findUnique({
    where: { email: adminEmail },
    select: { totpSecret: true, totpConfirmedAt: true },
  });
  const newSecret = authenticator.generateSecret();
  const totpSecret = existingAdmin
    ? existingAdmin.totpConfirmedAt
      ? existingAdmin.totpSecret
      : null
    : newSecret;

  const ids: Record<string, string> = {};
  for (const member of STAFF) {
    const email = `${member.local}@${tenant.slug}.gov.lb`;
    const row = await db.user.upsert({
      where: { email },
      update: {},
      create: {
        kind: 'STAFF',
        tenantSlug: tenant.slug,
        email,
        passwordHash,
        role: member.role,
        firstName: member.firstName,
        lastName: member.lastName,
        ...(member.role === 'SUPER_ADMIN' ? { totpSecret: newSecret, totpConfirmedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    ids[member.key] = row.id;
  }

  return {
    totpSecret,
    ids: {
      admin: ids.admin,
      auditor: ids.auditor,
      officer: ids.officer,
      accountant: ids.accountant,
      collector: ids.collector,
      inspectors: [ids.inspector1, ids.inspector2, ids.inspector3, ids.inspector4],
    },
  };
}

/**
 * Imports the municipality's survey file if its parcel table is empty, so the
 * register is generated against real parcel numbers — the ones the citizen
 * form checks a رقم العقار against. The GeoJSON goes to a temporary folder, not
 * over the copies committed under apps/frontend/public.
 */
async function ensureCadastre(db: TenantPrismaClient, tenant: Tenant): Promise<void> {
  if (!tenant.cadastre) return;
  if ((await db.parcel.count()) > 0) return;
  const file = join(__dirname, '..', '..', tenant.cadastre);
  if (!existsSync(file)) {
    console.log(`  ! no cadastre file at ${file}; parcel numbers will not be checked`);
    return;
  }
  await importCadastre({
    slug: tenant.slug,
    file,
    outDir: join(tmpdir(), `mechanization-seed-cadastre-${tenant.slug}`),
  });
}

/**
 * The previous seed's four sample citizens per municipality. They carried map
 * coordinates, and the register no longer seeds any.
 */
async function removePreviousSamples(db: TenantPrismaClient, tenant: Tenant): Promise<void> {
  const docNumbers = [1001, 1002, 1003, 1004].map((n) => `${tenant.prefix}${n}`);
  try {
    const { count } = await db.user.deleteMany({
      where: { kind: 'CITIZEN', identityDocType: 'NATIONAL_ID', identityDocNumber: { in: docNumbers } },
    });
    if (count > 0) console.log(`  removed the previous seed's ${count} sample citizens (they carried map points)`);
  } catch (error) {
    // A payment recorded against one of them makes the append-only ledger
    // refuse the cascade. That is the ledger working; leave them.
    console.log(`  ! kept the previous seed's sample citizens: ${(error as Error).message.split('\n')[0]}`);
  }
}

async function insertAll(
  label: string,
  rows: readonly Record<string, unknown>[],
  create: (chunk: Record<string, unknown>[]) => Promise<{ count: number }>,
  written: Record<string, number>,
): Promise<void> {
  let count = 0;
  for (let i = 0; i < rows.length; i += 500) {
    count += (await create(rows.slice(i, i + 500))).count;
  }
  written[label] = count;
}

/** Writes what is missing, in dependency order. Existing ids are skipped. */
async function writeRegister(
  db: TenantPrismaClient,
  schemaName: string,
  register: Register,
): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  const skip = { skipDuplicates: true } as const;

  await insertAll('citizens', register.users, (data) => db.user.createMany({ data: data as never, ...skip }), written);
  await insertAll('registrations', register.registrations, (data) => db.registration.createMany({ data: data as never, ...skip }), written);
  await insertAll('property cards', register.propertyEntries, (data) => db.propertyEntry.createMany({ data: data as never, ...skip }), written);
  await insertAll('card units', register.buildingUnits, (data) => db.buildingUnit.createMany({ data: data as never, ...skip }), written);
  await insertAll('record reviews', register.recordReviews, (data) => db.recordReview.createMany({ data: data as never, ...skip }), written);
  await insertAll('quality checks', register.qualityChecks, (data) => db.qualityCheck.createMany({ data: data as never, ...skip }), written);

  // One row per municipality; a developer's own settings are left alone.
  if ((await db.systemSettings.count()) === 0) {
    await db.systemSettings.create({ data: register.systemSettings as never });
  }
  await insertAll('fee notices', register.feeNotices, (data) => db.feeNotice.createMany({ data: data as never, ...skip }), written);
  await insertAll('invoices', register.invoices, (data) => db.citizenPayment.createMany({ data: data as never, ...skip }), written);

  /*
    Receipts are numbered from the ledger's own sequence, as
    PaymentLedgerService numbers them, and only for transactions not already
    written. Inventing numbers here would leave the sequence behind them, and
    the app's next real receipt would collide with a seeded one.
  */
  const planned = register.transactions;
  const existing = new Set(
    (await db.paymentTransaction.findMany({ where: { id: { in: planned.map((t) => t.id) } }, select: { id: true } })).map(
      (row) => row.id,
    ),
  );
  const fresh = planned.filter((t) => !existing.has(t.id));
  let receipts: Array<{ n: bigint }> = [];
  if (fresh.length > 0) {
    receipts = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT nextval('"${schemaName}".payment_receipt_seq') AS n FROM generate_series(1, ${fresh.length})`,
    );
  }
  await insertAll(
    'payment transactions',
    fresh.map((t, i) => ({
      ...t,
      currency: 'LBP',
      receiptNumber: `RCP-${String(receipts[i].n).padStart(6, '0')}`,
      note: null,
    })),
    (data) => db.paymentTransaction.createMany({ data: data as never, ...skip }),
    written,
  );

  return written;
}

/** Reads the municipality back on a fresh connection: the count, not the exit code. */
async function readBack(connectionString: string, schemaName: string): Promise<Record<string, number>> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const s = `"${schemaName}"`;
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM ${s}.users WHERE kind = 'STAFF')::int                     AS staff,
        (SELECT count(*) FROM ${s}.users WHERE kind = 'CITIZEN')::int                   AS citizens,
        (SELECT count(*) FROM ${s}.registrations)::int                                  AS registrations,
        (SELECT count(*) FROM ${s}.registrations WHERE status = 'REQUIRES_REVIEW')::int AS flagged,
        (SELECT count(*) FROM ${s}.property_entries)::int                               AS cards,
        (SELECT count(*) FROM ${s}.building_units)::int                                 AS units,
        (SELECT count(*) FROM ${s}.record_reviews)::int                                 AS reviews,
        (SELECT count(*) FROM ${s}.quality_checks)::int                                 AS checks,
        (SELECT count(*) FROM ${s}.citizen_payments)::int                               AS invoices,
        (SELECT count(*) FROM ${s}.payment_transactions)::int                           AS transactions,
        (SELECT count(*) FROM ${s}.parcels)::int                                        AS parcels,
        (SELECT count(*) FROM ${s}.property_entries WHERE latitude IS NOT NULL)::int    AS pinned_cards,
        (SELECT count(*) FROM ${s}.buildings)::int                                      AS buildings
    `);
    return rows[0] as Record<string, number>;
  } finally {
    await client.end();
  }
}

/** Provisions and seeds both demo municipalities. Exported for seed-census.ts, which builds on it. */
export async function runSeed(): Promise<void> {
  clearRemoteCredentials();
  // Constructing the client is what loads apps/backend/.env into process.env.
  const registry = new RegistryPrismaClient();
  clearRemoteCredentials();
  const connectionString = localDatabaseUrl();
  const citizens = requestedCitizens();
  const ddl = new Client({ connectionString });
  const logins: string[] = [];

  try {
    await ddl.connect();

    for (const tenant of TENANTS) {
      const schemaName = TenantSlug.parse(tenant.slug).schemaName;
      console.log(`\n${tenant.nameAr} (${tenant.slug}) → ${schemaName}`);

      await migrateTenantSchema(ddl, schemaName);

      await registry.tenant.upsert({
        where: { slug: tenant.slug },
        update: { provisionedAt: new Date() },
        create: {
          slug: tenant.slug,
          name: tenant.name,
          nameAr: tenant.nameAr,
          schemaName,
          adminPathSegment: tenant.adminPathSegment,
          referencePrefix: tenant.prefix,
          config: {},
          isActive: true,
          provisionedAt: new Date(),
        },
      });

      const db = tenantClient(connectionString, schemaName);
      try {
        await ensureCadastre(db, tenant);
        const { ids, totpSecret } = await seedStaff(db, tenant);
        await removePreviousSamples(db, tenant);

        const parcels = (
          await db.parcel.findMany({ select: { parcelNumber: true }, orderBy: { parcelNumber: 'asc' } })
        ).map((p) => p.parcelNumber);
        const count = tenant.share === 1 ? citizens : Math.max(50, Math.round(citizens * tenant.share));

        const register = generateRegister(
          { slug: tenant.slug, prefix: tenant.prefix, index: tenant.index, region: tenant.region, nameAr: tenant.nameAr },
          { citizens: count, parcels, staff: ids },
        );
        console.log(
          `  generated ${count} citizens against ${parcels.length > 0 ? `${parcels.length} real parcels` : 'no cadastre'}; ` +
            'every filing passed the API validation',
        );

        const written = await writeRegister(db, schemaName, register);
        const newRows = Object.entries(written)
          .filter(([, n]) => n > 0)
          .map(([label, n]) => `${n} ${label}`);
        console.log(`  written: ${newRows.length > 0 ? newRows.join(', ') : 'nothing new (already seeded)'}`);

        const on = await readBack(connectionString, schemaName);
        console.log(
          `  on the database now: ${on.citizens} citizens (${on.flagged} flagged for review), ${on.cards} cards, ` +
            `${on.units} units, ${on.reviews} reviews, ${on.checks} field re-checks, ${on.invoices} invoices, ` +
            `${on.transactions} payments, ${on.staff} staff, ${on.parcels} parcels`,
        );
        console.log(`  map points: ${on.pinned_cards} pinned cards, ${on.buildings} census buildings`);

        logins.push(
          `  ${tenant.nameAr}: http://localhost:3000/${tenant.slug}/ar/${tenant.adminPathSegment}` +
            `\n    ${STAFF.map((m) => `${m.local}@${tenant.slug}.gov.lb`).join(', ')}` +
            (totpSecret
              ? `\n    admin@ TOTP secret: ${totpSecret}`
              : '\n    admin@ has no 2FA set up (it was reset in the app): it signs in with the password alone'),
        );
      } finally {
        await db.$disconnect();
      }
    }

    console.log(`\nLogins (password for every account: ${DEV_PASSWORD})`);
    console.log(logins.join('\n'));
    console.log('\n✓ Seed complete');
  } finally {
    await ddl.end().catch(() => undefined);
    await registry.$disconnect();
  }
}

if (require.main === module) {
  runSeed().catch((error: unknown) => {
    console.error(`\n✗ Seed failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
