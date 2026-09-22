import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import {
  contradictsVacancy,
  isStructuralUnitType,
  isUnoccupied,
  unitStatusForRole,
} from '@mechanization/shared-schemas';
import type { OccupancyRole, OccupancyType } from '@mechanization/shared-schemas';
import { CasesService } from '../cases/cases.service';
import { activeVacancy, closeActiveVacancy } from './unit-vacancy';

/**
 * The write path from a citizen's registration back into the census (P5-T1).
 *
 * ## What was broken
 *
 * The census tables, the link columns on `PropertyEntry`/`BuildingUnit`, and the
 * picker that sets them all shipped in Phases 1–3. What never shipped is
 * anything that *acts* on the link when a registration arrives. `buildingId` and
 * `unitId` were written onto the rows and there it stopped — no `UnitOccupancy`,
 * no survey-status change, no visit, no case resolution.
 *
 * So an officer who tapped «تسجيل أسرة في هذه الوحدة», filled the form and saved
 * got: a matrix still showing the flat empty, a unit still reading «غير ممسوحة»,
 * a `unitsSurveyed` counter still at zero, a map pin still coloured as unvisited,
 * and the حالة that sent them there still open. Everything the census exists to
 * show was untouched by the one act that should have moved all of it.
 *
 * It was also, quietly, a billing fault rather than a display one. P2-T8's
 * `heldThroughOccupancy` bills a مبنى card carrying no unit rows from
 * `UnitOccupancy` — the only per-citizen table that can answer *which* flats
 * this person holds. Registration never wrote to it, so that path resolved to an
 * empty list and the citizen went unbilled with no complaint anywhere.
 *
 * ## Why a service and not a few lines in the repository
 *
 * Because the same facts have to be recorded identically whichever door they
 * come through, and there are now three: the registration form, the matrix's own
 * occupant form, and the offline queue replaying either. `BuildingsService.
 * recordOccupancy` is the matrix's door and already does this correctly. This is
 * the registration's door, and it delegates the parts that are genuinely the
 * same rather than restating them — a second copy of "which statuses may be
 * lifted to COMPLETE" is exactly how the map and the ledger start disagreeing.
 *
 * ## Why it runs after the transaction, not inside it
 *
 * A census hiccup must never cost a municipality a registration. The citizen,
 * their registration and their property cards are written and committed by
 * `RegistrationRepository.submit`; this runs afterwards, reads what was
 * committed, and brings the census into line with it. If it throws, the
 * registration still exists — which is the behaviour the system has today —
 * and the failure is logged and reported rather than swallowed.
 *
 * That makes it safe to re-run, and it is written to be: every write is an
 * upsert or a narrowed `updateMany`, so replaying a queued submission twice
 * produces the same census as replaying it once.
 */
