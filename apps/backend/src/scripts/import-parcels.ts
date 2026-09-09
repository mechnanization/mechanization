/**
 * Imports a municipality's cadastre from the survey office's KMZ.
 *
 *   pnpm --filter @mechanization/backend cadastre:import \
 *     --slug albazourieh --file data/bazoreyye.kmz
 *
 * Two outputs, because the data has two jobs:
 *
 *   1. `parcels` rows in the municipality's schema — the registry the citizen
 *      form validates رقم العقار against, and the source of a registration's
 *      coordinates now that citizens no longer drop their own pin.
 *   2. Static GeoJSON under the frontend's `public/tenants/<slug>/` — the parcel
 *      grid the staff map draws underneath the registration markers. Cartography,
 *      not queryable data, so it is a cacheable file rather than a table and an
 *      endpoint.
 *
 * Idempotent: the parcel table is rebuilt from the file each run, so a corrected
 * survey export is applied by re-running this rather than by hand-patching rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';
import {
  type CadastreLine,
  type Parcel,
  mergeParcelPoints,
  parseCadastre,
  readKmlText,
} from '../infrastructure/cadastre/kmz-parser';
import { buildCadastreGeometryAssets } from '../infrastructure/cadastre/parcel-geometry';

/**
 * Six decimal places is ~0.11 m at this latitude — finer than the survey's own
 * accuracy, and it keeps the line file a third of the size of the raw export.
 */
const COORDINATE_PRECISION = 6;

interface Args {
  slug: string;
  file: string;
  outDir?: string;
}

/** `--slug` and `--file` are both required; usage is thrown, not defaulted. */
function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const slug = get('--slug');
  const file = get('--file');

  if (!slug || !file) {
    throw new Error(
      'Usage: cadastre:import --slug <slug> --file <path to .kmz|.kml> [--out-dir <dir>]',
    );
  }

  return { slug, file, outDir: get('--out-dir') };
}

/** Trims a coordinate to survey precision — see COORDINATE_PRECISION. */
function round(value: number): number {
  return Number(value.toFixed(COORDINATE_PRECISION));
}

/** Parcel centroids as points, with a flag marking merged approximations. */
function parcelsGeoJson(parcels: readonly Parcel[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: parcels.map((parcel) => ({
      type: 'Feature',
      properties: {
        parcelNumber: parcel.parcelNumber,
        // Lets the map label a merged parcel as approximate rather than exact.
        approximate: parcel.pointCount > 1,
      },
      geometry: {
        type: 'Point',
        coordinates: [round(parcel.longitude), round(parcel.latitude)],
      },
    })),
  });
}

/**
 * One MultiLineString per layer rather than thousands of Features: the map draws
 * each layer as a single line style, and collapsing them cuts the per-Feature
 * JSON overhead that dominates a file of ten-thousand two-point segments.
 */
function cadastreGeoJson(lines: readonly CadastreLine[]): string {
  const byLayer = new Map<string, [number, number][][]>();

  for (const line of lines) {
    const coordinates = line.coordinates.map(
      ([lng, lat]) => [round(lng), round(lat)] as [number, number],
    );
    byLayer.set(line.kind, [...(byLayer.get(line.kind) ?? []), coordinates]);
  }

  return JSON.stringify({
    type: 'FeatureCollection',
    features: [...byLayer.entries()].map(([layer, coordinates]) => ({
      type: 'Feature',
      properties: { layer },
      geometry: { type: 'MultiLineString', coordinates },
    })),
  });
}

/** Writes one generated map asset, creating its directory, and logs the size. */
function writeAsset(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  const kb = Math.round(Buffer.byteLength(contents) / 1024);
  console.log(`  wrote ${path} (${kb} KB)`);
}

/**
 * The local write above is what the frontend serves cadastre.geojson and
 * parcels.geojson from once committed — fine for a repo colocated with the
 * frontend. The backend reads its own copy from Supabase Storage instead (see
 * `CadastreStorageService`), since in production the backend is a separate
 * deployment with no access to the frontend's filesystem at all. Best-effort:
 * a developer running this without Supabase creds configured still gets the
 * local files and a clear nudge, rather than a failed import.
 */
async function uploadToSupabase(slug: string, assetName: string, contents: string): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      `  ! SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipped uploading ${assetName} ` +
        `to Supabase Storage; the map's backend will not see this layer until it is uploaded`,
    );
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await supabase.storage
    .from('cadastre')
    .upload(`${slug}/${assetName}`, contents, { contentType: 'application/geo+json', upsert: true });

  if (error) {
    console.warn(`  ! Failed to upload ${assetName} to Supabase Storage: ${error.message}`);
    return;
  }
  console.log(`  uploaded ${slug}/${assetName} to Supabase Storage`);
}

