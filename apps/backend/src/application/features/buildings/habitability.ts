import { NEVER_HABITABLE_DAMAGE_LEVELS } from '@mechanization/shared-schemas';
import { Prisma, type PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';

/**
 * «غير صالحة للسكن» in SQL — the readers that cannot afford a row-by-row
 * TypeScript pass: the biller's fee hold, «وحدات غير ممسوحة» and «بانتظار
 * إعادة الكشف».
 *
 * Two rules, each the twin of one in `@mechanization/shared-schemas`
 * (`damage-rule.ts`). Change them together; `buildings.integration.spec.ts`
 * («holds by the same rule in SQL…») runs every level and answer through
 * both and fails if they disagree.
 */

const NEVER_HABITABLE: string[] = [...NEVER_HABITABLE_DAMAGE_LEVELS];

/**
 * The SQL twin of `isUninhabitableReading`: an explicit «غير صالحة», or a
 * reading from before the question at a level that settles it.
 *
 * `level` and `habitable` are column references the caller owns, e.g.
 * `Prisma.raw('cur.level')`.
 */
export function uninhabitableSql(level: Prisma.Sql, habitable: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${habitable} IS FALSE OR (${habitable} IS NULL AND ${level}::text = ANY(${NEVER_HABITABLE}::text[])))`;
}

/**
 * The SQL twin of `answersHabitability`: every reading but «غير مصنّف» with no
 * answer, which judged nothing and so decides nothing about habitability.
 */
export function answersHabitabilitySql(level: Prisma.Sql, habitable: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT (${level}::text = 'UNCLASSIFIED' AND ${habitable} IS NULL)`;
}

/**
 * The reading that applies to a flat *now*: the latest — by `assessedAt`, then
 * `createdAt` — of its own readings and its building's.
 *
 * A whole-building reading after a strike speaks for every flat in it until a
 * flat is read on its own, and a flat's own later reading speaks for that flat
 * alone. Latest by the day of the visit, not of the paperwork, as
 * `DamageService.currentLevel` reads it. Two index-backed single-row lookups,
 * one per target column, rather than an OR that defeats both indexes.
 *
 * For a `JOIN LATERAL (…) <alias> ON true`; it yields `id`, `level`,
 * `habitable`, `reinspectAt`, `assessedAt`, `assessedById`, `unitId` and
 * `buildingId`.
 *
 * `answering` keeps only the readings that make a finding about habitability
 * (`answersHabitabilitySql`): what the fee hold and both census worklists
 * read, so that a later «غير مصنّف» with no answer leaves a hold standing
 * instead of ending it. Without it, the plain latest reading.
 */
export function currentReadingForUnit(
  S: Prisma.Sql,
  unitId: Prisma.Sql,
  buildingId: Prisma.Sql,
  options: { answering?: boolean } = {},
): Prisma.Sql {
  const answering = options.answering
    ? Prisma.sql`AND ${answersHabitabilitySql(Prisma.sql`d.level`, Prisma.sql`d.habitable`)}`
    : Prisma.empty;
  return Prisma.sql`
    SELECT x.* FROM (
      (SELECT d.id, d.level, d.habitable, d."reinspectAt", d."assessedAt", d."createdAt",
              d."assessedById", d."unitId", d."buildingId"
         FROM ${S}damage_assessments d
        WHERE d."unitId" = ${unitId} ${answering}
        ORDER BY d."assessedAt" DESC, d."createdAt" DESC
        LIMIT 1)
      UNION ALL
      (SELECT d.id, d.level, d.habitable, d."reinspectAt", d."assessedAt", d."createdAt",
              d."assessedById", d."unitId", d."buildingId"
         FROM ${S}damage_assessments d
        WHERE d."buildingId" = ${buildingId} ${answering}
        ORDER BY d."assessedAt" DESC, d."createdAt" DESC
        LIMIT 1)
    ) x
    ORDER BY x."assessedAt" DESC, x."createdAt" DESC
    LIMIT 1`;
}

/**
 * The flats among these whose current reading says nobody can live in them —
 * the ones the biller holds the occupancy fee on (decision, 2026-10-05).
 *
 * Released by the next reading that says otherwise, from any screen, with
 * nothing to close by hand: the hold is recomputed from the readings every
 * run, as `unitsUnderReview` is recomputed from the records. A reading that
 * judged nothing («غير مصنّف» with no answer) does not say otherwise, so it
 * leaves the hold standing (`answering`).
 */
export async function uninhabitableUnitIds(
  db: Pick<TenantPrismaClient, '$queryRaw'>,
  S: Prisma.Sql,
  unitIds: readonly string[],
): Promise<Set<string>> {
  if (unitIds.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT u.id
      FROM ${S}units u
      JOIN LATERAL (${currentReadingForUnit(S, Prisma.sql`u.id`, Prisma.sql`u."buildingId"`, { answering: true })}) cur ON true
     WHERE u.id = ANY(${[...unitIds]}::uuid[])
       AND ${uninhabitableSql(Prisma.sql`cur.level`, Prisma.sql`cur.habitable`)}
  `;
  return new Set(rows.map((row) => row.id));
}
