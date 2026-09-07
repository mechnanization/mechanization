/**
 * Local development seed: two provisioned municipalities, staff at every role,
 * and enough citizen data to exercise the dashboard, the map and the taxonomy.
 *
 *   pnpm --filter @mechanization/backend seed
 *
 * Two tenants rather than one is deliberate — with a single municipality, a
 * tenant-isolation bug looks exactly like working software.
 */
import { Client } from 'pg';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { ReferenceNumber } from '../domain/value-objects/reference-number.vo';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';
import { migrateTenantSchema } from '../infrastructure/prisma/tenant-migrator';

const TENANTS = [
  {
    slug: 'albazourieh',
    name: 'Al-Bazourieh',
    nameAr: 'البازورية',
    prefix: 'BZR',
    adminPathSegment: 'admin-portal-a91f',
  },
  {
    slug: 'zahle',
    name: 'Zahle',
    nameAr: 'زحلة',
    prefix: 'ZHL',
    adminPathSegment: 'admin-portal-4c7d',
  },
];

/** Development only. Production staff are created by the provisioning flow. */
const DEV_PASSWORD = 'Password123!';

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

async function syncStaffToSupabase(email: string, password: string, metadata: Record<string, unknown>) {
  if (!supabase) return;
  try {
    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) {
      const { data } = await supabase.auth.admin.listUsers();
      const existing = data?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (existing) {
        await supabase.auth.admin.updateUserById(existing.id, {
          password,
          user_metadata: metadata,
        });
      }
    }
  } catch (err) {
    console.warn(`  Could not sync ${email} to Supabase: ${(err as Error).message}`);
  }
}

/** A Prisma client bound to one municipality's schema. */
function tenantClient(schemaName: string): TenantPrismaClient {
  const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
  url.searchParams.set('schema', schemaName);
  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}

/**
 * Real parcels from this municipality's cadastre, spread across the whole
 * imported set rather than taken from the front of it.
 *
 * Seeded property numbers have to be real ones wherever a cadastre exists.
 * Invented numbers would now be rejected by the submission path they are meant
 * to demonstrate, and they would plot the sample registrations at coordinates
 * outside the municipality — which is exactly the bug the staff map is supposed
 * to make visible.
 *
 * Returns an empty list for a municipality with no cadastre; the caller falls
 * back to synthetic numbers, which is correct there because nothing validates
 * against a registry that does not exist.
 */
async function sampleParcels(
  db: TenantPrismaClient,
  count: number,
): Promise<Array<{ parcelNumber: string; latitude: number; longitude: number }>> {
  const total = await db.parcel.count();
  if (total === 0) return [];

  const stride = Math.max(1, Math.floor(total / count));

  const picked = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      db.parcel.findMany({
        skip: index * stride,
        take: 1,
        orderBy: { parcelNumber: 'asc' },
        select: { parcelNumber: true, latitude: true, longitude: true },
      }),
    ),
  );

  return picked.flat();
}

