import { citizenStoredName, storedLandlordName } from '@mechanization/shared-schemas';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  STRUCTURE_TYPE_MAP,
  contradictsVacancy,
  feeBearerClass,
  OCCUPANCY_LIFTS_SURVEY_STATUS,
  unitStatusForRole,
  type OccupancyEndReason,
  type OccupancyRole,
  type StructureType,
  type UnitStatus,
  type UpsertOccupancyInput,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { assertFileOpen, assertNotMergedAway } from '../citizens/merged-away';
import { cardClaiming, takesAnotherFlat } from '../../../domain/entities/census-claim';
import { CasesService } from '../cases/cases.service';
import type { FileLinkResult, LandlordSpec, OccupancyRow } from './building.types';
import { activeVacancy, closeActiveVacancy } from './unit-vacancy';
import {
  BuildingsService,
  assertNonResidentOccupancy,
  assertOccupiableUnit,
  toOccupancyRow,
} from './buildings.service';
import { UnitVisitsService } from './unit-visits.service';
import { StaffActor } from '../../common/actor';

/**
 * Who lives in or holds a unit, written: «تسجيل إشغال» (`recordOccupancy`), the
 * card a link or a filing puts on a citizen's file (`ensureOnFile`, `claimOnFile`)
 * and an occupancy ended (`endOccupancy`). An occupancy is a dual record: the
 * `unit_occupancies` row and the citizen's card on the unit are written together,
 * in one transaction, or billing and the census matrix disagree. Out of
 * `BuildingsService` (audit GOD-05).
 */
