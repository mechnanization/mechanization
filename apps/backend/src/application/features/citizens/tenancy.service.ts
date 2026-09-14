import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  isDwellingUnitType,
  statusForFlags,
  type AfterTenancyStatus,
  type FieldFlag,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { ConflictError, NotFoundError, ValidationError } from '../../../domain/errors/domain-error';
import { BuildingsService } from '../buildings/buildings.service';
import { CasesService } from '../cases/cases.service';
import { withoutCardFlags } from './card-flags';
import { LandlordLinkService, type PendingEvent, type RevertReport } from './landlord-link.service';

/**
 * «إنهاء الإيجار» — one operation, whichever door it is reached through.
 *
 * ## What was wrong
 *
 * The unit matrix's «إنهاء الإشغال» ended the tenant's spell and cleared the
 * hidden link from their card's row to the flat, and stopped there. The card —
 * building, flat, owner, lease — stayed on the tenant's file reading as current,
 * and a row with no flat link still bills from its own floor and area, so the
 * ex-tenant kept being charged for a flat they had left. The flat kept
 * «مؤجرة», so its owner stayed exempt from the occupancy fee with nobody in it.
 * And the only other way to record a departure — removing the card in the edit
 * form — deleted the lease with it and, through the owner link, erased the
 * owner's ownership as though it had been a mistake.
 *
 * ## What ending a tenancy does now, in one transaction
 *
 *  1. The tenant's spell on each flat ends, dated, with its reason.
 *  2. The card's row for each flat ends — kept, still naming the flat — and the
 *     card itself ends once nothing on it is current. An ended card is history:
 *     it bills nothing, the census ignores it, and its documents stay.
 *  3. The owner link on the card follows the reason: a tenant who **left** leaves
 *     the owner exactly as they were — what the link recorded becomes the owner's
 *     own — and a tenancy **recorded in error** reverts what it supported. See
 *     `LandlordLinkService.detachUnits`.
 *  4. The flat's status is what the officer says it is now, not «مؤجرة» by
 *     default — see `AFTER_TENANCY_STATUS` — whenever nobody else is still
 *     recorded living there.
 *
 * ## Why the matrix, the file and the edit form all come here
 *
 * Three doors onto one fact is how the census and the file stopped agreeing in
 * the first place. Each of them resolves what it was pointed at — a spell, or a
 * card and some of its flats — into the same `Target`, and this is the only
 * code that writes a tenancy's end.
 */