/** Rebuilds a municipality's parcel registry and map layers from its KMZ. */
export async function importCadastre(args: Args): Promise<void> {
  const slug = TenantSlug.parse(args.slug);
  const registry = new RegistryPrismaClient();

  try {
    const tenant = await registry.tenant.findUnique({ where: { slug: slug.value } });
    if (!tenant) {
      throw new Error(`Unknown municipality '${slug.value}' — provision it first`);
    }

    console.log(`Importing cadastre for '${slug.value}' → schema '${tenant.schemaName}'`);

    const { points, lines } = parseCadastre(readKmlText(resolve(args.file)));
    const parcels = mergeParcelPoints(points);

    if (parcels.length === 0) {
      throw new Error('No parcel points found — is this the right export?');
    }

    const merged = parcels.filter((parcel) => parcel.pointCount > 1);
    console.log(
      `  ${points.length} label points → ${parcels.length} parcels ` +
        `(${merged.length} merged from several points)`,
    );

    // ── Derived geometry ──
    // The survey ships lines and labels but no shapes; these are reconstructed
    // so the zone editor has parcels to click and an outline to draw — and so
    // each parcel row can carry its own outline (see `Parcel.boundary`), which
    // is what lets the server decide whether a building's pin is inside its
    // parcel without shipping every polygon to it.
    //
    // Traced before the table is written, because the outlines go in with the
    // points rather than being backfilled afterwards: a parcel must never be
    // resolvable carrying a shape from the previous survey.
    const geometry = buildCadastreGeometryAssets(lines, points);
    console.log(
      `  ${geometry.shapeCount}/${parcels.length} parcel shapes traced ` +
        `(${geometry.unmatchedCount} stay point-only)`,
    );

    const boundaries = new Map(
      geometry.parcelBoundaries.map((entry) => [entry.parcelNumber, entry.geometry]),
    );

    // ── Registry table ──
    const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
    url.searchParams.set('schema', tenant.schemaName);
    const db = new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });

    try {
      // Rebuilt wholesale inside one transaction: a re-import must drop parcels
      // the survey removed, and must never leave the form validating against a
      // half-written registry.
      await db.$transaction([
        db.parcel.deleteMany({}),
        db.parcel.createMany({
          data: parcels.map((parcel) => ({
            parcelNumber: parcel.parcelNumber,
            latitude: parcel.latitude,
            longitude: parcel.longitude,
            pointCount: parcel.pointCount,
            // Undefined — not null — for a parcel with no traced shape: Prisma
            // omits the field entirely, so the column takes its own null.
            boundary: boundaries.get(parcel.parcelNumber),
          })),
        }),
      ]);
      console.log(
        `  ${parcels.length} parcels written to ${tenant.schemaName}.parcels ` +
          `(${boundaries.size} with an outline)`,
      );
    } finally {
      await db.$disconnect();
    }

    // ── Map assets ──
    const outDir =
      args.outDir ??
      join(__dirname, '..', '..', '..', 'frontend', 'public', 'tenants', slug.value);

    const parcelsAsset = parcelsGeoJson(parcels);
    const cadastreAsset = cadastreGeoJson(lines);
    writeAsset(join(outDir, 'parcels.geojson'), parcelsAsset);
    writeAsset(join(outDir, 'cadastre.geojson'), cadastreAsset);
    await uploadToSupabase(slug.value, 'parcels.geojson', parcelsAsset);
    await uploadToSupabase(slug.value, 'cadastre.geojson', cadastreAsset);

    if (geometry.parcelPolygonsGeoJson) {
      writeAsset(join(outDir, 'parcel-polygons.geojson'), geometry.parcelPolygonsGeoJson);
      await uploadToSupabase(slug.value, 'parcel-polygons.geojson', geometry.parcelPolygonsGeoJson);
    }
    if (geometry.cityBoundaryGeoJson) {
      writeAsset(join(outDir, 'city-boundary.geojson'), geometry.cityBoundaryGeoJson);
      await uploadToSupabase(slug.value, 'city-boundary.geojson', geometry.cityBoundaryGeoJson);
    }

    console.log(`\n✓ Cadastre imported for '${slug.value}'`);
  } finally {
    await registry.$disconnect();
  }
}

if (require.main === module) {
  importCadastre(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`\n✗ Import failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
