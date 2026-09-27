/**
 * The census seed: the development register from seed.ts, plus سجل المباني on
 * top of it — zones, buildings pinned inside their real parcels, floor-by-floor
 * units, the seeded households linked into them, survey progress, visits,
 * vacancies, war damage and follow-up cases. Use it when the map should look
 * like the field; `pnpm db:seed` stays free of map points.
 *
 *   pnpm db:seed:census                   base register + census
 *   pnpm db:seed:census --citizens=3000
 *
 * Everything census-shaped goes through the app's own services, built over the
 * tenant client exactly as census-sync.integration.spec.ts builds them:
 * `ZonesService.create`, `BuildingsService.create` (suffix under the parcel lock,
 * units inline), `CensusSyncService.syncRegistration` (occupancy, unit status,
 * survey status and the visit, together), `logVisit`, `confirmVacancy`,
 * `DamageService.record`. The census keeps invariants a raw insert would break
 * — the dual occupancy record, unit status written with occupancy, the
 * unit-count trigger, the claim rule — and those services are where they live.
 * Every input is parsed by the same schema the controller applies.
 *
 * Written directly, and why:
 * - the card → building / unit links, which are the columns
 *   RegistrationRepository.submit writes when an officer picks a building
 *   while filing — the sync then does the rest, as it does after a filing;
 * - the cards' coordinates, copied from the parcel as RegistrationService.submit
 *   copies them from the cadastre;
 * - timestamps, moved back into the September census window afterwards,
 *   because the services stamp "now". The registration's own `updatedAt` is put
 *   back after the sync, or every approved record would read as changed since
 *   its review.
 *
 * Pins stand inside the parcel's surveyed outline, at least 2 m in from its
 * edge and 12 m from any other building on the same parcel (the quality scan
 * flags anything under 10 m as a likely duplicate). Only municipalities with a
 * cadastre get a census: a pin with no parcel to stand in would be an invented
 * coordinate. Zahle has none.
 *
 * Re-running is safe. Buildings are created with derived ids, so an existing one
 * is recognised and left alone, and a card already linked is not linked again.
 */
import 'reflect-metadata';
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  confirmVacancySchema,
  createBuildingSchema,
  createCaseSchema,
  createDamageAssessmentSchema,
  createZoneSchema,
  logVisitSchema,
} from '@mechanization/shared-schemas';
import type { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { BuildingsService } from '../application/features/buildings/buildings.service';
import { CensusSyncService } from '../application/features/buildings/census-sync.service';
import { DamageService } from '../application/features/buildings/damage.service';
import { CasesService } from '../application/features/cases/cases.service';
import { ZonesService } from '../application/features/zones/zones.service';
import type { TenantContextService } from '../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../infrastructure/repositories/case.repository';
import { PrismaParcelRepository } from '../infrastructure/repositories/parcel.repository';
import { PrismaUserRepository } from '../infrastructure/repositories/user.repository';
import { PrismaZoneRepository } from '../infrastructure/repositories/zone.repository';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';
import { TENANTS, localDatabaseUrl, requestedCitizens, runSeed, tenantClient } from './seed';
import { Dice, randomSource, seedId, SEED_NOW } from './seed-register';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The quality scan calls two pins on one parcel under 10 m apart a likely duplicate. */
const MIN_SPACING_M = 12;
/** A pin on the parcel's edge reads as standing on the neighbour's land. */
const EDGE_MARGIN_M = 2;

type Actor = { id: string; role: string };
type Outline = Feature<Polygon | MultiPolygon>;
type LngLat = [number, number];

interface ParcelGeo {
  number: string;
  lat: number;
  lng: number;
  outline: Outline | null;
}

interface CardRow {
  id: string;
  registrationId: string;
  citizenId: string;
  createdById: string | null;
  submittedAt: Date;
  propertyType: string;
  occupancyType: string;
  propertyNumber: string | null;
  buildingName: string | null;
  unitArea: number | null;
  units: Array<{ id: string; unitType: string | null; floor: string | null; unitArea: number | null; unitStatus: string | null }>;
}

interface PlannedUnit {
  id: string;
  floor: number;
  sequence: number;
  startCol: number;
  endCol: number;
  unitType: string;
  unitArea?: number;
  unitStatus?: string;
  /** The card row that will name this unit. Unclaimed units are the households not filed yet. */
  claim?: { cardId: string; rowId: string };
}

interface PlannedBuilding {
  id: string;
  parcel: string;
  structureType: string;
  lifecycleStatus: string;
  floorsCount: number;
  basementsCount: number;
  postedNumber?: string;
  units: PlannedUnit[];
  /** HOUSE cards link through the building alone (a one-unit building infers the unit). */
  houseCardId?: string;
  createdAt: Date;
  occupied: boolean;
}

const DWELLING = new Set(['APARTMENT', 'INDEPENDENT_HOUSE']);
const STRUCTURAL = new Set(['PILOTIS', 'EMPTY_FLOOR']);
const TYPICAL_AREA: Record<string, [number, number]> = {
  APARTMENT: [85, 200],
  INDEPENDENT_HOUSE: [100, 260],
  SHOP: [20, 80],
  OFFICE: [35, 120],
  CLINIC: [40, 90],
  WAREHOUSE: [60, 300],
  GARAGE: [18, 40],
};

// ─────────────────────────────  Services  ─────────────────────────────

/** The census services over one tenant client — census-sync.integration.spec.ts's setup. */
function censusServices(db: TenantPrismaClient, tenantSlug: string, schemaName: string) {
  const context = {
    get prisma() {
      return db;
    },
    tenantSlug,
    schemaName,
  } as unknown as TenantContextService;
  const events = new EventEmitter2();
  const cases = new CasesService(new PrismaCaseRepository(context), new PrismaUserRepository(context), events);
  const buildings = new BuildingsService(context, cases, events);
  return {
    buildings,
    cases,
    census: new CensusSyncService(context, cases, events),
    damage: new DamageService(context, events),
    // The city-boundary check reads a file from the cadastre bucket, which a
    // development machine does not have; every parcel zoned here comes from
    // the cadastre itself, which is the check that matters.
    zones: new ZonesService(
      new PrismaZoneRepository(context),
      new PrismaParcelRepository(context),
      { getCityBoundary: async () => null } as never,
      buildings,
      events,
    ),
  };
}

// ─────────────────────────────  Geometry  ─────────────────────────────

function outlineOf(boundary: unknown): Outline | null {
  const geometry = boundary as { type?: string; coordinates?: unknown } | null;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
  return turf.feature(geometry as Polygon | MultiPolygon);
}

function outerRing(outline: Outline): LngLat[] {
  const g = outline.geometry;
  return (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]) as LngLat[];
}

