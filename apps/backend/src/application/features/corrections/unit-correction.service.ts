import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  isStructuralUnitType,
  isSurveyed,
  type UnitCorrectionBlocker,
  type UnitCorrectionDeleteInput,
  type UnitCorrectionPreview,
  type UnitCorrectionResult,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import { ConflictError, NotFoundError, ValidationError } from '../../../domain/errors/domain-error';
import { AUDIT_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type { AuditRepository } from '../../../domain/interfaces/audit-repository.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import {
  planUnitCorrection,
  previewOf,
  RECORDED_IN_ERROR,
  type UnitCorrectionPlan,
  type UnitCorrectionState,
} from './unit-correction.plan';

type Actor = { id: string; role: string };

/** The audit actions this writes. Labelled in the frontend's `audit-labels.ts`. */
export const UNIT_CORRECTION_DELETED = 'UNIT_CORRECTION_DELETED';
export const UNIT_CORRECTION_FILE_ENDED = 'UNIT_CORRECTION_FILE_ENDED';

const fullName = (row: { firstName: string; middleName?: string | null; lastName: string } | null) =>
  row ? [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ') : null;

/** Prisma rows (Decimal, Date) as the plain JSON an audit column stores. */
const json = <T>(value: T): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export function blockerMessage(blocker: UnitCorrectionBlocker): string {
  switch (blocker.kind) {
    case 'DAMAGE_ASSESSMENT':
      return `لا يمكن الحذف: على الوحدة ${blocker.count} كشف ضرر، وكشف الضرر مستند تعويض لا يُحذف مع الوحدة.`;
    case 'LINK_NAMES_OTHER_UNITS':
      return `لا يمكن الحذف: ربط ملف ${blocker.citizenName} بالمالك يشمل وحدات أخرى. ألغِ الربط من ملفه أولاً.`;
    case 'UNREADABLE_LANDLORD_LINK':
      return `لا يمكن الحذف: تعذّرت قراءة ربط ملف ${blocker.citizenName} بالمالك، فلا يمكن التراجع عنه بأمان.`;
  }
}

/**
 * «حذف تصحيحي» — SUPER_ADMIN removes a census unit the ordinary delete refuses.
 *
 * ## Why it exists
 *
 * `BuildingsService.deleteUnit` refuses the moment anything has been recorded
 * against a unit, and that is right for an officer in a stairwell. But a flat
 * drawn by mistake, with a household recorded in it, then had no way out but
 * hand-written SQL on production (A2-424-A, 2026-09-28). This is that SQL as a
 * feature. The rules are in `unit-correction.plan.ts`.
 *
 * ## The guarantee
 *
 * Everything happens in one transaction, and so does its audit trail: the rows
 * are written here, awaited, inside it — not handed to `AuditService`, which
 * writes after the commit and only logs a failure. So there is no outcome in
 * which the unit is gone and the trail is not, or the other way round.
 *
 * Before writing, the unit, its building, every card involved, every line on
 * those cards and their registrations are locked `FOR UPDATE`, and the plan is
 * computed again from what is there now. The locks block anyone adding an
 * occupancy, visit or line to the unit (their foreign-key check needs a share
 * lock on it) until this commits. If the plan's fingerprint is not the one the
 * admin previewed, nothing is written and the dialog shows the new preview.
 *
 * Then every write is checked by its row count, and the result is read back —
 * nothing left on the unit, every line recorded in error and unlinked, the
 * building's counters where the trigger should have put them — and any
 * mismatch throws, which rolls back all of it.
 */
@Injectable()
export class UnitCorrectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async preview(unitId: string): Promise<UnitCorrectionPreview> {
    const state = await this.load(unitId);
    return previewOf(state, planUnitCorrection(state));
  }

  async apply(unitId: string, input: UnitCorrectionDeleteInput, actor: Actor): Promise<UnitCorrectionResult> {
    let outcome: { result: UnitCorrectionResult; citizens: string[] };
    try {
      outcome = await runInTenantTransaction(this.tenantContext, () => this.applyLocked(unitId, input, actor));
    } catch (error) {
      throw busyOr(error);
    }

    /*
      After the commit, so nothing reacts to a delete that could still roll back.
      These clear the caches that describe the building and each file — the
      dashboard, the citizen profile, the quality and review queues. The audit
      rows are already written, so `AuditService` is told not to add another.
    */
    const tenantSlug = this.tenantContext.tenantSlug;
    this.events.emit('building.changed', {
      tenantSlug,
      action: UNIT_CORRECTION_DELETED,
      buildingId: outcome.result.buildingId,
      actorId: actor.id,
      actorRole: actor.role,
      alreadyAudited: true,
    });
    for (const citizenId of outcome.citizens) {
      this.events.emit('citizen.changed', {
        tenantSlug,
        citizenId,
        action: UNIT_CORRECTION_FILE_ENDED,
        actorId: actor.id,
        actorRole: actor.role,
        alreadyAudited: true,
      });
    }
    return outcome.result;
  }

  // ─────────────────────────────  The transaction  ─────────────────────────────

  private async applyLocked(unitId: string, input: UnitCorrectionDeleteInput, actor: Actor) {
    await this.db.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await this.lock(unitId);

    const state = await this.load(unitId);
    const plan = planUnitCorrection(state);

    if (plan.fingerprint !== input.fingerprint) {
      throw new ConflictError({
        code: 'UNIT_CORRECTION_PREVIEW_STALE',
        message: 'This unit’s data changed since you opened the preview. Review the new preview, then confirm again.',
        details: { reason: 'PREVIEW_STALE' },
      });
    }
    if (plan.blockers.length > 0) {
      throw new ConflictError(blockerMessage(plan.blockers[0]!), { reason: 'BLOCKED', blockers: plan.blockers });
    }
    if (input.confirmCode.trim() !== state.unit.unitCode) {
      throw new ValidationError({
        code: 'UNIT_CONFIRM_CODE_MISMATCH',
        message: 'The code you typed does not match the unit’s code.',
        details: { confirmCode: state.unit.unitCode },
      });
    }

    const snapshot = await this.snapshot(state, plan);
    const now = new Date();
    const endIds = plan.lineChanges.filter((change) => change.mode === 'END').map((change) => change.id);
    const reclassifyIds = plan.lineChanges.filter((change) => change.mode === 'RECLASSIFY').map((change) => change.id);
    const linesOnUnit = state.cards.flatMap((card) => card.rows.filter((row) => row.unitId === unitId).map((row) => row.id));

    // 1. File lines naming the unit: recorded in error, ended, never deleted.
    if (endIds.length > 0) {
      const ended = await this.db.buildingUnit.updateMany({
        where: { id: { in: endIds }, endedAt: null },
        data: { endedAt: now, endReason: RECORDED_IN_ERROR as never },
      });
      expectCount(ended.count, endIds.length);
    }
    if (reclassifyIds.length > 0) {
      const reclassified = await this.db.buildingUnit.updateMany({
        where: { id: { in: reclassifyIds }, endedAt: { not: null } },
        data: { endReason: RECORDED_IN_ERROR as never },
      });
      expectCount(reclassified.count, reclassifyIds.length);
    }

    // 2. Cards left with no current line.
    if (plan.cardsToEnd.length > 0) {
      const cardsEnded = await this.db.propertyEntry.updateMany({
        where: { id: { in: plan.cardsToEnd }, endedAt: null, units: { none: { endedAt: null } } },
        data: { endedAt: now, endReason: RECORDED_IN_ERROR as never },
      });
      expectCount(cardsEnded.count, plan.cardsToEnd.length);
    }

    // 3. Landlord links: cleared on a card that ended, pruned on one that goes on.
    for (const link of plan.landlordLinks) {
      await this.db.propertyEntry.update({
        where: { id: link.cardId },
        data:
          link.mode === 'CLEAR'
            ? { landlordCitizenId: null, landlordLinkFootprint: Prisma.DbNull }
            : { landlordLinkFootprint: link.footprint as Prisma.InputJsonValue },
      });
    }

    // 4. «غير مؤكَّد» flags that named what closed.
    for (const change of plan.registrationFlags) {
      await this.db.registration.update({
        where: { id: change.registrationId },
        data: { flaggedFields: change.flags as Prisma.InputJsonValue, status: change.status as never },
      });
    }

    // 5. The unit. Occupancies, visits, vacancy confirmations cascade; lines and cases lose the link.
    await this.db.unit.delete({ where: { id: unitId } });

    // 6. Read it back. Any surprise throws, and the throw undoes everything above.
    const [unitLeft, occupanciesLeft, visitsLeft, vacanciesLeft, linesDone, building] = await Promise.all([
      this.db.unit.count({ where: { id: unitId } }),
      this.db.unitOccupancy.count({ where: { id: { in: state.occupancies.map((row) => row.id) } } }),
      this.db.unitVisit.count({ where: { id: { in: state.visits.map((row) => row.id) } } }),
      this.db.unitVacancyConfirmation.count({ where: { id: { in: state.vacancies.map((row) => row.id) } } }),
      this.db.buildingUnit.count({
        where: { id: { in: linesOnUnit }, unitId: null, endReason: RECORDED_IN_ERROR as never, endedAt: { not: null } },
      }),
      this.db.building.findUnique({
        where: { id: state.unit.buildingId },
        select: { unitsTotal: true, unitsSurveyed: true },
      }),
    ]);
    if (
      unitLeft !== 0 ||
      occupanciesLeft !== 0 ||
      visitsLeft !== 0 ||
      vacanciesLeft !== 0 ||
      linesDone !== linesOnUnit.length ||
      building?.unitsTotal !== plan.counters.totalAfter ||
      building?.unitsSurveyed !== plan.counters.surveyedAfter
    ) {
      throw new ConflictError({
        code: 'UNIT_CORRECTION_UNVERIFIED',
        message: 'The result of the deletion could not be verified, so the whole operation was cancelled and nothing changed.',
        details: { reason: 'UNVERIFIED' },
      });
    }

    // 7. The trail, inside the transaction: it commits with the delete or not at all.
    const reason = input.reason.trim();
    const citizenNames = new Map<string, string>([
      ...state.occupancies.map((row) => [row.citizenId, row.citizenName] as const),
      ...state.cards.map((card) => [card.citizenId, card.citizenName] as const),
    ]);
    const result: UnitCorrectionResult = {
      unitCode: state.unit.unitCode,
      buildingId: state.building.id,
      buildingCode: state.building.code,
      deleted: {
        occupancies: state.occupancies.length,
        visits: state.visits.length,
        vacancies: state.vacancies.length,
      },
      linesEnded: endIds.length,
      linesReclassified: reclassifyIds.length,
      cardsEnded: plan.cardsToEnd.length,
      landlordLinksChanged: plan.landlordLinks.length,
      casesUnlinked: state.cases.length,
      citizensAffected: plan.citizensAffected.length,
      auditEntries: 1 + plan.citizensAffected.length,
    };

    await this.audit.append(
      AuditLogEntry.create({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: UNIT_CORRECTION_DELETED,
        entityType: 'Building',
        entityId: state.building.id,
        before: {
          unitCode: state.unit.unitCode,
          floor: state.unit.floor,
          sequence: state.unit.sequence,
          unitType: state.unit.unitType,
          snapshot: snapshot.building,
        },
        after: {
          note: reason,
          reason: RECORDED_IN_ERROR,
          deleted: result.deleted,
          linesEnded: endIds,
          linesReclassified: reclassifyIds,
          cardsEnded: plan.cardsToEnd,
          landlordLinks: plan.landlordLinks.map((link) => ({ cardId: link.cardId, mode: link.mode })),
          casesUnlinked: state.cases.map((row) => row.id),
          citizens: plan.citizensAffected,
          counters: plan.counters,
          pay: plan.pay,
        },
      }),
    );

    for (const citizenId of plan.citizensAffected) {
      const theirCards = state.cards.filter((card) => card.citizenId === citizenId).map((card) => card.id);
      const theirs = new Set(theirCards);
      await this.audit.append(
        AuditLogEntry.create({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role as never,
          action: UNIT_CORRECTION_FILE_ENDED,
          entityType: 'User',
          entityId: citizenId,
          before: { snapshot: snapshot.citizens.get(citizenId) ?? {} },
          after: {
            note: reason,
            reason: RECORDED_IN_ERROR,
            citizenName: citizenNames.get(citizenId) ?? null,
            unitCode: state.unit.unitCode,
            buildingId: state.building.id,
            buildingCode: state.building.code,
            occupanciesDeleted: state.occupancies.filter((row) => row.citizenId === citizenId).length,
            linesEnded: plan.lineChanges.filter((c) => c.mode === 'END' && theirs.has(c.cardId)).map((c) => c.id),
            linesReclassified: plan.lineChanges
              .filter((c) => c.mode === 'RECLASSIFY' && theirs.has(c.cardId))
              .map((c) => c.id),
            cardsEnded: plan.cardsToEnd.filter((id) => theirs.has(id)),
            landlordLinks: plan.landlordLinks
              .filter((link) => theirs.has(link.cardId))
              .map((link) => ({ cardId: link.cardId, mode: link.mode })),
          },
        }),
      );
    }

    return { result, citizens: plan.citizensAffected };
  }

  /**
   * Locks everything the plan reads, in one fixed order — unit, building,
   * cards, their lines, their registrations — so two corrections cannot
   * deadlock each other, and an app write that takes them in another order
   * fails on `lock_timeout` rather than waiting indefinitely.
   */
  private async lock(unitId: string): Promise<void> {
    const S = this.S;
    const units = await this.db.$queryRaw<Array<{ buildingId: string }>>`
      SELECT "buildingId" FROM ${S}units WHERE id = ${unitId}::uuid FOR UPDATE`;
    if (units.length === 0) throw new NotFoundError({
      code: 'UNIT_NOT_FOUND',
      message: `Unit ${unitId} was not found`,
    });
    await this.db.$queryRaw`SELECT id FROM ${S}buildings WHERE id = ${units[0]!.buildingId}::uuid FOR UPDATE`;

    const cards = await this.db.$queryRaw<Array<{ id: string; registrationId: string }>>`
      SELECT pe.id, pe."registrationId"
        FROM ${S}property_entries pe
       WHERE pe.id IN (SELECT "propertyEntryId" FROM ${S}building_units WHERE "unitId" = ${unitId}::uuid)
          OR pe."landlordLinkFootprint"::text LIKE ${`%${unitId}%`}
       ORDER BY pe.id
         FOR UPDATE`;
    if (cards.length === 0) return;

    const cardIds = cards.map((card) => card.id);
    const registrationIds = [...new Set(cards.map((card) => card.registrationId))].sort();
    await this.db.$queryRaw`
      SELECT id FROM ${S}building_units WHERE "propertyEntryId" = ANY(${cardIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await this.db.$queryRaw`
      SELECT id FROM ${S}registrations WHERE id = ANY(${registrationIds}::uuid[]) ORDER BY id FOR UPDATE`;
  }

  // ─────────────────────────────  Reading  ─────────────────────────────

  private async load(unitId: string): Promise<UnitCorrectionState> {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: {
        id: true,
        buildingId: true,
        unitCode: true,
        floor: true,
        sequence: true,
        unitType: true,
        unitStatus: true,
        surveyStatus: true,
        updatedAt: true,
        building: { select: { id: true, code: true } },
      },
    });
    if (!unit) throw new NotFoundError({
      code: 'UNIT_NOT_FOUND',
      message: `Unit ${unitId} was not found`,
    });

    const [siblings, occupancies, visits, vacancies, damage, cases, lineCards, linkCards] = await Promise.all([
      this.db.unit.findMany({ where: { buildingId: unit.buildingId }, select: { unitType: true, surveyStatus: true } }),
      this.db.unitOccupancy.findMany({
        where: { unitId },
        select: {
          id: true,
          citizenId: true,
          role: true,
          fromDate: true,
          toDate: true,
          endReason: true,
          updatedAt: true,
          citizen: { select: { firstName: true, middleName: true, lastName: true } },
        },
      }),
      this.db.unitVisit.findMany({
        where: { unitId },
        select: {
          id: true,
          visitedAt: true,
          outcome: true,
          officer: { select: { firstName: true, middleName: true, lastName: true } },
        },
      }),
      this.db.unitVacancyConfirmation.findMany({
        where: { unitId },
        select: { id: true, observedAt: true, basis: true, endedAt: true, updatedAt: true },
      }),
      this.db.damageAssessment.findMany({ where: { unitId }, select: { id: true } }),
      this.db.case.findMany({ where: { unitId }, select: { id: true, caseType: true, status: true, updatedAt: true } }),
      this.db.buildingUnit.findMany({ where: { unitId }, select: { propertyEntryId: true } }),
      this.db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM ${this.S}property_entries WHERE "landlordLinkFootprint"::text LIKE ${`%${unitId}%`}`,
    ]);

    const cardIds = [...new Set([...lineCards.map((row) => row.propertyEntryId), ...linkCards.map((row) => row.id)])];
    const cards =
      cardIds.length === 0
        ? []
        : await this.db.propertyEntry.findMany({
            where: { id: { in: cardIds } },
            select: {
              id: true,
              registrationId: true,
              occupancyType: true,
              propertyType: true,
              createdAt: true,
              updatedAt: true,
              endedAt: true,
              endReason: true,
              landlordCitizenId: true,
              landlordLinkFootprint: true,
              filedRegistration: {
                select: {
                  createdById: true,
                  createdBy: { select: { firstName: true, middleName: true, lastName: true } },
                },
              },
              registration: {
                select: {
                  citizenId: true,
                  createdById: true,
                  citizen: { select: { firstName: true, middleName: true, lastName: true } },
                  createdBy: { select: { firstName: true, middleName: true, lastName: true } },
                },
              },
              units: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  propertyEntryId: true,
                  unitId: true,
                  unitType: true,
                  floor: true,
                  unitArea: true,
                  endedAt: true,
                  endReason: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          });

    const registrationIds = [...new Set(cards.map((card) => card.registrationId))];
    const registrations =
      registrationIds.length === 0
        ? []
        : await this.db.registration.findMany({
            where: { id: { in: registrationIds } },
            select: {
              id: true,
              citizenId: true,
              updatedAt: true,
              flaggedFields: true,
              // The order the edit form lists cards in, which flags count positions in.
              properties: {
                where: { endedAt: null },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true },
              },
            },
          });

    /*
      Standing merges of anyone this could change — the plan narrows them to the
      files it actually changes. Undone merges are history and are not asked about.
    */
    const people = [
      ...new Set([
        ...occupancies.map((row) => row.citizenId),
        ...cards.map((card) => card.registration.citizenId),
        ...cards.flatMap((card) => (card.landlordCitizenId ? [card.landlordCitizenId] : [])),
      ]),
    ];
    const merges =
      people.length === 0
        ? []
        : await this.db.citizenMerge.findMany({
            where: { undoneAt: null, OR: [{ survivorId: { in: people } }, { absorbedId: { in: people } }] },
            select: {
              id: true,
              survivorId: true,
              absorbedId: true,
              mergedAt: true,
              survivor: { select: { firstName: true, middleName: true, lastName: true } },
              absorbed: { select: { firstName: true, middleName: true, lastName: true } },
            },
          });

    const counted = siblings.filter((row) => !isStructuralUnitType(row.unitType));
    return {
      unit: {
        id: unit.id,
        buildingId: unit.buildingId,
        unitCode: unit.unitCode,
        floor: unit.floor,
        sequence: unit.sequence,
        unitType: unit.unitType,
        unitStatus: unit.unitStatus,
        surveyStatus: unit.surveyStatus,
        updatedAt: unit.updatedAt,
      },
      building: {
        id: unit.building.id,
        code: unit.building.code,
        countedUnits: counted.length,
        surveyedUnits: counted.filter((row) => isSurveyed(row.surveyStatus)).length,
      },
      occupancies: occupancies.map((row) => ({
        id: row.id,
        citizenId: row.citizenId,
        citizenName: fullName(row.citizen) ?? '—',
        role: row.role,
        fromDate: row.fromDate,
        toDate: row.toDate,
        endReason: row.endReason,
        updatedAt: row.updatedAt,
      })),
      visits: visits.map((row) => ({
        id: row.id,
        visitedAt: row.visitedAt,
        outcome: row.outcome,
        officerName: fullName(row.officer),
      })),
      vacancies: vacancies.map((row) => ({
        id: row.id,
        observedAt: row.observedAt,
        basis: row.basis,
        endedAt: row.endedAt,
        updatedAt: row.updatedAt,
      })),
      damageIds: damage.map((row) => row.id),
      cases: cases.map((row) => ({ id: row.id, caseType: row.caseType, status: row.status, updatedAt: row.updatedAt })),
      cards: cards.map((card) => ({
        id: card.id,
        registrationId: card.registrationId,
        citizenId: card.registration.citizenId,
        citizenName: fullName(card.registration.citizen) ?? '—',
        occupancyType: card.occupancyType,
        propertyType: card.propertyType,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        endedAt: card.endedAt,
        endReason: card.endReason,
        landlordCitizenId: card.landlordCitizenId,
        landlordLinkFootprint: card.landlordLinkFootprint,
        // A card a merge moved still pays whoever filed it (`cardsFiledOn`).
        filedById: card.filedRegistration ? card.filedRegistration.createdById : card.registration.createdById,
        filedByName: fullName(card.filedRegistration ? card.filedRegistration.createdBy : card.registration.createdBy),
        rows: card.units.map((row) => ({
          id: row.id,
          propertyEntryId: row.propertyEntryId,
          unitId: row.unitId,
          unitType: row.unitType,
          floor: row.floor,
          unitArea: row.unitArea === null ? null : row.unitArea.toString(),
          endedAt: row.endedAt,
          endReason: row.endReason,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      })),
      registrations: registrations.map((row) => ({
        id: row.id,
        citizenId: row.citizenId,
        updatedAt: row.updatedAt,
        flaggedFields: row.flaggedFields,
        currentCardIds: row.properties.map((card) => card.id),
      })),
      merges: merges.map((row) => ({
        id: row.id,
        survivorId: row.survivorId,
        survivorName: fullName(row.survivor) ?? '—',
        absorbedId: row.absorbedId,
        absorbedName: fullName(row.absorbed) ?? '—',
        mergedAt: row.mergedAt,
      })),
    };
  }

  /** Whole rows, as they were, for the audit trail: enough to put any of it back by hand. */
  private async snapshot(state: UnitCorrectionState, plan: UnitCorrectionPlan) {
    const unitId = state.unit.id;
    const touched = new Set([
      ...plan.lineChanges.map((change) => change.cardId),
      ...plan.landlordLinks.map((change) => change.cardId),
      ...plan.cardsToEnd,
    ]);
    const flagged = plan.registrationFlags.map((change) => change.registrationId);

    const [unit, occupancies, visits, vacancies, cases, cards, registrations] = await Promise.all([
      this.db.unit.findUnique({ where: { id: unitId } }),
      this.db.unitOccupancy.findMany({ where: { unitId } }),
      this.db.unitVisit.findMany({ where: { unitId } }),
      this.db.unitVacancyConfirmation.findMany({ where: { unitId } }),
      this.db.case.findMany({ where: { unitId } }),
      touched.size === 0
        ? Promise.resolve([])
        : this.db.propertyEntry.findMany({ where: { id: { in: [...touched] } }, include: { units: true } }),
      flagged.length === 0
        ? Promise.resolve([])
        : this.db.registration.findMany({
            where: { id: { in: flagged } },
            select: { id: true, citizenId: true, status: true, flaggedFields: true },
          }),
    ]);

    const citizens = new Map<string, Record<string, unknown>>();
    for (const citizenId of plan.citizensAffected) {
      citizens.set(
        citizenId,
        json({
          occupancies: occupancies.filter((row) => row.citizenId === citizenId),
          cards: cards.filter((card) => state.cards.find((c) => c.id === card.id)?.citizenId === citizenId),
          registrations: registrations.filter((row) => row.citizenId === citizenId),
        }),
      );
    }

    return {
      building: json({ unit, occupancies, visits, vacancies, cases, cards, registrations }),
      citizens,
    };
  }
}

function expectCount(actual: number, expected: number): void {
  if (actual !== expected) throw new ConflictError({
    code: 'UNIT_CORRECTION_PREVIEW_STALE',
    message: 'This unit’s data changed since you opened the preview. Review the new preview, then confirm again.',
    details: { reason: 'PREVIEW_STALE' },
  });
}

/**
 * A lock wait that ran out, or a deadlock Postgres broke by cancelling this
 * transaction: both mean somebody else is writing the same records right now.
 * Either way the transaction rolled back whole; say so in words an admin can
 * act on, instead of a driver error.
 */
function busyOr(error: unknown): unknown {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? String((error.meta as { code?: unknown } | undefined)?.code ?? error.code)
      : null;
  const text = error instanceof Error ? error.message : '';
  if (
    code === 'P2034' ||
    code === '55P03' ||
    code === '40P01' ||
    /lock timeout|deadlock detected|could not obtain lock/i.test(text)
  ) {
    return new ConflictError({
      code: 'UNIT_CORRECTION_BUSY',
      message: 'The unit or one of the citizens’ files is being edited right now. Try again in a moment.',
      details: { reason: 'BUSY' },
    });
  }
  return error;
}
