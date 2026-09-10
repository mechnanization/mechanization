import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { CasesService } from '../cases/cases.service';

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
  }): Promise<CensusSyncResult> {
    const result: CensusSyncResult = {
      occupanciesCreated: 0,
      occupanciesRefreshed: 0,
      occupanciesEnded: 0,
      unitsSurveyed: 0,
      casesResolved: 0,
      buildingsNamed: 0,
    };

    const properties = await this.db.propertyEntry.findMany({
      where: { registrationId: input.registrationId, buildingId: { not: null } },
      select: {
        id: true,
        propertyType: true,
        occupancyType: true,
        buildingId: true,
        buildingName: true,
        units: { select: { id: true, unitId: true } },
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
    const claimed = new Map<string, { role: string; propertyId: string }>();

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
          claimed.set(unit.unitId!, { role, propertyId: property.id });
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
      if (units.length === 1) claimed.set(units[0]!.id, { role, propertyId: property.id });
    }

    for (const [unitId, { role }] of claimed) {
      const applied = await this.applyOccupancy({
        unitId,
        citizenId: input.citizenId,
        registrationId: input.registrationId,
        role,
        actor: input.actor,
      });

      if (applied.created) result.occupanciesCreated += 1;
      else result.occupanciesRefreshed += 1;
      result.unitsSurveyed += applied.surveyed;
      result.casesResolved += applied.casesResolved;
    }

    result.occupanciesEnded = await this.endUnclaimed({
      registrationId: input.registrationId,
      citizenId: input.citizenId,
      keep: [...claimed.keys()],
    });

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
    citizenId: string;
    registrationId: string;
    role: string;
    actor: { id: string; role: string };
  }): Promise<{ created: boolean; surveyed: number; casesResolved: number }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, buildingId: true, unitCode: true, surveyStatus: true },
    });

    /*
      A link pointing at a unit that no longer exists.

      Reachable and not an error: `BuildingUnit.unitId` is `SetNull` on delete,
      but a submission queued on a phone for three days carries the id it was
      given, and the unit may have been corrected away in the meantime. Skipped
      quietly — the citizen's own card is untouched and still says what they
      filed, which is the record that matters.
    */
    if (!unit) return { created: false, surveyed: 0, casesResolved: 0 };

    const current = await this.db.unitOccupancy.findFirst({
      where: { unitId: input.unitId, citizenId: input.citizenId, toDate: null },
      select: { id: true },
    });

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
      A visit is logged only when the occupancy is new.

      The alternative inflates «٣ محاولات» with paperwork: an officer correcting
      a misspelled surname a week later did not stand at the door again, and a
      count that rises when somebody opens a form is a count nobody can dispatch
      against. A newly created occupancy, by contrast, is somebody having got an
      answer at that flat — which is precisely what the visit log records.
    */
    if (!current) {
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

    return { created: !current, surveyed: lifted.count, casesResolved };
  }

  /**
   * Closes the spells this registration established and no longer claims.
   *
   * The edit path needs this: an officer who unticks a flat is saying the
   * household is not in it, and leaving the occupancy standing would keep
   * billing them for it and keep the matrix showing them there.
   *
   * Scoped to rows carrying **this** `registrationId`, which is the whole of
   * why the column is stamped above. An occupancy an officer recorded straight
   * onto the matrix carries none, and a colleague's registration carries a
   * different one; neither is this path's to end. Without that scope, saving a
   * منزل card would silently evict everyone a stairwell survey had recorded.
   *
   * Ended rather than deleted — D2, and the same rule `endOccupancy` follows.
   * Somebody who moved out is history the municipality needs.
   */
  private async endUnclaimed(input: {
    registrationId: string;
    citizenId: string;
    keep: readonly string[];
  }): Promise<number> {
    const ended = await this.db.unitOccupancy.updateMany({
      where: {
        registrationId: input.registrationId,
        citizenId: input.citizenId,
        toDate: null,
        ...(input.keep.length > 0 ? { unitId: { notIn: [...input.keep] } } : {}),
      },
      data: { toDate: new Date() },
    });

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
  }): Promise<CensusSyncResult | null> {
    try {
      return await this.syncRegistration(input);
    } catch (error) {
      this.logger.error(
        `census sync failed for registration ${input.registrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
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
 */
const OCCUPANCY_ROLE_BY_TYPE: Record<string, string> = {
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