function metres(a: LngLat, b: LngLat): number {
  return turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
}

/**
 * A building entrance inside the parcel: in the outline, clear of its edge,
 * and clear of every other building on the parcel. Null when the parcel is too
 * small to hold another one that far apart — the caller then leaves that
 * household unlinked, which is what an officer who could not find the
 * structure would do.
 */
function placePin(d: Dice, parcel: ParcelGeo, taken: readonly LngLat[]): LngLat | null {
  const clear = (pt: LngLat) => taken.every((other) => metres(pt, other) >= MIN_SPACING_M);

  if (parcel.outline) {
    const [minX, minY, maxX, maxY] = turf.bbox(parcel.outline);
    const edge = turf.lineString(outerRing(parcel.outline));
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const pt: LngLat = [minX + d.float() * (maxX - minX), minY + d.float() * (maxY - minY)];
      if (!turf.booleanPointInPolygon(turf.point(pt), parcel.outline)) continue;
      if (turf.pointToLineDistance(turf.point(pt), edge, { units: 'meters' }) < EDGE_MARGIN_M) continue;
      if (clear(pt)) return round(pt);
    }
    return null;
  }

  // The 26 parcels the survey gives as a point only: within a few metres of it.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const moved = turf.destination(turf.point([parcel.lng, parcel.lat]), (d.float() * 6) / 1000, d.float() * 360);
    const pt = moved.geometry.coordinates as LngLat;
    if (clear(pt)) return round(pt);
  }
  return null;
}

/** Six decimals, the survey's own precision (~0.1 m). */
function round([lng, lat]: LngLat): LngLat {
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

// ─────────────────────────────  Zones  ─────────────────────────────

const ZONE_COLOURS = ['#2563EB', '#16A34A', '#D97706', '#9333EA', '#DC2626', '#0891B2'];
const DIRECTIONS = ['الشمالي', 'الشمالي الشرقي', 'الشرقي', 'الجنوبي الشرقي', 'الجنوبي', 'الجنوبي الغربي', 'الغربي', 'الشمالي الغربي'];

/**
 * Six zones the way a municipality draws them: the old centre, and five
 * sectors around it. Created before any building, so every code is born with
 * its zone (`Z-3-991-A`, not `X-991-A`). Skipped if the municipality has zones.
 */
async function seedZones(
  db: TenantPrismaClient,
  zones: ReturnType<typeof censusServices>['zones'],
  tenantSlug: string,
  parcels: readonly ParcelGeo[],
  actor: Actor,
): Promise<number> {
  if ((await db.zone.count()) > 0) return 0;

  const centre: LngLat = [
    parcels.reduce((s, p) => s + p.lng, 0) / parcels.length,
    parcels.reduce((s, p) => s + p.lat, 0) / parcels.length,
  ];
  const placed = parcels.map((p) => ({
    number: p.number,
    distance: metres(centre, [p.lng, p.lat]),
    bearing: (turf.bearing(turf.point(centre), turf.point([p.lng, p.lat])) + 360) % 360,
  }));
  const coreRadius = [...placed].map((p) => p.distance).sort((a, b) => a - b)[Math.floor(placed.length * 0.25)];
  const core = placed.filter((p) => p.distance <= coreRadius);
  const ring = placed.filter((p) => p.distance > coreRadius).sort((a, b) => a.bearing - b.bearing);

  const groups: Array<{ name: string; members: typeof placed }> = [{ name: 'وسط البلدة', members: core }];
  const size = Math.ceil(ring.length / 5);
  const usedNames = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const members = ring.slice(i * size, (i + 1) * size);
    if (members.length === 0) continue;
    const mid = members[Math.floor(members.length / 2)].bearing;
    let name = `الحي ${DIRECTIONS[Math.round(mid / 45) % 8]}`;
    if (usedNames.has(name)) name = `${name} ${i + 1}`;
    usedNames.add(name);
    groups.push({ name, members });
  }

  for (const [i, group] of groups.entries()) {
    await zones.create(
      tenantSlug,
      createZoneSchema.parse({
        name: group.name,
        code: `Z-${i + 1}`,
        color: ZONE_COLOURS[i % ZONE_COLOURS.length],
        parcelNumbers: group.members.map((m) => m.number),
      }),
      actor,
    );
  }
  return groups.length;
}

// ──────────────────────────────  Plans  ──────────────────────────────

function floorNumber(raw: string | null): number {
  if (!raw) return 0;
  const t = raw.trim().replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/أول/.test(t)) return 1;
  if (/ثان/.test(t)) return 2;
  return 0; // أرضي, and anything unreadable
}

function area(d: Dice, unitType: string): number | undefined {
  const range = TYPICAL_AREA[unitType];
  return range ? d.step(range[0], range[1], 5) : undefined;
}

/**
 * A floor-by-floor matrix. `claims` are the seeded card rows that name a unit
 * here; each gets its own unit on its own floor. Every other unit is a
 * household nobody has filed yet, which is most of a census a few weeks in.
 */
