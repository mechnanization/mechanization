import { Injectable } from '@nestjs/common';
import {
  citizenDisplayName,
  isUninhabitableReading,
  municipalToday,
  normalizeDigits,
  type ArrearsExportResult,
  type ArrearsImportResult,
  type ArrearsTemplateRow,
  type ExportArrearsTemplateInput,
  type ImportArrearsInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { ConflictError, NotFoundError } from '../../../domain/errors/domain-error';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { AuditService } from '../audit/audit.service';
import { currentReadingForUnit } from '../buildings/habitability';
import {
  arrearsLineKey,
  oldestKeptYear,
  planArrearsImport,
  unitCodeKey,
  type ArrearsImportContext,
  type ArrearsMember,
  type ArrearsUnit,
} from './arrears-import.plan';

type Actor = { id: string; role: string };
type Db = Prisma.TransactionClient;

export const ARREARS_TEMPLATE_EXPORTED = 'ARREARS_TEMPLATE_EXPORTED';
export const ARREARS_LINES_IMPORTED = 'ARREARS_LINES_IMPORTED';

/** A batch's scope as stored: what the template was exported for. */
type BatchScope = { zoneId?: string; buildingId?: string; count: number };

const NAME_SELECT = { firstName: true, middleName: true, lastName: true, residence: true } as const;

/**
 * Old debts, «متأخرات سنوات سابقة» — the template's export and the import's dry
 * run and write (task 4; docs/old-debts-plan.md §4–§6). Submitting, approving and
 * the bills are task 5.
 *
 * Nothing here is shown to a citizen: a DRAFT batch and its lines are staff
 * work until the manager approves them. No log line names a person.
 */
@Injectable()
export class ArrearsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditTrail: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────  export  ─────────────────────────────

  /**
   * «تصدير قالب»: the next `count` citizens of a zone or a building who are in no
   * batch that is not DISCARDED, by رقم العقار then name — active and archived
   * files, never one folded into another by «دمج ملفين». Writes the DRAFT batch
   * and its citizen set and returns the template's rows, which the browser
   * writes as CSV. A retry of the same press is answered with the same batch.
   */
  async exportTemplate(input: ExportArrearsTemplateInput, actor: Actor): Promise<ArrearsExportResult> {
    const scope: BatchScope = input.zoneId ? { zoneId: input.zoneId, count: input.count } : { buildingId: input.buildingId!, count: input.count };
    const key = input.clientRequestId.toLowerCase();

    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      // A retry with the press's key meets the first here and is answered from its batch.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:arrears-export:${key}`}))`;
      const earlier = await tx.arrearsBatch.findUnique({ where: { clientRequestId: key }, select: { id: true, scope: true } });
      if (earlier) {
        if (!sameScope(earlier.scope, scope)) {
          throw new ConflictError({
            code: 'ARREARS_EXPORT_REQUEST_REUSED',
            message: 'This export key was already used for another zone, building or count',
          });
        }
        const set = await tx.arrearsBatchCitizen.findMany({ where: { batchId: earlier.id }, select: { citizenId: true, rowKey: true } });
        return { batchId: earlier.id, replayed: true, citizenCount: set.length, rows: await this.templateRows(tx, set) };
      }

      // Two exports never pick the same people: the choice and its set are written under one lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:arrears-export`}))`;
      const buildingIds = await this.buildingsInScope(tx, scope);
      const chosen = await this.nextCitizens(tx, buildingIds, scope.count);
      if (chosen.length === 0) {
        throw new ConflictError({
          code: 'ARREARS_EXPORT_NOTHING_LEFT',
          message: 'Every citizen in this zone or building is already in a batch',
        });
      }

      const batch = await tx.arrearsBatch.create({
        data: {
          scope: scope as Prisma.InputJsonObject,
          preparedById: actor.id,
          sourceNote: input.sourceNote ?? null,
          clientRequestId: key,
        },
        select: { id: true },
      });
      const set = chosen.map((citizenId, index) => ({ citizenId, rowKey: index + 1 }));
      await tx.arrearsBatchCitizen.createMany({ data: set.map((member) => ({ ...member, batchId: batch.id })) });

      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: ARREARS_TEMPLATE_EXPORTED,
        entityType: 'ArrearsBatch',
        entityId: batch.id,
        // The batch and how many; never a name.
        after: { batchId: batch.id, citizenCount: set.length, scope },
      });

      return { batchId: batch.id, replayed: false, citizenCount: set.length, rows: await this.templateRows(tx, set) };
    });
  }

  /** The buildings an export reaches: one building, or every building on a zone's parcels. */
  private async buildingsInScope(tx: Db, scope: BatchScope): Promise<string[]> {
    if (scope.buildingId) {
      const building = await tx.building.findUnique({ where: { id: scope.buildingId }, select: { id: true } });
      if (!building) throw new NotFoundError({ code: 'BUILDING_NOT_FOUND', message: 'No building has this id' });
      return [building.id];
    }
    const zone = await tx.zone.findUnique({ where: { id: scope.zoneId! }, select: { parcelNumbers: true } });
    if (!zone) throw new NotFoundError({ code: 'ZONE_NOT_FOUND', message: 'No zone has this id' });
    if (zone.parcelNumbers.length === 0) return [];
    const buildings = await tx.building.findMany({ where: { parcelNumber: { in: zone.parcelNumbers } }, select: { id: true } });
    return buildings.map((building) => building.id);
  }

  /**
   * The next citizens holding a unit in these buildings now, or a current card on
   * one of them on their latest registration, who are in no live batch: by their
   * lowest رقم العقار there, then name.
   */
  private async nextCitizens(tx: Db, buildingIds: readonly string[], count: number): Promise<string[]> {
    if (buildingIds.length === 0) return [];
    const ids = [...buildingIds];
    const rows = await tx.$queryRaw<Array<{ citizenId: string; propertyNumber: string; name: string }>>`
      WITH holders AS (
        SELECT o."citizenId", b."parcelNumber" AS "propertyNumber"
          FROM ${this.S}unit_occupancies o
          JOIN ${this.S}units u ON u.id = o."unitId"
          JOIN ${this.S}buildings b ON b.id = u."buildingId"
         WHERE o."toDate" IS NULL AND b.id = ANY(${ids}::uuid[])
        UNION ALL
        SELECT r."citizenId", coalesce(nullif(btrim(e."propertyNumber"), ''), b."parcelNumber") AS "propertyNumber"
          FROM ${this.S}property_entries e
          JOIN ${this.S}buildings b ON b.id = e."buildingId"
          JOIN (
            SELECT DISTINCT ON (r."citizenId") r.id, r."citizenId"
              FROM ${this.S}registrations r
             ORDER BY r."citizenId", r."submittedAt" DESC
          ) r ON r.id = e."registrationId"
         WHERE e."endedAt" IS NULL AND e."buildingId" = ANY(${ids}::uuid[])
      )
      SELECT h."citizenId", min(h."propertyNumber") AS "propertyNumber",
             concat_ws(' ', u."firstName", u."middleName", u."lastName") AS name
        FROM holders h
        JOIN ${this.S}users u ON u.id = h."citizenId"
       WHERE u.kind = 'CITIZEN' AND u."deletedAt" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${this.S}citizen_merges m WHERE m."absorbedId" = u.id AND m."undoneAt" IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${this.S}arrears_batch_citizens bc
             JOIN ${this.S}arrears_batches ab ON ab.id = bc."batchId"
            WHERE bc."citizenId" = u.id AND ab.status <> 'DISCARDED'
         )
       GROUP BY h."citizenId", u."firstName", u."middleName", u."lastName"
    `;
    return rows
      .sort((a, b) => a.propertyNumber.localeCompare(b.propertyNumber, 'en', { numeric: true }) || a.name.localeCompare(b.name, 'ar'))
      .slice(0, count)
      .map((row) => row.citizenId);
  }

  /**
   * The template's rows for a set: one per unit each citizen holds now (رقم
   * العقار, the unit's full code), then one bare row per current card on a رقم
   * العقار none of those units is on, and one bare row for a citizen with
   * neither. Names only: never a رقم مرجعي, phone or identity number.
   */
  private async templateRows(tx: Db, set: ReadonlyArray<{ citizenId: string; rowKey: number }>): Promise<ArrearsTemplateRow[]> {
    const ids = set.map((member) => member.citizenId);
    const people = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, ...NAME_SELECT } });
    const units = await tx.$queryRaw<Array<{ citizenId: string; propertyNumber: string; unitCode: string }>>`
      SELECT o."citizenId", b."parcelNumber" AS "propertyNumber", b.code || '-' || u."unitCode" AS "unitCode"
        FROM ${this.S}unit_occupancies o
        JOIN ${this.S}units u ON u.id = o."unitId"
        JOIN ${this.S}buildings b ON b.id = u."buildingId"
       WHERE o."toDate" IS NULL AND o."citizenId" = ANY(${ids}::uuid[])
    `;
    const cards = await tx.$queryRaw<Array<{ citizenId: string; propertyNumber: string }>>`
      SELECT r."citizenId", btrim(e."propertyNumber") AS "propertyNumber"
        FROM ${this.S}property_entries e
        JOIN (
          SELECT DISTINCT ON (r."citizenId") r.id, r."citizenId"
            FROM ${this.S}registrations r
           WHERE r."citizenId" = ANY(${ids}::uuid[])
           ORDER BY r."citizenId", r."submittedAt" DESC
        ) r ON r.id = e."registrationId"
       WHERE e."endedAt" IS NULL AND nullif(btrim(e."propertyNumber"), '') IS NOT NULL
    `;

    const nameOf = new Map(people.map((person) => [person.id, citizenDisplayName(person)]));
    const byNumber = (a: { propertyNumber: string | null; unitCode: string | null }, b: { propertyNumber: string | null; unitCode: string | null }) =>
      (a.propertyNumber ?? '').localeCompare(b.propertyNumber ?? '', 'en', { numeric: true }) ||
      (a.unitCode ?? '').localeCompare(b.unitCode ?? '', 'en', { numeric: true });

    const rows: ArrearsTemplateRow[] = [];
    for (const { citizenId, rowKey } of [...set].sort((a, b) => a.rowKey - b.rowKey)) {
      const fullName = nameOf.get(citizenId) ?? '';
      const held = units.filter((unit) => unit.citizenId === citizenId);
      const covered = new Set(held.map((unit) => normalizeDigits(unit.propertyNumber.trim())));
      const bare = [...new Set(cards.filter((card) => card.citizenId === citizenId).map((card) => normalizeDigits(card.propertyNumber)))]
        .filter((number) => !covered.has(number));
      const own: ArrearsTemplateRow[] = [
        ...held.map((unit) => ({ rowKey, fullName, propertyNumber: normalizeDigits(unit.propertyNumber.trim()), unitCode: unit.unitCode })),
        ...bare.map((propertyNumber) => ({ rowKey, fullName, propertyNumber, unitCode: null })),
      ].sort(byNumber);
      rows.push(...(own.length > 0 ? own : [{ rowKey, fullName, propertyNumber: null, unitCode: null }]));
    }
    return rows;
  }

  // ─────────────────────────────  import  ─────────────────────────────

  /**
   * The filled template, checked (`dryRun`) or written into the DRAFT batch. The
   * write runs the same checks inside the transaction that holds the batch's
   * lock, refuses the whole file while any line is refused, and replaces the
   * draft's lines with the file's. The one-live-line index has the last word.
   */
  async importLines(batchId: string, input: ImportArrearsInput, actor: Actor): Promise<ArrearsImportResult> {
    if (input.dryRun) {
      const batch = await this.draftBatch(this.db as Db, batchId, false);
      const context = await this.importContext(this.db as Db, batchId, input, batch.controlTotal);
      const plan = planArrearsImport(input.rows, context);
      return this.resultOf(batchId, true, context, plan, null);
    }

    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const batch = await this.draftBatch(tx, batchId, true);
      /*
        Every writer of live lines queues here (task 5's approval and link take
        it too), so the live lines the checks read cannot change before the
        insert: two batches holding the same debt are refused by the plan, in
        words, not by the index.
      */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:arrears-lines`}))`;
      const context = await this.importContext(tx, batchId, input, batch.controlTotal);
      if (context.cutoffYear === null) {
        throw new ConflictError({ code: 'ARREARS_CUTOFF_NOT_SET', message: 'No cutoff year is set; no old debt is imported until it is' });
      }
      const plan = planArrearsImport(input.rows, context);
      const refused = plan.totals.refused.count;
      if (refused > 0) {
        throw new ConflictError({
          code: 'ARREARS_IMPORT_HAS_REFUSED_ROWS',
          message: 'The file has refused lines; nothing was written',
          params: { count: refused },
          details: this.resultOf(batchId, false, context, plan, null),
        });
      }

      await tx.arrearsLine.deleteMany({ where: { batchId } });
      try {
        await tx.arrearsLine.createMany({
          data: plan.lines.map((line) => ({
            batchId,
            citizenId: line.citizenId,
            sourceName: line.sourceName,
            rowKey: line.rowKey,
            propertyNumber: line.propertyNumber,
            unitId: line.unitId,
            unitCode: line.unitCode,
            year: line.year,
            feeType: line.feeType,
            feeTypeNote: line.feeTypeNote,
            component: line.component,
            amount: new Prisma.Decimal(line.amount),
            dueDate: line.dueDate ? new Date(`${line.dueDate}T00:00:00.000Z`) : null,
            oldReference: line.oldReference,
            note: line.note,
            decision: line.decision,
            dropReason: line.dropReason,
            flags: line.flags as Prisma.InputJsonObject,
          })),
        });
      } catch (error) {
        // The index's last word, for a writer that skipped the lock above.
        if ((error as { code?: unknown }).code === 'P2002') {
          throw new ConflictError({ code: 'ARREARS_LINE_DUPLICATE', message: 'A line of this file is already recorded in another batch' });
        }
        throw error;
      }

      const { totals } = plan;
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: ARREARS_LINES_IMPORTED,
        entityType: 'ArrearsBatch',
        entityId: batchId,
        // Counts and sums only; the lines name people.
        after: {
          lines: plan.lines.length,
          kept: totals.kept,
          dropped: totals.dropped,
          prescribed: totals.prescribed,
          unmatched: totals.unmatched,
          fileTotal: totals.fileTotal,
        },
      });
      return this.resultOf(batchId, false, context, plan, plan.lines.length);
    });
  }

  /** The batch, which must be a DRAFT; locked for the write. */
  private async draftBatch(tx: Db, batchId: string, lock: boolean): Promise<{ controlTotal: number | null }> {
    const rows = lock
      ? await tx.$queryRaw<Array<{ status: string; controlTotal: Prisma.Decimal | null }>>`
          SELECT status, "controlTotal" FROM ${this.S}arrears_batches WHERE id = ${batchId}::uuid FOR UPDATE`
      : await tx.$queryRaw<Array<{ status: string; controlTotal: Prisma.Decimal | null }>>`
          SELECT status, "controlTotal" FROM ${this.S}arrears_batches WHERE id = ${batchId}::uuid`;
    const batch = rows[0];
    if (!batch) throw new NotFoundError({ code: 'ARREARS_BATCH_NOT_FOUND', message: 'No old-debts batch has this id' });
    if (batch.status !== 'DRAFT') {
      throw new ConflictError({ code: 'ARREARS_BATCH_NOT_DRAFT', message: 'Only a draft batch takes lines', params: { status: batch.status } });
    }
    return { controlTotal: batch.controlTotal === null ? null : Number(batch.controlTotal) };
  }

  /** Everything the checks ask of the register and the settings. */
  private async importContext(tx: Db, batchId: string, input: ImportArrearsInput, controlTotal: number | null): Promise<ArrearsImportContext> {
    const settings = await tx.systemSettings.findFirst({ select: { arrearsCutoffYear: true } });

    const set = await tx.arrearsBatchCitizen.findMany({
      where: { batchId },
      select: { rowKey: true, citizen: { select: { id: true, isActive: true, ...NAME_SELECT } } },
    });
    const citizenIds = set.map((member) => member.citizen.id);
    const [merged, spells, live] = await Promise.all([
      tx.citizenMerge.findMany({ where: { absorbedId: { in: citizenIds }, undoneAt: null }, select: { absorbedId: true } }),
      tx.unitOccupancy.findMany({ where: { citizenId: { in: citizenIds }, toDate: null }, select: { citizenId: true, unitId: true } }),
      tx.arrearsLine.findMany({
        where: { citizenId: { in: citizenIds }, decision: 'KEEP', discardedAt: null, batchId: { not: batchId } },
        select: { citizenId: true, propertyNumber: true, unitCode: true, year: true, feeType: true, component: true },
      }),
    ]);
    const mergedAway = new Set(merged.map((row) => row.absorbedId));
    const members = new Map<number, ArrearsMember>(
      set.map((member) => [
        member.rowKey,
        {
          citizenId: member.citizen.id,
          name: citizenDisplayName(member.citizen),
          archived: !member.citizen.isActive,
          mergedAway: mergedAway.has(member.citizen.id),
          heldUnitIds: new Set(spells.filter((spell) => spell.citizenId === member.citizen.id).map((spell) => spell.unitId)),
        },
      ]),
    );

    return {
      today: municipalToday(),
      cutoffYear: settings?.arrearsCutoffYear ?? null,
      startRow: input.startRow,
      members,
      units: await this.unitsNamed(tx, input.rows.map((row) => row.unitCode ?? '')),
      liveKeys: new Set(live.map((line) => arrearsLineKey({ ...line, citizenId: line.citizenId! }))),
      drops: input.drops,
      controlTotal,
    };
  }

  /** The units the file names, by full code, each with its رقم العقار and any war reading. */
  private async unitsNamed(tx: Db, codes: readonly string[]): Promise<Map<string, ArrearsUnit>> {
    const wanted = [...new Set(codes.map((code) => unitCodeKey(code)).filter((code) => code !== ''))];
    if (wanted.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      Array<{ id: string; code: string; parcelNumber: string; sharedParcelNumbers: string[]; level: string | null; habitable: boolean | null; assessedAt: Date | null }>
    >`
      SELECT u.id, b.code || '-' || u."unitCode" AS code, b."parcelNumber", b."sharedParcelNumbers",
             cur.level, cur.habitable, cur."assessedAt"
        FROM ${this.S}units u
        JOIN ${this.S}buildings b ON b.id = u."buildingId"
        LEFT JOIN LATERAL (${currentReadingForUnit(this.S, Prisma.sql`u.id`, Prisma.sql`u."buildingId"`, { answering: true })}) cur ON true
       WHERE upper(b.code || '-' || u."unitCode") = ANY(${wanted}::text[])
    `;
    return new Map(
      rows.map((row) => [
        unitCodeKey(row.code),
        {
          unitId: row.id,
          code: row.code,
          propertyNumbers: [row.parcelNumber, ...row.sharedParcelNumbers].map((number) => normalizeDigits(number.trim())),
          war:
            row.level !== null && isUninhabitableReading({ level: row.level, habitable: row.habitable })
              ? { level: row.level, habitable: row.habitable, assessedAt: row.assessedAt!.toISOString() }
              : null,
        },
      ]),
    );
  }

  private resultOf(
    batchId: string,
    dryRun: boolean,
    context: ArrearsImportContext,
    plan: ReturnType<typeof planArrearsImport>,
    written: number | null,
  ): ArrearsImportResult {
    return {
      batchId,
      dryRun,
      cutoffYear: context.cutoffYear,
      oldestKeptYear: oldestKeptYear(context.today),
      lines: plan.verdicts,
      totals: plan.totals,
      coverage: plan.coverage,
      written,
    };
  }
}

function sameScope(stored: Prisma.JsonValue, scope: BatchScope): boolean {
  const value = (stored ?? {}) as Partial<BatchScope>;
  return (value.zoneId ?? null) === (scope.zoneId ?? null)
    && (value.buildingId ?? null) === (scope.buildingId ?? null)
    && value.count === scope.count;
}
