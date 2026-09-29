import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isDwellingUnitType, statusForFlags, type AfterTenancyStatus, type FieldFlag } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { ConflictError, NotFoundError, ValidationError } from '../../../domain/errors/domain-error';
import { assertNotMergedAway } from './merged-away';
import { claimsFlat } from '../../../domain/entities/census-claim';
import { BuildingsService } from '../buildings/buildings.service';
import { CasesService } from '../cases/cases.service';
import { withoutCardFlags, withoutRowFlags } from './card-flags';
import { LandlordLinkService, type PendingEvent, type SaleRelease } from './landlord-link.service';
import type { TenancyService } from './tenancy.service';

/**
 * «إنهاء الملكية» — an owner no longer holds a property, or never did.
 *
 * ## What was wrong
 *
 * An owner's spell ended on the unit matrix went through
 * `BuildingsService.endOccupancy`, which closed the spell and *unlinked* the
 * flat from the owner's card — `building_units.unitId = NULL` — and stopped
 * there. The card and its row stayed current, and a row with no flat link
 * still bills from its own area: a sale recorded on the matrix went on billing
 * the seller. And the only way to record a sale from the file was deleting the
 * card, which erased that they had ever owned it.
 *
 * ## What ending an ownership does now, in one transaction
 *
 *  1. The owner's spell on each flat ends, dated, with its reason.
 *  2. The card's row for each flat ends — kept, still naming the flat — and the
 *     card itself ends once nothing on it is current. An ended card is history:
 *     it bills nothing, and it stays on the seller's file.
 *  3. On a sale, tenants' links to the seller for those flats are released
 *     (`LandlordLinkService.releaseForSale`), so no later save puts the seller
 *     back; a case asks for the tenant to be linked to the new owner.
 *  4. The buyer, when already registered, is recorded owner of the same flats
 *     from the day of the sale. When not, a case asks for them to be recorded.
 *     A buyer who already co-owns a flat keeps that ownership as it was. A
 *     buyer who rents it has that tenancy ended on the day of the sale — a
 *     real ending, kept as history — and is recorded owner living there.
 *  5. A flat the seller lived in, with no other owner left, gets the status the
 *     officer gives it now — the same question «إنهاء الإيجار» asks.
 *
 * A correction («سُجِّلت بالخطأ») does 1 and 2 only, dated now, and is refused
 * while a tenant's link names this person as the landlord of those flats: the
 * link is the tenant's record, and undoing it is «إلغاء الربط» on their card.
 *
 * ## The doors
 *
 * The citizen's file (`endCard`) and the unit matrix (`endOccupancy`, reached
 * through `TenancyService.endOccupancy` for an owner's spell) both resolve what
 * they point at into the same `Target`, and this is the only code that writes
 * an ownership's end — the rule `TenancyService` states for tenancies.
 */
