import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  isStructuralUnitType,
  type ConfirmVacancyInput,
  type EndVacancyInput,
  type LogVisitInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { CasesService } from '../cases/cases.service';
import type { UnitRow, VacancyRow, VisitRow } from './building.types';
import { activeVacancy, closeActiveVacancy, toVacancyRow } from './unit-vacancy';
import { APP_CONFIG } from '../../common/app.config';
import { BuildingsService, structuralLabel, toUnitRow, toVisitRow } from './buildings.service';

/**
 * Metres between two pins, on a sphere.
 *
 * Haversine and not an ellipsoidal formula, deliberately. The only consumer is
 * the duplicate-building prompt, where the question is "are these two entrances
 * eight metres apart or eighty" — and at the hundred-metre scale of one parcel
 * the two formulas differ by centimetres. What matters is that the number is
 * never confidently wrong, and Haversine at this range is not.
 */
/**
 * How recently this officer's own visit to a unit makes another one worth a
 * question. Twelve hours covers one working day's morning-and-evening retry,
 * which is still allowed — it is only asked.
 */
const REPEAT_VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * How close two visits' own dates must be to read as one knock. A day, because
 * the form sends a date without a time, so a visit dated "today" is midnight.
 */
const SAME_VISIT_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a visit finds at a unit: «تأكيد الشغور» and its undo (`confirmVacancy`,
 * `endVacancy`), and the visit log (`logVisit`, `visits`). Confirming a vacancy
 * stops the owner's occupancy fee and lifting it starts it again, so each is
 * audited as loudly as an occupancy. Out of `BuildingsService` (audit GOD-06).
 */