function planMatrix(
  d: Dice,
  buildingId: string,
  input: {
    claims: Array<{ floor: number; unitType: string; unitArea: number | null; unitStatus: string | null; cardId: string; rowId: string }>;
    floorsAbove: number;
    basement: boolean;
    perFloor: number;
    ground: 'claims' | 'shops' | 'pilotis' | 'flats' | 'empty';
    underConstruction?: boolean;
  },
): PlannedUnit[] {
  const byFloor = new Map<number, typeof input.claims>();
  for (const claim of input.claims) byFloor.set(claim.floor, [...(byFloor.get(claim.floor) ?? []), claim]);

  type Spec = { unitType: string; unitArea?: number; unitStatus?: string; claim?: { cardId: string; rowId: string } };
  const floors: Array<{ floor: number; specs: Spec[] }> = [];
  const fromClaim = (c: (typeof input.claims)[number]): Spec => ({
    unitType: c.unitType,
    unitArea: c.unitArea ?? area(d, c.unitType),
    ...(c.unitStatus ? { unitStatus: c.unitStatus } : {}),
    claim: { cardId: c.cardId, rowId: c.rowId },
  });
  const blank = (unitType: string): Spec => ({
    unitType,
    ...(STRUCTURAL.has(unitType) ? {} : { unitArea: area(d, unitType) }),
    ...(input.underConstruction && !STRUCTURAL.has(unitType) ? { unitStatus: 'UNDER_CONSTRUCTION' } : {}),
  });

  if (input.basement) floors.push({ floor: -1, specs: [blank(d.chance(0.5) ? 'GARAGE' : 'WAREHOUSE')] });

  const topFloor = Math.max(input.floorsAbove - 1, ...input.claims.map((c) => c.floor));
  for (let floor = 0; floor <= topFloor; floor += 1) {
    const claimed = (byFloor.get(floor) ?? []).map(fromClaim);
    let specs: Spec[];
    if (floor === 0 && claimed.length === 0) {
      specs =
        input.ground === 'shops'
          ? Array.from({ length: d.int(1, 3) }, () => blank('SHOP'))
          : input.ground === 'pilotis'
            ? [blank('PILOTIS')]
            : input.ground === 'empty'
              ? [blank('EMPTY_FLOOR')]
              : Array.from({ length: input.perFloor }, () => blank('APARTMENT'));
    } else {
      const dwelling = claimed.some((s) => DWELLING.has(s.unitType)) || floor > 0;
      const fill = dwelling ? Math.max(0, input.perFloor - claimed.length) : d.int(0, 1);
      specs = [...claimed, ...Array.from({ length: fill }, () => blank(dwelling ? 'APARTMENT' : 'SHOP'))];
    }
    floors.push({ floor, specs });
  }

  // Columns: the widest floor sets the grid, narrower floors spread across it.
  const columns = Math.max(1, ...floors.map((f) => f.specs.length));
  return floors.flatMap(({ floor, specs }) =>
    specs.map((spec, index) => {
      const span = STRUCTURAL.has(spec.unitType) ? [1, columns] : [
        Math.floor((index * columns) / specs.length) + 1,
        Math.floor(((index + 1) * columns) / specs.length),
      ];
      return {
        id: seedId(buildingId, 'unit', floor, index + 1),
        floor,
        sequence: index + 1,
        startCol: span[0],
        endCol: Math.max(span[0], span[1]),
        unitType: spec.unitType,
        ...(spec.unitArea ? { unitArea: spec.unitArea } : {}),
        ...(spec.unitStatus ? { unitStatus: spec.unitStatus } : {}),
        ...(spec.claim ? { claim: spec.claim } : {}),
      };
    }),
  );
}

function structureFor(units: readonly PlannedUnit[]): string {
  const kinds = units.filter((u) => u.floor >= 0 && !STRUCTURAL.has(u.unitType)).map((u) => u.unitType);
  const dwelling = kinds.some((k) => DWELLING.has(k));
  const business = kinds.some((k) => !DWELLING.has(k));
  if (dwelling && business) return 'MIXED_USE';
  if (dwelling) return 'RESIDENTIAL_BUILDING';
  return kinds.every((k) => k === 'WAREHOUSE') ? 'WAREHOUSE_HANGAR' : 'COMMERCIAL_CENTER';
}

/** UN-Habitat's scale. Severe levels only where the building is not lived in. */
function damageLevelFor(d: Dice, lifecycle: string): string {
  switch (lifecycle) {
    case 'WAR_DAMAGED_UNINHABITED':
      return d.weighted([['UNSAFE_EVACUATE', 6], ['RESTRICTED_USE', 3], ['TOTAL_COLLAPSE', 1]]);
    case 'DEMOLISHED':
      return 'TOTAL_COLLAPSE';
    case 'DERELICT':
      return d.weighted([['RESTRICTED_USE', 5], ['UNSAFE_EVACUATE', 3], ['UNCLASSIFIED', 2]]);
    case 'UNDER_CONSTRUCTION':
      return d.weighted([['NOT_AFFECTED', 7], ['SAFE_MINOR_DAMAGE', 3]]);
    default:
      return d.weighted([['NOT_AFFECTED', 55], ['SAFE_MINOR_DAMAGE', 35], ['RESTRICTED_USE', 10]]);
  }
}

// ──────────────────────────────  The census  ──────────────────────────────

interface CensusResult {
  zones: number;
  buildingsCreated: number;
  unplaced: number;
  linkedRegistrations: number;
}