@Injectable()
export class OwnershipService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly buildings: BuildingsService,
    private readonly cases: CasesService,
    private readonly links: LandlordLinkService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Ends the tenancy of a buyer who rented the flat. Handed over by
   * `TenancyService` itself: it already depends on this service for an owner's
   * spell, and a constructor dependency both ways would be a cycle.
   */
  private tenancy: Pick<TenancyService, 'endForPurchase'> | null = null;

  bindTenancy(tenancy: Pick<TenancyService, 'endForPurchase'>): void {
    this.tenancy = tenancy;
  }

  private get db() {
    return this.tenantContext.prisma;
  }

  // ─────────────────────────────  Entry points  ─────────────────────────────

  /** «إنهاء الملكية» from the owner's file or edit form. */
  async endCard(propertyEntryId: string, input: EndOwnershipCommand, actor: Actor): Promise<EndOwnershipResult> {
    const target = await this.targetFromCard(propertyEntryId, { rowIds: input.rowIds });
    return this.end(target, input, actor);
  }

  /** The matrix's end of an owner's spell. */
  async endOccupancy(occupancyId: string, input: EndOwnershipCommand, actor: Actor): Promise<EndOwnershipResult> {
    const target = await this.targetFromOccupancy(occupancyId);
    return this.end(target, input, actor);
  }

  /** What ending this card would touch — for the dialog to ask only what applies. */
  async previewCard(propertyEntryId: string): Promise<OwnershipPreview> {
    return this.preview(await this.targetFromCard(propertyEntryId, { everyRow: true }));
  }

  /** The same, for an owner's spell on the matrix. */
  async previewOccupancy(occupancyId: string): Promise<OwnershipPreview> {
    return this.preview(await this.targetFromOccupancy(occupancyId));
  }

  // ─────────────────────────────  Resolving  ─────────────────────────────

  private async targetFromCard(
    propertyEntryId: string,
    selection: { rowIds?: readonly string[]; everyRow?: boolean },
  ): Promise<Target> {
    const card = await this.db.propertyEntry.findUnique({
      where: { id: propertyEntryId },
      select: { ...CARD_SELECT, endedAt: true, registration: { select: { citizenId: true } } },
    });
    if (!card) throw new NotFoundError('بطاقة العقار غير موجودة');
    if (card.endedAt) throw new ConflictError('انتهت هذه الملكية مسبقاً');
    if (card.occupancyType !== 'OWNER') {
      throw new ValidationError('هذه ليست بطاقة مالك — لإنهاء إيجار أو إشغال استخدم «إنهاء الإيجار»', {
        propertyEntryId,
      });
    }

    let endingRows: typeof card.units;
    if (selection.rowIds?.length) {
      const current = new Set(card.units.map((row) => row.id));
      if (selection.rowIds.some((rowId) => !current.has(rowId))) {
        throw new ConflictError('إحدى الوحدات المحددة لم تعد قائمة على هذه البطاقة — حدّث الصفحة', {
          rowIds: selection.rowIds,
        });
      }
      endingRows = card.units.filter((row) => selection.rowIds!.includes(row.id));
    } else if (card.units.length > 1 && !selection.everyRow) {
      throw new ValidationError('لهذه البطاقة أكثر من وحدة — حدِّد الوحدات التي انتهت ملكيتها', {
        needsRows: true,
      });
    } else {
      endingRows = card.units;
    }

    let unitIds = unique(endingRows.map((row) => row.unitId));

    /*
      A card with no rows claims by inference. A منزل claims the one unit of a
      one-unit structure (`releaseCensusClaim`'s own condition); a مبنى card
      with no rows claims every flat of its structure, so ending it ends every
      spell the owner holds there. A أرض card claims no unit at all.
    */
    if (card.units.length === 0 && card.buildingId) {
      if (card.propertyType === 'HOUSE') {
        const units = await this.db.unit.findMany({
          where: { buildingId: card.buildingId },
          select: { id: true },
          take: 2,
        });
        if (units.length === 1) unitIds = [units[0]!.id];
      } else if (card.propertyType === 'BUILDING') {
        const spells = await this.db.unitOccupancy.findMany({
          where: {
            citizenId: card.registration.citizenId,
            role: 'OWNER' as never,
            toDate: null,
            unit: { buildingId: card.buildingId },
          },
          select: { unitId: true },
        });
        unitIds = unique(spells.map((spell) => spell.unitId));
      }
    }

    return this.describe({
      citizenId: card.registration.citizenId,
      unitIds,
      cards: [{ ...card, endingRowIds: endingRows.map((row) => row.id) }],
    });
  }

  private async targetFromOccupancy(occupancyId: string): Promise<Target> {
    const occupancy = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      select: {
        citizenId: true,
        role: true,
        toDate: true,
        unit: { select: { id: true, buildingId: true, unitCode: true } },
      },
    });
    if (!occupancy) throw new NotFoundError('سجل الإشغال غير موجود');
    if (occupancy.toDate) throw new ConflictError('هذه الملكية منتهية مسبقاً');
    if (occupancy.role !== 'OWNER') {
      throw new ValidationError('هذا الإشغال ليس ملكية — استخدم «إنهاء الإيجار»', { occupancyId });
    }

    // The owner's current cards on this structure, and which of them claim the flat.
    const [cards, spellsHere, unitsInBuilding] = await Promise.all([
      this.db.propertyEntry.findMany({
        where: {
          endedAt: null,
          occupancyType: 'OWNER' as never,
          registration: { citizenId: occupancy.citizenId },
          OR: [
            { units: { some: { unitId: occupancy.unit.id, endedAt: null } } },
            { buildingId: occupancy.unit.buildingId },
          ],
        },
        select: CARD_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      this.db.unitOccupancy.findMany({
        where: { citizenId: occupancy.citizenId, toDate: null, unit: { buildingId: occupancy.unit.buildingId } },
        select: { unitId: true, role: true },
      }),
      this.db.unit.count({ where: { buildingId: occupancy.unit.buildingId } }),
    ]);

    const claims = claimsFlat(cards, spellsHere, occupancy.unit.id);
    const claiming = cards.filter(claims);

    /*
      A مبنى card with no rows covers the whole structure without naming a flat.
      Ending one flat of it cannot be written on the card — there is no row to
      end — and the card would claim the flat back on the owner's next save. The
      officer is told how to say which flats the card holds, instead.
    */
    const wholeStructure = claiming.find(
      (card) => card.propertyType === 'BUILDING' && card.units.length === 0,
    );
    if (wholeStructure && unitsInBuilding > 1) {
      throw new ConflictError(
        `بطاقة هذا المالك تشمل المبنى كله دون تحديد وحداته، فلا يمكن إنهاء ملكية الوحدة ${occupancy.unit.unitCode} وحدها. حدِّد وحدات البطاقة من ملف المالك، أو أنهِ ملكية المبنى كله من هناك`,
        { propertyEntryId: wholeStructure.id, citizenId: occupancy.citizenId, code: 'CARD_COVERS_STRUCTURE' },
      );
    }

    return this.describe({
      citizenId: occupancy.citizenId,
      unitIds: [occupancy.unit.id],
      cards: claiming.map((card) => ({
        ...card,
        endingRowIds: card.units.filter((row) => row.unitId === occupancy.unit.id).map((row) => row.id),
      })),
    });
  }

  /** The facts every question in the dialog, and every check below, needs. */
  private async describe(input: { citizenId: string; unitIds: string[]; cards: TargetCard[] }): Promise<Target> {
    const unitIds = input.unitIds;
    const [owner, units, spells, otherOwners, occupants, tenantCards] = await Promise.all([
      this.db.user.findUnique({
        where: { id: input.citizenId },
        select: { firstName: true, middleName: true, lastName: true, residence: true },
      }),
      unitIds.length
        ? this.db.unit.findMany({
            where: { id: { in: unitIds } },
            select: {
              id: true,
              unitCode: true,
              unitType: true,
              unitStatus: true,
              buildingId: true,
              building: { select: { code: true, parcelNumber: true } },
            },
          })
        : Promise.resolve([]),
      unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: { citizenId: input.citizenId, unitId: { in: unitIds }, toDate: null, role: 'OWNER' as never },
            select: { id: true, unitId: true, fromDate: true },
          })
        : Promise.resolve([]),
      unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: { unitId: { in: unitIds }, citizenId: { not: input.citizenId }, toDate: null, role: 'OWNER' as never },
            select: {
              unitId: true,
              citizenId: true,
              citizen: { select: { firstName: true, middleName: true, lastName: true } },
            },
          })
        : Promise.resolve([]),
      // Who lives in these flats other than as owner — a buyer among them rents it (see `end`).
      unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: { unitId: { in: unitIds }, toDate: null, role: { not: 'OWNER' as never } },
            select: { unitId: true, citizenId: true },
          })
        : Promise.resolve([]),
      unitIds.length
        ? this.db.propertyEntry.findMany({
            where: {
              landlordCitizenId: input.citizenId,
              endedAt: null,
              occupancyType: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
              OR: [
                { units: { some: { unitId: { in: unitIds }, endedAt: null } } },
                { buildingId: { in: [...new Set(input.cards.map((card) => card.buildingId).filter(Boolean) as string[])] } },
              ],
            },
            select: {
              id: true,
              buildingId: true,
              units: { where: { endedAt: null }, select: { unitId: true } },
              registration: {
                select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } } },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    if (!owner) throw new NotFoundError('المالك غير موجود');

    /*
      حالة الوحدة as the seller's own card states it, where the unit has none —
      the order billing reads them in. «يسكنها المالك» or «مسكن موسمي» describe
      the *seller*, so after a sale they no longer describe anyone.
    */
    const cardStatus = (unitId: string): string | null => {
      for (const card of input.cards) {
        const row = card.units.find((line) => line.unitId === unitId);
        if (row?.unitStatus) return row.unitStatus;
        if (card.units.length === 0 && card.unitStatus) return card.unitStatus;
      }
      return null;
    };

    // A row names its flat; a card with none is the tenancy of its structure's flat.
    const tenantOn = (unitId: string, buildingId: string) =>
      tenantCards
        .filter((card) =>
          card.units.length > 0
            ? card.units.some((row) => row.unitId === unitId)
            : card.buildingId === buildingId,
        )
        .map((card) => ({
          citizenId: card.registration.citizen.id,
          name: fullName(card.registration.citizen),
          propertyEntryId: card.id,
        }));

    const starts = spells.map((spell) => spell.fromDate.getTime());
    return {
      citizenId: input.citizenId,
      citizenName: fullName(owner),
      ownerNonResident: owner.residence === 'NON_RESIDENT_OWNER',
      startedAt: starts.length ? new Date(Math.max(...starts)) : null,
      cards: input.cards,
      spells,
      units: units.map((unit) => {
        const status = unit.unitStatus ?? cardStatus(unit.id);
        const others = otherOwners.filter((row) => row.unitId === unit.id);
        return {
          unitId: unit.id,
          unitCode: unit.unitCode,
          buildingId: unit.buildingId,
          buildingCode: unit.building.code,
          parcelNumber: unit.building.parcelNumber,
          unitStatus: unit.unitStatus,
          dwelling: isDwellingUnitType(unit.unitType),
          otherOwners: others.map((row) => fullName(row.citizen)),
          otherOwnerIds: others.map((row) => row.citizenId),
          occupantIds: [
            ...new Set(occupants.filter((row) => row.unitId === unit.id).map((row) => row.citizenId)),
          ],
          ownerLivedThere: status === 'OWNER_OCCUPIED' || status === 'SEASONAL',
          linkedTenants: tenantOn(unit.id, unit.buildingId),
        };
      }),
    };
  }

  private preview(target: Target): OwnershipPreview {
    const card = target.cards[0];
    const unitView = (unit: TargetUnit) => ({
      unitId: unit.unitId,
      unitCode: unit.unitCode,
      buildingCode: unit.buildingCode,
      otherOwners: unit.otherOwners,
      otherOwnerIds: unit.otherOwnerIds,
      occupantIds: unit.occupantIds,
      ownerLivedThere: unit.ownerLivedThere,
      // Asked on a sale only: a flat still owned by somebody else keeps its status.
      needsStatus: unit.ownerLivedThere && unit.otherOwners.length === 0,
      dwelling: unit.dwelling,
      linkedTenants: unit.linkedTenants,
    });

    return {
      owner: { id: target.citizenId, name: target.citizenName, nonResident: target.ownerNonResident },
      propertyType: card?.propertyType ?? null,
      propertyNumber: card?.propertyNumber ?? target.units[0]?.parcelNumber ?? null,
      startedAt: target.startedAt?.toISOString() ?? null,
      units: target.units.map(unitView),
      rows: (card?.units ?? []).map((row) => {
        const unit = row.unitId ? target.units.find((entry) => entry.unitId === row.unitId) : undefined;
        return {
          rowId: row.id,
          unitId: row.unitId,
          unitCode: unit?.unitCode ?? null,
          unitType: row.unitType,
          floor: row.floor,
          unitArea: row.unitArea == null ? null : Number(row.unitArea),
          needsStatus: unit ? unit.ownerLivedThere && unit.otherOwners.length === 0 : false,
          otherOwners: unit?.otherOwners ?? [],
          linkedTenants: unit?.linkedTenants ?? [],
        };
      }),
    };
  }

  // ─────────────────────────────  Ending  ─────────────────────────────

  private async end(target: Target, input: EndOwnershipCommand, actor: Actor): Promise<EndOwnershipResult> {
    if (target.cards.length === 0 && target.spells.length === 0) {
      throw new ConflictError('لا توجد ملكية قائمة لإنهائها');
    }

    const sale = input.reason === 'OWNERSHIP_TRANSFERRED';
    /*
      Only the flats this ending actually touches: the chosen rows' flats, or
      the whole card's. A flat on the card the officer did not tick is not ending.
    */
    const endingUnitIds = new Set(target.spells.map((spell) => spell.unitId));
    for (const card of target.cards) {
      for (const row of card.units) {
        if (row.unitId && card.endingRowIds.includes(row.id)) endingUnitIds.add(row.unitId);
      }
    }
    const ending = target.units.filter((unit) => endingUnitIds.has(unit.unitId));

    // ── Checks, all before anything is written ──
    const tenants = ending.flatMap((unit) => unit.linkedTenants.map((tenant) => ({ ...tenant, unitCode: unit.unitCode })));
    if (!sale && tenants.length > 0) {
      const names = [...new Set(tenants.map((tenant) => tenant.name))];
      throw new ConflictError(
        `${names.join('، ')} ${names.length === 1 ? 'مربوط' : 'مربوطون'} بهذا الشخص مالكاً للوحدة. ألغِ الربط من ${names.length === 1 ? 'بطاقة المستأجر' : 'بطاقات المستأجرين'} أولاً، ثم صحّح الملكية`,
        { code: 'TENANTS_LINKED', linkedTenants: tenants },
      );
    }

    const endedAt = sale ? (input.endedAt ?? new Date()) : new Date();
    if (sale && target.startedAt && day(endedAt) < day(target.startedAt)) {
      throw new ValidationError(
        `تاريخ البيع قبل تسجيل الملكية (${day(target.startedAt)}) — اختر تاريخاً بعده`,
        { endedAt },
      );
    }

    if (input.newOwnerId) {
      if (!sale) throw new ValidationError('المالك الجديد يُسجَّل عند البيع فقط', { newOwnerId: input.newOwnerId });
      if (input.newOwnerId === target.citizenId) {
        throw new ValidationError('المالك الجديد هو نفسه المالك الحالي', { newOwnerId: input.newOwnerId });
      }
      const buyer = await this.db.user.findFirst({
        where: { id: input.newOwnerId, kind: 'CITIZEN' },
        select: { id: true },
      });
      if (!buyer) throw new ValidationError('المالك الجديد غير موجود في السجل', { newOwnerId: input.newOwnerId });
      await assertNotMergedAway(this.db, buyer.id);
    }

    /*
      Who lives in a flat the seller lived in is asked — unless the buyer rents
      it: then they live there, now as its owner, and that is the answer.
    */
    const buyerRents = (unit: TargetUnit) => Boolean(input.newOwnerId && unit.occupantIds.includes(input.newOwnerId));
    const asked = sale
      ? ending.filter((unit) => unit.ownerLivedThere && unit.otherOwners.length === 0 && !buyerRents(unit))
      : [];
    if (asked.length > 0 && !input.afterStatus) {
      throw new ValidationError('حدِّد من يسكن الوحدة الآن', {
        needsStatus: true,
        unitCodes: asked.map((unit) => unit.unitCode),
      });
    }
    if (input.afterStatus === 'OWNER_OCCUPIED' && !input.newOwnerId) {
      throw new ValidationError('اختر المالك الجديد لتسجيل أنه يسكنها، أو اختر «لا أعرف»', {
        afterStatus: input.afterStatus,
      });
    }
    if (input.afterStatus === 'VACANT' && !input.vacancyBasis) {
      throw new ValidationError('على ماذا يستند الشغور؟', { vacancyBasis: null });
    }

    const events: PendingEvent[] = [];
    const result: EndOwnershipResult = {
      reason: input.reason,
      endedAt: endedAt.toISOString(),
      occupanciesEnded: 0,
      rowsEnded: 0,
      endedRowIds: [],
      cardsEnded: 0,
      statusApplied: asked.length > 0 ? (input.afterStatus ?? null) : null,
      newOwnerRecorded: false,
      casesOpened: 0,
      vacanciesConfirmed: 0,
      tenantsReleased: [],
      buyerTenancyEndedOn: [],
      units: ending.map((unit) => ({ unitId: unit.unitId, unitCode: unit.unitCode, buildingId: unit.buildingId })),
    };
    const droppedFlags: Array<Record<string, unknown>> = [];
    // Written inside the transaction, copied onto `result` once it commits.
    let tenantsReleased: EndOwnershipResult['tenantsReleased'] = [];
    let newOwnerRecorded = false;
    const buyerTenancyEndedOn: string[] = [];

    await runInTenantTransaction(this.tenantContext, async () => {
      // 1 — the spells.
      for (const spell of target.spells) {
        if (!endingUnitIds.has(spell.unitId)) continue;
        const closedAt = sale && endedAt < spell.fromDate ? spell.fromDate : endedAt;
        const closed = await this.db.unitOccupancy.updateMany({
          where: { id: spell.id, toDate: null },
          data: { toDate: closedAt, endReason: input.reason as never },
        });
        if (closed.count === 0) throw new ConflictError('تغيّرت هذه الملكية للتو — حدّث الصفحة');
        result.occupanciesEnded += 1;
        const unit = target.units.find((row) => row.unitId === spell.unitId);
        events.push({
          name: 'building.changed',
          payload: {
            action: 'OCCUPANCY_ENDED',
            buildingId: unit?.buildingId,
            before: { unitCode: unit?.unitCode, citizenId: target.citizenId },
            after: { occupancyId: spell.id, role: 'OWNER', reason: input.reason, toDate: closedAt, via: 'OWNERSHIP_ENDED' },
          },
        });
      }

      // 2 — the rows and the cards, with their «غير مؤكَّد» flags.
      for (const card of target.cards) {
        if (card.endingRowIds.length > 0) {
          const rows = await this.db.buildingUnit.updateMany({
            where: { id: { in: card.endingRowIds }, endedAt: null },
            data: { endedAt, endReason: input.reason as never },
          });
          if (rows.count !== card.endingRowIds.length) {
            throw new ConflictError('تغيّرت وحدات هذه البطاقة للتو — حدّث الصفحة');
          }
          result.rowsEnded += rows.count;
          result.endedRowIds.push(...card.endingRowIds);
        }

        const current = await this.db.buildingUnit.count({ where: { propertyEntryId: card.id, endedAt: null } });
        const cardEnded = current === 0;

        const registration = await this.db.registration.findUnique({
          where: { id: card.registrationId },
          select: {
            flaggedFields: true,
            properties: { where: { endedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } },
          },
        });
        const cardIndex = registration?.properties.findIndex((row) => row.id === card.id) ?? -1;
        let flags: unknown = registration?.flaggedFields;
        let changed = false;

        if (cardEnded) {
          const shifted = withoutCardFlags(flags, cardIndex);
          flags = shifted.flags;
          changed = shifted.changed;
          droppedFlags.push(...shifted.removed);
          await this.db.propertyEntry.update({
            where: { id: card.id },
            data: { endedAt, endReason: input.reason as never },
          });
          result.cardsEnded += 1;
        } else {
          // Last first, so each position is still the one it was read at.
          const positions = card.endingRowIds
            .map((rowId) => card.units.findIndex((row) => row.id === rowId))
            .filter((index) => index >= 0)
            .sort((a, b) => b - a);
          for (const rowIndex of positions) {
            const shifted = withoutRowFlags(flags, { cardIndex, rowIndex });
            flags = shifted.flags;
            changed ||= shifted.changed;
            droppedFlags.push(...shifted.removed);
          }
        }

        if (changed) {
          await this.db.registration.update({
            where: { id: card.registrationId },
            data: {
              flaggedFields: flags as never,
              status: statusForFlags(flags as unknown as FieldFlag[]) as never,
            },
          });
        }
      }

      // 3 — a sale releases the tenants' links to the seller for these flats.
      if (sale && ending.length > 0) {
        const released = await this.links.releaseForSale({
          ownerId: target.citizenId,
          unitIds: ending.map((unit) => unit.unitId),
          buildingIds: [...new Set(ending.map((unit) => unit.buildingId))],
        });
        events.push(...released.events);
        tenantsReleased = released.released.map((release) => ({
          tenantId: release.tenantId,
          tenantName: release.tenantName,
          propertyEntryId: release.propertyEntryId,
          mode: release.mode,
        }));
      }

      // 4 — what each flat the seller lived in is now, when nobody else owns it.
      for (const unit of asked) {
        await this.applyAfterStatus(unit, target, input, endedAt, actor, result);
      }

      // 5 — the buyer, or a case asking for them.
      if (sale) {
        for (const unit of ending) {
          const heldBy = tenantsReleasedOn(tenantsReleased, unit, input.newOwnerId);
          if (input.newOwnerId) {
            /*
              `recordOccupancy` treats a second spell for the same person on the
              same flat as a correction of the first and rewrites it. For a
              buyer who is already there that would rewrite history: a co-owner
              buying the other share would have their own ownership re-dated to
              the sale, and a tenant buying their flat would have the tenancy
              turned into an ownership, its dates and its card left behind.

              So a co-owner keeps what they hold. A tenant's tenancy ends first,
              through `TenancyService` — the one place a tenancy ends — as a
              real ending on the day of the sale, and they are recorded owner
              after it, living there when nobody else rents it.
            */
            const already = await this.db.unitOccupancy.findFirst({
              where: { unitId: unit.unitId, citizenId: input.newOwnerId, toDate: null },
              select: { id: true, role: true },
            });
            let buyerStatus: { unitStatus: 'OWNER_OCCUPIED'; endsVacancy: true } | null =
              input.afterStatus === 'OWNER_OCCUPIED' && asked.includes(unit)
                ? { unitStatus: 'OWNER_OCCUPIED', endsVacancy: true }
                : null;
            if (already && already.role !== 'OWNER') {
              if (!this.tenancy) throw new Error('OwnershipService: TenancyService was never bound');
              const ended = await this.tenancy.endForPurchase(already.id, endedAt, actor);
              buyerTenancyEndedOn.push(unit.unitCode);
              buyerStatus = ended.statusApplied === 'OWNER_OCCUPIED'
                ? { unitStatus: 'OWNER_OCCUPIED', endsVacancy: true }
                : null;
            }
            if (!already || already.role !== 'OWNER') {
              await this.buildings.recordOccupancy(
                {
                  unitId: unit.unitId,
                  citizenId: input.newOwnerId,
                  role: 'OWNER',
                  fromDate: endedAt,
                  ...(buyerStatus ?? {}),
                },
                actor,
              );
            }
            newOwnerRecorded = true;
            if (heldBy.length > 0) {
              await this.openCase(unit, actor, result, 'GENERAL_NOTE',
                `انتقلت ملكية الوحدة ${unit.unitCode} من ${target.citizenName} بتاريخ ${day(endedAt)}، وسُجِّل المالك الجديد. ${heldBy.join('، ')} ${heldBy.length === 1 ? 'مستأجر' : 'مستأجرون'} فيها — اربطهم بالمالك الجديد من «روابط المالكين».`,
              );
            }
          } else {
            await this.openCase(unit, actor, result, 'GENERAL_NOTE',
              `انتقلت ملكية الوحدة ${unit.unitCode} من ${target.citizenName} بتاريخ ${day(endedAt)} — سجِّل المالك الجديد على الوحدة.` +
                (heldBy.length > 0
                  ? ` ${heldBy.join('، ')} ${heldBy.length === 1 ? 'مستأجر' : 'مستأجرون'} فيها — اربطهم به بعد تسجيله.`
                  : ''),
            );
          }
        }
      } else {
        /*
          A correction takes back what the ownership said about the flat, but
          only «يسكنها المالك» — the one status that was about this person. With
          no owner left, it is cleared rather than guessed, and a case asks who
          is there.
        */
        for (const unit of ending) {
          if (unit.otherOwners.length > 0 || unit.unitStatus !== 'OWNER_OCCUPIED') continue;
          await this.db.unit.updateMany({
            where: { id: unit.unitId, unitStatus: 'OWNER_OCCUPIED' as never },
            data: { unitStatus: null },
          });
          const { opened } = await this.cases.openUnlessStanding(
            {
              notes: `صُحِّحت ملكية الوحدة ${unit.unitCode} (سُجِّلت باسم ${target.citizenName} بالخطأ) — تحقّق من مالكها ومن يسكنها.`,
              caseType: 'VACANT_UNCONFIRMED',
              buildingId: unit.buildingId,
              unitId: unit.unitId,
              propertyNumber: unit.parcelNumber ?? undefined,
            } as never,
            actor,
          );
          if (opened) result.casesOpened += 1;
        }
      }
    });

    result.tenantsReleased = tenantsReleased;
    result.newOwnerRecorded = newOwnerRecorded;
    result.buyerTenancyEndedOn = buyerTenancyEndedOn;

    this.links.emitAll(events, actor);
    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: target.citizenId,
      action: 'OWNERSHIP_ENDED',
      after: {
        reason: input.reason,
        endedAt,
        unitCodes: ending.map((unit) => unit.unitCode),
        cardIds: target.cards.map((card) => card.id),
        afterStatus: result.statusApplied,
        newOwnerId: input.newOwnerId ?? null,
        occupanciesEnded: result.occupanciesEnded,
        cardsEnded: result.cardsEnded,
        tenantsReleased: result.tenantsReleased.map((tenant) => tenant.propertyEntryId),
        ...(result.buyerTenancyEndedOn.length > 0 ? { buyerTenancyEndedOn: result.buyerTenancyEndedOn } : {}),
        ...(droppedFlags.length > 0 ? { flagsOnEndedCards: droppedFlags } : {}),
      },
      actorId: actor.id,
      actorRole: actor.role,
    });
    for (const tenant of result.tenantsReleased) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: tenant.tenantId,
        action: 'LANDLORD_LINK_RELEASED_BY_SALE',
        after: { propertyEntryId: tenant.propertyEntryId, sellerId: target.citizenId, mode: tenant.mode },
        actorId: actor.id,
        actorRole: actor.role,
      });
    }

    return result;
  }

  /**
   * The flat's status once the seller has gone — the same four answers
   * «إنهاء الإيجار» gives, meaning the same things for the bill. «يسكنها المالك»
   * is the buyer here, written when the buyer is recorded (step 5).
   */
  private async applyAfterStatus(
    unit: TargetUnit,
    target: Target,
    input: EndOwnershipCommand,
    endedAt: Date,
    actor: Actor,
    result: EndOwnershipResult,
  ): Promise<void> {
    switch (input.afterStatus as AfterTenancyStatus | undefined) {
      case 'OWNER_OCCUPIED':
        // Written with the buyer's spell, so the status and its owner land together.
        await this.db.unit.updateMany({
          where: { id: unit.unitId, unitStatus: { in: ['OWNER_OCCUPIED', 'SEASONAL'] as never } },
          data: { unitStatus: null },
        });
        break;
      case 'VACANT': {
        await this.db.unit.updateMany({
          where: { id: unit.unitId, unitStatus: { in: ['OWNER_OCCUPIED', 'SEASONAL'] as never } },
          data: { unitStatus: null },
        });
        await this.buildings.confirmVacancy(
          unit.unitId,
          {
            basis: input.vacancyBasis as never,
            observedAt: endedAt,
            notes: input.vacancyNotes?.trim() || `انتقلت ملكيتها من ${target.citizenName}، وهي شاغرة`,
          },
          actor,
        );
        result.vacanciesConfirmed += 1;
        break;
      }
      case 'RENTED_TO_OTHER':
        await this.db.unit.update({ where: { id: unit.unitId }, data: { unitStatus: 'RENTED' } });
        await this.openCase(unit, actor, result, 'GENERAL_NOTE',
          `انتقلت ملكية الوحدة ${unit.unitCode} من ${target.citizenName}، ويسكنها مستأجر غير مسجَّل — سجِّله على الوحدة.`,
        );
        break;
      case 'UNKNOWN': {
        /*
          Cleared, not guessed: «يسكنها المالك» described the seller. With no
          status the flat's owner is billed — the presumption the law starts
          from — and the case sends somebody to find out.
        */
        await this.db.unit.updateMany({
          where: { id: unit.unitId, unitStatus: { in: ['OWNER_OCCUPIED', 'SEASONAL'] as never } },
          data: { unitStatus: null },
        });
        const { opened } = await this.cases.openUnlessStanding(
          {
            notes: `انتقلت ملكية الوحدة ${unit.unitCode} من ${target.citizenName} ولم تُعرف حالتها بعده — تحقّق: من يسكنها؟`,
            caseType: 'VACANT_UNCONFIRMED',
            buildingId: unit.buildingId,
            unitId: unit.unitId,
            propertyNumber: unit.parcelNumber ?? undefined,
          } as never,
          actor,
        );
        if (opened) result.casesOpened += 1;
        break;
      }
      default:
        break;
    }
  }

  private async openCase(
    unit: TargetUnit,
    actor: Actor,
    result: EndOwnershipResult,
    caseType: 'GENERAL_NOTE',
    notes: string,
  ): Promise<void> {
    await this.cases.create(
      {
        notes,
        caseType,
        buildingId: unit.buildingId,
        unitId: unit.unitId,
        propertyNumber: unit.parcelNumber ?? undefined,
      } as never,
      actor,
    );
    result.casesOpened += 1;
  }
}

