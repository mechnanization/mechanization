#!/usr/bin/env node
/**
 * Seeds a comprehensive test dataset of 20 citizens with diverse property types,
 * occupancy arrangements, and billing edge cases in the LOCAL database.
 *
 * Designed specifically for testing fee calculations and posting:
 *   - FLAT fees (fixed fee per citizen)
 *   - PER_UNIT fees (including duplex 2-level roof multipliers)
 *   - PER_AREA fees (linear rate * area, deed share weighting)
 *   - TIERED_AREA fees (bracket tables + shared unit bills)
 *   - OWNER vs OCCUPANT bearer rules
 *   - Landlord & 5 distinct tenant property types (APARTMENT, SHOP, OFFICE, CLINIC, WAREHOUSE)
 *   - Diaspora / Non-resident landlord renting to village resident tenant
 *   - Co-ownership modes: EQUAL (50/50), BY_SHARES (1600/800), RESPONSIBLE_OWNER (100%/0%)
 *   - Commercial units (Shop + Warehouse) vs Residential vs Standalone House
 *   - War-damaged uninhabitable property (habitable: false -> exempt)
 *   - Place of worship (feeExemption: PLACE_OF_WORSHIP -> exempt)
 *   - Non-resident absentee owner (residence: NON_RESIDENT_OWNER)
 *
 * Usage:
 *   node scripts/db/seed-fee-testing-citizens.mjs [--clean] [--tenant=<slug>]
 *   pnpm db:seed:fee-testing
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, resolveTarget, parseConnection } from './targets.mjs';
import { deleteCitizensAndBuildings } from './delete-local-citizens-and-buildings.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  cyan: (s) => `\x1b[96m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(C.red(`\n✗ ${msg}`));
  process.exit(1);
}

export async function seedFeeTestingCitizens({ tenantSlug = 'albazourieh', cleanFirst = true } = {}) {
  console.log(C.bold(`--- Seeding 20 Fee-Testing Citizens & Properties in ${tenantSlug} ---`));

  // 1. Strict Target Validation
  let resolved;
  try {
    resolved = resolveTarget('local');
  } catch (err) {
    fail(`Could not resolve local target: ${err.message}`);
  }

  const dbUrl = resolved.env.DIRECT_URL ?? resolved.env.DATABASE_URL;
  const parsed = parseConnection(dbUrl);
  if (!parsed || !(parsed.host.startsWith('127.0.0.1') || parsed.host.startsWith('localhost')) || parsed.database !== 'municipality_db_local') {
    fail(`REFUSED: Script can only run against municipality_db_local on loopback!`);
  }

  // Optional clean step before seeding
  if (cleanFirst) {
    console.log(C.dim(`Cleaning prior citizens and buildings in ${tenantSlug}...`));
    await deleteCitizensAndBuildings({ tenantSlug, autoConfirm: true });
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const s = `tenant_${tenantSlug.replace(/-/g, '_')}`;

    // Verify tenant schema exists
    const schemaCheck = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [s]);
    if (schemaCheck.rows.length === 0) {
      fail(`Schema "${s}" does not exist in local database.`);
    }

    // Get staff accounts for createdById / officerId
    const staffRes = await client.query(`
      SELECT id, role FROM "${s}".users WHERE kind = 'STAFF' ORDER BY role LIMIT 5
    `);
    if (staffRes.rows.length === 0) {
      fail(`No staff accounts found in ${s}. Please run "pnpm db:seed" first to create staff.`);
    }
    const officerId = staffRes.rows.find((u) => u.role === 'ADMINISTRATIVE_OFFICER')?.id ?? staffRes.rows[0].id;
    const inspectorId = staffRes.rows.find((u) => u.role === 'FIELD_INSPECTOR')?.id ?? staffRes.rows[0].id;

    // Fetch surveyed parcels for real coordinates & parcel numbers
    const parcelsRes = await client.query(`
      SELECT "parcelNumber", latitude, longitude
      FROM "${s}".parcels
      ORDER BY "parcelNumber"::integer ASC
      LIMIT 20
    `);
    const parcels = parcelsRes.rows;
    const p = (idx) => parcels[idx] ?? { parcelNumber: String(idx + 1), latitude: 33.255, longitude: 35.271 };

    await client.query('BEGIN');

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Define Citizens Data (20 Citizens)
    // ──────────────────────────────────────────────────────────────────────────
    const citizens = [
      {
        ref: 'BZR-TEST-001',
        first: 'أحمد',
        last: 'حسن',
        mother: 'مريم خليل',
        phone: '+96177100001',
        residence: 'RESIDENT',
        title: 'شقة سكنية عادية (Single Flat 120m² - FLAT / AREA testing)',
      },
      {
        ref: 'BZR-TEST-002',
        first: 'فاطمة',
        last: 'قاسم',
        mother: 'زينب علي',
        phone: '+96177100002',
        residence: 'RESIDENT',
        title: 'دوبلكس سكني طابقين (Duplex Flat 220m² - Levels: 2 - Roof Multiplier)',
      },
      {
        ref: 'BZR-TEST-003',
        first: 'حسين',
        last: 'سرور',
        mother: 'خديجة محمد',
        phone: '+96177100003',
        residence: 'RESIDENT',
        title: 'مالك ومؤجر 5 وحدات متنوعة (Landlord: 5 Units - Apt, Shop, Office, Clinic, Warehouse)',
      },
      {
        ref: 'BZR-TEST-004',
        first: 'علي',
        last: 'زين',
        mother: 'فاطمة رضا',
        phone: '+96177100004',
        residence: 'RESIDENT',
        title: 'مستأجر لشقة المالك المغترب جوزيف مطر (Tenant: Flat 175m² - Diaspora Landlord)',
      },
      {
        ref: 'BZR-TEST-005',
        first: 'محمد',
        last: 'بيضون',
        mother: 'هدى إبراهيم',
        phone: '+96177100005',
        residence: 'RESIDENT',
        title: 'مالك شريك مناصفة أ (Co-owner 50% - Flat 140m² - Mode EQUAL)',
      },
      {
        ref: 'BZR-TEST-006',
        first: 'خليل',
        last: 'بيضون',
        mother: 'هدى إبراهيم',
        phone: '+96177100006',
        residence: 'RESIDENT',
        title: 'مالك شريك مناصفة ب (Co-owner 50% - Flat 140m² - Mode EQUAL)',
      },
      {
        ref: 'BZR-TEST-007',
        first: 'عباس',
        last: 'مغنية',
        mother: 'سكينة حسن',
        phone: '+96177100007',
        residence: 'RESIDENT',
        title: 'شريك بالأسهم ثلثين (Co-owner 1600/2400 Shares - Flat 180m² - Mode BY_SHARES)',
      },
      {
        ref: 'BZR-TEST-008',
        first: 'مهدي',
        last: 'مغنية',
        mother: 'سكينة حسن',
        phone: '+96177100008',
        residence: 'RESIDENT',
        title: 'شريك بالأسهم ثلث (Co-owner 800/2400 Shares - Flat 180m² - Mode BY_SHARES)',
      },
      {
        ref: 'BZR-TEST-009',
        first: 'سامي',
        last: 'فقيه',
        mother: 'أمينة أسعد',
        phone: '+96177100009',
        residence: 'RESIDENT',
        title: 'مالك مسؤول يدفع 100% (Responsible Owner - Flat 150m² - Mode RESPONSIBLE_OWNER)',
      },
      {
        ref: 'BZR-TEST-010',
        first: 'رمزي',
        last: 'فقيه',
        mother: 'أمينة أسعد',
        phone: '+96177100010',
        residence: 'RESIDENT',
        title: 'شريك معفى يدفع 0% (Non-paying Co-owner - Flat 150m² - Mode RESPONSIBLE_OWNER)',
      },
      {
        ref: 'BZR-TEST-011',
        first: 'جورج',
        last: 'حداد',
        mother: 'ماري سليم',
        phone: '+96177100011',
        residence: 'RESIDENT',
        title: 'منزل مستقل (Standalone House 200m² - HOUSE)',
      },
      {
        ref: 'BZR-TEST-012',
        first: 'ريم',
        last: 'قصير',
        mother: 'سلمى عبد الله',
        phone: '+96177100012',
        residence: 'RESIDENT',
        title: 'محلات تجارية ومستودع (Commercial: Shop 45m² + Warehouse 90m²)',
      },
      {
        ref: 'BZR-TEST-013',
        first: 'وليد',
        last: 'صايغ',
        mother: 'جميلة فؤاد',
        phone: '+96177100013',
        residence: 'RESIDENT',
        title: 'شقة متضررة غير صالحة للسكن (War-damaged Uninhabitable Flat 130m² - EXEMPT)',
      },
      {
        ref: 'BZR-TEST-014',
        first: 'الشيخ حسن',
        last: 'عواد',
        mother: 'فاطمة رضا',
        phone: '+96177100014',
        residence: 'RESIDENT',
        title: 'دار عبادة معفاة من الرسوم (Place of Worship 160m² - EXEMPT)',
      },
      {
        ref: 'BZR-TEST-015',
        first: 'جوزيف',
        last: 'مطر',
        mother: 'تريز ميشال',
        phone: '+96177100015',
        residence: 'NON_RESIDENT_OWNER',
        residencePlace: 'باريس، فرنسا',
        title: 'مالك غير مقيم / مغترب (Non-Resident Owner 175m² - France - Landlord to Citizen 4)',
      },
      {
        ref: 'BZR-TEST-016',
        first: 'طارق',
        last: 'العبد الله',
        mother: 'ندى يوسف',
        phone: '+96177100016',
        residence: 'RESIDENT',
        title: 'مستأجر شقة سكنية من حسين سرور (Tenant: APARTMENT 110m² in BLD-102)',
      },
      {
        ref: 'BZR-TEST-017',
        first: 'نادين',
        last: 'حيدر',
        mother: 'إلهام قاسم',
        phone: '+96177100017',
        residence: 'RESIDENT',
        title: 'مستأجرة محل تجاري من حسين سرور (Tenant: SHOP 50m² in BLD-102)',
      },
      {
        ref: 'BZR-TEST-018',
        first: 'كمال',
        last: 'حمود',
        mother: 'سمر برجاوي',
        phone: '+96177100018',
        residence: 'RESIDENT',
        title: 'مستأجر مكتب إداري من حسين سرور (Tenant: OFFICE 75m² in BLD-102)',
      },
      {
        ref: 'BZR-TEST-019',
        first: 'رنا',
        last: 'شرف الدين',
        mother: 'ليلى محفوظ',
        phone: '+96177100019',
        residence: 'RESIDENT',
        title: 'مستأجرة عيادة طبية من حسين سرور (Tenant: CLINIC 85m² in BLD-102)',
      },
      {
        ref: 'BZR-TEST-020',
        first: 'جهاد',
        last: 'عطوي',
        mother: 'منى دياب',
        phone: '+96177100020',
        residence: 'RESIDENT',
        title: 'مستأجر مستودع بضائع من حسين سرور (Tenant: WAREHOUSE 150m² in BLD-102)',
      },
    ];

    // Insert Citizen Users & Registrations
    const citizenRows = [];
    for (const c of citizens) {
      const uId = randomUUID();
      const rId = randomUUID();

      await client.query(`
        INSERT INTO "${s}".users (
          id, kind, "tenantSlug", residence, "residencePlace", phone,
          "firstName", "lastName", "motherName", "isLebanese",
          "residentStatus", "referenceNumber", "isActive", "createdAt", "updatedAt"
        ) VALUES (
          $1, 'CITIZEN', $2, $3, $4, $5,
          $6, $7, $8, true,
          'VILLAGE_RESIDENT', $9, true, NOW(), NOW()
        )
      `, [
        uId, tenantSlug, c.residence, c.residencePlace ?? null, c.phone,
        c.first, c.last, c.mother, c.ref,
      ]);

      await client.query(`
        INSERT INTO "${s}".registrations (
          id, "citizenId", "referenceNumber", status, "submittedAt", "createdById",
          "reviewedById", "reviewedAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, 'APPROVED', NOW(), $4,
          $4, NOW(), NOW()
        )
      `, [rId, uId, `REG-${c.ref}`, officerId]);

      citizenRows.push({ ...c, userId: uId, regId: rId });
    }

    console.log(C.green(`  ✓ Created 20 citizen files with approved registrations.`));

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Helper to Create Buildings & Units
    // ──────────────────────────────────────────────────────────────────────────
    async function createBuilding({ parcel, code, name, structureType = 'RESIDENTIAL_BUILDING', floors = 3 }) {
      const bId = randomUUID();
      await client.query(`
        INSERT INTO "${s}".buildings (
          id, "parcelNumber", "codeSuffix", code, name,
          "structureType", latitude, longitude, "floorsCount",
          "unitsTotal", "unitsSurveyed", "createdById", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          0, 0, $10, NOW(), NOW()
        )
      `, [
        bId, parcel.parcelNumber, code.replace('BLD-', ''), code, name,
        structureType, parcel.latitude, parcel.longitude, floors, officerId,
      ]);
      return bId;
    }

    async function createUnit({
      buildingId, floor, sequence, unitCode, unitType = 'APARTMENT',
      unitArea, unitStatus = 'OWNER_OCCUPIED', levels = 1,
      ownerBillingMode = null, responsibleOwnerId = null,
      feeExemption = null, feeExemptionNote = null,
    }) {
      const uId = randomUUID();
      const exemptedAt = feeExemption ? new Date() : null;
      const exemptedById = feeExemption ? officerId : null;
      await client.query(`
        INSERT INTO "${s}".units (
          id, "buildingId", floor, sequence, "unitCode",
          "unitType", "unitArea", "unitStatus", "surveyStatus",
          levels, "ownerBillingMode", "responsibleOwnerId",
          "feeExemption", "feeExemptionNote", "feeExemptedAt", "feeExemptedById",
          "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, 'COMPLETE',
          $9, $10, $11,
          $12, $13, $14, $15,
          NOW(), NOW()
        )
      `, [
        uId, buildingId, floor, sequence, unitCode,
        unitType, unitArea, unitStatus,
        levels, ownerBillingMode, responsibleOwnerId,
        feeExemption, feeExemptionNote, exemptedAt, exemptedById,
      ]);
      return uId;
    }

    async function linkPropertyCard({
      citizen, buildingId, unitId, propertyType = 'BUILDING', occupancyType = 'OWNER',
      unitType = 'APARTMENT', unitArea, unitStatus = 'OWNER_OCCUPIED',
      floor = '1', buildingName, parcelNumber, landlordCitizenId = null,
      landlordName = null, landlordPhone = null, shares = null,
    }) {
      const peId = randomUUID();
      const buId = randomUUID();

      await client.query(`
        INSERT INTO "${s}".property_entries (
          id, "registrationId", "occupancyType", "propertyType", "propertyNumber",
          "unitType", "unitArea", "unitStatus", "buildingName", floor,
          "buildingId", "landlordCitizenId", "landlordName", "landlordPhone", shares, "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, NOW(), NOW()
        )
      `, [
        peId, citizen.regId, occupancyType, propertyType, parcelNumber,
        unitType, unitArea, unitStatus, buildingName, floor,
        buildingId, landlordCitizenId, landlordName, landlordPhone, shares,
      ]);

      await client.query(`
        INSERT INTO "${s}".building_units (
          id, "propertyEntryId", "unitId", "unitType",
          floor, "unitArea", "unitStatus", "filedById", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, NOW(), NOW()
        )
      `, [
        buId, peId, unitId, unitType,
        floor, unitArea, unitStatus, officerId,
      ]);

      await client.query(`
        INSERT INTO "${s}".unit_occupancies (
          id, "unitId", "citizenId", "registrationId",
          role, shares, "fromDate", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, NOW(), NOW(), NOW()
        )
      `, [
        randomUUID(), unitId, citizen.userId, citizen.regId,
        occupancyType, shares,
      ]);

      return { peId, buId };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Populate Properties
    // ──────────────────────────────────────────────────────────────────────────

    // Case 1: أحمد حسن - شقة عادية 120م²
    const bld1 = await createBuilding({ parcel: p(0), code: 'BLD-101', name: 'بناية النور السكنية' });
    const u1 = await createUnit({ buildingId: bld1, floor: 1, sequence: 1, unitCode: 'BLD-101-U01', unitArea: 120 });
    await linkPropertyCard({
      citizen: citizenRows[0], buildingId: bld1, unitId: u1, unitArea: 120,
      buildingName: 'بناية النور السكنية', parcelNumber: p(0).parcelNumber,
    });

    // Case 2: فاطمة قاسم - دوبلكس 220م² طابقين
    const u2 = await createUnit({ buildingId: bld1, floor: 3, sequence: 2, unitCode: 'BLD-101-U02', unitArea: 220, levels: 2 });
    await linkPropertyCard({
      citizen: citizenRows[1], buildingId: bld1, unitId: u2, unitArea: 220, floor: '3-4',
      buildingName: 'بناية النور السكنية', parcelNumber: p(0).parcelNumber,
    });

    // Case 3 & 16-20: حسين سرور (المالك) يملك 5 عقارات متنوعة ومؤجرة لـ 5 مواطنين
    const bld2 = await createBuilding({
      parcel: p(1), code: 'BLD-102', name: 'مجمع سرور التجاري والسكني',
      structureType: 'MIXED_USE', floors: 4,
    });

    // 5 Distinct Property Types owned by Citizen 3 (حسين سرور):
    // 1. APARTMENT (110m², Floor 2)
    const u3_apt = await createUnit({
      buildingId: bld2, floor: 2, sequence: 1, unitCode: 'BLD-102-U01',
      unitType: 'APARTMENT', unitArea: 110, unitStatus: 'RENTED',
    });
    // 2. SHOP (50m², Floor 0)
    const u3_shop = await createUnit({
      buildingId: bld2, floor: 0, sequence: 2, unitCode: 'BLD-102-U02',
      unitType: 'SHOP', unitArea: 50, unitStatus: 'RENTED',
    });
    // 3. OFFICE (75m², Floor 1)
    const u3_off = await createUnit({
      buildingId: bld2, floor: 1, sequence: 3, unitCode: 'BLD-102-U03',
      unitType: 'OFFICE', unitArea: 75, unitStatus: 'RENTED',
    });
    // 4. CLINIC (85m², Floor 1)
    const u3_cln = await createUnit({
      buildingId: bld2, floor: 1, sequence: 4, unitCode: 'BLD-102-U04',
      unitType: 'CLINIC', unitArea: 85, unitStatus: 'RENTED',
    });
    // 5. WAREHOUSE (150m², Floor -1)
    const u3_wh = await createUnit({
      buildingId: bld2, floor: -1, sequence: 5, unitCode: 'BLD-102-U05',
      unitType: 'WAREHOUSE', unitArea: 150, unitStatus: 'RENTED',
    });

    // Link Landlord (حسين سرور) as OWNER of all 5 units
    await linkPropertyCard({
      citizen: citizenRows[2], buildingId: bld2, unitId: u3_apt, unitType: 'APARTMENT',
      unitArea: 110, unitStatus: 'RENTED', buildingName: 'مجمع سرور التجاري والسكني',
      parcelNumber: p(1).parcelNumber, floor: '2',
    });
    await linkPropertyCard({
      citizen: citizenRows[2], buildingId: bld2, unitId: u3_shop, unitType: 'SHOP',
      unitArea: 50, unitStatus: 'RENTED', buildingName: 'مجمع سرور التجاري والسكني',
      parcelNumber: p(1).parcelNumber, floor: '0',
    });
    await linkPropertyCard({
      citizen: citizenRows[2], buildingId: bld2, unitId: u3_off, unitType: 'OFFICE',
      unitArea: 75, unitStatus: 'RENTED', buildingName: 'مجمع سرور التجاري والسكني',
      parcelNumber: p(1).parcelNumber, floor: '1',
    });
    await linkPropertyCard({
      citizen: citizenRows[2], buildingId: bld2, unitId: u3_cln, unitType: 'CLINIC',
      unitArea: 85, unitStatus: 'RENTED', buildingName: 'مجمع سرور التجاري والسكني',
      parcelNumber: p(1).parcelNumber, floor: '1',
    });
    await linkPropertyCard({
      citizen: citizenRows[2], buildingId: bld2, unitId: u3_wh, unitType: 'WAREHOUSE',
      unitArea: 150, unitStatus: 'RENTED', buildingName: 'مجمع سرور التجاري والسكني',
      parcelNumber: p(1).parcelNumber, floor: '-1',
    });

    // Link the 5 new citizens (Citizens 16–20) renting the 5 units from Hussein Sourour:
    const landlord3 = citizenRows[2];
    const llName3 = `${landlord3.first} ${landlord3.last}`;

    // Citizen 16: طارق العبد الله -> rents APARTMENT (110m²)
    await linkPropertyCard({
      citizen: citizenRows[15], buildingId: bld2, unitId: u3_apt, occupancyType: 'TENANT',
      unitType: 'APARTMENT', unitArea: 110, unitStatus: 'RENTED',
      buildingName: 'مجمع سرور التجاري والسكني', parcelNumber: p(1).parcelNumber, floor: '2',
      landlordCitizenId: landlord3.userId, landlordName: llName3, landlordPhone: landlord3.phone,
    });

    // Citizen 17: نادين حيدر -> rents SHOP (50m²)
    await linkPropertyCard({
      citizen: citizenRows[16], buildingId: bld2, unitId: u3_shop, occupancyType: 'TENANT',
      unitType: 'SHOP', unitArea: 50, unitStatus: 'RENTED',
      buildingName: 'مجمع سرور التجاري والسكني', parcelNumber: p(1).parcelNumber, floor: '0',
      landlordCitizenId: landlord3.userId, landlordName: llName3, landlordPhone: landlord3.phone,
    });

    // Citizen 18: كمال حمود -> rents OFFICE (75m²)
    await linkPropertyCard({
      citizen: citizenRows[17], buildingId: bld2, unitId: u3_off, occupancyType: 'TENANT',
      unitType: 'OFFICE', unitArea: 75, unitStatus: 'RENTED',
      buildingName: 'مجمع سرور التجاري والسكني', parcelNumber: p(1).parcelNumber, floor: '1',
      landlordCitizenId: landlord3.userId, landlordName: llName3, landlordPhone: landlord3.phone,
    });

    // Citizen 19: د. رنا شرف الدين -> rents CLINIC (85m²)
    await linkPropertyCard({
      citizen: citizenRows[18], buildingId: bld2, unitId: u3_cln, occupancyType: 'TENANT',
      unitType: 'CLINIC', unitArea: 85, unitStatus: 'RENTED',
      buildingName: 'مجمع سرور التجاري والسكني', parcelNumber: p(1).parcelNumber, floor: '1',
      landlordCitizenId: landlord3.userId, landlordName: llName3, landlordPhone: landlord3.phone,
    });

    // Citizen 20: جهاد عطوي -> rents WAREHOUSE (150m²)
    await linkPropertyCard({
      citizen: citizenRows[19], buildingId: bld2, unitId: u3_wh, occupancyType: 'TENANT',
      unitType: 'WAREHOUSE', unitArea: 150, unitStatus: 'RENTED',
      buildingName: 'مجمع سرور التجاري والسكني', parcelNumber: p(1).parcelNumber, floor: '-1',
      landlordCitizenId: landlord3.userId, landlordName: llName3, landlordPhone: landlord3.phone,
    });

    // Case 5 & 6: محمد وخليل بيضون - ملكية مشتركة مناصفة EQUAL (140م²)
    const bld3 = await createBuilding({ parcel: p(2), code: 'BLD-103', name: 'بناية بيضون' });
    const u5 = await createUnit({
      buildingId: bld3, floor: 2, sequence: 1, unitCode: 'BLD-103-U01', unitArea: 140,
      ownerBillingMode: 'EQUAL',
    });
    await linkPropertyCard({
      citizen: citizenRows[4], buildingId: bld3, unitId: u5, unitArea: 140,
      buildingName: 'بناية بيضون', parcelNumber: p(2).parcelNumber, floor: '2', shares: 1200,
    });
    await linkPropertyCard({
      citizen: citizenRows[5], buildingId: bld3, unitId: u5, unitArea: 140,
      buildingName: 'بناية بيضون', parcelNumber: p(2).parcelNumber, floor: '2', shares: 1200,
    });

    // Case 7 & 8: عباس ومهدي مغنية - ملكية مشتركة بالأسهم BY_SHARES (180م²: 1600 سهم مقابل 800 سهم)
    const bld4 = await createBuilding({ parcel: p(3), code: 'BLD-104', name: 'مجمع الوفاء السكني' });
    const u7 = await createUnit({
      buildingId: bld4, floor: 1, sequence: 1, unitCode: 'BLD-104-U01', unitArea: 180,
      ownerBillingMode: 'BY_SHARES',
    });
    await linkPropertyCard({
      citizen: citizenRows[6], buildingId: bld4, unitId: u7, unitArea: 180,
      buildingName: 'مجمع الوفاء السكني', parcelNumber: p(3).parcelNumber, floor: '1', shares: 1600,
    });
    await linkPropertyCard({
      citizen: citizenRows[7], buildingId: bld4, unitId: u7, unitArea: 180,
      buildingName: 'مجمع الوفاء السكني', parcelNumber: p(3).parcelNumber, floor: '1', shares: 800,
    });

    // Case 9 & 10: سامي ورمزي فقيه - مالك مسؤول RESPONSIBLE_OWNER (150م²)
    const bld5 = await createBuilding({ parcel: p(4), code: 'BLD-105', name: 'بناية الأمانة' });
    const u9 = await createUnit({
      buildingId: bld5, floor: 1, sequence: 1, unitCode: 'BLD-105-U01', unitArea: 150,
      ownerBillingMode: 'RESPONSIBLE_OWNER', responsibleOwnerId: citizenRows[8].userId,
    });
    await linkPropertyCard({
      citizen: citizenRows[8], buildingId: bld5, unitId: u9, unitArea: 150,
      buildingName: 'بناية الأمانة', parcelNumber: p(4).parcelNumber, floor: '1',
    });
    await linkPropertyCard({
      citizen: citizenRows[9], buildingId: bld5, unitId: u9, unitArea: 150,
      buildingName: 'بناية الأمانة', parcelNumber: p(4).parcelNumber, floor: '1',
    });

    // Case 11: جورج حداد - منزل مستقل (HOUSE / INDEPENDENT_HOUSE 200م²)
    const bld6 = await createBuilding({
      parcel: p(5), code: 'BLD-106', name: 'فيلا حداد المستقلة',
      structureType: 'INDEPENDENT_HOUSE', floors: 1,
    });
    const u11 = await createUnit({
      buildingId: bld6, floor: 0, sequence: 1, unitCode: 'BLD-106-U01',
      unitType: 'INDEPENDENT_HOUSE', unitArea: 200,
    });
    await linkPropertyCard({
      citizen: citizenRows[10], buildingId: bld6, unitId: u11, propertyType: 'HOUSE',
      unitType: 'INDEPENDENT_HOUSE', unitArea: 200,
      buildingName: 'فيلا حداد المستقلة', parcelNumber: p(5).parcelNumber, floor: '0',
    });

    // Case 12: ريم قصير - عقارات تجارية (محل 45م² + مستودع 90م²)
    const bld7 = await createBuilding({
      parcel: p(6), code: 'BLD-107', name: 'سنتر قصير التجاري',
      structureType: 'COMMERCIAL_CENTER', floors: 2,
    });
    const u12A = await createUnit({
      buildingId: bld7, floor: 0, sequence: 1, unitCode: 'BLD-107-U01',
      unitType: 'SHOP', unitArea: 45,
    });
    const u12B = await createUnit({
      buildingId: bld7, floor: -1, sequence: 2, unitCode: 'BLD-107-U02',
      unitType: 'WAREHOUSE', unitArea: 90,
    });
    await linkPropertyCard({
      citizen: citizenRows[11], buildingId: bld7, unitId: u12A, unitType: 'SHOP', unitArea: 45,
      buildingName: 'سنتر قصير التجاري', parcelNumber: p(6).parcelNumber, floor: '0',
    });
    await linkPropertyCard({
      citizen: citizenRows[11], buildingId: bld7, unitId: u12B, unitType: 'WAREHOUSE', unitArea: 90,
      buildingName: 'سنتر قصير التجاري', parcelNumber: p(6).parcelNumber, floor: '-1',
    });

    // Case 13: وليد صايغ - شقة متضررة غير صالحة للسكن (130م²)
    const bld8 = await createBuilding({ parcel: p(7), code: 'BLD-108', name: 'بناية الصفا' });
    const u13 = await createUnit({ buildingId: bld8, floor: 2, sequence: 1, unitCode: 'BLD-108-U01', unitArea: 130 });
    await linkPropertyCard({
      citizen: citizenRows[12], buildingId: bld8, unitId: u13, unitArea: 130,
      buildingName: 'بناية الصفا', parcelNumber: p(7).parcelNumber, floor: '2',
    });
    // Record war damage assessment with habitable = false (unit-level: buildingId is null)
    await client.query(`
      INSERT INTO "${s}".damage_assessments (
        id, "buildingId", "unitId", level, source, observations,
        habitable, "assessedById", "assessedAt", "createdAt"
      ) VALUES (
        $1, $2, $3, 'RESTRICTED_USE', 'FIELD_VISIT',
        'أضرار جسيمة في الهيكل والواجهة — غير صالحة للسكن جراء القصف',
        false, $4, NOW(), NOW()
      )
    `, [randomUUID(), null, u13, inspectorId]);

    // Case 14: الشيخ حسن عواد - دار عبادة معفاة من الرسوم (160م²)
    const bld9 = await createBuilding({ parcel: p(8), code: 'BLD-109', name: 'مجمع الإمام الرضا الوقفي' });
    const u14 = await createUnit({
      buildingId: bld9, floor: 0, sequence: 1, unitCode: 'BLD-109-U01',
      unitArea: 160, feeExemption: 'PLACE_OF_WORSHIP',
      feeExemptionNote: 'مصلّى وقفي ودار عبادة معفاة رسمياً بقرار المجلس البلدي',
    });
    await linkPropertyCard({
      citizen: citizenRows[13], buildingId: bld9, unitId: u14, unitArea: 160,
      buildingName: 'مجمع الإمام الرضا الوقفي', parcelNumber: p(8).parcelNumber, floor: '0',
    });

    // Case 15 & 4: جوزيف مطر (مالك غير مقيم) يؤجر شقته لعلي زين (مستأجر)
    const bld10 = await createBuilding({ parcel: p(9), code: 'BLD-110', name: 'عمارة الصنوبر' });
    const u15 = await createUnit({
      buildingId: bld10, floor: 2, sequence: 1, unitCode: 'BLD-110-U01',
      unitArea: 175, unitStatus: 'RENTED',
    });
    // Landlord card (جوزيف مطر - مقيم في فرنسا)
    await linkPropertyCard({
      citizen: citizenRows[14], buildingId: bld10, unitId: u15, unitArea: 175, unitStatus: 'RENTED',
      buildingName: 'عمارة الصنوبر', parcelNumber: p(9).parcelNumber, floor: '2',
    });
    // Tenant card (علي زين - مستأجر مقيم)
    await linkPropertyCard({
      citizen: citizenRows[3], buildingId: bld10, unitId: u15, occupancyType: 'TENANT',
      unitArea: 175, unitStatus: 'RENTED', buildingName: 'عمارة الصنوبر',
      parcelNumber: p(9).parcelNumber, floor: '2',
      landlordCitizenId: citizenRows[14].userId,
      landlordName: `${citizenRows[14].first} ${citizenRows[14].last}`,
      landlordPhone: citizenRows[14].phone,
    });

    // Update building counts
    await client.query(`
      UPDATE "${s}".buildings b
      SET "unitsTotal" = (SELECT count(*) FROM "${s}".units u WHERE u."buildingId" = b.id),
          "unitsSurveyed" = (SELECT count(*) FROM "${s}".units u WHERE u."buildingId" = b.id)
    `);

    await client.query('COMMIT');
    console.log(C.green(`  ✓ Seed transaction committed successfully in ${s}.`));

    // ──────────────────────────────────────────────────────────────────────────
    // 5. Verification & Report
    // ──────────────────────────────────────────────────────────────────────────
    console.log(C.bold('\n--- Verification & Test Matrix Roster ---'));
    const verify = await client.query(`
      SELECT
        (SELECT count(*) FROM "${s}".users WHERE kind = 'CITIZEN') as citizens,
        (SELECT count(*) FROM "${s}".buildings) as buildings,
        (SELECT count(*) FROM "${s}".units) as units,
        (SELECT count(*) FROM "${s}".property_entries) as cards,
        (SELECT count(*) FROM "${s}".building_units) as card_units,
        (SELECT count(*) FROM "${s}".damage_assessments WHERE habitable = false) as uninhabitable,
        (SELECT count(*) FROM "${s}".units WHERE "feeExemption" IS NOT NULL) as exempt,
        (SELECT count(*) FROM "${s}".units WHERE levels > 1) as duplexes,
        (SELECT count(*) FROM "${s}".property_entries WHERE "occupancyType" = 'TENANT') as tenants
    `);
    const stats = verify.rows[0];

    console.log(`Summary Counts in ${C.cyan(tenantSlug)}:`);
    console.log(`  - Citizens:                 ${C.bold(stats.citizens)} (Target: 20)`);
    console.log(`  - Buildings:                ${C.bold(stats.buildings)} (Distinct surveyed structures)`);
    console.log(`  - Units:                    ${C.bold(stats.units)}`);
    console.log(`  - Property Cards:           ${C.bold(stats.cards)}`);
    console.log(`  - Card Unit Lines:          ${C.bold(stats.card_units)}`);
    console.log(`  - Tenants:                  ${C.bold(stats.tenants)} (6 Tenants total: 5 from Hussein, 1 from Joseph)`);
    console.log(`  - Duplex Multi-Level Units: ${C.bold(stats.duplexes)}`);
    console.log(`  - War-damaged Uninhabitable:${C.bold(stats.uninhabitable)}`);
    console.log(`  - Fee Exempt Units:         ${C.bold(stats.exempt)}`);

    console.log(C.bold('\nCitizen Cases Ready for Testing:'));
    for (let i = 0; i < citizenRows.length; i++) {
      const cr = citizenRows[i];
      console.log(`  ${(i + 1).toString().padStart(2, ' ')}. [${cr.ref}] ${cr.first} ${cr.last.padEnd(10, ' ')} : ${cr.title}`);
    }

    console.log(C.green('\n✓ Seeding complete! All 20 cases ready for testing fee calculation & issuance.\n'));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(`Seeding failed: ${err.message}\n${err.stack}`);
  } finally {
    await client.end();
  }
}

// Direct CLI entrypoint
const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  const args = process.argv.slice(2);
  const tenantArg = args.find((a) => a.startsWith('--tenant='));
  const tenantSlug = tenantArg ? tenantArg.split('=')[1].trim() : 'albazourieh';
  const cleanFirst = !args.includes('--no-clean');

  seedFeeTestingCitizens({ tenantSlug, cleanFirst }).catch((err) => fail(err.message));
}