/** Staff at every role plus enough citizen data to exercise the dashboard. */
async function seedTenant(
  tenant: (typeof TENANTS)[number],
  schemaName: string,
): Promise<void> {
  const db = tenantClient(schemaName);

  try {
    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

    /**
     * SUPER_ADMIN gets a confirmed TOTP secret so the seeded account can
     * actually sign in — `User.assertMayStartSession()` refuses a SUPER_ADMIN
     * whose enrolment is incomplete, which is the intended production behaviour
     * and would otherwise lock a developer out of their own seed data.
     *
     * `update: {}` below means re-running the seed against an existing tenant
     * never touches this row, so generating a *new* secret on every run and
     * printing that would print a value that was never written to the
     * database — exactly the bug that made a re-seeded admin account
     * unloggable-into. The existing row's real secret is read back and printed
     * instead; a fresh one is only generated the first time the row is created.
     */
    const existingAdmin = await db.user.findUnique({
      where: { email: `admin@${tenant.slug}.gov.lb` },
      select: { totpSecret: true },
    });
    const totpSecret = existingAdmin?.totpSecret ?? authenticator.generateSecret();

    await db.user.upsert({
      where: { email: `admin@${tenant.slug}.gov.lb` },
      update: {},
      create: {
        kind: 'STAFF',
        tenantSlug: tenant.slug,
        email: `admin@${tenant.slug}.gov.lb`,
        passwordHash,
        role: 'SUPER_ADMIN',
        firstName: 'مدير',
        lastName: 'النظام',
        totpSecret,
        totpConfirmedAt: new Date(),
      },
    });

    await db.user.upsert({
      where: { email: `auditor@${tenant.slug}.gov.lb` },
      update: {},
      create: {
        kind: 'STAFF',
        tenantSlug: tenant.slug,
        email: `auditor@${tenant.slug}.gov.lb`,
        passwordHash,
        role: 'AUDITOR',
        firstName: 'مدقق',
        lastName: 'الحسابات',
      },
    });

    await db.user.upsert({
      where: { email: `inspector@${tenant.slug}.gov.lb` },
      update: {},
      create: {
        kind: 'STAFF',
        tenantSlug: tenant.slug,
        email: `inspector@${tenant.slug}.gov.lb`,
        passwordHash,
        role: 'FIELD_INSPECTOR',
        firstName: 'مفتش',
        lastName: 'ميداني',
      },
    });

    await syncStaffToSupabase(`admin@${tenant.slug}.gov.lb`, DEV_PASSWORD, {
      role: 'SUPER_ADMIN',
      tenantSlug: tenant.slug,
      firstName: 'مدير',
      lastName: 'النظام',
    });
    await syncStaffToSupabase(`auditor@${tenant.slug}.gov.lb`, DEV_PASSWORD, {
      role: 'AUDITOR',
      tenantSlug: tenant.slug,
      firstName: 'مدقق',
      lastName: 'الحسابات',
    });
    await syncStaffToSupabase(`inspector@${tenant.slug}.gov.lb`, DEV_PASSWORD, {
      role: 'FIELD_INSPECTOR',
      tenantSlug: tenant.slug,
      firstName: 'مفتش',
      lastName: 'ميداني',
    });

    console.log(`  staff: admin/auditor/inspector@${tenant.slug}.gov.lb (${DEV_PASSWORD})`);
    console.log(`  SUPER_ADMIN TOTP secret: ${totpSecret}`);

    // ── Citizens + registrations ──────────────────────────────────────
    // Deliberately covers every branch of the property taxonomy and every
    // صفة الإقامة, so the dashboard's group-by charts have something to show.
    const samples = [
      {
        firstName: 'علي',
        lastName: 'حسن',
        phone: '+96170111222',
        residentStatus: 'VILLAGE_RESIDENT' as const,
        docNumber: `${tenant.prefix}1001`,
        property: {
          occupancyType: 'OWNER' as const,
          propertyType: 'BUILDING' as const,
          neighborhood: 'الزهراء',
          propertyNumber: `${tenant.prefix}-B-101`,
          buildingName: 'مبنى الزهراء',
          latitude: 33.2705,
          longitude: 35.2038,
          // A whole building, which is the case the units table exists for —
          // one رقم العقار, three units. Seeding a single-unit building would
          // never exercise it.
          units: {
            create: [
              { unitType: 'APARTMENT' as const, floor: '3', unitArea: 120.5 },
              { unitType: 'APARTMENT' as const, floor: '4', unitArea: 118 },
              { unitType: 'SHOP' as const, floor: '0', unitArea: 45 },
            ],
          },
        },
        status: 'PENDING' as const,
      },
      {
        firstName: 'فاطمة',
        lastName: 'خليل',
        phone: '+96171333444',
        residentStatus: 'DISPLACED' as const,
        docNumber: `${tenant.prefix}1002`,
        property: {
          occupancyType: 'TENANT' as const,
          landlordName: 'سمير مراد',
          landlordPhone: '+96176555666',
          propertyType: 'HOUSE' as const,
          neighborhood: 'الحديقة',
          propertyNumber: `${tenant.prefix}-H-202`,
          buildingName: 'منزل الحديقة',
          unitArea: 85,
          latitude: 33.2731,
          longitude: 35.2094,
        },
        status: 'UNDER_REVIEW' as const,
      },
      {
        firstName: 'محمد',
        lastName: 'صالح',
        phone: '+96103777888',
        residentStatus: 'REFUGEE' as const,
        docNumber: `${tenant.prefix}1003`,
        property: {
          occupancyType: 'OWNER' as const,
          propertyType: 'TENT' as const,
          neighborhood: 'المخيم الشمالي',
          propertyNumber: `${tenant.prefix}-T-303`,
          tentLocation: 'مخيم الشمال — قطاع ب',
          latitude: 33.2688,
          longitude: 35.1975,
        },
        status: 'VERIFIED' as const,
      },
      {
        firstName: 'رانيا',
        lastName: 'عبدالله',
        phone: '+96178999000',
        residentStatus: 'VILLAGE_RESIDENT' as const,
        docNumber: `${tenant.prefix}1004`,
        property: {
          occupancyType: 'OWNER' as const,
          propertyType: 'LAND' as const,
          neighborhood: 'الأطراف الشرقية',
          propertyNumber: `${tenant.prefix}-L-404`,
          landType: 'AGRICULTURAL' as const,
          unitArea: 2400,
          shares: 2400,
          latitude: 33.2752,
          longitude: 35.2141,
        },
        status: 'APPROVED' as const,
      },
    ];

    /**
     * Where a cadastre exists, the sample properties adopt real parcel numbers
     * and the survey's own coordinates — the same substitution the live
     * submission path performs, so the seeded rows are indistinguishable from
     * ones a citizen filed.
     */
    const realParcels = await sampleParcels(db, samples.length);
    if (realParcels.length > 0) {
      console.log(
        `  using real parcels: ${realParcels.map((p) => p.parcelNumber).join(', ')}`,
      );
    }

    for (const [sampleIndex, sample] of samples.entries()) {
      const parcel = realParcels[sampleIndex];
      if (parcel) {
        sample.property.propertyNumber = parcel.parcelNumber;
        sample.property.latitude = parcel.latitude;
        sample.property.longitude = parcel.longitude;
      }

      const citizen = await db.user.upsert({
        where: {
          identityDocType_identityDocNumber: {
            identityDocType: 'NATIONAL_ID',
            identityDocNumber: sample.docNumber,
          },
        },
        update: {},
        create: {
          kind: 'CITIZEN',
          tenantSlug: tenant.slug,
          phone: sample.phone,
          whatsapp: sample.phone,
          firstName: sample.firstName,
          lastName: sample.lastName,
          gender: 'MALE',
          nationality: 'لبناني',
          isLebanese: sample.residentStatus !== 'REFUGEE',
          residentStatus: sample.residentStatus,
          identityDocType: 'NATIONAL_ID',
          identityDocNumber: sample.docNumber,
          civilRecordNumber: '12',
          totalRegisteredMembers: 4,
          actualHouseholdMembers: 4,
          maritalStatus: 'MARRIED',
          referenceNumber: ReferenceNumber.generate(tenant.prefix).value,
        },
        select: { id: true },
      });

      // `findFirst`, not `findUnique`: رقم العقار is no longer unique, because
      // a building is one cadastral number shared by everyone in it. This is
      // only re-run protection for the seed itself — it keeps a second
      // `pnpm db:seed` from stacking duplicate sample registrations onto the
      // same parcel, which real citizens are explicitly allowed to do.
      const existing = await db.propertyEntry.findFirst({
        where: { propertyNumber: sample.property.propertyNumber },
        select: { id: true },
      });
      if (existing) continue;

      await db.registration.create({
        data: {
          citizenId: citizen.id,
          referenceNumber: ReferenceNumber.generate(tenant.prefix).value,
          status: sample.status,
          properties: { create: [sample.property as never] },
        },
      });
    }

    console.log(`  ${samples.length} citizens + registrations`);
  } finally {
    await db.$disconnect();
  }
}

/** Provisions and seeds both demo municipalities. */
async function main(): Promise<void> {
  const registry = new RegistryPrismaClient();
  const ddl = new Client({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });

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

      await seedTenant(tenant, schemaName);
      console.log(`  admin path: /${tenant.slug}/ar/${tenant.adminPathSegment}`);
    }

    console.log('\n✓ Seed complete');
  } finally {
    await ddl.end().catch(() => undefined);
    await registry.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ Seed failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