// ─────────────────────────────  Helpers  ─────────────────────────────

/**
 * The tenants whose link to the seller this sale released on one flat, who
 * still need linking to the new owner — never the buyer, who is that owner.
 */
function tenantsReleasedOn(
  releases: EndOwnershipResult['tenantsReleased'],
  unit: TargetUnit,
  buyerId?: string,
): string[] {
  const onUnit = new Set(unit.linkedTenants.map((tenant) => tenant.propertyEntryId));
  return [
    ...new Set(
      releases
        .filter((release) => onUnit.has(release.propertyEntryId) && release.tenantId !== buyerId)
        .map((release) => release.tenantName),
    ),
  ];
}

function unique(ids: ReadonlyArray<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fullName(person: { firstName: string; middleName?: string | null; lastName: string }): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
}

const CARD_SELECT = {
  id: true,
  registrationId: true,
  occupancyType: true,
  propertyType: true,
  propertyNumber: true,
  buildingId: true,
  unitStatus: true,
  // In the order the edit form lists them — the order row flags count positions in.
  units: {
    where: { endedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, unitId: true, unitType: true, floor: true, unitArea: true, unitStatus: true },
  },
} as const;

type Actor = { id: string; role: string };

export interface EndOwnershipCommand {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt?: Date;
  rowIds?: readonly string[];
  newOwnerId?: string;
  afterStatus?: AfterTenancyStatus;
  vacancyBasis?: string;
  vacancyNotes?: string;
}