@Injectable()
export class TenancyService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly buildings: BuildingsService,
    private readonly cases: CasesService,
    private readonly links: LandlordLinkService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  // ─────────────────────────────  Entry points  ─────────────────────────────

  /**
   * The matrix's «إنهاء الإشغال». An owner's spell is not a tenancy — a sale or
   * a correction of who owns the flat — and keeps its own path.
   */
  async endOccupancy(
    occupancyId: string,
    input: EndInput & { reason: string },
    actor: Actor,
  ): Promise<EndTenancyResult | { ownerSpellEnded: true }> {
    const occupancy = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      select: { role: true },
    });
    if (!occupancy) throw new NotFoundError('سجل الإشغال غير موجود');

    if (occupancy.role === 'OWNER') {
      await this.buildings.endOccupancy(
        occupancyId,
        { toDate: input.endedAt, reason: input.reason },
        actor,
      );
      return { ownerSpellEnded: true };
    }

    if (input.reason !== 'MOVED_OUT' && input.reason !== 'RECORDED_IN_ERROR') {
      throw new ValidationError(
        'إنهاء إشغال مستأجر أو شاغل يكون بخروجه من الوحدة، أو لأنه سُجِّل بالخطأ',
        { reason: input.reason },
      );
    }

    const target = await this.targetFromOccupancy(occupancyId);
    return this.end(target, { ...input, reason: input.reason }, actor);
  }

  /** «إنهاء الإيجار» on a card — from the tenant's file or their edit form. */
  async endCard(
    propertyEntryId: string,
    input: EndInput & { reason: EndReason; unitIds?: readonly string[] },
    actor: Actor,
  ): Promise<EndTenancyResult> {
    const target = await this.targetFromCard(propertyEntryId, input.unitIds);
    return this.end(target, input, actor);
  }

  /**
   * What ending this card would touch, for the dialog to ask the right
   * questions before anything is pressed: which flats, whether each still has
   * somebody else in it (then its status is not asked), who owns it, and
   * whether a link names the landlord.
   */
  async previewCard(propertyEntryId: string): Promise<TenancyPreview> {
    const target = await this.targetFromCard(propertyEntryId);
    const card = target.cards[0]!;
    const landlord = card.landlordCitizenId
      ? await this.db.user.findUnique({
          where: { id: card.landlordCitizenId },
          select: { firstName: true, middleName: true, lastName: true },
        })
      : null;

    return {
      tenant: { id: target.citizenId, name: target.citizenName },
      occupancyType: card.occupancyType,
      landlordName: landlord ? fullName(landlord) : null,
      startedAt: target.startedAt?.toISOString() ?? null,
      units: target.units.map((unit) => ({
        unitId: unit.unitId,
        unitCode: unit.unitCode,
        needsStatus: !unit.othersRemain,
        othersRemain: unit.othersRemain,
        ownerNames: unit.ownerNames,
        ownerNonResident: unit.ownerNonResident,
        dwelling: unit.dwelling,
      })),
    };
  }

  // ─────────────────────────────  Resolving  ─────────────────────────────

  private async targetFromOccupancy(occupancyId: string): Promise<Target> {
    const occupancy = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      select: {
        id: true,
        citizenId: true,
        toDate: true,
        unit: { select: { id: true, buildingId: true } },
      },
    });
    if (!occupancy) throw new NotFoundError('سجل الإشغال غير موجود');
    if (occupancy.toDate) throw new ConflictError('هذا الإشغال منتهٍ مسبقاً');

    const unitsInBuilding = await this.db.unit.count({
      where: { buildingId: occupancy.unit.buildingId },
    });

    /*
      The tenant's current cards that claim this flat, in either shape the census
      reads a claim from: a row naming it, or a منزل on its one-unit structure.
    */
    const cards = await this.db.propertyEntry.findMany({
      where: {
        endedAt: null,
        occupancyType: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
        registration: { citizenId: occupancy.citizenId },
        OR: [
          { units: { some: { unitId: occupancy.unit.id, endedAt: null } } },
          ...(unitsInBuilding === 1
            ? [{ buildingId: occupancy.unit.buildingId, propertyType: 'HOUSE' as never }]
            : []),
        ],
      },
      select: CARD_SELECT,
      orderBy: { createdAt: 'asc' },
    });

    return this.describe({
      citizenId: occupancy.citizenId,
      unitIds: [occupancy.unit.id],
      cards: cards.map((card) => ({
        ...card,
        endingRowIds: card.units
          .filter((row) => row.unitId === occupancy.unit.id)
          .map((row) => row.id),
      })),
    });
  }

  private async targetFromCard(
    propertyEntryId: string,
    requested?: readonly string[],
  ): Promise<Target> {
    const card = await this.db.propertyEntry.findUnique({
      where: { id: propertyEntryId },
      select: { ...CARD_SELECT, endedAt: true, registration: { select: { citizenId: true } } },
    });
    if (!card) throw new NotFoundError('بطاقة العقار غير موجودة');
    if (card.endedAt) throw new ConflictError('انتهى هذا الإيجار مسبقاً');
    if (card.occupancyType === 'OWNER') {
      throw new ValidationError('هذه بطاقة مالك — لا إيجار فيها لإنهائه', { propertyEntryId });
    }

    const named = new Set(card.units.map((row) => row.unitId).filter((id): id is string => Boolean(id)));
    if (requested && requested.some((unitId) => !named.has(unitId))) {
      throw new ValidationError('إحدى الوحدات المحددة ليست على هذه البطاقة', { unitIds: requested });
    }

    const endingRows = requested?.length
      ? card.units.filter((row) => row.unitId && requested.includes(row.unitId))
      : card.units;
    let unitIds = [...new Set(endingRows.map((row) => row.unitId).filter((id): id is string => Boolean(id)))];

    /*
      A منزل names no flat — it has nothing to tick — so its one unit is the one
      the census inferred, on the same condition.
    */
    if (unitIds.length === 0 && card.units.length === 0 && card.buildingId) {
      const units = await this.db.unit.findMany({
        where: { buildingId: card.buildingId },
        select: { id: true },
        take: 2,
      });
      if (units.length === 1) unitIds = [units[0]!.id];
    }

    return this.describe({
      citizenId: card.registration.citizenId,
      unitIds,
      cards: [{ ...card, endingRowIds: endingRows.map((row) => row.id) }],
    });
  }

  /** The facts every question in the dialog, and every check below, needs. */
  private async describe(input: {
    citizenId: string;
    unitIds: string[];
    cards: Array<TargetCard>;
  }): Promise<Target> {
    const [citizen, units, spells, others, owners] = await Promise.all([
      this.db.user.findUnique({
        where: { id: input.citizenId },
        select: { firstName: true, middleName: true, lastName: true },
      }),
      input.unitIds.length
        ? this.db.unit.findMany({
            where: { id: { in: input.unitIds } },
            select: { id: true, unitCode: true, buildingId: true, unitType: true, unitStatus: true },
          })
        : Promise.resolve([]),
      input.unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: {
              citizenId: input.citizenId,
              unitId: { in: input.unitIds },
              toDate: null,
              role: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
            },
            select: { id: true, unitId: true, fromDate: true },
          })
        : Promise.resolve([]),
      input.unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: {
              unitId: { in: input.unitIds },
              citizenId: { not: input.citizenId },
              toDate: null,
              role: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
            },
            select: { unitId: true },
          })
        : Promise.resolve([]),
      input.unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: { unitId: { in: input.unitIds }, toDate: null, role: 'OWNER' as never },
            select: {
              unitId: true,
              citizen: { select: { firstName: true, middleName: true, lastName: true, residence: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const starts = spells.map((spell) => spell.fromDate.getTime());
    return {
      citizenId: input.citizenId,
      citizenName: citizen ? fullName(citizen) : '',
      startedAt: starts.length ? new Date(Math.max(...starts)) : null,
      cards: input.cards,
      spells,
      units: units.map((unit) => {
        const unitOwners = owners.filter((row) => row.unitId === unit.id);
        return {
          unitId: unit.id,
          unitCode: unit.unitCode,
          buildingId: unit.buildingId,
          unitStatus: unit.unitStatus,
          dwelling: isDwellingUnitType(unit.unitType),
          othersRemain: others.some((row) => row.unitId === unit.id),
          ownerNames: unitOwners.map((row) => fullName(row.citizen)),
          ownerNonResident:
            unitOwners.length > 0 &&
            unitOwners.every((row) => row.citizen.residence === 'NON_RESIDENT_OWNER'),
        };
      }),
    };
  }

  // ─────────────────────────────  Ending  ─────────────────────────────

  private async end(
    target: Target,
    input: EndInput & { reason: EndReason },
    actor: Actor,
  ): Promise<EndTenancyResult> {
    if (target.cards.length === 0 && target.spells.length === 0) {
      throw new ConflictError('لا يوجد إيجار قائم لإنهائه');
    }

    /*
      A tenancy recorded in error never happened, so it has no departure date:
      it is closed as of now, the way `endOccupancy` closes one.
    */
    const endedAt = input.reason === 'RECORDED_IN_ERROR' ? new Date() : (input.endedAt ?? new Date());
    if (input.reason === 'MOVED_OUT' && target.startedAt && endedAt < target.startedAt) {
      // Compared by day: a spell recorded this afternoon may end today.
      if (endedAt.toISOString().slice(0, 10) < target.startedAt.toISOString().slice(0, 10)) {
        throw new ValidationError('تاريخ الانتهاء قبل بدء الإشغال', { endedAt });
      }
    }

    const freed = target.units.filter((unit) => !unit.othersRemain);
    if (freed.length > 0 && !input.afterStatus) {
      throw new ValidationError('حدِّد حالة الوحدة بعد خروج الشاغل', {
        needsStatus: true,
        unitCodes: freed.map((unit) => unit.unitCode),
      });
    }
    if (input.afterStatus === 'VACANT' && !input.vacancyBasis) {
      throw new ValidationError('على ماذا يستند الشغور؟', { vacancyBasis: null });
    }
    if (input.afterStatus === 'OWNER_OCCUPIED') {
      const refused = freed.find((unit) => unit.ownerNonResident && unit.dwelling);
      if (refused) {
        throw new ValidationError(
          `مالك الوحدة ${refused.unitCode} غير مقيم في البلدة، فلا يُسجَّل أنه يسكنها — اختر «شاغرة» أو «لا أعرف»`,
          { unitCode: refused.unitCode },
        );
      }
    }

    const events: PendingEvent[] = [];
    const result: EndTenancyResult = {
      occupanciesEnded: 0,
      rowsEnded: 0,
      cardsEnded: 0,
      statusApplied: input.afterStatus && freed.length > 0 ? input.afterStatus : null,
      casesOpened: 0,
      vacanciesConfirmed: 0,
      link: [],
    };
    const droppedFlags: Array<Record<string, unknown>> = [];

    await this.inTransaction(async () => {
      // 1 — the spells.
      for (const spell of target.spells) {
        const ended = await this.db.unitOccupancy.updateMany({
          where: { id: spell.id, toDate: null },
          data: { toDate: endedAt, endReason: input.reason as never },
        });
        if (ended.count === 0) throw new ConflictError('تغيّر هذا الإشغال للتو — حدّث الصفحة');
        result.occupanciesEnded += 1;
        const unit = target.units.find((row) => row.unitId === spell.unitId);
        events.push({
          name: 'building.changed',
          payload: {
            action: 'OCCUPANCY_ENDED',
            buildingId: unit?.buildingId,
            before: { unitCode: unit?.unitCode, citizenId: target.citizenId },
            after: { occupancyId: spell.id, reason: input.reason, toDate: endedAt, via: 'TENANCY_ENDED' },
          },
        });
      }

      // 2 and 3 — the rows, the cards, and each card's owner link.
      for (const card of target.cards) {
        if (card.endingRowIds.length > 0) {
          const rows = await this.db.buildingUnit.updateMany({
            where: { id: { in: card.endingRowIds }, endedAt: null },
            data: { endedAt, endReason: input.reason as never },
          });
          result.rowsEnded += rows.count;
        }

        const current = await this.db.buildingUnit.count({
          where: { propertyEntryId: card.id, endedAt: null },
        });
        const cardEnded = current === 0;

        const data: Record<string, unknown> = {};
        if (cardEnded) {
          data.endedAt = endedAt;
          data.endReason = input.reason;
        }

        if (card.landlordCitizenId) {
          const endingUnitIds = cardEnded
            ? target.units.map((unit) => unit.unitId)
            : card.units
                .filter((row) => card.endingRowIds.includes(row.id) && row.unitId)
                .map((row) => row.unitId!);
          const detached = await this.links.detachUnits(this.db, {
            entryId: card.id,
            ownerId: card.landlordCitizenId,
            footprint: card.landlordLinkFootprint,
            unitIds: endingUnitIds,
            cardEnded,
            mode: input.reason === 'MOVED_OUT' ? 'KEEP' : 'REVERT',
          });
          Object.assign(data, detached.data);
          events.push(...detached.events);
          result.link.push({
            propertyEntryId: card.id,
            ownerId: card.landlordCitizenId,
            kept: input.reason === 'MOVED_OUT',
            report: detached.report,
          });
        }

        if (cardEnded) {
          /*
            The card leaves the list flags are counted in, so its own flags go
            with it — into the audit row, not into nothing — and later cards'
            flags move down a place.
          */
          const registration = await this.db.registration.findUnique({
            where: { id: card.registrationId },
            select: {
              flaggedFields: true,
              properties: { where: { endedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } },
            },
          });
          const index = registration?.properties.findIndex((row) => row.id === card.id) ?? -1;
          const shifted = withoutCardFlags(registration?.flaggedFields, index);
          if (shifted.changed) {
            await this.db.registration.update({
              where: { id: card.registrationId },
              data: {
                flaggedFields: shifted.flags as never,
                status: statusForFlags(shifted.flags as unknown as FieldFlag[]) as never,
              },
            });
            droppedFlags.push(...shifted.removed);
          }
          result.cardsEnded += 1;
        }

        if (Object.keys(data).length > 0) {
          await this.db.propertyEntry.update({ where: { id: card.id }, data: data as never });
        }
      }

      // 4 — what each flat nobody else lives in is now.
      for (const unit of freed) {
        await this.applyAfterStatus(unit, target, input, endedAt, actor, result, events);
      }
    });

    this.links.emitAll(events, actor);
    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: target.citizenId,
      action: 'TENANCY_ENDED',
      after: {
        reason: input.reason,
        endedAt,
        unitCodes: target.units.map((unit) => unit.unitCode),
        cardIds: target.cards.map((card) => card.id),
        afterStatus: result.statusApplied,
        occupanciesEnded: result.occupanciesEnded,
        cardsEnded: result.cardsEnded,
        ...(droppedFlags.length > 0 ? { flagsOnEndedCards: droppedFlags } : {}),
      },
      actorId: actor.id,
      actorRole: actor.role,
    });
    for (const link of result.link) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: link.ownerId,
        action: link.kept ? 'LANDLORD_TENANCY_ENDED' : 'LANDLORD_LINK_REVERTED',
        after: { propertyEntryId: link.propertyEntryId, tenantId: target.citizenId, reason: input.reason },
        actorId: actor.id,
        actorRole: actor.role,
      });
    }

    return result;
  }

  /**
   * Writes the flat's new status everywhere billing reads one: the unit itself,
   * and the owner's own card where it states the flat's حالة — a row naming the
   * flat, or a منزل on its one-unit structure, which bills from its own column.
   * Only a status the tenancy implied («مؤجرة» / «مشغولة بتسامح», or nothing) is
   * replaced; anything else is somebody's finding and is left for a person.
   */
  private async applyAfterStatus(
    unit: TargetUnit,
    target: Target,
    input: EndInput,
    endedAt: Date,
    actor: Actor,
    result: EndTenancyResult,
    events: PendingEvent[],
  ): Promise<void> {
    const implied = { in: ['RENTED', 'FREE_OCCUPIED'] as never };
    const replaceable = { OR: [{ unitStatus: null }, { unitStatus: implied }] };
    const singleUnit =
      (await this.db.unit.count({ where: { buildingId: unit.buildingId } })) === 1;

    const setOwnerCards = async (status: string | null, includeRows: boolean) => {
      if (includeRows) {
        await this.db.buildingUnit.updateMany({
          where: {
            unitId: unit.unitId,
            endedAt: null,
            propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
            ...replaceable,
          },
          data: { unitStatus: status as never },
        });
      }
      if (singleUnit) {
        await this.db.propertyEntry.updateMany({
          where: {
            buildingId: unit.buildingId,
            propertyType: 'HOUSE' as never,
            occupancyType: 'OWNER' as never,
            endedAt: null,
            ...replaceable,
          },
          data: { unitStatus: status as never },
        });
      }
    };

    const building = await this.db.building.findUnique({
      where: { id: unit.buildingId },
      select: { parcelNumber: true },
    });
    const tenantName = target.citizenName || 'الشاغل';

    switch (input.afterStatus) {
      case 'OWNER_OCCUPIED': {
        await this.db.unit.update({
          where: { id: unit.unitId },
          data: { unitStatus: 'OWNER_OCCUPIED' },
        });
        await setOwnerCards('OWNER_OCCUPIED', true);
        break;
      }
      case 'VACANT': {
        /*
          Through `confirmVacancy`, not a status write: a vacancy exempts the
          owner, so it is a recorded finding with what it rests on, and it can be
          lifted again. It runs inside this transaction.
        */
        await this.buildings.confirmVacancy(
          unit.unitId,
          {
            basis: input.vacancyBasis as never,
            observedAt: endedAt,
            notes: input.vacancyNotes?.trim() || `خرج ${tenantName} من الوحدة`,
          },
          actor,
        );
        // A منزل bills from its own column; the unit's «شاغرة» never reaches it.
        await setOwnerCards('VACANT', false);
        result.vacanciesConfirmed += 1;
        break;
      }
      case 'RENTED_TO_OTHER': {
        await this.db.unit.updateMany({
          where: { id: unit.unitId, ...replaceable },
          data: { unitStatus: 'RENTED' },
        });
        await setOwnerCards('RENTED', true);
        await this.cases.create(
          {
            notes: `خرج ${tenantName} من الوحدة ${unit.unitCode}، ويسكنها مستأجر آخر غير مسجَّل — سجِّله على الوحدة.`,
            caseType: 'GENERAL_NOTE',
            buildingId: unit.buildingId,
            unitId: unit.unitId,
            propertyNumber: building?.parcelNumber ?? undefined,
          } as never,
          actor,
        );
        result.casesOpened += 1;
        break;
      }
      case 'UNKNOWN': {
        /*
          Cleared, not guessed. With no حالة the owner is billed the occupancy
          fee — a unit is presumed occupied until a vacancy is recorded — and the
          case sends somebody to find out, which a confirmed vacancy then closes.
        */
        await this.db.unit.updateMany({
          where: { id: unit.unitId, unitStatus: implied },
          data: { unitStatus: null },
        });
        await this.db.buildingUnit.updateMany({
          where: {
            unitId: unit.unitId,
            endedAt: null,
            unitStatus: implied,
            propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
          },
          data: { unitStatus: null },
        });
        if (singleUnit) {
          await this.db.propertyEntry.updateMany({
            where: {
              buildingId: unit.buildingId,
              propertyType: 'HOUSE' as never,
              occupancyType: 'OWNER' as never,
              endedAt: null,
              unitStatus: implied,
            },
            data: { unitStatus: null },
          });
        }
        await this.cases.create(
          {
            notes: `خرج ${tenantName} من الوحدة ${unit.unitCode} ولم تُعرف حالتها بعده — تحقّق: شاغرة أم يسكنها أحد.`,
            caseType: 'VACANT_UNCONFIRMED',
            buildingId: unit.buildingId,
            unitId: unit.unitId,
            propertyNumber: building?.parcelNumber ?? undefined,
          } as never,
          actor,
        );
        result.casesOpened += 1;
        break;
      }
      default:
        break;
    }

    events.push({
      name: 'building.changed',
      payload: {
        action: 'UNIT_STATUS_AFTER_TENANCY',
        buildingId: unit.buildingId,
        before: { unitCode: unit.unitCode, unitStatus: unit.unitStatus },
        after: { afterStatus: input.afterStatus, tenantId: target.citizenId },
      },
    });
  }

  /** See `runInTenantTransaction` — every service joins it; audit rows follow the commit. */
  private inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return runInTenantTransaction(this.tenantContext, work);
  }
}