@Injectable()
export class OccupancyWritesService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cases: CasesService,
    private readonly events: EventEmitter2,
    private readonly buildings: BuildingsService,
    private readonly unitVisits: UnitVisitsService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Records who is in a unit — and closes the case that was waiting to find out.
   *
   * The auto-resolve is P2-T5's half of this and it belongs here rather than in
   * the cases page, because this is the moment the thing the case was waiting
   * on actually happened. A حالة on a flat says "nobody answered"; an occupancy
   * on that flat says who lives there. Leaving the case open would send a second
   * officer to a door the municipality has already been through.
   *
   * ## And it now writes the citizen’s half of the record too
   *
   * `endOccupancy` has always released the census claim on the citizen’s file
   * when a spell ends. Nothing established it when a spell *began*, so the two
   * halves of one fact were maintained in one direction of travel only: an
   * officer who tapped «تسجيل شاغل» got an occupancy on the matrix and a citizen
   * file that went on saying nothing about the flat — «غير مرتبط بملفه» on the
   * commonest correct action in the census, with nothing the officer could do
   * about the warning but go and edit that person’s card by hand.
   *
   * It was a billing fault as much as a display one, and in the direction that
   * costs the municipality: `assessCitizen` bills the cards a citizen filed, so
   * an occupancy with no card behind it is a flat nobody is charged for.
   *
   * See `claimOnFile` for what is written and, more importantly, for the three
   * things it deliberately refuses to do.
   */
  async recordOccupancy(
    input: UpsertOccupancyInput,
    actor: StaffActor,
    /**
     * `fromMatrix`: an officer at the drawer, not another flow recording a
     * party on the way (a sale's buyer, a landlord link's owner). Only then is
     * an owner's answer that contradicts a registered tenant refused, and only
     * then is the answer written onto the owner's own card.
     */
    options: { fromMatrix?: boolean } = {},
  ): Promise<{ occupancy: OccupancyRow; casesResolved: number; fileLink: FileLinkResult }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: {
        id: true,
        buildingId: true,
        unitCode: true,
        unitType: true,
        unitStatus: true,
        surveyStatus: true,
        unitArea: true,
      },
    });
    if (!unit) throw new NotFoundError({
      code: 'UNIT_NOT_FOUND',
      message: 'Unit was not found',
    });

    /*
      Ahead of the citizen lookup, because it is a fact about the unit alone.
      Whether the person exists does not change the answer, and the officer who
      tapped the wrong block wants to be told which block, not told about a
      citizen they had already picked correctly.
    */
    assertOccupiableUnit({ unitType: unit.unitType, unitCode: unit.unitCode });

    const citizen = await this.db.user.findUnique({ where: { id: input.citizenId } });
    if (!citizen || citizen.kind !== 'CITIZEN') {
      throw new ValidationError({
        code: 'CITIZEN_NOT_FOUND',
        message: `Citizen ${input.citizenId} was not found`,
        details: { citizenId: input.citizenId },
      });
    }
    // A file folded into another is nobody to record in a flat — see `assertNotMergedAway`.
    await assertNotMergedAway(this.db, citizen.id);
    /*
      Nor is an archived one, until it is restored: an occupancy writes a card on
      the file (the dual record), which is a new filing (`assertFileOpen`). Every
      way a person lands in a flat comes through here — the matrix, a sale's
      buyer, an owner link.
    */
    assertFileOpen(citizen);

    assertNonResidentOccupancy({
      residence: citizen.residence,
      role: input.role,
      unitType: unit.unitType,
      unitStatus: input.unitStatus,
      unitCode: unit.unitCode,
    });

    /*
      Linking somebody to a flat the municipality has confirmed empty.

      This is the other half of «تأكيد الشغور» being undoable: a unit found
      empty in March and let in June must be re-linkable without an officer
      first remembering to go and lift the vacancy, and without the register
      spending the interval saying both things at once. It used to say both —
      `recordOccupancy`'s حالة write is narrowed to `unitStatus: null`, so a
      tenant recorded on a «شاغرة» unit left the unit empty on paper, the owner
      exempt, and the matrix showing «تعارض».

      So it is asked rather than assumed. Without `endsVacancy` the refusal
      carries the confirmation with it, so the client can show *when* the flat
      was confirmed empty and on what basis before anyone overrides a finding
      somebody else recorded. With it, the vacancy is closed as «لم تعد شاغرة»
      in the same request.

      An owner is not asked: a deed is not residence (D2), and an owner on a
      شاغرة flat is the ordinary case. What an owner *says* about the flat can
      still contradict it — see `contradictsVacancy`.
    */
    const standing = await activeVacancy(this.db, input.unitId);
    if (standing && contradictsVacancy(input.role, input.unitStatus)) {
      if (!input.endsVacancy) {
        throw new ConflictError({
          code: 'UNIT_VACANCY_STANDING',
          message: `Unit ${unit.unitCode} is confirmed vacant`,
          params: { unitCode: unit.unitCode, since: standing.observedAt.toISOString().slice(0, 10) },
          details: {
            vacancy: {
              id: standing.id,
              basis: standing.basis,
              observedAt: standing.observedAt,
              notes: standing.notes,
            },
          },
        });
      }

      /*
        Closed before the writes below rather than after, so they see the unit
        the reversal leaves: the survey lift reads `PARTIAL` as still open and
        carries it to «مكتملة», and the حالة write finds the null it needs to
        fill with «مؤجرة» or «مشغولة بتسامح».
      */
      const closed = await closeActiveVacancy(this.db, {
        unitId: input.unitId,
        unit,
        reason: 'NO_LONGER_VACANT',
        actorId: actor.id,
      });
      if (closed) {
        await this.db.unit.update({
          where: { id: input.unitId },
          data: {
            ...(closed.restore.unitStatus !== undefined
              ? { unitStatus: closed.restore.unitStatus }
              : {}),
            ...(closed.restore.surveyStatus !== undefined
              ? { surveyStatus: closed.restore.surveyStatus }
              : {}),
          },
        });
        this.buildings.record({
          action: 'UNIT_VACANCY_ENDED',
          buildingId: unit.buildingId,
          before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
          after: {
            unitCode: unit.unitCode,
            vacancyId: closed.confirmation!.id,
            reason: 'NO_LONGER_VACANT',
            citizenId: input.citizenId,
            via: 'OCCUPANCY',
          },
          actor,
        });
      }
    }

    /*
      A person is in a unit once, in one capacity, at a time.

      Re-recording the same pair is a correction — the officer picked the wrong
      role, or is re-syncing an offline entry — not a second tenancy, so the
      current row is updated rather than duplicated. A *closed* occupancy is
      left alone: someone who moved out and back in is two spells, which is
      exactly the history D2 exists to keep.
    */
    /*
      An owner said to live in, or to have emptied, a flat a registered tenant
      lives in — refused at the drawer, for `updateUnit`'s reason. «شاغرة» is
      also refused below by `confirmVacancy`; this says it first, in the words
      that apply to an owner.
    */
    if (
      options.fromMatrix &&
      input.role === 'OWNER' &&
      input.unitStatus &&
      feeBearerClass(input.unitStatus) !== 'OTHERS'
    ) {
      await this.buildings.assertNoOccupantBesidesOwner(unit, input.unitStatus, input.citizenId);
    }

    const current = await this.db.unitOccupancy.findFirst({
      where: { unitId: input.unitId, citizenId: input.citizenId, toDate: null },
    });

    const occupancy = current
      ? await this.db.unitOccupancy.update({
          where: { id: current.id },
          data: {
            role: input.role,
            /*
              أسهم are an owner's only, and a re-record with the box left empty
              keeps the ones on file. The drawer sends nothing for an empty box,
              and «تعديل» on an owner used to wipe the أسهم a «حسب الأسهم» flat
              is billed by (migration 0075) — the flat then refused to bill.
            */
            shares: input.role === 'OWNER' ? (input.shares ?? current.shares ?? null) : null,
            ...(input.fromDate ? { fromDate: input.fromDate } : {}),
            ...(input.toDate !== undefined ? { toDate: input.toDate } : {}),
          },
          include: { citizen: { select: { firstName: true, lastName: true, phone: true, isActive: true, residence: true } } },
        })
      : await this.db.unitOccupancy.create({
          data: {
            unitId: input.unitId,
            citizenId: input.citizenId,
            role: input.role,
            shares: input.shares ?? null,
            ...(input.fromDate ? { fromDate: input.fromDate } : {}),
            ...(input.toDate ? { toDate: input.toDate } : {}),
          },
          include: { citizen: { select: { firstName: true, lastName: true, phone: true, isActive: true, residence: true } } },
        });

    /*
      A unit with somebody in it has been surveyed.

      Only lifted from the states that mean "we still do not have the answer"
      (`OCCUPANCY_LIFTS_SURVEY_STATUS`, shared with the registration path so
      the two cannot drift). An officer who has recorded an occupant has, by
      definition, been answered, and that includes a flat whose last visit was
      «رفض» or «تعذّر الوصول». A unit
      already marked `DEMOLISHED` or `VACANT_CONFIRMED` is left alone — those
      are findings that contradict this one, and a contradiction is for a person
      to resolve, not for a side effect to overwrite.
    */
    await this.db.unit.updateMany({
      where: { id: input.unitId, surveyStatus: { in: [...OCCUPANCY_LIFTS_SURVEY_STATUS] } },
      data: { surveyStatus: 'COMPLETE' },
    });

    /*
      A non-owner spell settles حالة الوحدة — and nothing used to write it.

      Who is in a flat and what state the flat is in are one fact stored twice,
      and this path wrote only the first. So recording a مستأجر never made the
      unit «مؤجرة»; the owner's card went on saying «مشغولة من المالك»,
      `bearsFee` read that and charged them the occupancy fee, and the tenant
      was charged it too on their own card. One flat, two bills, every row
      individually valid.

      `unitStatusForRole` returns null for OWNER on purpose: a deed is not a
      statement of residence, and an owner abroad with a tenant downstairs is
      the case the join table exists for (D2).

      Narrowed to `unitStatus: null` for the same reason the lift above is
      narrowed — only "nobody was asked" may be answered by a side effect. An
      officer who set «شاغرة» and an occupancy that says otherwise are a
      contradiction for a person to look at, and the drawer now shows it rather
      than letting this quietly win.
    */
    /*
      An owner’s own answer, and it *replaces* rather than fills a gap.

      This is the other half of the asymmetry above. `unitStatusForRole` is an
      inference and is narrowed accordingly; `input.unitStatus` is a person standing
      in the building saying what the flat is — the same kind of statement
      `logVisit` makes, and treated the same way. It is only ever reachable for an
      OWNER (the schema refuses it on anyone else, whose capacity already settles
      the question), so it cannot be used to contradict a tenancy recorded in the
      same breath.

      It is what makes the four owner cases distinguishable at last. An owner
      living there («مشغولة من المالك»), an owner who lets it («مؤجرة»), an owner
      whose relative is in it («مشغولة بتسامح») and an owner of an empty or
      unfinished flat («شاغرة» / «قيد الإنشاء») are four different bills, and
      recording the owner used to state none of them — so `bearsFee` read the null
      as «nobody was asked» and charged them the occupancy fee regardless.
    */
    /*
      Since 2026-09-30 the owner's «شاغرة» is a تصريح بالشغور and becomes a
      vacancy resting on the owner's statement — dated, attributed, undoable —
      instead of a bare «شاغرة» nothing could tell apart from a finding (the
      user's decision). Every other owner answer replaces the unit's status as
      before. What a tenant or شاغل بتسامح implies is no longer written here at
      all: `settle` below derives it from who is recorded, whatever the unit said
      before — the empty-only fill it replaces left a seasonal home «موسمي»
      under a registered tenant, and both were billed.
    */
    const impliedStatus = unitStatusForRole(input.role);
    if (input.role === 'OWNER' && input.unitStatus === 'VACANT') {
      if (!(await activeVacancy(this.db, input.unitId))) {
        await this.unitVisits.confirmVacancy(
          input.unitId,
          { basis: 'OWNER_STATEMENT', notes: 'تصريح المالك عند تسجيله على الوحدة' },
          actor,
          { settle: false, ownerStatement: true },
        );
      }
    } else if (input.unitStatus) {
      await this.db.unit.update({
        where: { id: input.unitId },
        data: { unitStatus: input.unitStatus },
      });
    }

    /*
      مساحة الوحدة, filled in from the doorstep — and only where it is missing.

      The gap this closes: `generateUnits` and the grid painter both create
      flats with no area, because they assert that a flat exists rather than
      that anyone has measured it. Recording an occupant was the first moment
      somebody had actually been inside, and the form had nowhere to put the
      number — so `claimOnFile` below minted the citizen's property card from a
      unit with `unitArea` null, billing could not price a PER_AREA notice
      against it, and the edit form rendered the absence as «0».

      Narrowed to `unitArea: null` for the same reason the survey-status lift
      and the implied حالة are narrowed: only "nobody established this" may be
      answered by a side effect of recording who lives here. A flat the census
      has already measured keeps its measurement — correcting a surveyed area is
      the unit editor's job, and silently overwriting it while filing a tenant
      would be a change nobody asked for and nobody would see.

      Written before `claimOnFile` so the card it mints copies the new area
      rather than the null it replaced.
    */
    if (input.unitArea !== undefined) {
      await this.db.unit.updateMany({
        where: { id: input.unitId, unitArea: null },
        data: { unitArea: input.unitArea },
      });
    }

    const casesResolved = await this.cases.resolveForUnit(input.unitId, input.citizenId, actor);

    const landlord: LandlordSpec | null =
      input.role === 'OWNER'
        ? null
        : {
            citizenId: input.landlordCitizenId ?? null,
            name: input.landlordName ?? null,
            phone: input.landlordPhone ?? null,
          };

    const fileLink = await this.claimOnFile({
      unitId: input.unitId,
      buildingId: unit.buildingId,
      citizenId: input.citizenId,
      role: input.role,
      shares: input.shares ?? null,
      unitStatus: input.unitStatus ?? impliedStatus ?? null,
      landlord,
      filedById: actor.id,
    });

    /*
      The owner's answer, on the owner's own card too.

      A flat already on the owner's file came back `ALREADY_CLAIMED` and nothing
      was written to it, so an owner re-recorded on the matrix as «مسكن موسمي»
      kept «مشغولة من المالك» on their card — and the next save of their file
      put that back on the unit. The two now say the same thing.
    */
    if (
      options.fromMatrix &&
      input.role === 'OWNER' &&
      input.unitStatus &&
      fileLink.outcome === 'ALREADY_CLAIMED' &&
      fileLink.propertyEntryId
    ) {
      await this.stateOnOwnerCard(fileLink.propertyEntryId, input.unitId, input.unitStatus, {
        citizenId: input.citizenId,
        unitCode: unit.unitCode,
        actor,
      });
    }

    this.buildings.record({
      action: 'OCCUPANCY_RECORDED',
      buildingId: unit.buildingId,
      after: {
        unitCode: unit.unitCode,
        citizenId: input.citizenId,
        role: input.role,
        unitStatus: input.unitStatus ?? null,
        ...(input.landlordCitizenId ? { landlordCitizenId: input.landlordCitizenId } : {}),
        /*
          Logged only where it was actually written — i.e. where the unit had
          no area and this request supplied one. An audit row saying an area
          was recorded when the update matched nothing would be a lie about the
          one field on this form that decides a PER_AREA bill.
        */
        ...(input.unitArea !== undefined && unit.unitArea == null
          ? { unitArea: input.unitArea }
          : {}),
        // «لم تُقَس» with its reason — only where the unit really has no area.
        ...(input.unitArea === undefined && unit.unitArea == null && input.unitAreaMissingReason
          ? { unitAreaNotMeasured: input.unitAreaMissingReason }
          : {}),
        // «لم يُعرف من يشغلها» with its reason — an owner with no answer given.
        ...(input.role === 'OWNER' && !input.unitStatus && input.unitStatusMissingReason
          ? { unitStatusNotEstablished: input.unitStatusMissingReason }
          : {}),
        casesResolved,
        /*
          Named in the audit row for the reason `endOccupancy` names its release:
          this is the part that edits somebody’s own file rather than the census,
          and a resident disputing a bill is entitled to see when their card
          started claiming the flat and who made it do so.
        */
        fileLink: fileLink.outcome,
      },
      actor,
    });

    await this.buildings.settle(input.unitId, actor, 'OCCUPANCY_RECORDED');

    return { occupancy: toOccupancyRow(occupancy, fileLink.backed), casesResolved, fileLink };
  }


  /**
   * Writes an owner's «حالة الوحدة» onto the card that already claims the flat:
   * the line naming it, or — for a منزل on a one-unit structure — the card.
   * Audited as an edit of the owner's file, which is what it is.
   */
  private async stateOnOwnerCard(
    propertyEntryId: string,
    unitId: string,
    status: UnitStatus,
    context: { citizenId: string; unitCode: string; actor: StaffActor },
  ): Promise<void> {
    const card = await this.db.propertyEntry.findUnique({
      where: { id: propertyEntryId },
      select: {
        id: true,
        occupancyType: true,
        propertyType: true,
        unitStatus: true,
        units: { where: { endedAt: null, unitId }, select: { id: true, unitStatus: true } },
      },
    });
    if (!card || card.occupancyType !== 'OWNER') return;

    let before: string | null = null;
    if (card.units.length > 0) {
      const line = card.units[0]!;
      if (line.unitStatus === status) return;
      before = line.unitStatus;
      await this.db.buildingUnit.update({ where: { id: line.id }, data: { unitStatus: status } });
    } else if (card.propertyType === 'HOUSE') {
      if (card.unitStatus === status) return;
      before = card.unitStatus;
      await this.db.propertyEntry.update({ where: { id: card.id }, data: { unitStatus: status } });
    } else {
      return;
    }

    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: context.citizenId,
      action: 'CITIZEN_UPDATED',
      before: { unitStatus: before },
      after: {
        cards: [{ kind: 'changed', propertyEntryId: card.id, fields: ['unitStatus'] }],
        unitCode: context.unitCode,
        unitStatus: status,
        via: 'OCCUPANCY',
      },
      actorId: context.actor.id,
      actorRole: context.actor.role,
    });
  }


  /**
   * Puts the flat on the citizen’s own file — the mirror of
   * `releaseCensusClaim`, and the write that was never on this side.
   *
   * ## What "backed" has to mean
   *
   * Not "a row exists somewhere" but "billing would read this". `assessCitizen`
   * charges the property cards a citizen filed, so the claim has to land in one
   * of the three shapes `claimsBackingOccupancies` recognises — which are the
   * three shapes `attachOccupancies` and `bearsFee` actually consume. A row that
   * satisfied the warning without satisfying billing would be worse than the
   * warning: it would hide the uncollected flat instead of flagging it.
   *
   * ## The three things it will not do
   *
   * **It never rewrites a card that already claims this building.** That card is
   * the citizen’s own account of what they hold, and topping one up changes how
   * it is billed — an itemised مبنى card stops consuming the occupancy list
   * (`attachOccupancies`), so adding a flat to one can *reduce* what its holder
   * is charged. An existing card is reported as the backing it already is and
   * left exactly as filed. The one exception is a card that itemises flats and
   * simply has not ticked this one: adding the tick is the same act the unit
   * picker performs, in the same shape, and withholding it would leave the
   * occupancy unbacked beside a card listing every other flat in the block.
   *
   * **It never mints a card on a structure a card cannot hold.** A خيمة drops
   * `buildingId` on the next edit (`branchFieldsOnly`), so the claim would be a
   * holding attached to nothing — the same refusal `declareOwnership` makes, for
   * the same reason.
   *
   * **It never invents a file.** A citizen with no registration gets no card;
   * the occupancy stands on its own and the matrix goes on saying so. That is
   * the state the warning was written for, and it is now the only state that
   * produces it.
   *
   * ## One card per capacity, and one tenancy card per owner
   *
   * A card's rows are billed in the card's own نوع الإشغال, and a tenancy card
   * names one owner. So a flat goes onto an existing card only when both agree:
   * the same capacity, and — for a مستأجر or شاغل بتسامح — the same owner
   * (`holdsFrom`). Otherwise a new card is minted.
   *
   * This used to take the first card on the building whatever it said: a flat
   * rented from one owner was ticked onto the tenancy card of another, and a
   * flat somebody owns onto their own مستأجر card. Somebody renting a shop from
   * one owner and the flat above it from another is ordinary, and each tenancy
   * has to be able to name its own owner and end on its own.
   */
  /**
   * `claimOnFile` for a spell that already exists.
   *
   * The owner-link path's door onto the same rules. When the owner is already
   * recorded on a flat — the matrix put them there, or an earlier link did —
   * re-running `recordOccupancy` would rewrite that spell (its أسهم are reset
   * from the input), so the link records nothing on the census and asks only
   * that the file back what the census already says.
   */
  ensureOnFile(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
    role: OccupancyRole;
    shares: number | null;
    unitStatus: UnitStatus | null;
    landlord?: LandlordSpec | null;
    /** The staff member doing this, paid for any line it writes. See `claimOnFile`. */
    filedById: string;
  }): Promise<FileLinkResult> {
    return this.claimOnFile(input);
  }


  private async claimOnFile(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
    role: OccupancyRole;
    shares: number | null;
    unitStatus: UnitStatus | null;
    /** Non-owner capacities only: who the flat is held from. */
    landlord?: LandlordSpec | null;
    /**
     * The staff member recording this. A line written here goes onto a file
     * somebody else may have registered, and is his work, not theirs: he is the
     * one paid for it (`building_units.filedById`, 0096; `creditBillableUnits`).
     */
    filedById: string;
  }): Promise<FileLinkResult> {
    /*
      Five reads with nothing to say to each other, issued together.

      They used to be five round-trips in a row on a path that runs once per tap
      on the matrix and once per flat on an owner link — a link over a
      twelve-flat block paid for sixty. Two of them can still end the call and
      the other three are reads, so nothing is wasted by having asked.
    */
    const [building, registration, unitsInBuilding, cards, spellsHere] = await Promise.all([
      this.db.building.findUnique({
        where: { id: input.buildingId },
        select: { id: true, parcelNumber: true, name: true, structureType: true },
      }),
      /*
        The citizen’s current file *is* their latest registration — the convention
        `CitizensService.update` and `declareOwnership` both follow. A citizen with
        none cannot receive a card, which is barely reachable through the register
        (a citizen exists because a registration created them) but is refused
        rather than assumed.
      */
      this.db.registration.findFirst({
        where: { citizenId: input.citizenId },
        orderBy: { submittedAt: 'desc' },
        select: { id: true },
      }),
      this.db.unit.count({ where: { buildingId: input.buildingId } }),
      /*
        Current cards only. An ended tenancy is the citizen's history on this
        structure, not a card to tick a new flat onto — somebody who rented here,
        left, and now owns a flat gets a card saying so, not a row on the old lease.
      */
      this.db.propertyEntry.findMany({
        where: {
          buildingId: input.buildingId,
          endedAt: null,
          registration: { citizenId: input.citizenId },
        },
        select: {
          id: true,
          propertyType: true,
          occupancyType: true,
          landlordCitizenId: true,
          landlordPhone: true,
          landlordLinkDismissedIds: true,
          units: { where: { endedAt: null }, select: { id: true, unitId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      /*
        What the census says this citizen holds in this structure — the only
        thing a card that names no flat can be read against. See `claimsFlat`.
      */
      this.db.unitOccupancy.findMany({
        where: { citizenId: input.citizenId, toDate: null, unit: { buildingId: input.buildingId } },
        select: { unitId: true, role: true },
      }),
    ]);
    if (!building) return { backed: false, outcome: 'NO_BUILDING' };
    if (!registration) return { backed: false, outcome: 'NO_FILE' };

    /*
      Already ticked, or already backed by one of the shapes that claim a flat
      without naming it. Nothing to write, and nothing to warn about either.

      `claimsFlat` is shared with every other reader of the same question — the
      matrix's owner-link column, the tenancy card an owner link attaches to,
      the card «إنهاء الإيجار» ends a row on — because a claim this path makes
      and those paths cannot see is a card that bills a flat nothing can end,
      correct or unlink.
    */
    const holder = cardClaiming(cards, spellsHere, input.unitId, input.role);
    if (holder) {
      return { backed: true, outcome: 'ALREADY_CLAIMED', propertyEntryId: holder.id };
    }

    const nonOwner = input.role !== 'OWNER';
    const owner =
      nonOwner && input.landlord?.citizenId
        ? await this.db.user.findUnique({
            where: { id: input.landlord.citizenId },
            select: {
              id: true,
              firstName: true,
              middleName: true,
              lastName: true,
              residence: true,
              phone: true,
              whatsapp: true,
            },
          })
        : null;

    /*
      The card this flat may join: same capacity — rows bill in the card's نوع
      الإشغال — and for a non-owner, the same owner. See the docblock.

      And one that can take a row without losing what it already bills:
      `takesAnotherFlat` passes over a card that bills from its own columns, for
      the reason it gives. The flat gets a card of its own below, and both are
      billed.
    */
    const sameCapacity = cards.filter(
      (card) => card.occupancyType === input.role && takesAnotherFlat(card),
    );
    const existing = nonOwner
      ? await this.cardHeldFrom(sameCapacity, input.landlord ?? null, owner)
      : sameCapacity[0];

    if (existing) {
      /*
        An itemised card that has not ticked this flat.

        The tick is added rather than withheld — see the docblock. A card
        already listing flats 1, 2 and 4 does not stop consuming the occupancy
        list by gaining flat 3; it stopped the moment it listed anything, so a
        row here is the only way this occupancy can be backed at all.

        Only a card that already itemises reaches here — `takesAnotherFlat`
        above — so the tick can never be the row that stops a card billing its
        own columns.
      */
      const described = await this.unitDescription(input.unitId);
      await this.db.buildingUnit.create({
        data: {
          propertyEntryId: existing.id,
          unitId: input.unitId,
          // Copied from the canonical unit, which is the register’s own answer
          // and the only one available — the officer was not asked to describe a
          // flat the matrix already describes.
          unitType: described.unitType,
          floor: described.floor,
          side: described.side,
          unitArea: described.unitArea,
          unitStatus: (input.unitStatus ?? null),
          filedById: input.filedById,
        },
      });

      return { backed: true, outcome: 'UNIT_ADDED', propertyEntryId: existing.id };
    }

    const mapped = STRUCTURE_TYPE_MAP[building.structureType as StructureType];

    /*
      A خيمة cannot carry the link and must not be minted as a holding.

      `branchFieldsOnly` drops `buildingId` from anything but مبنى and منزل, so the
      card would silently lose its link the first time anyone edited it — a
      holding attached to nothing. The occupancy still records who is there;
      only the card is withheld. An unmapped structure type takes the same exit
      rather than throwing, because the occupancy above is already written and
      losing it to a card that could not be minted would be the worse failure.
    */
    if (mapped?.propertyType !== 'BUILDING' && mapped?.propertyType !== 'HOUSE') {
      return { backed: false, outcome: 'UNLINKABLE_STRUCTURE' };
    }

    const described = await this.unitDescription(input.unitId);

    /*
      نوع العقار is decided by the census, not by the structure type alone.

      `STRUCTURE_TYPE_MAP` calls a منزل مستقل a HOUSE, and that is right for a
      structure holding one flat: the card bills that flat from its own columns
      and needs no units array. Where the matrix holds several — an officer who
      found the منزل had been built up, Z-5-201-A — such a card cannot say
      *which* of them it is about, and there is no honest way to make it say so:
      a HOUSE card is forbidden a units array by `PropertyEntry` («a house
      cannot be divided into units»), the منزل branch of `propertyEntrySchema`
      has no such field for a form to round-trip, and a row written past both is
      deleted by the first save of the citizen's file. So the flat is filed as a
      مبنى card naming it — the shape every reader of a claim already
      understands, and the honest one: several units are standing there.
    */
    const cardType = mapped.propertyType === 'HOUSE' && unitsInBuilding === 1 ? 'HOUSE' : 'BUILDING';

    /*
      نوع الإشغال is the officer’s answer, carried straight across.

      `OccupancyRole` and `OccupancyType` are the same three values by design —
      مالك, مستأجر, شاغل بتسامح — because they are one question asked of the unit
      and of the card. This is the half that decides whether the register tells
      the truth about what it just recorded: a مستأجر named on the matrix now
      files a tenant’s card, not an owner’s, and a شاغل بتسامح files neither a
      tenancy that does not exist nor an ownership they do not have.
    */
    const minted = await this.db.propertyEntry.create({
      select: { id: true },
      data: {
        registrationId: registration.id,
        occupancyType: input.role,
        propertyType: cardType,
        buildingId: building.id,
        // The parcel is the building’s own. الحي is left null rather than
        // guessed: the cadastre has no neighbourhood layer to ask, and this
        // path has no second card to copy one from the way `declareOwnership`
        // does.
        propertyNumber: building.parcelNumber || null,
        buildingName: building.name,
        /*
          Who the flat is held from, on the tenancy card that exists for it.

          A registered owner's own name and number: a tenancy card needs both to
          pass the form it is edited in, and the number is what an owner link is
          kept against. The link itself (`landlordCitizenId`) is written by the
          owner-link service with the rest of what it records, not here.
        */
        ...(nonOwner && owner
          ? {
              // The row's own name: «ورثة المرحوم» is added where it is shown, never stored.
              landlordName: citizenStoredName(owner),
              landlordPhone: owner.phone ?? owner.whatsapp ?? null,
            }
          : nonOwner && (input.landlord?.name || input.landlord?.phone)
            ? {
                // Never «ورثة المرحوم …» — see `storedLandlordName`.
                landlordName: storedLandlordName(input.landlord.name),
                landlordPhone: input.landlord.phone ?? null,
              }
            : {}),
        /*
          A منزل bills its single unit from its own columns and has no units
          array to tick, so the description and the حالة go on the card itself.

          A مبنى carries a unit row instead — and carries one rather than none
          deliberately. An empty مبنى card claims *every* flat this citizen
          occupies in the block through `heldThroughOccupancy`, which is the right
          claim for a landlord whose holding nobody has enumerated and the wrong
          one for an officer who has just named a single flat.
        */
        ...(cardType === 'HOUSE'
          ? {
              unitType: mapped.defaultUnitType,
              unitStatus: (input.unitStatus ?? null),
              unitArea: described.unitArea,
            }
          : {
              units: {
                create: {
                  unitId: input.unitId,
                  unitType: described.unitType,
                  floor: described.floor,
                  side: described.side,
                  unitArea: described.unitArea,
                  unitStatus: (input.unitStatus ?? null),
                  filedById: input.filedById,
                },
              },
            }),
      },
    });

    return { backed: true, outcome: 'ENTRY_CREATED', propertyEntryId: minted.id };
  }


  /**
   * The tenant's card, among `cards` (one capacity, oldest first), that holds
   * its flats from this landlord — or none, and a new card is minted.
   *
   *  - **A registered owner**: the card already linked to them, or a card not
   *    linked to anyone whose typed number is theirs (a number somebody said
   *    «لا أحد منهم» to on this card does not count). A card whose flats are
   *    recorded as owned by somebody else is never theirs, whatever it says.
   *  - **A typed number**: an unlinked card naming that same number.
   *  - **Nothing known**: no card. Two flats whose owners nobody has named are
   *    not known to share one, and filing them together would give both the
   *    first owner anyone identifies.
   */
  private async cardHeldFrom<
    T extends {
      id: string;
      landlordCitizenId: string | null;
      landlordPhone: string | null;
      landlordLinkDismissedIds: string[];
      units: Array<{ unitId: string | null }>;
    },
  >(
    cards: readonly T[],
    landlord: LandlordSpec | null,
    owner: { id: string; phone: string | null; whatsapp: string | null } | null,
  ): Promise<T | undefined> {
    if (owner) {
      const linked = cards.find((card) => card.landlordCitizenId === owner.id);
      if (linked) return linked;

      const numbers = [owner.phone, owner.whatsapp].filter(Boolean);
      const typed = cards.filter(
        (card) =>
          !card.landlordCitizenId &&
          card.landlordPhone !== null &&
          numbers.includes(card.landlordPhone) &&
          !card.landlordLinkDismissedIds.includes(owner.id),
      );
      if (typed.length === 0) return undefined;

      const unitIds = [
        ...new Set(
          typed.flatMap((card) =>
            card.units.map((row) => row.unitId).filter((id): id is string => Boolean(id)),
          ),
        ),
      ];
      const otherOwners = unitIds.length
        ? await this.db.unitOccupancy.findMany({
            where: {
              unitId: { in: unitIds },
              toDate: null,
              role: 'OWNER',
              citizenId: { not: owner.id },
            },
            select: { unitId: true },
          })
        : [];
      const ownedElsewhere = new Set(otherOwners.map((row) => row.unitId));
      return typed.find((card) =>
        card.units.every((row) => !row.unitId || !ownedElsewhere.has(row.unitId)),
      );
    }

    const phone = landlord?.phone ?? null;
    if (phone) {
      return cards.find((card) => !card.landlordCitizenId && card.landlordPhone === phone);
    }
    return undefined;
  }


  /**
   * The canonical unit’s own description, in the shape a property card stores.
   *
   * The one conversion worth naming is the floor. `Unit.floor` is a signed
   * integer — the durable half of the unit code, basements negative — while
   * `BuildingUnit.floor` is the free text a citizen wrote on a form, which is why
   * `parseFloorLabel` exists to read «الطابق ٤» back out of it. The plain decimal
   * string is the one label that survives that round trip exactly, so it is what
   * a card minted from the register carries.
   */
  private async unitDescription(unitId: string) {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { unitType: true, floor: true, side: true, unitArea: true },
    });
    return {
      unitType: unit?.unitType ?? null,
      floor: unit == null ? null : String(unit.floor),
      side: unit?.side ?? null,
      unitArea: unit?.unitArea ?? null,
    };
  }


  /**
   * Ends a spell without deleting it — the history is the point (D2) — and
   * releases the citizen's own claim on the flat at the same time.
   *
   * ## Why the second half exists
   *
   * Who is in a flat is recorded in two places: `UnitOccupancy`, which the
   * matrix shows, and the citizen's `PropertyEntry`/`BuildingUnit` link, which
   * billing reads and which their file displays. `CensusSyncService` writes
   * both together because a registration establishes both at once. This method
   * used to write only the first, and that asymmetry was the bug:
   *
   *   • an officer ended a spell from the matrix, saw the occupant disappear,
   *     and the citizen's file went on claiming the property — so the register
   *     still answered «من يملك هذه الوحدة؟» with someone the census had
   *     already moved out;
   *   • `heldThroughOccupancy` bills from the occupancy, the file shows the
   *     property, and the two now disagreed about the same flat;
   *   • worst, it came back. `CensusSyncService` re-reads the card on the next
   *     save and re-creates the occupancy from the link nobody cleared, so
   *     correcting a phone number six weeks later silently re-housed a
   *     household the municipality had evicted on paper.
   *
   * Ending a spell is the officer stating the household is not there. That is
   * one fact, so it is now written to both records or to neither.
   */
  async endOccupancy(
    occupancyId: string,
    input: { toDate?: Date; reason: OccupancyEndReason },
    actor: StaffActor,
  ): Promise<OccupancyRow> {
    const existing = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      include: { unit: { select: { buildingId: true, unitCode: true } } },
    });
    if (!existing) throw new NotFoundError({
      code: 'OCCUPANCY_NOT_FOUND',
      message: 'Occupancy was not found',
    });

    /*
      Ending an ended spell is refused rather than re-dated.

      A double tap, or two officers on one drawer, used to move `toDate` again
      and release the file claim a second time — harmless to the claim, but it
      rewrote *when* somebody left. The first answer stands.
    */
    if (existing.toDate) {
      throw new ConflictError({
        code: 'OCCUPANCY_ALREADY_ENDED',
        message: 'Occupancy already ended',
      });
    }

    /*
      The reason has to fit the capacity.

      An owner does not «move out» — a deed is not a residence (D2), and an
      owner who left the flat but still holds it has not ended anything the
      matrix records; their unit is «شاغرة» or «مسكن موسمي». A tenant does not
      sell. Accepting either would store a history that reads as a fact and is
      not one. «سُجِّل بالخطأ» fits everyone.
    */
    const fits =
      input.reason === 'RECORDED_IN_ERROR' ||
      (existing.role === 'OWNER'
        ? input.reason === 'OWNERSHIP_TRANSFERRED'
        : input.reason === 'MOVED_OUT');
    if (!fits) {
      throw new ValidationError({
        code: existing.role === 'OWNER' ? 'OWNERSHIP_END_REASON_INVALID' : 'TENANCY_END_REASON_INVALID',
        message: `${input.reason} does not end a ${existing.role} occupancy`,
        details: { reason: input.reason },
      });
    }

    const toDate = input.toDate ?? new Date();
    if (toDate < existing.fromDate) {
      throw new ValidationError({
        code: 'OCCUPANCY_END_BEFORE_START',
        message: 'The end date is before the occupancy began',
        details: { toDate },
      });
    }

    const updated = await this.db.unitOccupancy.update({
      where: { id: occupancyId },
      data: { toDate, endReason: input.reason },
      include: { citizen: { select: { firstName: true, lastName: true, phone: true, isActive: true, residence: true } } },
    });

    const released = await this.releaseCensusClaim({
      unitId: existing.unitId,
      buildingId: existing.unit.buildingId,
      citizenId: existing.citizenId,
    });

    this.buildings.record({
      action: 'OCCUPANCY_ENDED',
      buildingId: existing.unit.buildingId,
      after: {
        unitCode: existing.unit.unitCode,
        toDate: updated.toDate,
        role: existing.role,
        reason: input.reason,
        citizenId: existing.citizenId,
        /*
          Named in the audit row because this is the part that edits somebody's
          file rather than the census, and a resident disputing a bill is
          entitled to see when their card stopped claiming the flat and who
          did it.
        */
        unitLinksCleared: released.unitLinksCleared,
        buildingLinksCleared: released.buildingLinksCleared,
      },
      actor,
    });

    // A tenant ended here leaves «مؤجرة» on a flat nobody is in — see `settle`.
    await this.buildings.settle(existing.unitId, actor, 'OCCUPANCY_ENDED');

    return toOccupancyRow(updated);
  }


  /**
   * Drops this citizen's census link to one unit, so their file stops claiming
   * a flat they are no longer recorded in.
   *
   * Two shapes of claim, because there are two ways a card reaches a unit and
   * clearing only the explicit one leaves the inferred one to resurrect it.
   *
   *   1. **An itemised unit.** A مبنى card ticks flats, and each tick is a
   *      `BuildingUnit` row carrying `unitId`. Only the link is dropped — the
   *      row itself is the citizen's own statement about a flat they filed
   *      (floor, area, أسهم), and deleting it would throw away what they said
   *      rather than what the census concluded.
   *
   *   2. **A منزل standing on a one-unit structure.** Such a card has no units
   *      to tick, so `CensusSyncService` infers the unit from the building —
   *      which means the claim lives in `PropertyEntry.buildingId` and
   *      clearing unit links alone would leave the next sync free to re-create
   *      exactly the occupancy just ended.
   *
   * Narrowed to buildings with exactly one unit, mirroring the inference it is
   * undoing. A منزل linked to a six-flat block claims nothing by inference, so
   * severing its `buildingId` would discard a link an officer made deliberately
   * and answer "this person left flat 3" by forgetting which building it was.
   *
   * A مبنى card keeps its `buildingId` for the same reason even when its last
   * tick is gone: the card is still about that structure, and it claims no unit
   * now that nothing points at one.
   */
  private async releaseCensusClaim(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
  }): Promise<{ unitLinksCleared: number; buildingLinksCleared: number }> {
    const unitLinks = await this.db.buildingUnit.updateMany({
      where: {
        unitId: input.unitId,
        // An ended row keeps naming its flat on purpose — it is the record of
        // which flat the tenancy was. Only a current claim is released.
        endedAt: null,
        propertyEntry: { endedAt: null, registration: { citizenId: input.citizenId } },
      },
      data: { unitId: null },
    });

    const unitsInBuilding = await this.db.unit.count({
      where: { buildingId: input.buildingId },
    });

    if (unitsInBuilding !== 1) {
      return { unitLinksCleared: unitLinks.count, buildingLinksCleared: 0 };
    }

    const buildingLinks = await this.db.propertyEntry.updateMany({
      where: {
        buildingId: input.buildingId,
        propertyType: 'HOUSE',
        endedAt: null,
        registration: { citizenId: input.citizenId },
        // Nothing itemised; the `buildingId` is the whole of the claim. A card
        // that still ticks a flat elsewhere in this structure is not what the
        // single-unit inference acts on, and is left alone.
        units: { none: { unitId: { not: null } } },
      },
      data: { buildingId: null },
    });

    return { unitLinksCleared: unitLinks.count, buildingLinksCleared: buildingLinks.count };
  }
}