interface TargetCard {
  id: string;
  registrationId: string;
  occupancyType: string;
  propertyType: string;
  propertyNumber: string | null;
  buildingId: string | null;
  unitStatus: string | null;
  units: Array<{
    id: string;
    unitId: string | null;
    unitType: string | null;
    floor: string | null;
    unitArea: { toString(): string } | null;
    unitStatus: string | null;
  }>;
  /** The current rows on this card the ending gives up. */
  endingRowIds: string[];
}

interface LinkedTenant {
  citizenId: string;
  name: string;
  propertyEntryId: string;
}

interface TargetUnit {
  unitId: string;
  unitCode: string;
  buildingId: string;
  buildingCode: string;
  parcelNumber: string | null;
  unitStatus: string | null;
  dwelling: boolean;
  /** Other current owners — co-owners keep the flat, and its status. */
  otherOwners: string[];
  otherOwnerIds: string[];
  /** Who is recorded living here other than as owner — a buyer among them has their tenancy ended. */
  occupantIds: string[];
  /** «يسكنها المالك» or «مسكن موسمي» — a status that described this owner. */
  ownerLivedThere: boolean;
  /** Tenants whose link names this owner as the landlord of this flat. */
  linkedTenants: LinkedTenant[];
}

interface Target {
  citizenId: string;
  citizenName: string;
  ownerNonResident: boolean;
  /** The latest start among the spells being ended — a sale cannot precede it. */
  startedAt: Date | null;
  cards: TargetCard[];
  spells: Array<{ id: string; unitId: string; fromDate: Date }>;
  units: TargetUnit[];
}