async function seedCensus(
  db: TenantPrismaClient,
  tenant: (typeof TENANTS)[number],
  schemaName: string,
  citizens: number,
): Promise<CensusResult> {
  const services = censusServices(db, tenant.slug, schemaName);
  const s = `"${schemaName}"`;
  const [{ now: runStart }] = await db.$queryRawUnsafe<Array<{ now: Date }>>(
    `SELECT (now() AT TIME ZONE 'utc')::timestamp AS now`,
  );

  // ── Who acts: the seeded staff, by the addresses seed.ts gives them ──
  const staff = await db.user.findMany({
    where: { kind: 'STAFF', email: { endsWith: `@${tenant.slug}.gov.lb` } },
    select: { id: true, email: true, role: true },
  });
  const byLocal = new Map(staff.map((u) => [u.email!.split('@')[0], { id: u.id, role: u.role as string }]));
  const admin = byLocal.get('admin')!;
  const fieldTeam = ['inspector', 'inspector2', 'inspector3', 'inspector4'].map((k) => byLocal.get(k)!).filter(Boolean);
  const roleOf = new Map(staff.map((u) => [u.id, u.role as string]));

  // ── The cadastre ──
  const parcels: ParcelGeo[] = (
    await db.parcel.findMany({
      select: { parcelNumber: true, latitude: true, longitude: true, boundary: true },
      orderBy: { parcelNumber: 'asc' },
    })
  ).map((p) => ({ number: p.parcelNumber, lat: p.latitude, lng: p.longitude, outline: outlineOf(p.boundary) }));
  const parcelByNumber = new Map(parcels.map((p) => [p.number, p]));

  const zonesCreated = await seedZones(db, services.zones, tenant.slug, parcels, admin);

  // ── The seeded register's current cards, oldest first ──
  const seededRegistrations = Array.from({ length: citizens }, (_, i) => seedId(tenant.slug, 'registration', i));
  const registrations = new Map(
    (
      await db.registration.findMany({
        where: { id: { in: seededRegistrations } },
        select: { id: true, citizenId: true, createdById: true, submittedAt: true, updatedAt: true },
      })
    ).map((r) => [r.id, r]),
  );
  const cards: CardRow[] = (
    await db.propertyEntry.findMany({
      where: { registrationId: { in: seededRegistrations }, endedAt: null, buildingId: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        registrationId: true,
        propertyType: true,
        occupancyType: true,
        propertyNumber: true,
        buildingName: true,
        unitArea: true,
        units: {
          where: { endedAt: null, unitId: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, unitType: true, floor: true, unitArea: true, unitStatus: true },
        },
      },
    })
  ).map((c) => {
    const reg = registrations.get(c.registrationId)!;
    return {
      id: c.id,
      registrationId: c.registrationId,
      citizenId: reg.citizenId,
      createdById: reg.createdById,
      submittedAt: reg.submittedAt,
      propertyType: c.propertyType,
      occupancyType: c.occupancyType,
      propertyNumber: c.propertyNumber?.trim() || null,
      buildingName: c.buildingName,
      unitArea: c.unitArea === null ? null : Number(c.unitArea),
      units: c.units.map((u) => ({
        id: u.id,
        unitType: u.unitType,
        floor: u.floor,
        unitArea: u.unitArea === null ? null : Number(u.unitArea),
        unitStatus: u.unitStatus,
      })),
    };
  });

  // ── Plan: one census structure per apartment block, house and tent camp ──
  const onParcel = new Map<string, CardRow[]>();
  for (const card of cards) {
    if (!card.propertyNumber || !parcelByNumber.has(card.propertyNumber)) continue;
    onParcel.set(card.propertyNumber, [...(onParcel.get(card.propertyNumber) ?? []), card]);
  }

  const plans: PlannedBuilding[] = [];
  const earliest = (rows: readonly CardRow[]) =>
    new Date(Math.min(...rows.map((r) => r.submittedAt.getTime())) - 20 * 60_000);

  for (const [parcel, rows] of onParcel) {
    const d = new Dice(randomSource(tenant.slug, 'census-parcel', parcel));

    // Blocks: the BUILDING cards on the parcel, one structure per building name.
    const blocks = new Map<string, CardRow[]>();
    for (const card of rows.filter((r) => r.propertyType === 'BUILDING' && r.units.length > 0)) {
      const key = card.buildingName ?? '';
      blocks.set(key, [...(blocks.get(key) ?? []), card]);
    }
    for (const [key, blockCards] of blocks) {
      const id = seedId(tenant.slug, 'census-building', parcel, 'block', key);
      const claims = blockCards.flatMap((card) =>
        card.units.map((row) => ({
          floor: floorNumber(row.floor),
          unitType: row.unitType ?? 'APARTMENT',
          unitArea: row.unitArea,
          unitStatus: card.occupancyType === 'OWNER' ? row.unitStatus : null,
          cardId: card.id,
          rowId: row.id,
        })),
      );
      const groundClaimed = claims.some((c) => c.floor === 0);
      const units = planMatrix(d, id, {
        claims,
        floorsAbove: Math.min(8, Math.max(2, ...claims.map((c) => c.floor + 1)) + d.weighted([[0, 4], [1, 3], [2, 1]])),
        basement: d.chance(0.12),
        perFloor: d.weighted([[1, 2], [2, 6], [3, 2]]),
        ground: groundClaimed ? 'claims' : d.weighted([['shops', 3], ['pilotis', 3], ['flats', 4]]),
      });
      plans.push({
        id,
        parcel,
        structureType: structureFor(units),
        lifecycleStatus: 'IN_USE',
        floorsCount: Math.max(...units.map((u) => u.floor)) + 1,
        basementsCount: units.some((u) => u.floor < 0) ? 1 : 0,
        ...(d.chance(0.3) ? { postedNumber: String(d.int(1, 240)) } : {}),
        units,
        createdAt: earliest(blockCards),
        occupied: true,
      });
    }

    // Houses: each منزل card its own one-unit structure.
    for (const card of rows.filter((r) => r.propertyType === 'HOUSE')) {
      const id = seedId(tenant.slug, 'census-building', parcel, 'house', card.id);
      plans.push({
        id,
        parcel,
        structureType: 'INDEPENDENT_HOUSE',
        lifecycleStatus: 'IN_USE',
        floorsCount: d.chance(0.35) ? 2 : 1,
        basementsCount: 0,
        units: [
          {
            id: seedId(id, 'unit', 0, 1),
            floor: 0,
            sequence: 1,
            startCol: 1,
            endCol: 1,
            unitType: 'INDEPENDENT_HOUSE',
            unitArea: card.unitArea ?? area(d, 'INDEPENDENT_HOUSE'),
          },
        ],
        houseCardId: card.id,
        createdAt: earliest([card]),
        occupied: true,
      });
    }

    // A tent camp: one shelter structure per parcel. Tent cards never link to
    // a structure (PropertyEntry forces it), so the camp stands on its own.
    const tents = rows.filter((r) => r.propertyType === 'TENT');
    if (tents.length > 0) {
      const id = seedId(tenant.slug, 'census-building', parcel, 'camp');
      const count = Math.min(24, Math.max(3, tents.length + d.int(1, 4)));
      plans.push({
        id,
        parcel,
        structureType: 'TENT_SHELTER',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
        basementsCount: 0,
        units: Array.from({ length: count }, (_, i) => ({
          id: seedId(id, 'unit', 0, i + 1),
          floor: 0,
          sequence: i + 1,
          startCol: i + 1,
          endCol: i + 1,
          unitType: 'INDEPENDENT_HOUSE',
          unitArea: d.step(12, 28, 1),
        })),
        createdAt: earliest(tents),
        occupied: false,
      });
    }
  }

  // Structures nobody has filed from yet: a census counts every building,
  // including the empty, the unfinished and the war-damaged.
  // Chosen from parcels no seeded household filed on at all — linked or not —
  // so a re-run picks the same parcels instead of the ones the first run's
  // links happened to leave behind.
  const filedParcels = new Set(
    (
      await db.propertyEntry.findMany({
        where: { registrationId: { in: seededRegistrations } },
        select: { propertyNumber: true },
      })
    )
      .map((p) => p.propertyNumber?.trim())
      .filter((n): n is string => Boolean(n)),
  );
  const quiet = parcels.filter((p) => p.outline && !filedParcels.has(p.number));
  const extraCount = Math.round(filedParcels.size * 0.35);
  const pick = new Dice(randomSource(tenant.slug, 'census-extras'));
  const chosen = new Set<string>();
  while (chosen.size < Math.min(extraCount, quiet.length)) chosen.add(pick.pick(quiet).number);
  for (const parcel of [...chosen].sort()) {
    const d = new Dice(randomSource(tenant.slug, 'census-extra', parcel));
    const id = seedId(tenant.slug, 'census-building', parcel, 'extra');
    const lifecycle = d.weighted([
      ['IN_USE', 55], ['UNDER_CONSTRUCTION', 14], ['WAR_DAMAGED_UNINHABITED', 15],
      ['DERELICT', 5], ['DEMOLISHED', 6], ['PERMITTED', 3], ['NOT_REALISED', 2],
    ]);
    const kind = d.weighted([['block', 45], ['house', 30], ['warehouse', 10], ['shops', 8], ['mixed', 7]]);
    const noUnits = lifecycle === 'PERMITTED' || lifecycle === 'NOT_REALISED';
    let units: PlannedUnit[] = [];
    let structureType = 'RESIDENTIAL_BUILDING';
    if (!noUnits && kind === 'house') {
      structureType = 'INDEPENDENT_HOUSE';
      units = [{ id: seedId(id, 'unit', 0, 1), floor: 0, sequence: 1, startCol: 1, endCol: 1, unitType: 'INDEPENDENT_HOUSE', unitArea: area(d, 'INDEPENDENT_HOUSE'), ...(lifecycle === 'UNDER_CONSTRUCTION' ? { unitStatus: 'UNDER_CONSTRUCTION' } : {}) }];
    } else if (!noUnits && kind === 'warehouse') {
      structureType = 'WAREHOUSE_HANGAR';
      units = planMatrix(d, id, { claims: [], floorsAbove: 1, basement: false, perFloor: d.int(1, 2), ground: 'shops' }).map((u) => ({ ...u, unitType: 'WAREHOUSE', unitArea: area(d, 'WAREHOUSE') }));
    } else if (!noUnits && kind === 'shops') {
      structureType = 'COMMERCIAL_CENTER';
      units = planMatrix(d, id, { claims: [], floorsAbove: d.int(1, 2), basement: false, perFloor: d.int(2, 4), ground: 'shops' }).map((u) => (u.floor > 0 ? { ...u, unitType: 'OFFICE', unitArea: area(d, 'OFFICE') } : u));
    } else if (!noUnits) {
      units = planMatrix(d, id, {
        claims: [],
        floorsAbove: d.int(2, 5),
        basement: d.chance(0.1),
        perFloor: d.weighted([[1, 2], [2, 6], [3, 2]]),
        ground: kind === 'mixed' ? 'shops' : d.weighted([['pilotis', 3], ['flats', 4], ['empty', 1]]),
        underConstruction: lifecycle === 'UNDER_CONSTRUCTION',
      });
      structureType = structureFor(units);
    }
    plans.push({
      id,
      parcel,
      structureType,
      lifecycleStatus: lifecycle,
      floorsCount: units.length > 0 ? Math.max(...units.map((u) => u.floor)) + 1 : d.int(1, 3),
      basementsCount: units.some((u) => u.floor < 0) ? 1 : 0,
      units,
      createdAt: new Date(Date.UTC(2026, 8, 8) + d.int(0, 17) * DAY + d.int(5, 14) * HOUR),
      occupied: false,
    });
  }

  // ── Create, in the order an officer would have: oldest first ──
  plans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const existing = await db.building.findMany({ select: { id: true, parcelNumber: true, latitude: true, longitude: true } });
  const existingIds = new Set(existing.map((b) => b.id));
  const pinsOn = new Map<string, LngLat[]>();
  for (const b of existing) {
    if (b.latitude !== null && b.longitude !== null) {
      pinsOn.set(b.parcelNumber, [...(pinsOn.get(b.parcelNumber) ?? []), [b.longitude, b.latitude]]);
    }
  }

  const created: PlannedBuilding[] = [];
  const cardBuilding = new Map<string, string>(); // cardId → buildingId (HOUSE and BUILDING cards)
  const rowUnit = new Map<string, string>(); // card row id → unit id
  let unplaced = 0;

  for (const plan of plans) {
    if (existingIds.has(plan.id)) continue;
    const d = new Dice(randomSource(plan.id, 'pin'));
    const taken = pinsOn.get(plan.parcel) ?? [];
    const pin = placePin(d, parcelByNumber.get(plan.parcel)!, taken);
    if (!pin) {
      unplaced += 1;
      continue;
    }
    const actor = plan.occupied || d.chance(0.5) ? d.pick(fieldTeam) : admin;
    const input = createBuildingSchema.parse({
      parcelNumber: plan.parcel,
      structureType: plan.structureType,
      lifecycleStatus: plan.lifecycleStatus,
      floorsCount: plan.floorsCount,
      ...(plan.basementsCount ? { basementsCount: plan.basementsCount } : {}),
      ...(plan.postedNumber ? { postedNumber: plan.postedNumber } : {}),
      latitude: pin[1],
      longitude: pin[0],
      clientSubmissionId: plan.id,
      ...(taken.length > 0
        ? { acknowledgedDuplicates: true, duplicateReason: 'منشأة منفصلة على العقار نفسه — مدخل مستقل.' }
        : {}),
      units: plan.units.map((u) => ({
        id: u.id,
        floor: u.floor,
        sequence: u.sequence,
        startCol: u.startCol,
        endCol: u.endCol,
        unitType: u.unitType,
        ...(u.unitArea ? { unitArea: u.unitArea } : {}),
        ...(u.unitStatus ? { unitStatus: u.unitStatus } : {}),
      })),
    });
    const { deduplicated } = await services.buildings.create(input, actor);
    pinsOn.set(plan.parcel, [...taken, pin]);
    if (deduplicated) continue;
    created.push(plan);

    if (plan.houseCardId) cardBuilding.set(plan.houseCardId, plan.id);
    for (const unit of plan.units) {
      if (!unit.claim) continue;
      cardBuilding.set(unit.claim.cardId, plan.id);
      rowUnit.set(unit.claim.rowId, unit.id);
    }
  }

  // ── Link the households: the columns filing writes, then the sync ──
  const linksByRegistration = new Map<string, CardRow[]>();
  for (const card of cards) {
    if (cardBuilding.has(card.id)) {
      linksByRegistration.set(card.registrationId, [...(linksByRegistration.get(card.registrationId) ?? []), card]);
    }
  }
  for (const [registrationId, linked] of linksByRegistration) {
    const reg = registrations.get(registrationId)!;
    for (const card of linked) {
      await db.$executeRawUnsafe(`UPDATE ${s}.property_entries SET "buildingId" = $1::uuid WHERE id = $2::uuid`, cardBuilding.get(card.id), card.id);
      for (const row of card.units) {
        const unitId = rowUnit.get(row.id);
        if (unitId) await db.$executeRawUnsafe(`UPDATE ${s}.building_units SET "unitId" = $1::uuid WHERE id = $2::uuid`, unitId, row.id);
      }
    }
    const officer = reg.createdById ?? admin.id;
    await services.census.syncRegistration({
      registrationId,
      citizenId: reg.citizenId,
      actor: { id: officer, role: roleOf.get(officer) ?? 'FIELD_INSPECTOR' },
    });
    // The sync is part of the filing, not an edit after its review.
    await db.$executeRawUnsafe(
      `UPDATE ${s}.registrations SET "updatedAt" = $1, "censusSyncedAt" = $2 WHERE id = $3::uuid`,
      reg.updatedAt,
      reg.submittedAt,
      registrationId,
    );
  }

  // Every seeded card on a surveyed parcel gets the parcel's point, the way
  // filing copies it from the cadastre — the registration dots on the map.
  await db.$executeRawUnsafe(
    `UPDATE ${s}.property_entries pe
        SET latitude = p.latitude, longitude = p.longitude
       FROM ${s}.parcels p
      WHERE p."parcelNumber" = btrim(pe."propertyNumber")
        AND pe.latitude IS NULL
        AND pe."registrationId" = ANY($1::uuid[])`,
    seededRegistrations,
  );

  // ── The rest of a census a few weeks in: visits, vacancies, damage ──
  const claimedUnits = new Set(rowUnit.values());
  const houseUnits = new Set(created.filter((b) => b.houseCardId).map((b) => b.units[0].id));
  for (const plan of created) {
    const d = new Dice(randomSource(plan.id, 'survey'));
    const surveyor = d.pick(fieldTeam);
    const firstVisit = new Date(Math.max(plan.createdAt.getTime() + 2 * HOUR, Date.UTC(2026, 8, 8, 6)));

    for (const unit of plan.units) {
      if (claimedUnits.has(unit.id) || houseUnits.has(unit.id) || STRUCTURAL.has(unit.unitType)) continue;
      if (plan.lifecycleStatus === 'PERMITTED' || plan.lifecycleStatus === 'NOT_REALISED') continue;
      const visitedAt = new Date(Math.min(firstVisit.getTime() + d.int(0, 72) * HOUR, SEED_NOW.getTime() - HOUR));
      const destroyed = plan.lifecycleStatus === 'DEMOLISHED';
      const outcome = destroyed
        ? 'DEMOLISHED'
        : plan.lifecycleStatus === 'WAR_DAMAGED_UNINHABITED' || plan.lifecycleStatus === 'DERELICT'
          ? d.weighted([['INACCESSIBLE', 6], ['VACANT', 4], ['NONE', 2]])
          : plan.lifecycleStatus === 'UNDER_CONSTRUCTION'
            ? 'NONE'
            : d.weighted([['NONE', 45], ['VISITED_NO_ANSWER', 25], ['VACANT', 14], ['REFUSED', 8], ['INACCESSIBLE', 4], ['PARTIAL', 4]]);

      if (outcome === 'NONE') continue;
      if (outcome === 'VACANT') {
        const basis = d.weighted([['FIELD_INSPECTION', 6], ['OWNER_STATEMENT', 2], ['NEIGHBOUR_OR_CARETAKER', 2]]);
        await services.buildings.confirmVacancy(
          unit.id,
          confirmVacancySchema.parse({
            basis,
            observedAt: visitedAt,
            ...(basis === 'NEIGHBOUR_OR_CARETAKER'
              ? { notes: 'أفاد الجار في الطابق نفسه أن الشقة فارغة منذ الحرب.' }
              : basis === 'OWNER_STATEMENT'
                ? { notes: 'أكّد المالك هاتفياً أن الوحدة غير مسكونة.' }
                : {}),
          }),
          surveyor,
        );
        continue;
      }
      await services.buildings.logVisit(
        logVisitSchema.parse({
          unitId: unit.id,
          outcome,
          visitedAt,
          notes: ({
            VISITED_NO_ANSWER: 'لم يُجب أحد — يُعاد المرور مساءً.',
            REFUSED: 'رفض الساكن الإدلاء بالمعلومات.',
            INACCESSIBLE: 'المدخل مغلق أو غير آمن.',
            PARTIAL: 'أُخذت بعض المعلومات — يُستكمل الباقي لاحقاً.',
            DEMOLISHED: 'المبنى مهدَّم بالكامل.',
          } as Record<string, string>)[outcome],
        }),
        surveyor,
      );
    }

    // War damage, UN-Habitat scale. Severe levels only where nobody lives.
    const assessed =
      plan.lifecycleStatus !== 'IN_USE' && plan.lifecycleStatus !== 'PERMITTED' && plan.lifecycleStatus !== 'NOT_REALISED'
        ? true
        : d.chance(0.3);
    if (assessed) {
      const level = damageLevelFor(d, plan.lifecycleStatus);
      await services.damage.record(
        createDamageAssessmentSchema.parse({
          buildingId: plan.id,
          level,
          source: d.weighted([['FIELD_VISIT', 70], ['SATELLITE', 15], ['SELF_REPORTED', 10], ['OFFICIAL_REPORT', 5]]),
          assessedAt: new Date(Math.min(firstVisit.getTime() + d.int(0, 96) * HOUR, SEED_NOW.getTime() - HOUR)),
          observations: ({
            NOT_AFFECTED: 'لا أضرار ظاهرة.',
            SAFE_MINOR_DAMAGE: 'تشققات في الواجهة وزجاج مكسور — صالح للسكن.',
            RESTRICTED_USE: 'أضرار في الأسقف والجدران — استخدام محدود بانتظار الترميم.',
            UNSAFE_EVACUATE: 'أضرار إنشائية في الأعمدة — يُمنع السكن حتى الكشف الهندسي.',
            TOTAL_COLLAPSE: 'انهيار كامل للمبنى.',
            UNCLASSIFIED: 'لم يُصنَّف الضرر بعد — يلزم كشف هندسي.',
          } as Record<string, string>)[level],
        }),
        surveyor,
      );
    }

    // A few ownership disputes and notes, as officers raise them.
    if (plan.occupied && d.chance(0.03)) {
      await services.cases.create(
        createCaseSchema.parse({
          caseType: d.chance(0.5) ? 'OWNERSHIP_DISPUTE' : 'GENERAL_NOTE',
          buildingId: plan.id,
          propertyNumber: plan.parcel,
          notes: d.pick([
            'خلاف بين الورثة على ملكية الطابق الأرضي — بانتظار حصر الإرث.',
            'يدّعي شخصان ملكية الوحدة نفسها — يُطلب سند الملكية.',
            'المالك مسافر — يُتواصل مع الوكيل لاستكمال البيانات.',
          ]),
        }),
        surveyor,
      );
    }
  }

  // ── Move this run's timestamps into the census window ──
  const createdIds = created.map((b) => b.id);
  for (const plan of created) {
    await db.$executeRawUnsafe(
      `UPDATE ${s}.buildings SET "createdAt" = $1, "updatedAt" = $1 WHERE id = $2::uuid`,
      plan.createdAt,
      plan.id,
    );
  }
  // Each statement carries exactly the parameters it uses: Postgres cannot
  // type a parameter a statement never mentions, and refuses the statement.
  const fallback = new Date(SEED_NOW.getTime() - DAY);
  const fixes: Array<[string, ...unknown[]]> = [
    [
      `UPDATE ${s}.units SET "createdAt" = b."createdAt", "updatedAt" = b."createdAt"
         FROM ${s}.buildings b WHERE b.id = units."buildingId" AND b.id = ANY($1::uuid[])`,
      createdIds,
    ],
    // Occupancy began with the filing that established it.
    [
      `UPDATE ${s}.unit_occupancies o SET "fromDate" = r."submittedAt", "createdAt" = r."submittedAt", "updatedAt" = r."submittedAt"
         FROM ${s}.registrations r
        WHERE o."registrationId" = r.id AND o."createdAt" >= $1`,
      runStart,
    ],
    // The sync's own visit happened at the filing…
    [
      `UPDATE ${s}.unit_visits v SET "visitedAt" = sub.at
         FROM (SELECT o."unitId", min(o."fromDate") AS at FROM ${s}.unit_occupancies o GROUP BY o."unitId") sub
        WHERE v."unitId" = sub."unitId" AND v."visitedAt" >= $1`,
      runStart,
    ],
    // …a vacancy's visit at the confirmation…
    [
      `UPDATE ${s}.unit_visits v SET "visitedAt" = c."observedAt"
         FROM ${s}.unit_vacancy_confirmations c
        WHERE c."unitId" = v."unitId" AND v."visitedAt" >= $1`,
      runStart,
    ],
    // …and anything else the services stamped "now", a day after the building.
    [
      `UPDATE ${s}.unit_visits v SET "visitedAt" = LEAST(u."createdAt" + interval '1 day', $2::timestamp)
         FROM ${s}.units u WHERE u.id = v."unitId" AND v."visitedAt" >= $1`,
      runStart,
      fallback,
    ],
    [`UPDATE ${s}.unit_visits SET "createdAt" = "visitedAt" WHERE "createdAt" >= $1`, runStart],
    [`UPDATE ${s}.damage_assessments SET "createdAt" = "assessedAt" WHERE "createdAt" >= $1`, runStart],
    [
      `UPDATE ${s}.unit_vacancy_confirmations SET "createdAt" = "observedAt", "updatedAt" = "observedAt" WHERE "createdAt" >= $1`,
      runStart,
    ],
    [
      `UPDATE ${s}.cases c SET "createdAt" = t.at, "updatedAt" = t.at
         FROM (SELECT c2.id, LEAST(COALESCE(
                 (SELECT max(v."visitedAt") FROM ${s}.unit_visits v WHERE v."unitId" = c2."unitId"),
                 (SELECT b."createdAt" + interval '1 day' FROM ${s}.buildings b WHERE b.id = c2."buildingId"),
                 $2::timestamp), $2::timestamp) AS at
               FROM ${s}.cases c2 WHERE c2."createdAt" >= $1) t
        WHERE c.id = t.id`,
      runStart,
      fallback,
    ],
    [
      `UPDATE ${s}.units u SET "updatedAt" = GREATEST(u."createdAt", (SELECT max(v."visitedAt") FROM ${s}.unit_visits v WHERE v."unitId" = u.id))
        WHERE u."buildingId" = ANY($1::uuid[]) AND EXISTS (SELECT 1 FROM ${s}.unit_visits v WHERE v."unitId" = u.id)`,
      createdIds,
    ],
    [
      `UPDATE ${s}.buildings b SET "updatedAt" = GREATEST(b."createdAt", (SELECT max(u."updatedAt") FROM ${s}.units u WHERE u."buildingId" = b.id))
        WHERE b.id = ANY($1::uuid[]) AND EXISTS (SELECT 1 FROM ${s}.units u WHERE u."buildingId" = b.id)`,
      createdIds,
    ],
  ];
  for (const [sql, ...params] of fixes) {
    await db.$executeRawUnsafe(sql, ...params);
  }

  return {
    zones: zonesCreated,
    buildingsCreated: created.length,
    unplaced,
    linkedRegistrations: linksByRegistration.size,
  };
}