@Injectable()
export class CensusSyncService {
  private readonly logger = new Logger(CensusSyncService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cases: CasesService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Brings the census into line with one registration's property cards.
   *
   * Reads the committed rows rather than taking them as an argument, for two
   * reasons that both come down to trust: the caller's in-memory draft has been
   * through domain construction and flag-stripping since it was validated, and
   * the row that was actually stored is the only version this should act on.
   * It also means the create and edit paths — which build their property rows
   * quite differently — need to pass nothing but an id.
   */
  async syncRegistration(input: {
    registrationId: string;
    citizenId: string;
    actor: { id: string; role: string };
    /**
     * Which of this citizen's spells a flat no longer claimed may be closed.
     *
     *  - `CITIZEN` (the default) — any spell any of their registrations
     *    established. What an **edit** means: the form is the citizen's current
     *    statement of everything they hold. See `endUnclaimed`.
     *  - `REGISTRATION` — only spells *this* registration established. What a
     *    **new filing** means: it adds what it names and says nothing about
     *    what the person already holds elsewhere.
     */
    scope?: 'CITIZEN' | 'REGISTRATION';
  }): Promise<CensusSyncResult> {
    const result: CensusSyncResult = {
      occupanciesCreated: 0,
      occupanciesRefreshed: 0,
      occupanciesEnded: 0,
      unitsSurveyed: 0,
      casesResolved: 0,
      vacanciesEnded: 0,
      buildingsNamed: 0,
    };

    /*
      Current cards and rows only (migration 0046).

      An ended tenancy keeps its card and its row — and the row keeps naming its
      flat, because that is the record of which flat it was. Read here, it would
      re-open the very spell «إنهاء الإيجار» just closed, the next time anybody
      saved the household's file for any reason.
    */
    const properties = await this.db.propertyEntry.findMany({
      where: { registrationId: input.registrationId, buildingId: { not: null }, endedAt: null },
      select: {
        id: true,
        propertyType: true,
        occupancyType: true,
        buildingId: true,
        buildingName: true,
        /*
          حالة الوحدة as the card states it — read so a correction on the
          citizen's file reaches سجل المباني. See `declaredStatus` below.

          The منزل card carries its own, because a منزل has no units array to
          tick; the مبنى card carries one per ticked flat.
        */
        unitStatus: true,
        units: {
          where: { endedAt: null },
          select: { id: true, unitId: true, unitStatus: true },
        },
      },
    });

    /*
      Which canonical units this registration now claims, and in what capacity.

      A map rather than a list because one citizen can legitimately reach the
      same unit twice — a مبنى card itemising flat 3, and a منزل card linked to
      the same one-unit structure — and two occupancy rows for one person in one
      flat is a duplicate, not a co-tenancy. Last writer wins, which is the same
      rule `recordOccupancy` applies when the pair already exists.
    */
    const claimed = new Map<
      string,
      {
        role: OccupancyRole;
        propertyId: string;
        buildingId: string;
        /** حالة الوحدة this card states about the flat, or null where it states none. */
        declaredStatus: string | null;
      }
    >();

    for (const property of properties) {
      const buildingId = property.buildingId;
      if (!buildingId) continue;

      /*
        The building's name, learned from the person standing in front of it.

        The card's `buildingName` is free text and the census's `Building.name`
        is the register's own — and until now nothing connected them, so two
        tenants of one block produced «بناية النور» and «بنايه النور» in two
        rows that no query could recognise as the same building.

        Promoted upward only into an *empty* name, never over one. The register
        is the authority once it has an answer (the card's field is mirrored
        read-only from it in the form), but an unnamed building has no answer to
        defend, and the officer in its stairwell is the person who knows.
      */
      if (property.buildingName?.trim()) {
        const named = await this.db.building.updateMany({
          where: { id: buildingId, OR: [{ name: null }, { name: '' }] },
          data: { name: property.buildingName.trim() },
        });
        result.buildingsNamed += named.count;
      }

      const role = OCCUPANCY_ROLE_BY_TYPE[property.occupancyType] ?? 'FREE_OCCUPANT';
      const linked = property.units.filter((unit) => unit.unitId);

      if (linked.length > 0) {
        for (const unit of linked) {
          claimed.set(unit.unitId!, {
            role,
            propertyId: property.id,
            buildingId,
            declaredStatus: unit.unitStatus ?? null,
          });
        }
        continue;
      }

      /*
        A منزل linked to a structure with exactly one unit.

        The only shape where inferring the unit is safe, and it is safe because
        there is nothing to infer *between*: a منزل card has no units array to
        tick — the picker's unit list renders for مبنى only — so a house linked
        to its own single-unit shell would otherwise be permanently unable to
        record who lives in it.

        A مبنى is deliberately excluded even when it has one unit. P2-T8 went
        down that road and reverted: a matrix says what flats exist, never how
        many of them one citizen holds, and a building that has one unit today
        can have twelve after somebody finishes the survey. The officer ticks
        them, or nothing is claimed.
      */
      if (property.propertyType !== 'HOUSE') continue;

      const units = await this.db.unit.findMany({
        where: { buildingId },
        select: { id: true },
        take: 2,
      });
      if (units.length === 1)
        claimed.set(units[0]!.id, {
          role,
          propertyId: property.id,
          buildingId,
          declaredStatus: property.unitStatus ?? null,
        });
    }

    /*
      One unit's failure must not cost the reconciliation below.

      `endUnclaimed` is the statement that *releases* flats this registration no
      longer claims, and it used to sit downstream of an unguarded loop. So a
      blip on unit 2 — a deadlock, a dropped connection, an FK — threw straight
      past it: the officer had unticked flat 3, `syncQuietly` logged and returned
      `null`, and flat 3's occupancy stayed open. `heldThroughOccupancy` then
      goes on billing that household for a flat their own file stopped claiming,
      and the matrix goes on showing them in it. Nothing retries, and the only
      sign is a line in a server log.

      The first failure is kept and rethrown after the release runs, so
      `syncQuietly` still reports the sync as failed — it did fail — but it fails
      with the census closer to the truth rather than further from it.
    */
    let firstFailure: unknown = null;

    for (const [unitId, { role, buildingId, declaredStatus }] of claimed) {
      try {
        const applied = await this.applyOccupancy({
          unitId,
          buildingId,
          citizenId: input.citizenId,
          registrationId: input.registrationId,
          role,
          declaredStatus,
          actor: input.actor,
        });

        if (applied.created) result.occupanciesCreated += 1;
        else result.occupanciesRefreshed += 1;
        result.unitsSurveyed += applied.surveyed;
        result.casesResolved += applied.casesResolved;
        if (applied.vacancyEnded) result.vacanciesEnded += 1;
      } catch (error) {
        /*
          Kept, not swallowed. The other flats on this card are independent —
          each `applyOccupancy` is its own set of narrowed writes — so stopping
          at the first one would leave more undone than carrying on does.
        */
        this.logger.error(
          `census sync: unit ${unitId} failed for registration ${input.registrationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        firstFailure ??= error;
      }
    }

    /*
      Runs whatever happened above, and is scoped to `keep` — the units this
      registration *did* claim. A unit that failed to apply is still in
      `claimed`, so a transient error never causes its occupancy to be released
      as though the officer had unticked it.
    */
    result.occupanciesEnded = await this.endUnclaimed({
      registrationId: input.registrationId,
      citizenId: input.citizenId,
      keep: [...claimed.keys()],
      actor: input.actor,
      scope: input.scope ?? 'CITIZEN',
    });

    if (firstFailure) throw firstFailure;

    return result;
  }

  /**
   * One unit: the occupancy, the survey status, the visit, and the case.
   *
   * Deliberately the same four facts, in the same order and under the same
   * rules, as `BuildingsService.recordOccupancy`. The one difference is the
   * `registrationId` stamped on the row, which is what makes the occupancy
   * traceable back to the file that established it — and what `endUnclaimed`
   * below uses to know which rows this path is allowed to touch.
   */
  private async applyOccupancy(input: {
    unitId: string;
    /** The building the *card* says this unit is in. See the guard below. */
    buildingId: string;
    citizenId: string;
    registrationId: string;
    role: OccupancyRole;
    /**
     * حالة الوحدة the card states, or null where it states none — the owner's
     * own answer, carried onto the unit by `declareUnitStatus` below.
     */
    declaredStatus: string | null;
    actor: { id: string; role: string };
  }): Promise<{
    created: boolean;
    surveyed: number;
    casesResolved: number;
    /** Whether this household moving in lifted a confirmed vacancy. */
    vacancyEnded: boolean;
  }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: {
        id: true,
        buildingId: true,
        unitCode: true,
        unitType: true,
        surveyStatus: true,
        unitStatus: true,
      },
    });

    /*
      The unit has to be in the building the card names.

      `unitId` arrives from the submission as a bare `uuid.optional()` and
      nothing has ever checked what it points at. A card linked to building A
      carrying B's unit ids — a re-render that kept a previous building's list,
      or any hand-made request from an account that can write — would create
      occupancies in B, lift B's units to «مكتملة», auto-resolve B's cases and
      move B's counters, while the card on screen still said A and nothing
      anywhere reconciled the two.

      Refused quietly rather than thrown, for the same reason the missing-unit
      case below is: the citizen's own record is committed and correct, and a
      mismatched link is a stale client rather than a bad registration. The
      census simply declines to act on a claim it cannot substantiate.
    */
    if (unit && unit.buildingId !== input.buildingId) {
      this.logger.warn(
        `census sync: unit ${input.unitId} belongs to building ${unit.buildingId}, not ${input.buildingId} as the card claims — ignored`,
      );
      return { created: false, surveyed: 0, casesResolved: 0, vacancyEnded: false };
    }

    /*
      A link pointing at a unit that no longer exists.

      Reachable and not an error: `BuildingUnit.unitId` is `SetNull` on delete,
      but a submission queued on a phone for three days carries the id it was
      given, and the unit may have been corrected away in the meantime. Skipped
      quietly — the citizen's own card is untouched and still says what they
      filed, which is the record that matters.
    */
    if (!unit) return { created: false, surveyed: 0, casesResolved: 0, vacancyEnded: false };

    /*
      A card pointing at a طابق أعمدة.

      The other half of `assertOccupiableUnit`, which `recordOccupancy` calls on
      the matrix path. Both doors refuse the same thing or the weaker one
      becomes the way round the stronger — the argument
      `assertNonResidentOccupancy` is built on, and it applies here with the
      same force: an occupancy minted on a pilotis would be claimed back onto
      the citizen's file and billed like any other.

      Reachable even though `buildingUnitSchema` refuses the *type* on a card,
      because `unitId` is a bare uuid pointing into the census: a client
      holding a stale unit list, or a grid re-render after a block was retyped
      to «طابق أعمدة», can name one. It is a mis-link, not a bad registration.

      Skipped quietly rather than thrown, unlike the matrix path — and the
      difference is deliberate. There the officer is at a screen and can pick
      another block. Here the registration has already committed and
      `syncQuietly` runs after the fact, so a throw would fail nothing except
      the census half of a record the citizen correctly filed. The warning is
      what makes it findable; the card keeps saying what the officer wrote.
    */
    if (isStructuralUnitType(unit.unitType)) {
      this.logger.warn(
        `census sync: unit ${input.unitId} (${unit.unitCode}) is a ${unit.unitType} — no occupant is recorded on a structural unit; the card's link is ignored`,
      );
      return { created: false, surveyed: 0, casesResolved: 0, vacancyEnded: false };
    }

    const current = await this.db.unitOccupancy.findFirst({
      where: { unitId: input.unitId, citizenId: input.citizenId, toDate: null },
      select: { id: true },
    });

    /*
      Has *this registration* already put this household in this flat before?

      Asked before the write below, because the write is what would make the
      answer yes. See the visit gate further down for why the question is
      scoped to the registration rather than to "is there a current spell".
    */
    const priorSpell =
      current !== null ||
      (await this.db.unitOccupancy.count({
        where: {
          unitId: input.unitId,
          citizenId: input.citizenId,
          registrationId: input.registrationId,
        },
      })) > 0;

    let vacancyEnded = false;

    /*
      A registration that puts a household into a flat confirmed empty lifts the
      confirmation, and does not ask.

      The matrix path asks — see `recordOccupancy` — because an officer is
      standing there with a screen in front of them. Here there is nobody to
      ask: the registration has already committed, `syncQuietly` runs after the
      fact, and refusing would leave the citizen's own file claiming a flat the
      census insists is empty, which is the split-record state D2 exists to
      prevent. A household filing a registration *is* the statement that they
      live there, and it is the better evidence: it names them.

      Closed as «لم تعد شاغرة» rather than «سُجِّل بالخطأ» — the flat was empty
      when it was confirmed, and somebody has since moved in. Owners are left
      alone, as everywhere: an owner registering their own empty flat contradicts
      nothing (D2).
    */
    if (input.role !== 'OWNER') {
      const closed = await closeActiveVacancy(this.db, {
        unitId: input.unitId,
        unit,
        reason: 'NO_LONGER_VACANT',
        actorId: input.actor.id,
      });
      if (closed) {
        await this.db.unit.update({
          where: { id: input.unitId },
          data: {
            ...(closed.restore.unitStatus !== undefined
              ? { unitStatus: closed.restore.unitStatus as never }
              : {}),
            ...(closed.restore.surveyStatus !== undefined
              ? { surveyStatus: closed.restore.surveyStatus as never }
              : {}),
          },
        });
        vacancyEnded = true;
        this.events.emit('building.changed', {
          tenantSlug: this.tenantContext.tenantSlug,
          action: 'UNIT_VACANCY_ENDED',
          buildingId: unit.buildingId,
          before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
          after: {
            unitCode: unit.unitCode,
            vacancyId: closed.confirmation!.id,
            reason: 'NO_LONGER_VACANT',
            citizenId: input.citizenId,
            via: 'REGISTRATION',
          },
          actorId: input.actor.id,
          actorRole: input.actor.role,
        });
      }
    }

    if (current) {
      await this.db.unitOccupancy.update({
        where: { id: current.id },
        data: { role: input.role as never, registrationId: input.registrationId },
      });
    } else {
      await this.db.unitOccupancy.create({
        data: {
          unitId: input.unitId,
          citizenId: input.citizenId,
          role: input.role as never,
          registrationId: input.registrationId,
        },
      });
    }

    /*
      A unit with a registered household in it has been surveyed.

      Narrowed to the three states that mean "we still do not know", exactly as
      `recordOccupancy` narrows it. `VACANT_CONFIRMED`, `DEMOLISHED`, `REFUSED`
      and `INACCESSIBLE` are findings that contradict this one, and a
      contradiction is for a person to look at — not for a side effect of
      somebody saving a phone number to overwrite.
    */
    const lifted = await this.db.unit.updateMany({
      where: { id: input.unitId, surveyStatus: { in: UNRESOLVED_SURVEY_STATES as never } },
      data: { surveyStatus: 'COMPLETE' },
    });

    /*
      حالة الوحدة, from the capacity just recorded — the same write
      `recordOccupancy` now makes, because the two paths must leave the census
      in the same state or the door an officer came through changes the answer.

      Null-only, so a status somebody set by hand survives. See the note there
      for the double-charge this closes: a مستأجر recorded here with the unit
      left null meant the landlord's card kept «مشغولة من المالك» and both of
      them were billed for the flat.
    */
    const impliedStatus = unitStatusForRole(input.role);
    if (impliedStatus) {
      await this.db.unit.updateMany({
        where: { id: input.unitId, unitStatus: null },
        data: { unitStatus: impliedStatus as never },
      });
    }

    /*
      …and حالة الوحدة as the owner's own card states it, which *replaces*.

      This is the half that was missing, and the gap it left is a split record
      of exactly the kind D2 exists to prevent. An officer who picked «شاغرة» on
      the card and then corrected it to «مشغولة من المالك» changed the card and
      nothing else: سجل المباني went on drawing the flat «شاغرة», the citizen's
      own file showed both answers at once («مشغولة من المالك» beside «سجل
      المباني: شاغرة»), and billing read the census's — the one that lost the
      correction (P2-T8 reads `unitStatus ?? ownerDeclaredStatus`).

      Owner cards only, and for the reason `recordOccupancy` gives at its own
      copy of this write: a مستأجر or شاغل بتسامح has no حالة to state, because
      their capacity already settles it and `unitStatusForRole` above records
      it. An owner is the one person whose card answers a question the unit
      cannot answer from who is recorded against it.

      Replacing rather than filling is the same decision `recordOccupancy` took,
      and for the same reason: this is a person stating what the flat is, not an
      inference. Narrowing it to `unitStatus: null` would fix a first filing and
      silently drop every correction after it — which is the bug.
    */
    await this.declareUnitStatus({ ...input, unit });

    /*
      A visit is logged only the first time this household is recorded here —
      ever, not merely the first time it is recorded *currently*.

      The alternative inflates «٣ محاولات» with paperwork: an officer correcting
      a misspelled surname a week later did not stand at the door again, and a
      count that rises when somebody opens a form is a count nobody can dispatch
      against.

      `!current` alone was not enough, because `endUnclaimed` ends a spell by
      setting `toDate` rather than deleting it (D2). So the ordinary correction
      — untick flat 3 by mistake, save, notice, re-tick, save — ended the spell
      and then found no *current* one, created a second, and logged a second
      visit. The cell read «٢ محاولة» for a door somebody stood at once,
      which is the exact inflation this gate exists to prevent, arriving through
      the gate itself.

      So the question is scoped to *this registration* instead. Re-saving one
      file never logs a second visit however many times a flat is unticked and
      re-ticked; a genuinely new registration on the same flat years later —
      a household that moved out and moved back — carries a different
      `registrationId` and is a real doorstep again, so it does log one.
    */
    if (!priorSpell) {
      await this.db.unitVisit.create({
        data: {
          unitId: input.unitId,
          officerId: input.actor.id,
          outcome: 'COMPLETE',
          notes: 'تسجيل أسرة عبر نموذج التسجيل',
        },
      });
    }

    const casesResolved = await this.cases.resolveForUnit(
      input.unitId,
      input.citizenId,
      input.actor,
    );

    this.events.emit('building.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'OCCUPANCY_RECORDED',
      buildingId: unit.buildingId,
      before: { surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        citizenId: input.citizenId,
        role: input.role,
        casesResolved,
        via: 'REGISTRATION',
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return { created: !current, surveyed: lifted.count, casesResolved, vacancyEnded };
  }

  /**
   * Carries حالة الوحدة from an owner's card onto the unit — and says so in the
   * building's log, because a status that decides a bill is not a silent write.
   *
   * ## What it refuses, and why it refuses rather than asks
   *
   * `recordOccupancy` poses both of these to the officer standing in front of
   * it. Here there is nobody to ask: the registration has already committed and
   * this runs after the fact. So each one is *declined*, not overridden — the
   * card keeps what the citizen filed, `ownerDeclaredStatus` goes on surfacing
   * it beside the census's answer, and the disagreement stays visible on both
   * screens for a person to settle.
   *
   * **A standing «تأكيد الشغور».** A confirmed vacancy is a finding with a
   * basis, a date and somebody's name on it, and it exempts the owner from the
   * occupancy fee. Writing «مشغولة من المالك» over it from a form somebody
   * saved would undo that finding with nothing recorded about who decided it
   * had stopped being true — which is the whole reason «إلغاء تأكيد الشغور»
   * exists and asks for a reason. The undo is a person's to make.
   *
   * **Somebody else living there.** The rule `assertMayBeCalledEmpty` applies
   * wherever a flat is called empty: a مستأجر or شاغل بتسامح recorded on the
   * unit is its occupant, and «شاغرة» written over them leaves the register
   * asserting nobody is there beside rows naming who is — read downstream as an
   * exemption, so the contradiction quietly stops a bill.
   *
   * **A «مسكن موسمي» being called empty.** The same refusal, and the other half
   * of `assertMayBeCalledEmpty`: a seasonal home is billed to its owners while
   * they are away, a vacant one is exempt, and the owners being away is what
   * «موسمي» *means*. A card filed in January saying «شاغرة» about a summer house
   * would cancel the summer's fees. The declaration that actually shortens the
   * bill is `vacancyDeclaredAt` on the unit, not this.
   */
  private async declareUnitStatus(input: {
    unitId: string;
    citizenId: string;
    role: OccupancyRole;
    declaredStatus: string | null;
    unit: { buildingId: string; unitCode: string; unitStatus: string | null };
    actor: { id: string; role: string };
  }): Promise<void> {
    const declared = input.declaredStatus;
    if (input.role !== 'OWNER' || !declared) return;
    // Already what the card says. Not a no-op worth an audit row.
    if (declared === input.unit.unitStatus) return;

    const standing = await activeVacancy(this.db, input.unitId);
    if (standing && contradictsVacancy(input.role, declared)) {
      this.logger.warn(
        `census sync: unit ${input.unit.unitCode} is confirmed vacant (${standing.id}); the owner's card says ${declared} — unit left as recorded, card unchanged`,
      );
      return;
    }

    /*
      Somebody recorded inside settles حالة الوحدة, whatever the card says —
      and this is checked for *every* declared status, not only for «شاغرة».

      Narrowed to the unoccupied ones, it read the emptiness cases and let the
      opposite one through: an owner card saying «مشغولة من المالك» about a
      flat a tenancy has already made «مؤجرة» overwrote it, from a card that
      may have been filed months before the tenant moved in. That is one flat
      claimed by two people — the owner billed the occupancy fee here and the
      tenant billed it on their own card — which is the double-count
      `OCCUPIED_BY_OTHERS` and the whole حالة الوحدة column exist to end.

      A spell that agrees with the card is not a contradiction, so «مؤجرة» over
      a tenant and «مشغولة بتسامح» over a شاغل بتسامح still pass: they are the
      two screens saying the same thing.
    */
    const living = await this.db.unitOccupancy.findMany({
      where: {
        unitId: input.unitId,
        toDate: null,
        role: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
      },
      select: { role: true },
    });
    if (living.length > 0) {
      const implied = living.some((spell) => spell.role === 'TENANT') ? 'RENTED' : 'FREE_OCCUPIED';
      if (declared !== implied) {
        this.logger.warn(
          `census sync: unit ${input.unit.unitCode} has ${living.length} recorded occupant(s) — the owner's card says ${declared}, the unit is ${implied}; unit left as recorded, card unchanged`,
        );
        return;
      }
    }

    if (isUnoccupied(declared) && (await this.isSeasonalHome(input.unitId, input.unit.unitStatus))) {
      this.logger.warn(
        `census sync: unit ${input.unit.unitCode} is a seasonal home; the owner's card says ${declared} — unit left as recorded, card unchanged`,
      );
      return;
    }

    await this.db.unit.update({
      where: { id: input.unitId },
      data: { unitStatus: declared as never },
    });

    this.events.emit('building.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'UNIT_UPDATED',
      buildingId: input.unit.buildingId,
      before: { unitCode: input.unit.unitCode, unitStatus: input.unit.unitStatus },
      after: {
        unitCode: input.unit.unitCode,
        unitStatus: declared,
        citizenId: input.citizenId,
        via: 'REGISTRATION',
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /**
   * Whether this flat is «مسكن موسمي» — by its own حالة, or by an owner's card
   * where the unit has none.
   *
   * The fallback is the half that matters, and it mirrors
   * `BuildingsService.isSeasonal`: a unit whose own حالة is null is the state
   * of every row the census painted from the street, and «موسمي» about it
   * exists only on the owner's card until somebody opens the unit editor. A
   * check on the unit alone therefore passed exactly the rows the refusal is
   * for, and a card filed in January could call a summer house empty — which
   * cancels the season's fees, because a vacant flat is exempt and a seasonal
   * one is not.
   *
   * Only live owner cards count, and only ones that say «موسمي»: the card
   * being synced states something else by construction (it is in `declared`),
   * so this reads a co-owner's answer or an earlier filing, never itself.
   */
  private async isSeasonalHome(unitId: string, unitStatus: string | null): Promise<boolean> {
    if (unitStatus) return unitStatus === 'SEASONAL';
    const declaredSeasonal = await this.db.buildingUnit.count({
      where: {
        unitId,
        endedAt: null,
        unitStatus: 'SEASONAL' as never,
        propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
      },
    });
    return declaredSeasonal > 0;
  }

  /**
   * Closes the spells this registration established and no longer claims.
   *
   * The edit path needs this: an officer who unticks a flat is saying the
   * household is not in it, and leaving the occupancy standing would keep
   * billing them for it and keep the matrix showing them there.
   *
   * ## What this is scoped to, and why it is not the registration alone
   *
   * Two rules, and the second one used to be missing:
   *
   *   • **Never a row this citizen's own filings did not establish.** An
   *     occupancy recorded straight onto the matrix carries no
   *     `registrationId`, and a colleague's registration carries one belonging
   *     to a different person. Neither is this path's to end — without that
   *     guard, saving a منزل card would silently evict everyone a stairwell
   *     survey had recorded.
   *
   *   • **Any of this citizen's registrations, not only the one being synced.**
   *     This is the fix. `RegistrationRepository.submit` *upserts* the citizen
   *     by identity document but always `create`s a registration, so filing
   *     someone who is already in the register — the ordinary «سجّل هذه الأسرة
   *     في هذه الوحدة» on a person the municipality already knows — produces a
   *     second registration against the same citizen. Scoped to one
   *     `registrationId`, the flats the *earlier* filing claimed could never be
   *     released: `getEditable` loads `take: 1`, so the officer could not even
   *     see those cards to untick them, and no save would ever close them. The
   *     household stayed recorded in a flat nothing on any screen claimed, and
   *     `heldThroughOccupancy` went on billing it.
   *
   * The widening is what the edit form already promises in words — «التعديلات
   * تُطبَّق على أحدث طلب لهذا المواطن. الطلبات السابقة تبقى كما هي في ملفه».
   * The latest filing is the citizen's current statement of what they hold;
   * earlier ones are history, and history must not keep somebody housed.
   *
   * `registrationId: { not: null }` is redundant beside the relation filter —
   * Prisma's optional to-one filter already excludes rows with no related
   * registration — and is stated anyway, because that exclusion is the whole of
   * the first rule and should not rest on a reader knowing that.
   *
   * Ended rather than deleted — D2, and the same rule `endOccupancy` follows.
   * Somebody who moved out is history the municipality needs.
   */
  private async endUnclaimed(input: {
    registrationId: string;
    citizenId: string;
    keep: readonly string[];
    actor: { id: string; role: string };
    scope: 'CITIZEN' | 'REGISTRATION';
  }): Promise<number> {
    const where = {
      citizenId: input.citizenId,
      toDate: null,
      /*
        `REGISTRATION` narrows the widening described above back to this one
        filing, for the create path. On 2026-09-12 identity-document merges put
        several brothers' registrations under one citizen, and each new filing
        closed the flat the previous brother had just been recorded in — the
        widening was right for an edit and wrong for a filing.
      */
      ...(input.scope === 'REGISTRATION'
        ? { registrationId: input.registrationId }
        : { registrationId: { not: null }, registration: { citizenId: input.citizenId } }),
      ...(input.keep.length > 0 ? { unitId: { notIn: [...input.keep] } } : {}),
    };

    /*
      Read the rows before ending them, because afterwards there is no way to
      find them again.

      This used to be a bare `updateMany` returning a count, and that left an
      eviction as the only census write with no trace: no audit row naming who
      saved the edit or when the household stopped being recorded in the flat —
      which is precisely what a resident disputing a bill asks to see — and no
      `building.changed`, so the map and the dashboard kept serving the old
      occupancy for the whole cache TTL. `BuildingsService.endOccupancy`, the
      matrix's door onto the same fact, has always emitted `OCCUPANCY_ENDED`.
      Two doors, one fact, and only one of them was telling anyone.
    */
    const closing = await this.db.unitOccupancy.findMany({
      where,
      select: { id: true, unitId: true, unit: { select: { buildingId: true, unitCode: true } } },
    });

    if (closing.length === 0) return 0;

    const ended = await this.db.unitOccupancy.updateMany({
      where,
      data: { toDate: new Date() },
    });

    for (const row of closing) {
      this.events.emit('building.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        action: 'OCCUPANCY_ENDED',
        buildingId: row.unit.buildingId,
        before: { unitCode: row.unit.unitCode, citizenId: input.citizenId },
        after: { occupancyId: row.id, via: 'REGISTRATION' },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }

    return ended.count;
  }

  /**
   * Runs the sync and refuses to let its failure become the caller's.
   *
   * The registration has already committed by the time this is called. Throwing
   * here would answer a saved record with an error and send the officer back to
   * re-enter a household the municipality already holds — or, on a phone, put
   * the submission back in the queue to be delivered a second time.
   *
   * So it is logged loudly and reported as `null`, which callers surface rather
   * than hide: the record is safe, the census is behind, and the link can be
   * re-made from the ledger. Silence is the one option not on the table.
   */
  async syncQuietly(input: {
    registrationId: string;
    citizenId: string;
    actor: { id: string; role: string };
    scope?: 'CITIZEN' | 'REGISTRATION';
  }): Promise<CensusSyncResult | null> {
    try {
      const result = await this.syncRegistration(input);
      await this.markCensusSync(input.registrationId, true);
      return result;
    } catch (error) {
      this.logger.error(
        `census sync failed for registration ${input.registrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.markCensusSync(input.registrationId, false);
      return null;
    }
  }

  /**
   * Records that a sync ran, and whether it worked (migration 0055).
   *
   * The log line above is the only trace this used to leave, and it lives on
   * whichever instance happened to serve the request. That is not a place
   * anyone can query "which registrations does the census disagree with?" — so
   * the answer goes in the register instead.
   *
   * Two columns rather than one boolean: `censusSyncFailedAt` later than
   * `censusSyncedAt` is "they disagree right now", and the pair also says how
   * long ago it started disagreeing, which is what decides whether it matters.
   *
   * No error text is stored. A Postgres error quotes the row that caused it,
   * and these rows carry national ID numbers and residency status — a column
   * for the message would be a citizen-data column nobody agreed to create.
   *
   * Its own failure is swallowed, and deliberately: this runs after the
   * citizen's transaction has committed, and a marker that could not be written
   * must not turn a successful save into an error the officer sees. A missing
   * marker degrades to the behaviour that existed before this column did.
   */
  private async markCensusSync(registrationId: string, succeeded: boolean): Promise<void> {
    try {
      await this.db.registration.update({
        where: { id: registrationId },
        data: succeeded
          ? { censusSyncedAt: new Date(), censusSyncFailedAt: null }
          : { censusSyncFailedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `could not record census sync state for registration ${registrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** What one sync changed, so the caller can tell the officer what happened. */
export interface CensusSyncResult {
  occupanciesCreated: number;
  occupanciesRefreshed: number;
  /** Spells this registration used to claim and no longer does. */
  occupanciesEnded: number;
  /** Units lifted out of «غير ممسوحة» / «زيارة بلا رد» / «بيانات ناقصة». */
  unitsSurveyed: number;
  casesResolved: number;
  /**
   * Units whose confirmed vacancy this registration lifted — because it
   * recorded a household living in a flat the municipality had called empty.
   *
   * Reported for `casesResolved`'s reason: it changes what the owner is billed,
   * and it happened to a record nobody had open. Silent would be worse here
   * than anywhere, since the officer's own screen shows no unit matrix.
   */
  vacanciesEnded: number;
  /** Structures that had no name until this card supplied one. */
  buildingsNamed: number;
}

/**
 * `OccupancyType` on a card → `OccupancyRole` on a unit.
 *
 * The two enums hold the same three values and are deliberately separate — one
 * is a field on a citizen's file, the other a row on the matrix that routinely
 * exists without one. Stated as a map rather than a cast so that the day either
 * enum gains a value, this is a compile-time hole with a name rather than a
 * silent `FREE_OCCUPANT`.
 *
 * It was typed `Record<string, string>`, which promised exactly that and
 * delivered the opposite: every key type-checked, no key was required, and a
 * new `OccupancyType` would have fallen straight through the `??` below into
 * the silent default the docblock says it exists to prevent. `Record<
 * OccupancyType, OccupancyRole>` is what makes the sentence above true — adding
 * a value to either enum now fails the build here, by name.
 */
const OCCUPANCY_ROLE_BY_TYPE: Record<OccupancyType, OccupancyRole> = {
  OWNER: 'OWNER',
  TENANT: 'TENANT',
  FREE_OCCUPANT: 'FREE_OCCUPANT',
};

/**
 * The survey states an occupancy is allowed to lift.
 *
 * Mirrors the list in `BuildingsService.recordOccupancy` and must keep
 * mirroring it: these are the three that mean nobody has an answer yet.
 */
const UNRESOLVED_SURVEY_STATES: readonly string[] = [
  'NOT_SURVEYED',
  'VISITED_NO_ANSWER',
  'PARTIAL',
];