export interface EndOwnershipResult {
  reason: EndOwnershipCommand['reason'];
  endedAt: string;
  occupanciesEnded: number;
  rowsEnded: number;
  /** The card rows this ending closed — so an open edit form can drop exactly those. */
  endedRowIds: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  newOwnerRecorded: boolean;
  casesOpened: number;
  vacanciesConfirmed: number;
  tenantsReleased: Array<{
    tenantId: string;
    tenantName: string;
    propertyEntryId: string;
    mode: SaleRelease['mode'];
  }>;
  /** The flats the buyer rented until the sale — their tenancy ended there, as history. */
  buyerTenancyEndedOn: string[];
  /** The flats whose ownership ended — for «سجِّل المالك الجديد الآن» on the success screen. */
  units: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

export interface OwnershipPreview {
  owner: { id: string; name: string; nonResident: boolean };
  propertyType: string | null;
  propertyNumber: string | null;
  startedAt: string | null;
  /** The flats in سجل المباني this ending would touch. */
  units: Array<{
    unitId: string;
    unitCode: string;
    buildingCode: string;
    otherOwners: string[];
    /** A buyer among these already owns the flat, and keeps that ownership as it is. */
    otherOwnerIds: string[];
    /** A buyer among these rents the flat: the sale ends that tenancy and records them living there. */
    occupantIds: string[];
    ownerLivedThere: boolean;
    needsStatus: boolean;
    dwelling: boolean;
    linkedTenants: LinkedTenant[];
  }>;
  /** Every current row on the card, in the form's order — what the dialog chooses from. */
  rows: Array<{
    rowId: string;
    unitId: string | null;
    unitCode: string | null;
    unitType: string | null;
    floor: string | null;
    unitArea: number | null;
    needsStatus: boolean;
    otherOwners: string[];
    linkedTenants: LinkedTenant[];
  }>;
}
