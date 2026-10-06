import {
  OCCUPIABLE_LIFECYCLE,
  STANDING_LIFECYCLE,
  STRUCTURAL_UNIT_TYPE,
  SURVEYED_STATUS,
  municipalToday,
  type WorklistQuery,
  type ReinspectionRow,
  type ReinspectionsPage,
} from '@mechanization/shared-schemas';
import { Prisma, type PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { likePattern } from '../../common/search-terms';
import { worklistOwnerFilter, type WorklistViewer } from '../../common/worklist-viewer';
import type { UnsurveyedUnitRow } from './building.types';
import { answersHabitabilitySql, currentReadingForUnit, uninhabitableSql } from './habitability';

/**
 * The census's collection worklists — the doors still to knock on.
 *
 * «وحدات غير ممسوحة»: flats nobody has surveyed yet. «بانتظار إعادة الكشف»:
 * flats and structures read «غير صالحة للسكن», waiting for the visit after
 * repair that releases their fee hold. Apart from `BuildingsService` (a god
 * file) and in raw SQL, because both turn on the reading that applies to a
 * flat now (`currentReadingForUnit`), which a model query cannot express.
 *
 * Read-only: each worklist is a page and its count, two reads that a door
 * recorded in between can move by one — never a write, never a transaction.
 */

type Db = Pick<TenantPrismaClient, '$queryRaw'>;

/** A code, a name or a parcel — what a clerk types. Escaped, so `%` and `_` match themselves. */
function searchFilter(search: string | undefined, columns: readonly Prisma.Sql[]): Prisma.Sql {
  const term = search?.trim();
  if (!term) return Prisma.empty;
  const pattern = likePattern(term);
  return Prisma.sql`AND (${Prisma.join(
    columns.map((column) => Prisma.sql`${column} ILIKE ${pattern}`),
    ' OR ',
  )})`;
}

interface UnsurveyedSqlRow {
  unitId: string;
  unitCode: string;
  floor: number;
  unitType: string;
  surveyStatus: string;
  visitCount: number;
  lastVisitAt: Date | null;
  buildingId: string;
  buildingCode: string;
  buildingName: string | null;
  parcelNumber: string;
  addedByName: string | null;
  addedById: string | null;
  openCaseType: string | null;
  scheduledRevisitAt: Date | null;
}

/**
 * «وحدات غير ممسوحة» — the flats still waiting for someone to go in and record
 * who lives there.
 *
 * A flat is on it while all of these hold:
 *
 * - its survey has produced no answer (not in `SURVEYED_STATUS`);
 * - nobody is recorded in it — no current `UnitOccupancy`, and no current card
 *   line naming it (`building_units`): the census claim rule's explicit shape.
 *   Its inferred shapes (a منزل, a مبنى card with no lines) are inferred *from*
 *   current occupancies, so the first condition already covers them;
 * - it is a dwelling or a premises, not a structural row (أعمدة، طابق فارغ);
 * - its building can hold households (`OCCUPIABLE_LIFECYCLE`; no status reads
 *   as occupiable, as `isOccupiableLifecycle` does);
 * - its current damage reading does not say nobody can live in it — that flat
 *   is waiting for a re-inspection, not a survey, and is on that list instead.
 *
 * Whose: units have no creator and nothing assigns them, so a staff member's
 * own are the units of the buildings *they* put on the census
 * (`buildings.createdById`). Ordered as a round is walked: building by
 * building, top floor down. Each row carries its open case, if any — a door
 * already booked for a revisit (`ACCESS_REFUSED`, `UNIT_UNREACHABLE`) is the
 * same door, and the list says when.
 */
export async function unsurveyedUnits(
  db: Db,
  S: Prisma.Sql,
  query: WorklistQuery,
  viewer?: WorklistViewer,
): Promise<{ items: UnsurveyedUnitRow[]; total: number }> {
  const where = Prisma.sql`
    WHERE u."surveyStatus"::text <> ALL(${[...SURVEYED_STATUS]}::text[])
      AND u."unitType"::text <> ALL(${[...STRUCTURAL_UNIT_TYPE]}::text[])
      AND (b."lifecycleStatus" IS NULL OR b."lifecycleStatus"::text = ANY(${[...OCCUPIABLE_LIFECYCLE]}::text[]))
      AND NOT EXISTS (
        SELECT 1 FROM ${S}unit_occupancies o WHERE o."unitId" = u.id AND o."toDate" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${S}building_units line
          JOIN ${S}property_entries card ON card.id = line."propertyEntryId"
         WHERE line."unitId" = u.id AND line."endedAt" IS NULL AND card."endedAt" IS NULL
      )
      AND NOT (cur.id IS NOT NULL AND ${uninhabitableSql(Prisma.sql`cur.level`, Prisma.sql`cur.habitable`)})
      ${worklistOwnerFilter(S, Prisma.sql`b."createdById"`, query.owner, viewer)}
      ${searchFilter(query.search, [
        Prisma.sql`u."unitCode"`,
        Prisma.sql`b.code`,
        Prisma.sql`b.name`,
        Prisma.sql`b."parcelNumber"`,
      ])}`;
  const from = Prisma.sql`
    FROM ${S}units u
    JOIN ${S}buildings b ON b.id = u."buildingId"
    LEFT JOIN LATERAL (${currentReadingForUnit(S, Prisma.sql`u.id`, Prisma.sql`u."buildingId"`, { answering: true })}) cur ON true`;

  const [rows, [aggregate]] = await Promise.all([
    db.$queryRaw<UnsurveyedSqlRow[]>`
      SELECT u.id AS "unitId", u."unitCode", u.floor, u."unitType"::text AS "unitType",
             u."surveyStatus"::text AS "surveyStatus",
             (SELECT count(*)::int FROM ${S}unit_visits v WHERE v."unitId" = u.id) AS "visitCount",
             (SELECT max(v."visitedAt") FROM ${S}unit_visits v WHERE v."unitId" = u.id) AS "lastVisitAt",
             b.id AS "buildingId", b.code AS "buildingCode", b.name AS "buildingName",
             b."parcelNumber",
             NULLIF(TRIM(CONCAT(adder."firstName", ' ', adder."lastName")), '') AS "addedByName",
             b."createdById" AS "addedById",
             booked."caseType" AS "openCaseType", booked."scheduledRevisitAt"
      ${from}
      LEFT JOIN ${S}users adder ON adder.id = b."createdById" AND adder.kind = 'STAFF'
      LEFT JOIN LATERAL (
        SELECT c."caseType"::text AS "caseType", c."scheduledRevisitAt"
          FROM ${S}cases c
         WHERE c."unitId" = u.id AND c.status::text IN ('OPEN', 'SCHEDULED')
         ORDER BY c."scheduledRevisitAt" ASC NULLS LAST, c."createdAt" DESC
         LIMIT 1
      ) booked ON true
      ${where}
      ORDER BY b.code ASC, u.floor DESC, u.sequence ASC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `,
    db.$queryRaw<Array<{ total: number }>>`SELECT count(*)::int AS total ${from} ${where}`,
  ]);

  return {
    items: rows.map((row) => ({ ...row, visitCount: Number(row.visitCount) })),
    total: aggregate?.total ?? 0,
  };
}

interface ReinspectionSqlRow {
  assessmentId: string;
  target: 'BUILDING' | 'UNIT';
  buildingId: string;
  buildingCode: string;
  buildingName: string | null;
  parcelNumber: string | null;
  unitId: string | null;
  unitCode: string | null;
  level: string;
  habitable: boolean | null;
  reinspectAt: Date | null;
  assessedAt: Date;
  assessedById: string | null;
  assessedByName: string | null;
}

/**
 * «بانتظار إعادة الكشف» — what is waiting for the visit after repair.
 *
 * One row per reading that still stands and says nobody can live in its
 * target (`isUninhabitableReading`, in SQL):
 *
 * - a **flat** whose own reading is the one that applies to it now — no later
 *   whole-building reading has spoken for it since;
 * - a **structure** whose latest whole-building reading says so. It stands for
 *   every flat in it, which is one visit, not one row per flat.
 *
 * Gone when the next reading of that target that answers habitability is
 * recorded (`answersHabitability`) — a «غير مصنّف» with no answer leaves it —
 * with nothing to close by hand. Planned days first, the most overdue at the top,
 * then the readings no day was set for. Whose: the officer who recorded the
 * reading (`assessedById`) — the one who knows what the repair was waiting on.
 * Demolished, never-realised and permit-only structures have nothing left to
 * re-inspect (`STANDING_LIFECYCLE`).
 */
export async function reinspections(
  db: Db,
  S: Prisma.Sql,
  query: WorklistQuery,
  viewer?: WorklistViewer,
): Promise<Omit<ReinspectionsPage, 'seesAll'>> {
  const uninhabitable = (alias: string) =>
    uninhabitableSql(Prisma.raw(`${alias}.level`), Prisma.raw(`${alias}.habitable`));
  const candidates = Prisma.sql`
    SELECT 'UNIT'::text AS target, cur.id AS "assessmentId", u."buildingId", u.id AS "unitId",
           u."unitCode", u.floor, u.sequence, cur.level::text AS level, cur.habitable,
           cur."reinspectAt", cur."assessedAt", cur."assessedById"
      FROM ${S}units u
      JOIN LATERAL (${currentReadingForUnit(S, Prisma.sql`u.id`, Prisma.sql`u."buildingId"`, { answering: true })}) cur ON true
     WHERE cur."unitId" = u.id AND ${uninhabitable('cur')}
    UNION ALL
    SELECT 'BUILDING'::text, whole.id, b.id, NULL::uuid, NULL::text, NULL::int, NULL::int,
           whole.level::text, whole.habitable, whole."reinspectAt", whole."assessedAt", whole."assessedById"
      FROM ${S}buildings b
      JOIN LATERAL (
        SELECT d.id, d.level, d.habitable, d."reinspectAt", d."assessedAt", d."assessedById"
          FROM ${S}damage_assessments d
         WHERE d."buildingId" = b.id
           AND ${answersHabitabilitySql(Prisma.sql`d.level`, Prisma.sql`d.habitable`)}
         ORDER BY d."assessedAt" DESC, d."createdAt" DESC
         LIMIT 1
      ) whole ON true
     WHERE ${uninhabitable('whole')}`;
  const from = Prisma.sql`
    FROM (${candidates}) w
    JOIN ${S}buildings b ON b.id = w."buildingId"`;
  const where = Prisma.sql`
    WHERE b."lifecycleStatus"::text = ANY(${[...STANDING_LIFECYCLE]}::text[])
      ${worklistOwnerFilter(S, Prisma.sql`w."assessedById"`, query.owner, viewer)}
      ${searchFilter(query.search, [
        Prisma.sql`w."unitCode"`,
        Prisma.sql`b.code`,
        Prisma.sql`b.name`,
        Prisma.sql`b."parcelNumber"`,
      ])}`;
  const today = municipalToday();

  const [rows, [aggregate]] = await Promise.all([
    db.$queryRaw<ReinspectionSqlRow[]>`
      SELECT w."assessmentId", w.target, b.id AS "buildingId", b.code AS "buildingCode",
             b.name AS "buildingName", b."parcelNumber", w."unitId", w."unitCode", w.level,
             w.habitable, w."reinspectAt", w."assessedAt", w."assessedById",
             NULLIF(TRIM(CONCAT(officer."firstName", ' ', officer."lastName")), '') AS "assessedByName"
      ${from}
      LEFT JOIN LATERAL (
        SELECT s."firstName", s."lastName" FROM ${S}users s
         WHERE s.id = w."assessedById" AND s.kind = 'STAFF'
      ) officer ON true
      ${where}
      ORDER BY (w."reinspectAt" IS NULL) ASC, w."reinspectAt" ASC, b.code ASC,
               w.floor DESC NULLS FIRST, w.sequence ASC NULLS FIRST
      LIMIT ${query.limit} OFFSET ${query.offset}
    `,
    db.$queryRaw<Array<{ total: number; overdue: number }>>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE w."reinspectAt"::date < ${today}::date)::int AS overdue
      ${from}
      ${where}
    `,
  ]);

  return {
    items: rows.map(
      (row): ReinspectionRow => ({
        ...row,
        reinspectAt: row.reinspectAt ? row.reinspectAt.toISOString().slice(0, 10) : null,
        assessedAt: row.assessedAt.toISOString(),
      }),
    ),
    total: aggregate?.total ?? 0,
    overdue: aggregate?.overdue ?? 0,
  };
}
