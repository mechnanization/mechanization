/**
 * Derives the building census from the property cards already on file.
 *
 *   pnpm --filter @mechanization/backend backfill:buildings --slug albazourieh
 *   pnpm --filter @mechanization/backend backfill:buildings --slug albazourieh --apply
 *
 * Every مبنى and منزل a citizen has registered describes a structure that,
 * until now, had no row of its own. This walks those cards and mints the row:
 * one `Building` per `(propertyNumber, buildingName)`, one `Unit` per
 * `BuildingUnit` line (and one per منزل, which is a single-unit structure), and
 * one `UnitOccupancy` per unit for the citizen who filed it.
 *
 * ══ The authority rule, until Phase 2 says otherwise ═════════════════════
 *
 *   `PropertyEntry` and `BuildingUnit` remain **authoritative for billing.**
 *   `Building` and `Unit` are a *read model* — something to colour on a map,
 *   filter in a ledger and dispatch officers against. Nothing under
 *   `features/fees` may read the new tables while this rule stands.
 *
 * It matters because the derivation is lossy in one direction and cannot be
 * otherwise: `BuildingUnit.floor` is free text, so a unit whose floor nobody
 * can parse still gets a row (on floor 0, flagged in the report below) rather
 * than being dropped. That is the right answer for a census — an unplaceable
 * flat is still a flat — and exactly the wrong basis for an invoice. P2-T8
 * flips the rule, deliberately and in its own commit.
 *
 * ══ Idempotence ══════════════════════════════════════════════════════════
 *
 * Re-running produces zero new rows. The links written on the legacy tables
 * are the record of what has been done: a `PropertyEntry` with a `buildingId`
 * and a `BuildingUnit` with a `unitId` are skipped, and each card is converted
 * inside its own transaction, so a run interrupted half-way leaves finished
 * cards finished and unfinished ones untouched rather than half-built.
 *
 * `--apply` writes; without it this is a dry run that reports exactly what it
 * would do and touches nothing.
 */
import {
  formatBuildingCode,
  formatUnitCode,
  nextBuildingSuffix,
  parseFloorLabel,
  STRUCTURE_TYPE_MAP,
  structureTypeForProperty,
  type StructureType,
} from '@mechanization/shared-schemas';
import { PrismaClient as RegistryPrismaClient } from '../generated/registry-client';
import { PrismaClient as TenantPrismaClient, type Prisma } from '../generated/tenant-client';
import { TenantSlug } from '../domain/value-objects/tenant-slug.vo';

interface Args {
  slug: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const index = argv.indexOf('--slug');
  const slug = index >= 0 ? argv[index + 1] : undefined;

  if (!slug) {
    throw new Error('Usage: backfill:buildings --slug <slug> [--apply]');
  }

  return { slug, apply: argv.includes('--apply') };
}

function tenantClient(schemaName: string): TenantPrismaClient {
  const url = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
  url.searchParams.set('schema', schemaName);
  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}

/**
 * The cards this converts, with everything the conversion needs, in one query.
 *
 * `propertyType IN (BUILDING, HOUSE)` and a non-null `propertyNumber` — the
 * scope is the decision recorded as Q2 in the plan, and it is narrow on
 * purpose. A أرض has no structure standing on it. A خيمة has no permanent
 * footprint, no fixed entrance and no floor matrix, and moves between
 * agricultural plots by season, so minting a one-unit building shell for each
 * would corrupt every building-density and structural-inventory figure the
 * census exists to produce. Both stay bare `PropertyEntry` cards.
 *
 * A card with no رقم العقار is skipped for a different reason: the building
 * code is anchored on the parcel number, so there is nothing to anchor. Those
 * cards are counted in the report rather than passed over in silence.
 */
