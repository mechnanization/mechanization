/**
 * Fills `Parcel.boundary` for a municipality whose cadastre was imported before
 * the column existed.
 *
 *   pnpm --filter @mechanization/backend backfill:boundaries --slug albazourieh
 *   pnpm --filter @mechanization/backend backfill:boundaries --slug albazourieh --apply
 *
 * `cadastre:import` now writes each parcel's traced outline onto its row as it
 * rebuilds the table, so a municipality imported from today onwards needs
 * nothing from this. What it does not do is help the municipalities already on
 * file: their rows were written before the column existed, and re-running the
 * import means finding the survey office's original KMZ again — which is not
 * something a municipality can be relied on to still have.
 *
 * The polygons themselves are not lost, though. They were derived at import
 * time and written to `parcel-polygons.geojson`, which is still sitting in the
 * cadastre bucket on S3 and in the frontend's public assets. This reads that file
 * and puts the shapes where the server can query them, so the outlines a
 * municipality already has stop being cartography the browser draws and become
 * something the API can answer questions with.
 *
 * Reads only the asset and writes only `boundary`. Nothing else about a parcel
 * is touched, so this can never disagree with the registry about which numbers
 * exist — a polygon whose parcel number is not in the table is reported and
 * skipped rather than creating a row.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { Prisma, PrismaClient as TenantPrismaClient } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';

interface Args {
  slug: string;
  file?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const slug = get('--slug');
  if (!slug) {
    throw new Error(
      'Usage: backfill:boundaries --slug <slug> [--file <parcel-polygons.geojson>] [--apply]',
    );
  }

  return { slug, file: get('--file'), apply: argv.includes('--apply') };
}

/**
 * Rings per رقم العقار, grouped — the same rule `buildCadastreGeometryAssets`
 * applies. A parcel the survey drew as several disconnected pieces has one
 * feature per piece and one row to put them on, so two or more become a
 * MultiPolygon. Keeping the last would silently shrink the parcel to whichever
 * fragment the file happened to list last, and every building standing on one
 * of the others would then read as outside its own parcel.
 */
function boundariesFrom(raw: string): Map<string, unknown> {
  const collection = JSON.parse(raw) as {
    features?: Array<{
      properties?: { parcelNumber?: unknown };
      geometry?: { type?: string; coordinates?: unknown };
    }>;
  };

  const rings = new Map<string, unknown[]>();

  for (const feature of collection.features ?? []) {
    const parcelNumber = feature.properties?.parcelNumber;
    if (typeof parcelNumber !== 'string' || !parcelNumber.trim()) continue;
    if (feature.geometry?.type !== 'Polygon' || !Array.isArray(feature.geometry.coordinates)) {
      continue;
    }
    const key = parcelNumber.trim();
    rings.set(key, [...(rings.get(key) ?? []), feature.geometry.coordinates]);
  }

  return new Map(
    [...rings.entries()].map(([parcelNumber, polygons]) => [
      parcelNumber,
      polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons },
    ]),
  );
}

export async function backfillParcelBoundaries(args: Args): Promise<void> {
  const slug = TenantSlug.parse(args.slug);
  const registry = new RegistryPrismaClient();

  try {
    const tenant = await registry.tenant.findUnique({ where: { slug: slug.value } });
    if (!tenant) throw new Error(`Unknown municipality '${slug.value}' — provision it first`);

    const path = args.file
      ? resolve(args.file)
      : join(
          __dirname,
          '..', '..', '..',
          'frontend', 'public', 'tenants', slug.value, 'parcel-polygons.geojson',
        );

    const boundaries = boundariesFrom(readFileSync(path, 'utf8'));
    const mode = args.apply ? '' : '[dry run] ';
    console.log(`${mode}${boundaries.size} outline(s) in ${path}`);

    const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
    url.searchParams.set('schema', tenant.schemaName);
    const db = new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });

    try {
      const parcels = await db.parcel.findMany({
        select: { id: true, parcelNumber: true, boundary: true },
      });
      const known = new Set(parcels.map((parcel) => parcel.parcelNumber));

      const orphans = [...boundaries.keys()].filter((number) => !known.has(number));
      const matched = parcels.filter((parcel) => boundaries.has(parcel.parcelNumber));

      console.log(
        `  ${parcels.length} parcel(s) on file · ${matched.length} match an outline · ` +
          `${parcels.length - matched.length} stay point-only`,
      );
      if (orphans.length > 0) {
        // Reported, never created. The registry is the authority on which
        // numbers exist; an outline for a number it does not have is a stale
        // asset, and inventing the parcel would resurrect one the survey
        // removed.
        console.log(
          `  ! ${orphans.length} outline(s) name a parcel not in the registry — skipped: ` +
            `${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? ' …' : ''}`,
        );
      }

      if (!args.apply) {
        console.log('\nNothing written. Re-run with --apply to store the outlines.');
        return;
      }

      // One statement per parcel, chunked into transactions rather than one
      // enormous one: this is a couple of thousand small writes against a live
      // database, and a single transaction holding every row for its duration
      // is the kind of lock the migrator's own `lock_timeout` exists to avoid.
      const CHUNK = 200;
      let written = 0;

      for (let index = 0; index < matched.length; index += CHUNK) {
        const chunk = matched.slice(index, index + CHUNK);
        await db.$transaction(
          chunk.map((parcel) =>
            db.parcel.update({
              where: { id: parcel.id },
              data: { boundary: boundaries.get(parcel.parcelNumber) as never },
            }),
          ),
        );
        written += chunk.length;
        console.log(`  ${written}/${matched.length} written`);
      }

      // `Prisma.DbNull`, not `null`: for a nullable Json column Prisma keeps
      // "the column is SQL NULL" and "the column holds the JSON value null"
      // apart, and a bare `null` is not a filter it accepts.
      const withBoundary = await db.parcel.count({
        where: { boundary: { not: Prisma.DbNull } },
      });
      console.log(`\n✓ ${withBoundary}/${parcels.length} parcels now carry an outline`);
    } finally {
      await db.$disconnect();
    }
  } finally {
    await registry.$disconnect();
  }
}

if (require.main === module) {
  backfillParcelBoundaries(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`\n✗ Boundary backfill failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