const CARD_SELECT = {
  id: true,
  registrationId: true,
  occupancyType: true,
  propertyType: true,
  buildingId: true,
  landlordCitizenId: true,
  landlordLinkFootprint: true,
  units: { where: { endedAt: null }, select: { id: true, unitId: true } },
} as const;

type Actor = { id: string; role: string };
type EndReason = 'MOVED_OUT' | 'RECORDED_IN_ERROR';

interface EndInput {
  endedAt?: Date;
  afterStatus?: AfterTenancyStatus;
  vacancyBasis?: string;
  vacancyNotes?: string;
}

interface TargetCard {
  id: string;
  registrationId: string;
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  landlordCitizenId: string | null;
  landlordLinkFootprint: Prisma.JsonValue;
  units: Array<{ id: string; unitId: string | null }>;
  /** The current rows on this card the tenancy is giving up. */
  endingRowIds: string[];
}

interface TargetUnit {
  unitId: string;
  unitCode: string;
  buildingId: string;
  unitStatus: string | null;
  dwelling: boolean;
  /** Somebody else is still recorded living in it — its status is not asked. */
  othersRemain: boolean;
  ownerNames: string[];
  ownerNonResident: boolean;
}

interface Target {
  citizenId: string;
  citizenName: string;
  /** The latest start among the spells being ended — an end cannot precede it. */
  startedAt: Date | null;
  cards: TargetCard[];
  spells: Array<{ id: string; unitId: string; fromDate: Date }>;
  units: TargetUnit[];
}

export interface EndTenancyResult {
  occupanciesEnded: number;
  rowsEnded: number;
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  casesOpened: number;
  vacanciesConfirmed: number;
  link: Array<{
    propertyEntryId: string;
    ownerId: string;
    /** True when the owner's records were kept (the tenant left). */
    kept: boolean;
    report: RevertReport | null;
  }>;
}

export interface TenancyPreview {
  tenant: { id: string; name: string };
  occupancyType: string;
  landlordName: string | null;
  startedAt: string | null;
  units: Array<{
    unitId: string;
    unitCode: string;
    needsStatus: boolean;
    othersRemain: boolean;
    ownerNames: string[];
    ownerNonResident: boolean;
    dwelling: boolean;
  }>;
}

function fullName(person: { firstName: string; middleName?: string | null; lastName: string }): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
}