/** Reads the census back on a fresh connection, and checks what matters. */
async function readBack(connectionString: string, schemaName: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const s = `"${schemaName}"`;
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM ${s}.zones)::int                                                   AS zones,
        (SELECT count(*) FROM ${s}.buildings)::int                                               AS buildings,
        (SELECT count(*) FROM ${s}.buildings WHERE latitude IS NOT NULL)::int                    AS pinned,
        (SELECT count(*) FROM ${s}.units)::int                                                   AS units,
        (SELECT count(*) FROM ${s}.units WHERE "surveyStatus" = 'COMPLETE')::int                 AS complete,
        (SELECT count(*) FROM ${s}.units WHERE "surveyStatus" <> 'NOT_SURVEYED')::int            AS surveyed,
        (SELECT count(*) FROM ${s}.unit_occupancies WHERE "toDate" IS NULL)::int                 AS occupancies,
        (SELECT count(*) FROM ${s}.unit_visits)::int                                             AS visits,
        (SELECT count(*) FROM ${s}.unit_vacancy_confirmations WHERE "endedAt" IS NULL)::int      AS vacancies,
        (SELECT count(*) FROM ${s}.damage_assessments)::int                                      AS damage,
        (SELECT count(*) FROM ${s}.cases)::int                                                   AS cases,
        (SELECT count(*) FROM ${s}.property_entries WHERE "buildingId" IS NOT NULL)::int         AS linked_cards,
        (SELECT count(DISTINCT "propertyNumber") FROM ${s}.property_entries WHERE latitude IS NOT NULL)::int AS dotted_parcels,
        (SELECT count(*) FROM ${s}.buildings WHERE code LIKE 'X-%')::int                         AS unzoned,
        -- A linked card whose household the census does not show is the
        -- dual-record defect; there must be none.
        (SELECT count(*) FROM ${s}.property_entries pe
          WHERE pe."buildingId" IS NOT NULL AND pe."endedAt" IS NULL AND pe."propertyType" = 'BUILDING'
            AND EXISTS (SELECT 1 FROM ${s}.building_units bu WHERE bu."propertyEntryId" = pe.id AND bu."unitId" IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM ${s}.unit_occupancies o
                                           JOIN ${s}.registrations r ON r.id = pe."registrationId"
                                          WHERE o."unitId" = bu."unitId" AND o."citizenId" = r."citizenId" AND o."toDate" IS NULL)))::int
                                                                                                 AS unbacked_links
    `);
    const r = rows[0] as Record<string, number>;

    // Pins inside their own parcel, and neighbours far enough apart.
    const pins = await client.query(`
      SELECT b.id, b."parcelNumber", b.latitude, b.longitude, p.boundary
        FROM ${s}.buildings b JOIN ${s}.parcels p ON p."parcelNumber" = b."parcelNumber"
       WHERE b.latitude IS NOT NULL`);
    let outside = 0;
    let tooClose = 0;
    const byParcel = new Map<string, LngLat[]>();
    for (const row of pins.rows as Array<{ parcelNumber: string; latitude: number; longitude: number; boundary: unknown }>) {
      const pt: LngLat = [row.longitude, row.latitude];
      const outline = outlineOf(row.boundary);
      if (outline && !turf.booleanPointInPolygon(turf.point(pt), outline)) outside += 1;
      const others = byParcel.get(row.parcelNumber) ?? [];
      if (others.some((o) => metres(o, pt) < 10)) tooClose += 1;
      byParcel.set(row.parcelNumber, [...others, pt]);
    }

    console.log(
      `  census: ${r.zones} zones, ${r.buildings} buildings (${r.pinned} pinned, ${r.unzoned} without a zone), ${r.units} units ` +
        `(${r.surveyed} surveyed, ${r.complete} complete), ${r.occupancies} occupancies, ${r.visits} visits, ` +
        `${r.vacancies} standing vacancies, ${r.damage} damage assessments, ${r.cases} cases`,
    );
    console.log(
      `  households: ${r.linked_cards} cards linked into the census; registration dots on ${r.dotted_parcels} parcels`,
    );
    console.log(
      `  checks: ${outside} pins outside their parcel, ${tooClose} pins under 10 m from a neighbour, ` +
        `${r.unbacked_links} linked flats without an occupancy`,
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await runSeed();

  const connectionString = localDatabaseUrl();
  const citizens = requestedCitizens();
  console.log('\nسجل المباني');

  for (const tenant of TENANTS) {
    const schemaName = TenantSlug.parse(tenant.slug).schemaName;
    const db = tenantClient(connectionString, schemaName);
    try {
      if ((await db.parcel.count()) === 0) {
        console.log(`  ${tenant.nameAr}: no cadastre, so no real parcel to pin a building in — skipped`);
        continue;
      }
      console.log(`  ${tenant.nameAr} (${tenant.slug})`);
      const count = tenant.share === 1 ? citizens : Math.max(50, Math.round(citizens * tenant.share));
      const result = await seedCensus(db, tenant, schemaName, count);
      console.log(
        `  written: ${result.zones} zones, ${result.buildingsCreated} buildings, ` +
          `${result.linkedRegistrations} households linked` +
          (result.unplaced > 0 ? `; ${result.unplaced} left unlinked (no room on the parcel 12 m from its neighbours)` : ''),
      );
      await readBack(connectionString, schemaName);
    } finally {
      await db.$disconnect();
    }
  }
  console.log('\n✓ Census seed complete');
}

main().catch((error: unknown) => {
  console.error(`\n✗ Census seed failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exit(1);
});