const CARD_SELECT = {
  id: true,
  propertyType: true,
  propertyNumber: true,
  buildingName: true,
  occupancyType: true,
  side: true,
  unitArea: true,
  unitType: true,
  unitStatus: true,
  latitude: true,
  longitude: true,
  createdAt: true,
  buildingId: true,
  registration: { select: { id: true, citizenId: true, createdById: true } },
  units: {
    select: {
      id: true,
      unitId: true,
      unitType: true,
      floor: true,
      side: true,
      unitArea: true,
      unitStatus: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.PropertyEntrySelect;

type Card = Prisma.PropertyEntryGetPayload<{ select: typeof CARD_SELECT }>;

interface Report {
  cardsConsidered: number;
  cardsSkippedNoParcel: number;
  cardsAlreadyLinked: number;
  buildingsCreated: number;
  buildingsReused: number;
  unitsCreated: number;
  occupanciesCreated: number;
  /** Units whose free-text floor could not be read — filed on 0, listed below. */
  unreadableFloors: Array<{ card: string; label: string }>;
  /** Structures several cards contributed units to — see `printReport`. */
  multiCardBuildings: Array<{ code: string; cards: number }>;
}

/**
 * Groups the cards that describe the same structure.
 *
 * `(propertyNumber, buildingName)` and nothing cleverer, because nothing
 * cleverer is trustworthy. Two citizens in one block write «بناية النور» and
 * «بنايه النور» and mean the same building, and no amount of fuzzy matching
 * here can tell that apart from two genuinely different structures on one
 * parcel — which is the ordinary case this census exists to record. Over-
 * splitting produces two buildings a person can merge by looking at them;
 * over-merging silently folds one structure's units into another's matrix,
 * and nobody ever finds it.
 *
 * A card with no `buildingName` groups under the empty key, so every unnamed
 * structure on a parcel becomes one building rather than one per card.
 */
/**
 * Joins the two halves of a group key.
 *
 * `\u0000` rather than a space, because a space is ambiguous with the fields'
 * own contents: parcel «28 A» named «B» and parcel «28» named «A B» would
 * produce the same key and be silently merged into one building. NUL is the
 * one byte neither a رقم العقار nor a free-text building name can contain, and
 * it is written as an escape so it stays visible in the source.
 */
const KEY_SEPARATOR = '\u0000';

function groupKey(card: Card): string {
  return `${card.propertyNumber!.trim()}${KEY_SEPARATOR}${(card.buildingName ?? '').trim()}`;
}

export async function backfillBuildings(args: Args): Promise<void> {
  const slug = TenantSlug.parse(args.slug);
  const registry = new RegistryPrismaClient();

  try {
    const tenant = await registry.tenant.findUnique({ where: { slug: slug.value } });
    if (!tenant) throw new Error(`Unknown municipality '${slug.value}' — provision it first`);

    const db = tenantClient(tenant.schemaName);
    const mode = args.apply ? '' : '[dry run] ';

    try {
      const cards = await db.propertyEntry.findMany({
        where: { propertyType: { in: ['BUILDING', 'HOUSE'] }, propertyNumber: { not: null } },
        select: CARD_SELECT,
        // Creation order is suffix order: the first structure recorded on a
        // parcel is its `A`. Arbitrary, but fixed — and a fixed rule is the
        // whole requirement, since the alternative is two runs disagreeing.
        orderBy: { createdAt: 'asc' },
      });

      const report: Report = {
        cardsConsidered: cards.length,
        cardsSkippedNoParcel: 0,
        cardsAlreadyLinked: 0,
        buildingsCreated: 0,
        buildingsReused: 0,
        unitsCreated: 0,
        occupanciesCreated: 0,
        unreadableFloors: [],
        multiCardBuildings: [],
      };

      // Every parcel number the cards mention, so the zone half of each code is
      // resolved in one pass rather than a query per building. Zone membership
      // lives in `Zone.parcelNumbers` and is never denormalised onto a building
      // — see D13 — so this map is read here and thrown away.
      const zones = await db.zone.findMany({ select: { code: true, parcelNumbers: true } });
      const zoneOfParcel = new Map<string, string>();
      for (const zone of zones) {
        for (const parcelNumber of zone.parcelNumbers) zoneOfParcel.set(parcelNumber, zone.code);
      }

      const parcelPoints = await db.parcel.findMany({
        select: { parcelNumber: true, latitude: true, longitude: true },
      });
      const pointOfParcel = new Map(parcelPoints.map((p) => [p.parcelNumber, p]));

      // Suffixes already taken on each parcel, so a re-run — or a run against a
      // municipality that has started surveying by hand — allocates around what
      // exists instead of colliding with it.
      const existing = await db.building.findMany({
        select: { id: true, parcelNumber: true, codeSuffix: true, name: true, code: true },
      });
      const codeOfBuilding = new Map(existing.map((b) => [b.id, b.code]));
      const takenSuffixes = new Map<string, string[]>();
      const buildingByGroup = new Map<string, string>();
      for (const building of existing) {
        takenSuffixes.set(building.parcelNumber, [
          ...(takenSuffixes.get(building.parcelNumber) ?? []),
          building.codeSuffix,
        ]);
        buildingByGroup.set(
          `${building.parcelNumber}${KEY_SEPARATOR}${(building.name ?? '').trim()}`,
          building.id,
        );
      }

      // Floor → sequences already taken, per building. Seeded from whatever is
      // on file so a re-run appends to a matrix instead of colliding with its
      // unique (buildingId, floor, sequence), then maintained in memory as
      // units are allocated. See `nextSequence`.
      const sequencesByBuilding = new Map<string, Map<number, Set<number>>>();
      for (const unit of await db.unit.findMany({
        select: { buildingId: true, floor: true, sequence: true },
      })) {
        const floors = sequencesByBuilding.get(unit.buildingId) ?? new Map<number, Set<number>>();
        const set = floors.get(unit.floor) ?? new Set<number>();
        set.add(unit.sequence);
        floors.set(unit.floor, set);
        sequencesByBuilding.set(unit.buildingId, floors);
      }

      // How many cards fed each building, so a structure assembled from several
      // of them can be named in the report — see `printReport`.
      const cardsPerBuilding = new Map<string, number>();

      /**
       * Mints the shell for a card that is the first to describe its structure,
       * and returns the id every later line hangs off.
       *
       * In a dry run nothing is written and the id is a readable placeholder —
       * enough to key the in-memory maps by, and never handed to the database.
       */
      const createBuilding = async (
        card: Card,
        parcelNumber: string,
        structureType: StructureType,
        key: string,
      ): Promise<string> => {
        const taken = takenSuffixes.get(parcelNumber) ?? [];
        const codeSuffix = nextBuildingSuffix(taken);
        const point = pointOfParcel.get(parcelNumber);

        const data = {
          parcelNumber,
          codeSuffix,
          code: formatBuildingCode({
            zoneCode: zoneOfParcel.get(parcelNumber),
            parcelNumber,
            codeSuffix,
          }),
          name: card.buildingName?.trim() || null,
          structureType,
          // The card's own pin if the officer dropped one, else the parcel's
          // survey point. Neither is the *entrance* this column is ultimately
          // for — nobody has stood at the door yet — but a pin on the right
          // parcel is what makes the building findable on the map at all, and
          // the real entrance replaces it on the first visit.
          latitude: card.latitude ?? point?.latitude ?? null,
          longitude: card.longitude ?? point?.longitude ?? null,
          floorsCount: 1,
          createdById: card.registration?.createdById ?? null,
        };

        const id = args.apply
          ? (await db.building.create({ data, select: { id: true } })).id
          : `dry-run:${data.code}`;

        takenSuffixes.set(parcelNumber, [...taken, codeSuffix]);
        buildingByGroup.set(key, id);
        codeOfBuilding.set(id, data.code);
        report.buildingsCreated += 1;

        return id;
      };

      console.log(
        `${mode}${cards.length} مبنى/منزل card(s) in '${slug.value}', ` +
          `${existing.length} building(s) already recorded`,
      );

      for (const card of cards) {
        const parcelNumber = card.propertyNumber?.trim();
        if (!parcelNumber) {
          report.cardsSkippedNoParcel += 1;
          continue;
        }

        if (card.buildingId && card.units.every((unit) => unit.unitId)) {
          report.cardsAlreadyLinked += 1;
          continue;
        }

        const structureType = structureTypeForProperty(card.propertyType);
        if (!structureType) continue; // Unreachable given the query; kept honest.

        const key = groupKey(card);
        const known = card.buildingId ?? buildingByGroup.get(key) ?? null;

        // ── The building shell ──
        //
        // Resolved into a `const` in one expression rather than assigned in a
        // branch: the id is read again on every line below it, and a variable
        // that is read, awaited across, then written is the shape
        // `require-atomic-updates` exists to catch. This loop is sequential and
        // could not actually race, but the rule is worth keeping honest rather
        // than silencing.
        const buildingId = known ?? (await createBuilding(card, parcelNumber, structureType, key));
        if (known) report.buildingsReused += 1;

        cardsPerBuilding.set(buildingId, (cardsPerBuilding.get(buildingId) ?? 0) + 1);

        // ── The units inside it ──
        //
        // A منزل has no `BuildingUnit` rows at all — it is a single-unit
        // structure whose one unit's details live on the card itself — so it is
        // synthesised here rather than being skipped for having an empty list.
        const lines: Array<{
          id: string | null;
          unitId: string | null;
          unitType: string | null;
          floorLabel: string | null;
          side: string | null;
          unitArea: Prisma.Decimal | null;
          unitStatus: string | null;
        }> =
          card.units.length > 0
            ? card.units.map((unit) => ({
                id: unit.id,
                unitId: unit.unitId,
                unitType: unit.unitType,
                floorLabel: unit.floor,
                side: unit.side,
                unitArea: unit.unitArea,
                unitStatus: unit.unitStatus,
              }))
            : [
                {
                  id: null,
                  unitId: null,
                  unitType: card.unitType,
                  floorLabel: null,
                  side: card.side,
                  unitArea: card.unitArea,
                  unitStatus: card.unitStatus,
                },
              ];

        /*
          Sequences already spoken for on each floor of this building.

          Held in a map that outlives the loop rather than re-read per card,
          because several cards routinely describe one structure — a landlord
          files the building, each tenant files their own flat — and the second
          card must append to the first's matrix rather than collide with it on
          the unique `(buildingId, floor, sequence)`.

          Keeping it in memory is also what makes the dry run honest: reading
          siblings from the database would show every card an empty floor,
          since a dry run writes nothing, and the preview would then disagree
          with what `--apply` actually does.
        */
        const usedSequences =
          sequencesByBuilding.get(buildingId) ?? new Map<number, Set<number>>();
        sequencesByBuilding.set(buildingId, usedSequences);

        const nextSequence = (floor: number): number => {
          const set = usedSequences.get(floor) ?? new Set<number>();
          let sequence = 1;
          while (set.has(sequence)) sequence += 1;
          set.add(sequence);
          usedSequences.set(floor, set);
          return sequence;
        };

        const pending: Array<{
          legacyUnitId: string | null;
          data: Prisma.UnitUncheckedCreateInput;
        }> = [];

        for (const line of lines) {
          if (line.unitId) continue;

          /*
            An unreadable floor is filed on the ground floor and reported, not
            dropped and not guessed at.

            The label is free text an officer typed on a phone, so «ميزانين»,
            «سطح» and a typo all arrive here, and none of them is an integer.
            Refusing the unit would delete a flat from the census over a
            formatting question; picking a plausible floor would put it in the
            wrong place with nothing to say so. Floor 0 plus a line in the
            report is the version a person can act on — and the legacy string is
            untouched on `BuildingUnit.floor`, so nothing is lost either way.
          */
          const parsed = parseFloorLabel(line.floorLabel);
          if (line.floorLabel && parsed === null) {
            report.unreadableFloors.push({ card: card.id, label: line.floorLabel });
          }
          const floor = parsed ?? 0;
          const sequence = nextSequence(floor);

          pending.push({
            legacyUnitId: line.id,
            data: {
              buildingId: buildingId!,
              floor,
              sequence,
              unitCode: formatUnitCode(floor, sequence),
              unitType: (line.unitType ??
                STRUCTURE_TYPE_MAP[structureType as StructureType].defaultUnitType) as never,
              side: line.side,
              unitArea: line.unitArea,
              unitStatus: line.unitStatus as never,
              /*
                A unit that came out of a registration has been surveyed —
                somebody stood in it, wrote down its area and who lives there.
                Anything else would report a town as unsurveyed on the strength
                of the very records that surveyed it.

                Only these units. Every unit *generated* later to fill out a
                building's matrix starts at the column default,
                `NOT_SURVEYED`, which is the whole point of the state machine.
              */
              surveyStatus: 'COMPLETE',
            },
          });
        }

        const floors = pending.map((entry) => entry.data.floor);
        const floorsCount = floors.length > 0 ? Math.max(...floors) + 1 : 1;

        if (!args.apply) {
          report.unitsCreated += pending.length;
          report.occupanciesCreated += card.registration ? pending.length : 0;
          continue;
        }

        /*
          One transaction per card.

          The unit of work is a card: its building link, its units, and the
          occupancies that say who is in them are one fact about one structure,
          and a run interrupted between them would leave a building whose matrix
          is missing the flats nobody can now tell were meant to be there. Per
          card rather than per run so a single bad row cannot roll back an
          afternoon's work.
        */
        await db.$transaction(async (tx) => {
          for (const entry of pending) {
            const unit = await tx.unit.create({ data: entry.data, select: { id: true } });
            report.unitsCreated += 1;

            // The link back is what makes the next run a no-op on this line.
            if (entry.legacyUnitId) {
              await tx.buildingUnit.update({
                where: { id: entry.legacyUnitId },
                data: { unitId: unit.id },
              });
            }

            /*
              One occupancy per unit, carrying the card's own صفة.

              Per unit and not per card, because occupancy is a fact about a
              flat: an owner who filed a ten-unit building owns ten flats, and
              one row against the building would be unable to say that the third
              floor is let and the fourth is not. A card whose unitStatus says
              RENTED still produces an OWNER row here — the owner is the owner
              of a flat they have let, and the tenant files their own card,
              which is the pair `UnitOccupancy` exists to hold at once.
            */
            if (card.registration) {
              await tx.unitOccupancy.create({
                data: {
                  unitId: unit.id,
                  citizenId: card.registration.citizenId,
                  role: card.occupancyType as never,
                  registrationId: card.registration.id,
                  fromDate: card.createdAt,
                },
              });
              report.occupanciesCreated += 1;
            }
          }

          await tx.propertyEntry.update({
            where: { id: card.id },
            data: { buildingId: buildingId! },
          });

          // Only ever raised. A second card filed against the same structure
          // reporting fewer floors is not evidence the building shrank.
          await tx.building.updateMany({
            where: { id: buildingId!, floorsCount: { lt: floorsCount } },
            data: { floorsCount },
          });
        });
      }

      // Read from the map rather than queried back: in a dry run these ids are
      // placeholders and never reach the database at all.
      for (const [id, cards] of cardsPerBuilding) {
        if (cards > 1) report.multiCardBuildings.push({ code: codeOfBuilding.get(id) ?? id, cards });
      }

      printReport(mode, report);

      if (!args.apply) {
        console.log('\nNothing written. Re-run with --apply to create the rows.');
      }
    } finally {
      await db.$disconnect();
    }
  } finally {
    await registry.$disconnect();
  }
}

function printReport(mode: string, report: Report): void {
  console.log(`\n${mode}Summary`);
  console.log(`  cards considered        ${report.cardsConsidered}`);
  console.log(`  already linked, skipped ${report.cardsAlreadyLinked}`);
  console.log(`  skipped (no رقم العقار)  ${report.cardsSkippedNoParcel}`);
  console.log(`  buildings created       ${report.buildingsCreated}`);
  console.log(`  buildings reused        ${report.buildingsReused}`);
  console.log(`  units created           ${report.unitsCreated}`);
  console.log(`  occupancies created     ${report.occupanciesCreated}`);

  /*
    The structures several cards described, named rather than counted.

    One `Unit` per `BuildingUnit` line is the specified rule and the safe one,
    but it has a consequence worth stating out loud: a landlord who filed a
    three-flat building and two tenants who each filed their own flat produce
    five unit rows for three flats. Matching a tenant's line to the landlord's
    is not something a script can do — a floor with four flats gives no way to
    tell which one the tenant is in — and guessing wrong puts two households in
    one unit, which nobody would ever find.

    So the duplicates are left standing and the buildings are named here. Over-
    splitting is the error a person can see in the unit matrix and merge;
    over-merging is the one that disappears.
  */
  if (report.multiCardBuildings.length > 0) {
    console.log(
      `\n  ${report.multiCardBuildings.length} building(s) were assembled from more than one` +
        `\n  property card. Where a landlord and their tenants each filed the same flat,` +
        `\n  it now has a unit row per card. Review these matrices and merge duplicates:`,
    );
    for (const entry of report.multiCardBuildings) {
      console.log(`    ${entry.code}  (${entry.cards} cards)`);
    }
  }

  if (report.unreadableFloors.length === 0) return;

  // Printed in full rather than counted. Each line is one flat filed on the
  // ground floor because nobody could read its floor, and somebody has to go
  // and look at them — a number alone gives them nothing to look at.
  console.log(
    `\n  ${report.unreadableFloors.length} unit(s) had a floor label that could not be read.` +
      `\n  They are on floor 0 with survey status COMPLETE; the original label is` +
      `\n  untouched on building_units.floor. Fix them from the unit matrix.`,
  );
  for (const entry of report.unreadableFloors) {
    console.log(`    property_entry ${entry.card}  floor="${entry.label}"`);
  }
}

if (require.main === module) {
  backfillBuildings(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`\n✗ Backfill failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