@Injectable()
export class UnitVisitsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cases: CasesService,
    private readonly events: EventEmitter2,
    private readonly buildings: BuildingsService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * One transaction — or the caller's, when there already is one: `runInTenantTransaction`
   * with this service's bounds (`APP_CONFIG.transactions.buildingWrite`), the work handed the
   * transaction client the scope now holds (audit ARCH-03).
   *
   * «إنهاء الإيجار» confirms the vacancy it leaves behind inside its own transaction, so the
   * tenancy and the vacancy commit together; a whole-matrix save (`saveMatrix`) runs `addUnit`
   * inside its own. The helper joins an enclosing transaction rather than opening a second,
   * and since it swaps the scope, the services and audit listeners called inside the work write
   * through it too — which the bare `$transaction` this replaced, joined by duck-typing, did not.
   */
  private atomic<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runInTenantTransaction(
      this.tenantContext,
      () => work(this.db as Prisma.TransactionClient),
      APP_CONFIG.transactions.buildingWrite,
    );
  }

  /** See `endVacancy`: an owner's «شاغرة» on their own card, cleared with the vacancy. */
  private async withdrawOwnerVacancyStatements(
    unitId: string,
    unitCode: string,
    actor: { id: string; role: string },
  ): Promise<void> {
    const unit = await this.db.unit.findUnique({ where: { id: unitId }, select: { buildingId: true } });
    if (!unit) return;
    const soleUnit = (await this.db.unit.count({ where: { buildingId: unit.buildingId } })) === 1;
    const [lines, houses] = await Promise.all([
      this.db.buildingUnit.findMany({
        where: {
          unitId,
          endedAt: null,
          unitStatus: 'VACANT' as never,
          propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
        },
        select: { id: true, propertyEntryId: true, propertyEntry: { select: { registration: { select: { citizenId: true } } } } },
      }),
      soleUnit
        ? this.db.propertyEntry.findMany({
            where: {
              buildingId: unit.buildingId,
              propertyType: 'HOUSE' as never,
              occupancyType: 'OWNER' as never,
              endedAt: null,
              unitStatus: 'VACANT' as never,
              units: { none: { endedAt: null } },
            },
            select: { id: true, registration: { select: { citizenId: true } } },
          })
        : Promise.resolve([]),
    ]);
    if (lines.length > 0) {
      await this.db.buildingUnit.updateMany({ where: { id: { in: lines.map((line) => line.id) } }, data: { unitStatus: null } });
    }
    if (houses.length > 0) {
      await this.db.propertyEntry.updateMany({ where: { id: { in: houses.map((card) => card.id) } }, data: { unitStatus: null } });
    }
    const touched = [
      ...lines.map((line) => ({ citizenId: line.propertyEntry.registration.citizenId, propertyEntryId: line.propertyEntryId })),
      ...houses.map((card) => ({ citizenId: card.registration.citizenId, propertyEntryId: card.id })),
    ];
    for (const change of touched) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: change.citizenId,
        action: 'CITIZEN_UPDATED',
        before: { unitStatus: 'VACANT' },
        after: {
          cards: [{ kind: 'changed', propertyEntryId: change.propertyEntryId, fields: ['unitStatus'] }],
          unitCode,
          unitStatus: null,
          via: 'VACANCY_ENDED',
        },
        actorId: actor.id,
        actorRole: actor.role,
      });
    }
  }

  /**
   * Records that a unit was found empty — as a row that says so, not as two
   * overwritten columns.
   *
   * ## Why this is not a status edit
   *
   * A confirmed vacancy exempts the owner from the occupancy fee (Law 60/1988
   * Art. 11 — the fee is owed for *actual* occupancy), so it is a finding with a
   * cost to the municipality if it is wrong and a cost to the owner if it is
   * missing. The old button wrote «شاغرة» and «مؤكَّدة الشغور» and kept nothing
   * else: not who decided, not what they had, not what the flat said before. A
   * resident disputing an assessment could be told only that the register said
   * so.
   *
   * So the confirmation is the record, and the unit's two columns are its
   * *effect*. `basis` is what it rests on (the law is specific — see
   * `VACANCY_BASIS`), `observedAt` is when the flat was seen empty, and the
   * previous حالة and حالة مسح are snapshotted so `endVacancy` can put them
   * back.
   *
   * ## What it refuses
   *
   * The two in `assertMayBeCalledEmpty`, plus a vacancy already standing — the
   * partial unique index in migration 0043 is the backstop for two officers
   * confirming the same flat at once, and this is the message for the ordinary
   * case of one officer pressing twice.
   *
   * A unit already marked `DEMOLISHED` is allowed through deliberately: a
   * demolished flat is empty, and refusing here would leave the only way to say
   * so blocked behind a status nobody is going to change back.
   */
  async confirmVacancy(
    unitId: string,
    input: ConfirmVacancyInput,
    actor: { id: string; role: string },
    /**
     * For callers inside another write. `settle: false` — the caller settles
     * the flat once its own writes are done, so a half-written flat is never
     * judged (and a review opened and closed in one request). `ownerStatement`
     * — the owner's own «شاغرة»: a seasonal home's owner saying it is no longer
     * used is exactly how one stops being seasonal, so the seasonal refusal does
     * not apply to them.
     */
    options: { settle?: boolean; ownerStatement?: boolean } = {},
  ): Promise<{ vacancy: VacancyRow; unit: UnitRow; casesResolved: number }> {
    const unit = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    /*
      A طابق أعمدة is not empty — it is not a space that can be full.

      «تأكيد الشغور» exists to exempt an owner from the occupancy fee on a
      dwelling or premises nobody is using (Law 60/1988 Art. 11). A column floor
      was never going to be charged one, so a confirmation on it would be a
      finding with nothing to find and an exemption from nothing — while still
      producing the audit rows, the survey-status change and the undo path that
      a real confirmation carries.
    */
    if (isStructuralUnitType(unit.unitType)) {
      throw new ValidationError(
        `الوحدة ${unit.unitCode} ${structuralLabel(unit.unitType)} — لا يُسجَّل لها تأكيد شغور، فهي ليست مسكناً ولا محلاً يُشغل`,
        { unitType: unit.unitType, unitCode: unit.unitCode },
      );
    }

    const standing = await activeVacancy(this.db, unitId);
    if (standing) {
      throw new ConflictError(
        `الوحدة ${unit.unitCode} مؤكَّد شغورها مسبقاً منذ ${standing.observedAt
          .toISOString()
          .slice(0, 10)}`,
      );
    }

    await this.buildings.assertMayBeCalledEmpty(unit, { seasonalAllowed: options.ownerStatement === true });

    /*
      One transaction, because the row and the effect are one fact. A
      confirmation with the unit left unchanged would be a vacancy nothing bills
      on; a changed unit with no confirmation is the state this whole feature
      exists to get rid of.
    */
    const [vacancy, updated] = await this.atomic(async (tx) => {
      const created = await tx.unitVacancyConfirmation.create({
        data: {
          unitId,
          basis: input.basis as never,
          ...(input.observedAt ? { observedAt: input.observedAt } : {}),
          notes: input.notes?.trim() || null,
          confirmedById: actor.id,
          previousUnitStatus: unit.unitStatus,
          previousSurveyStatus: unit.surveyStatus,
        },
        include: {
          confirmedBy: { select: { firstName: true, lastName: true } },
          endedBy: { select: { firstName: true, lastName: true } },
        },
      });

      const unitRow = await tx.unit.update({
        where: { id: unitId },
        data: { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
      });

      return [created, unitRow] as const;
    });

    /*
      A «شاغرة قيد التحقق» case is a question this answers.

      Only that type, and only on this exact unit: the other case types are
      about access, ownership or a note, and closing them here would silently
      clear somebody else's dispatch item — the specific way a case list stops
      being believed.
    */
    const casesResolved = await this.cases.resolveVacancyCasesForUnit(unitId, actor);

    this.buildings.record({
      action: 'UNIT_VACANCY_CONFIRMED',
      buildingId: unit.buildingId,
      before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        vacancyId: vacancy.id,
        basis: input.basis,
        observedAt: vacancy.observedAt,
        casesResolved,
      },
      actor,
    });

    if (options.settle !== false) await this.buildings.settle(unitId, actor, 'VACANCY_CONFIRMED');

    return { vacancy: toVacancyRow(vacancy), unit: toUnitRow(updated), casesResolved };
  }

  /**
   * Lifts the vacancy standing on a unit — the undo, available at any time.
   *
   * ## Why it is always available
   *
   * The old action had no way back at all: an officer who confirmed the wrong
   * flat could only type a status in again and hope they remembered the right
   * one, and nothing recorded that the register had ever called it empty. A
   * finding that changes a bill has to be reversible by the people who make it,
   * or it gets worked around — and the workaround here was ending the owner's
   * spell, which erases a deed.
   *
   * ## What it restores, and what it refuses to touch
   *
   * `vacancyReversal` decides, and it only ever rewrites the two values the
   * confirmation itself wrote. A unit whose حالة has moved on since is left
   * alone: that is a newer statement about the flat, and an undo pressed a month
   * later has no business overruling it.
   *
   * The confirmation is closed, never deleted — including one «سُجِّل بالخطأ»,
   * which is kept for the reason an occupancy recorded in error is: the row is
   * evidence of what was entered and by whom. What it is *not* is history, so
   * the matrix hides it from the unit's timeline while the audit keeps it.
   */
  async endVacancy(
    unitId: string,
    input: EndVacancyInput,
    actor: { id: string; role: string },
  ): Promise<{ vacancy: VacancyRow; unit: UnitRow }> {
    const unit = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const standing = await activeVacancy(this.db, unitId);
    if (!standing) {
      throw new ConflictError(`لا يوجد تأكيد شغور قائم على الوحدة ${unit.unitCode}`);
    }

    /*
      Refused rather than clamped, unlike `closeActiveVacancy`'s own guard: here
      a person typed the date, and a vacancy that ended before it was observed is
      something for them to correct, not for the server to quietly round.
    */
    if (input.endedAt && input.endedAt < standing.observedAt) {
      throw new ValidationError(
        `التاريخ قبل تاريخ تأكيد الشغور (${standing.observedAt.toISOString().slice(0, 10)})`,
        { endedAt: input.endedAt },
      );
    }

    const [vacancy, updated] = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const closed = await closeActiveVacancy(tx, {
        unitId,
        unit,
        reason: input.reason,
        endedAt: input.endedAt,
        notes: input.notes,
        actorId: actor.id,
      });
      // Nothing can have closed it in between — the read above and this write
      // are in the same request — but the helper is the only thing that knows
      // how, so its null is handled rather than asserted away.
      if (!closed) throw new ConflictError(`لا يوجد تأكيد شغور قائم على الوحدة ${unit.unitCode}`);

      const unitRow =
        Object.keys(closed.restore).length > 0
          ? await tx.unit.update({
              where: { id: unitId },
              data: {
                ...(closed.restore.unitStatus !== undefined
                  ? { unitStatus: closed.restore.unitStatus as never }
                  : {}),
                ...(closed.restore.surveyStatus !== undefined
                  ? { surveyStatus: closed.restore.surveyStatus as never }
                  : {}),
              },
            })
          : unit;

      const withNames = await tx.unitVacancyConfirmation.findUniqueOrThrow({
        where: { id: closed.confirmation!.id },
        include: {
          confirmedBy: { select: { firstName: true, lastName: true } },
          endedBy: { select: { firstName: true, lastName: true } },
        },
      });

      return [withNames, unitRow] as const;
    });

    this.buildings.record({
      action: 'UNIT_VACANCY_ENDED',
      buildingId: unit.buildingId,
      before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        vacancyId: vacancy.id,
        reason: input.reason,
        endedAt: vacancy.endedAt,
        unitStatus: updated.unitStatus,
        surveyStatus: updated.surveyStatus,
      },
      actor,
    });

    /*
      An owner's «شاغرة» left on their card would outlive the vacancy it stood
      for: billing reads the card while the unit has no answer, so the owner
      stayed exempt after an officer found the flat lived in, and the next save
      of their file could re-open the vacancy. The officer's finding is the
      newer one, so the card's «شاغرة» goes with it — audited on the owner's
      file like any edit of it.
    */
    await this.withdrawOwnerVacancyStatements(unitId, unit.unitCode, actor);

    /*
      «سُجِّل بالخطأ» restores the status the vacancy replaced — which, after a
      tenancy ended into it, can be the «مؤجرة» of a tenant who has gone. The
      rule puts a let flat with nobody in it to review instead of billing nobody.
    */
    const { statusChanged } = await this.buildings.settle(unitId, actor, 'VACANCY_ENDED');
    const settled = statusChanged ? await this.db.unit.findUnique({ where: { id: unitId } }) : null;

    return { vacancy: toVacancyRow(vacancy), unit: toUnitRow(settled ?? updated) };
  }

  // ──────────────────────────────  Visits  ──────────────────────────────

  /**
   * Logs one attempt, and moves the unit to what the attempt found.
   *
   * Two facts recorded by one action, deliberately. An officer who has just
   * stood at a door knows both — that they went, and what happened — and asking
   * them to say it twice is how the two drift apart: a unit reading «مكتملة»
   * with no visit behind it, or three visits under a status nobody updated.
   *
   * The status is *set*, not merged, and that is the difference from
   * `recordOccupancy`'s narrow lift. This is not a side effect of some other
   * action — it is an officer stating a finding directly, and a finding
   * replaces the previous one. `NOT_SURVEYED` is refused by the schema, so the
   * one thing this cannot do is walk a unit backwards to "nobody has been".
   */
  async logVisit(
    input: LogVisitInput,
    actor: { id: string; role: string },
  ): Promise<{ visit: VisitRow; visitCount: number; vacancyStands: boolean }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, buildingId: true, unitCode: true, surveyStatus: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    /*
      The same officer, the same door, the same day, the same finding: asked,
      not refused.

      Each part rules out an ordinary sequence. Logged by this officer in the
      last twelve hours, so a colleague's knock is not it. Dated within a day
      of this one, so three back-dated paper visits a week apart are not it.
      The same outcome, so «لا يوجد رد» in the morning and «مكتملة» in the
      evening — a real second finding — is not it. What is left is the double
      submit of one knock: 2026-09-15, one closed shop, «مغلق» twice, a case
      each time.
    */
    if (!input.acknowledgedRepeat) {
      const claimedAt = (input.visitedAt ?? new Date()).getTime();
      const recent = (
        await this.db.unitVisit.findMany({
          where: {
            unitId: input.unitId,
            officerId: actor.id,
            outcome: input.outcome as never,
            createdAt: { gte: new Date(Date.now() - REPEAT_VISIT_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, visitedAt: true, outcome: true },
        })
      ).find((visit) => Math.abs(visit.visitedAt.getTime() - claimedAt) < SAME_VISIT_DAY_MS);
      if (recent) {
        const minutesAgo = Math.max(0, Math.round((Date.now() - recent.createdAt.getTime()) / 60_000));
        throw new ConflictError(
          `سجَّلتَ زيارة بالنتيجة نفسها لهذه الوحدة قبل ${
            minutesAgo === 1
              ? 'دقيقة واحدة'
              : minutesAgo === 2
                ? 'دقيقتين'
                : minutesAgo >= 3 && minutesAgo <= 10
                  ? `${minutesAgo} دقائق`
                  : `${minutesAgo} دقيقة`
          }. إن كانت هذه محاولة جديدة فأكِّد ذلك قبل التسجيل.`,
          {
            repeatVisit: {
              unitId: input.unitId,
              loggedAt: recent.createdAt.toISOString(),
              outcome: recent.outcome,
              minutesAgo,
            },
          },
        );
      }
    }

    /*
      A visit to a flat whose vacancy is standing is logged, and leaves the
      finding alone.

      The status is otherwise *set* by the outcome, which is right for a finding
      an officer states directly — but a confirmed vacancy is a finding too, and
      one with a record behind it and an exemption resting on it. Letting an
      ordinary «زيارة بلا رد» walk the unit out of `VACANT_CONFIRMED` would
      leave the confirmation standing with the unit no longer reading as empty:
      the register saying two things, which is what the confirmation table was
      added to stop. A locked door on an empty flat is also not news.

      The visit itself is always recorded — it happened, and D10's count is what
      dispatch reads — and the caller is told the vacancy still stands so the
      officer can lift it if what they found says otherwise.
    */
    const standing = await activeVacancy(this.db, input.unitId);

    const [visit, visitCount] = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const created = await tx.unitVisit.create({
        data: {
          unitId: input.unitId,
          officerId: actor.id,
          outcome: input.outcome as never,
          ...(input.visitedAt ? { visitedAt: input.visitedAt } : {}),
          notes: input.notes?.trim() || null,
        },
        include: { officer: { select: { firstName: true, lastName: true } } },
      });

      if (!standing) {
        await tx.unit.update({
          where: { id: input.unitId },
          data: { surveyStatus: input.outcome as never },
        });
      }

      return [created, await tx.unitVisit.count({ where: { unitId: input.unitId } })] as const;
    });

    this.buildings.record({
      action: 'UNIT_VISIT_LOGGED',
      buildingId: unit.buildingId,
      before: { surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        outcome: input.outcome,
        attempts: visitCount,
        // Named in the audit row because the outcome and the unit's status
        // disagree in this case, and the reason has to be readable later.
        ...(standing ? { vacancyStands: true } : {}),
        ...(input.acknowledgedRepeat ? { acknowledgedRepeat: true } : {}),
      },
      actor,
    });

    return { visit: toVisitRow(visit), visitCount, vacancyStands: standing !== null };
  }

  /** Every attempt on one unit, newest first. The panel behind «٣ محاولات». */
  async visits(unitId: string): Promise<VisitRow[]> {
    const rows = await withConnectionRetry(() =>
      this.db.unitVisit.findMany({
        where: { unitId },
        orderBy: [{ visitedAt: 'desc' }, { createdAt: 'desc' }],
        include: { officer: { select: { firstName: true, lastName: true } } },
      }),
    );
    return rows.map(toVisitRow);
  }
}
