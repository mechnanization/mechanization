import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as turf from '@turf/turf';
import { formatBuildingCode, nextBuildingSuffix, citizenDisplayName } from '@mechanization/shared-schemas';
import type { CorrectBuildingParcelInput } from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { AuditService, type BuildingChange, type CitizenChange } from '../audit/audit.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { BuildingsService, sharedParcelsExcluding } from './buildings.service';

/**
 * «تصحيح رقم العقار» — a building was filed under the wrong parcel.
 *
 * ## Why this was impossible
 *
 * `updateBuildingSchema` never accepted `parcelNumber`, and deleting a building
 * is refused as soon as anyone has lived in it. So once a building had
 * residents, a wrong parcel number was permanent — and the building-unit
 * picker copied it onto every citizen card linked to the building.
 *
 * ## What a correction is
 *
 * Not a move. The structure is where it always was; the number was wrong. So
 * the building keeps its id, its units, its occupants and all of its history,
 * and in one transaction:
 *
 *  1. It gets the suffix the right parcel allocates, under the same per-parcel
 *     advisory lock `BuildingsService.create` takes (both parcels, in a fixed
 *     order), and the code that suffix and the right parcel's sector derive.
 *  2. Its old code is retired into `building_code_aliases`: search still finds
 *     the building by it, and no building is ever given it again. A building
 *     corrected back to a parcel it had left takes its own old code back.
 *  3. The citizen cards linked to it that copy its parcel — current and ended,
 *     since an ended card is a record of *this* building too — take the right
 *     number, and the cadastre point of the right parcel, as a card saved with
 *     that number would. Cards naming one of its shared parcels, or naming
 *     some other number, are left as they are and reported.
 *  4. The cases filed about it under the old number take the new one.
 *
 * The correction is refused, as a creation is, when the right parcel already
 * carries a structure the officer has not looked at (`acknowledgedDuplicates`).
 * A pin outside the right parcel's outline is reported, not refused: the pin is
 * the entrance, and entrances are on the street.
 *
 * Nothing about billing changes: no fee is assessed by parcel or sector — the
 * number only labels an assessment's lines — and issued bills keep what they
 * were issued with. See the preview's `bills` note.
 */
/** A change a parcel correction records, as the audit trail and the caches read it. */
type CorrectionChange =
  | { channel: 'building.changed'; payload: BuildingChange & { tenantSlug: string } }
  | { channel: 'citizen.changed'; payload: CitizenChange & { tenantSlug: string } };

@Injectable()
export class ParcelCorrectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly buildings: BuildingsService,
    private readonly events: EventEmitter2,
    private readonly auditTrail: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  // ─────────────────────────────  Preview  ─────────────────────────────

  /** What correcting this building to `parcelNumber` would do — read before anything is asked. */
  async preview(id: string, parcelNumber: string): Promise<ParcelCorrectionPreview> {
    const before = await this.loadBuilding(id);
    const next = this.nextParcel(before, parcelNumber);

    const [zoneBefore, zoneAfter, cadastre, neighbours, inUse, ownRetired, linkedCards, unlinked, cases] =
      await Promise.all([
        this.buildings.zoneFor(before.parcelNumber),
        this.buildings.zoneFor(next),
        this.cadastre(next, before),
        this.buildings.neighboursOn(next, before),
        this.buildings.suffixesInUse(this.db, next, id),
        this.db.buildingCodeAlias.findFirst({
          where: { buildingId: id, parcelNumber: next },
          select: { codeSuffix: true },
        }),
        this.db.propertyEntry.findMany({
          where: { buildingId: id },
          select: {
            id: true,
            propertyNumber: true,
            endedAt: true,
            registration: {
              select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true, residence: true } } },
            },
          },
        }),
        this.db.propertyEntry.groupBy({
          by: ['propertyNumber'],
          where: { buildingId: null, propertyNumber: { in: [before.parcelNumber, next] } },
          _count: { _all: true },
        }),
        this.db.case.count({ where: this.casesWhere(id, before.parcelNumber) }),
      ]);

    const reclaims = Boolean(ownRetired && !inUse.includes(ownRetired.codeSuffix));
    const codeSuffix = reclaims ? ownRetired!.codeSuffix : nextBuildingSuffix(inUse);

    const followOld = (card: (typeof linkedCards)[number]) => card.propertyNumber === before.parcelNumber;
    const rewritten = linkedCards.filter(followOld);
    const holders = new Map<string, string>();
    for (const card of rewritten) {
      const citizen = card.registration.citizen;
      holders.set(citizen.id, fullName(citizen));
    }
    const unlinkedOn = (number: string) =>
      unlinked.find((row) => row.propertyNumber === number)?._count._all ?? 0;

    return {
      building: {
        id: before.id,
        code: before.code,
        parcelNumber: before.parcelNumber,
        sharedParcelNumbers: before.sharedParcelNumbers,
        zoneCode: zoneBefore?.code ?? null,
        zoneName: zoneBefore?.name ?? null,
        hasPin: before.latitude != null && before.longitude != null,
        updatedAt: before.updatedAt.toISOString(),
      },
      next: {
        parcelNumber: next,
        codeSuffix,
        code: formatBuildingCode({ zoneCode: zoneAfter?.code, parcelNumber: next, codeSuffix }),
        zoneCode: zoneAfter?.code ?? null,
        zoneName: zoneAfter?.name ?? null,
        zoneChanged: (zoneBefore?.code ?? null) !== (zoneAfter?.code ?? null),
        reclaimsOwnCode: reclaims,
        wasSharedParcel: before.sharedParcelNumbers.includes(next),
      },
      cadastre,
      neighbours: neighbours.filter((row) => row.id !== id),
      cards: {
        toRewrite: rewritten.length,
        current: rewritten.filter((card) => card.endedAt === null).length,
        citizenCount: holders.size,
        citizens: [...holders.entries()].slice(0, PREVIEW_NAMES).map(([citizenId, name]) => ({ citizenId, name })),
        underSharedParcel: linkedCards.filter(
          (card) => card.propertyNumber != null && before.sharedParcelNumbers.includes(card.propertyNumber),
        ).length,
        otherNumber: linkedCards.filter(
          (card) =>
            card.propertyNumber !== before.parcelNumber &&
            !(card.propertyNumber != null && before.sharedParcelNumbers.includes(card.propertyNumber)),
        ).length,
      },
      unlinkedOnOldParcel: unlinkedOn(before.parcelNumber),
      unlinkedOnNewParcel: unlinkedOn(next),
      cases,
    };
  }

  // ─────────────────────────────  Correcting  ─────────────────────────────

  async correct(
    id: string,
    input: CorrectBuildingParcelInput,
    actor: { id: string; role: string },
  ): Promise<ParcelCorrectionResult> {
    const before = await this.loadBuilding(id);
    await this.buildings.assertFresh(before, input.expectedUpdatedAt, actor);
    const next = this.nextParcel(before, input.parcelNumber);
    const reason = input.reason.trim();
    const keepOld = Boolean(input.keepOldAsShared);

    /*
      The right parcel already carries a structure: the same question creation
      asks, and for the same reason — two records of one building on one parcel
      is the duplicate every count downstream gets wrong. Asked before the
      transaction, and the candidates travel with the refusal.
    */
    const neighbours = (await this.buildings.neighboursOn(next, before)).filter((row) => row.id !== id);
    if (neighbours.length > 0 && !input.acknowledgedDuplicates) {
      throw new ConflictError({
        code: 'PARCEL_HAS_OTHER_BUILDINGS',
        message: `${neighbours.length} building(s) already recorded on parcel ${next}`,
        params: { count: neighbours.length, parcel: next },
        details: { parcelNumber: next, candidates: neighbours },
      });
    }

    const cadastre = await this.cadastre(next, before);
    // Read before the correction, so the trail's «before» is the zone as it was.
    const zoneBefore = await this.buildings.zoneFor(before.parcelNumber);

    let changes: CorrectionChange[] = [];
    const outcome = await runInTenantTransaction(this.tenantContext, async () => {
      /*
        Both parcels' suffix locks, in a fixed order so two corrections crossing
        between the same two parcels cannot deadlock. The key is
        `BuildingsService.create`'s, character for character: a creation on
        either parcel waits for this correction and then sees its result.
      */
      for (const parcel of [before.parcelNumber, next].sort()) {
        await this.db.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `${this.tenantContext.schemaName}:building-suffix:${parcel}`,
        );
      }

      // Read again under the locks: another correction may have landed since.
      const current = await this.db.building.findUnique({
        where: { id },
        select: { parcelNumber: true, codeSuffix: true, code: true, sharedParcelNumbers: true },
      });
      if (!current || current.parcelNumber !== before.parcelNumber || current.codeSuffix !== before.codeSuffix) {
        throw new ConflictError({
          code: 'PARCEL_CHANGED_CONCURRENTLY',
          message: 'This building’s parcel number just changed. Reopen it.',
        });
      }

      const inUse = await this.buildings.suffixesInUse(this.db, next, id);
      const ownRetired = await this.db.buildingCodeAlias.findFirst({
        where: { buildingId: id, parcelNumber: next },
        select: { id: true, codeSuffix: true },
      });
      const reclaims = Boolean(ownRetired && !inUse.includes(ownRetired.codeSuffix));
      const codeSuffix = reclaims ? ownRetired!.codeSuffix : nextBuildingSuffix(inUse);
      if (reclaims) await this.db.buildingCodeAlias.delete({ where: { id: ownRetired!.id } });

      const zone = await this.buildings.zoneFor(next, this.db);
      const code = formatBuildingCode({ zoneCode: zone?.code, parcelNumber: next, codeSuffix });

      await this.db.buildingCodeAlias.create({
        data: {
          buildingId: id,
          code: current.code,
          parcelNumber: before.parcelNumber,
          codeSuffix: before.codeSuffix,
          reason,
          retiredById: actor.id,
        },
      });

      const sharedParcelNumbers = sharedParcelsExcluding(
        [...current.sharedParcelNumbers, ...(keepOld ? [before.parcelNumber] : [])],
        next,
      );
      let updated;
      try {
        updated = await this.db.building.update({
          where: { id },
          data: { parcelNumber: next, codeSuffix, code, sharedParcelNumbers },
        });
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          throw new ConflictError({
            code: 'BUILDING_CODE_TAKEN',
            message: `Code ${code} is used by another building. Try again.`,
            params: { code },
            details: { code },
          });
        }
        throw caught;
      }

      /*
        What copies the building's parcel follows it — unless the old parcel
        stays on the building as a shared one, when a card naming it is still
        right. Read first, so the audit row can name exactly what moved.
      */
      const cards = keepOld
        ? []
        : await this.db.propertyEntry.findMany({
            where: { buildingId: id, propertyNumber: before.parcelNumber },
            select: { id: true, endedAt: true, registration: { select: { citizenId: true } } },
          });
      if (cards.length > 0) {
        await this.db.propertyEntry.updateMany({
          where: { id: { in: cards.map((card) => card.id) } },
          data: {
            propertyNumber: next,
            // What a card saved with this number carries: the parcel's cadastre point, or none.
            latitude: cadastre.point?.latitude ?? null,
            longitude: cadastre.point?.longitude ?? null,
          },
        });
      }

      const cases = keepOld
        ? []
        : await this.db.case.findMany({ where: this.casesWhere(id, before.parcelNumber), select: { id: true } });
      if (cases.length > 0) {
        await this.db.case.updateMany({
          where: { id: { in: cases.map((row) => row.id) } },
          data: { propertyNumber: next },
        });
      }

      const byCitizen = new Map<string, string[]>();
      for (const card of cards) {
        const list = byCitizen.get(card.registration.citizenId) ?? [];
        list.push(card.id);
        byCitizen.set(card.registration.citizenId, list);
      }

      /*
        Before and after in full: a building's parcel is not a sensitive value,
        and «who moved Z-1-45-A, from what, to what, and why» is the row somebody
        holding an old receipt will need. Each holder's own trail says why their
        card's رقم العقار changed.
      */
      const base = { tenantSlug: this.tenantContext.tenantSlug, actorId: actor.id, actorRole: actor.role };
      changes = [
        {
          channel: 'building.changed',
          payload: {
            ...base,
            action: 'BUILDING_PARCEL_CORRECTED',
            buildingId: id,
            before: {
              parcelNumber: before.parcelNumber,
              codeSuffix: before.codeSuffix,
              code: before.code,
              sharedParcelNumbers: before.sharedParcelNumbers,
              zoneCode: zoneBefore?.code ?? null,
            },
            after: {
              parcelNumber: next,
              codeSuffix: updated.codeSuffix,
              code: updated.code,
              sharedParcelNumbers,
              zoneCode: zone?.code ?? null,
              reason,
              ...(reclaims ? { reclaimedOwnCode: true } : {}),
              ...(keepOld ? { keptOldAsShared: true } : {}),
              cardsCorrected: cards.map((card) => card.id),
              casesCorrected: cases.map((row) => row.id),
              pinInsideNewParcel: cadastre.pinInside,
              ...(neighbours.length > 0
                ? {
                    acknowledgedNeighbours: neighbours.map((row) => ({
                      id: row.id,
                      code: row.code,
                      distanceMetres: row.distanceMetres,
                    })),
                  }
                : {}),
            },
          },
        },
        ...[...byCitizen].map(
          ([citizenId, propertyEntryIds]): CorrectionChange => ({
            channel: 'citizen.changed',
            payload: {
              ...base,
              citizenId,
              action: 'PROPERTY_NUMBER_CORRECTED',
              before: { propertyNumber: before.parcelNumber, buildingCode: before.code },
              after: { propertyNumber: next, buildingCode: updated.code, buildingId: id, propertyEntryIds, reason },
            },
          }),
        ),
      ];
      // Tier 1 (docs/security.md): the correction and its rows commit together.
      for (const change of changes) await this.auditTrail.recordChangeInTransaction(change);

      return { updated, cards, cases, reclaims, zone, sharedParcelNumbers, citizensAffected: byCitizen.size };
    });

    // After the commit: the same changes as events, for the caches. The rows are already written.
    for (const change of changes) this.events.emit(change.channel, { ...change.payload, alreadyAudited: true });

    return {
      building: {
        id,
        parcelNumber: next,
        codeSuffix: outcome.updated.codeSuffix,
        code: outcome.updated.code,
        sharedParcelNumbers: outcome.sharedParcelNumbers,
        updatedAt: outcome.updated.updatedAt.toISOString(),
      },
      previousCode: before.code,
      reclaimedOwnCode: outcome.reclaims,
      cardsCorrected: outcome.cards.length,
      citizensAffected: outcome.citizensAffected,
      casesCorrected: outcome.cases.length,
      pinInsideNewParcel: cadastre.pinInside,
    };
  }

  // ─────────────────────────────  Helpers  ─────────────────────────────

  private async loadBuilding(id: string) {
    const building = await this.db.building.findUnique({ where: { id } });
    if (!building) throw new NotFoundError({
      code: 'BUILDING_NOT_FOUND',
      message: 'This building could not be found.',
    });
    return building;
  }

  private nextParcel(before: { parcelNumber: string }, parcelNumber: string): string {
    const next = parcelNumber.trim();
    if (!next) throw new ValidationError({
      code: 'PARCEL_NUMBER_REQUIRED',
      message: 'Enter the correct parcel number.',
      details: { parcelNumber },
    });
    if (next === before.parcelNumber) {
      throw new ValidationError({
        code: 'PARCEL_NUMBER_UNCHANGED',
        message: 'That is already the building’s parcel number.',
        details: { parcelNumber: next },
      });
    }
    return next;
  }

  /** Cases about this building — filed on it, or on one of its units — under the old number. */
  private casesWhere(buildingId: string, parcelNumber: string): Prisma.CaseWhereInput {
    return {
      propertyNumber: parcelNumber,
      OR: [{ buildingId }, { unit: { buildingId } }],
    };
  }

  /**
   * What the cadastre says about the right parcel: whether it is known (null
   * when this municipality has no cadastre loaded, which means "any number"),
   * its point, and whether the building's pin lies inside its outline (null
   * when either is missing — an unknown outline is never a containment
   * failure; see `Parcel.boundary`).
   */
  private async cadastre(
    parcelNumber: string,
    pin: { latitude: number | null; longitude: number | null },
  ): Promise<{
    known: boolean | null;
    point: { latitude: number; longitude: number } | null;
    pinInside: boolean | null;
  }> {
    const [parcel, size] = await Promise.all([
      this.db.parcel.findUnique({
        where: { parcelNumber },
        select: { latitude: true, longitude: true, boundary: true },
      }),
      this.db.parcel.count(),
    ]);
    let pinInside: boolean | null = null;
    if (parcel?.boundary && pin.latitude != null && pin.longitude != null) {
      try {
        pinInside = turf.booleanPointInPolygon([pin.longitude, pin.latitude], parcel.boundary as never);
      } catch {
        pinInside = null;
      }
    }
    return {
      known: size > 0 ? parcel !== null : null,
      point: parcel ? { latitude: parcel.latitude, longitude: parcel.longitude } : null,
      pinInside,
    };
  }
}

const PREVIEW_NAMES = 12;

/** A citizen's name as shown — «ورثة المرحوم …» for an estate (0076). */
function fullName(person: { firstName: string; middleName?: string | null; lastName: string; residence?: string | null }): string {
  return citizenDisplayName(person);
}

type Neighbour = Awaited<ReturnType<BuildingsService['neighboursOn']>>[number];

export interface ParcelCorrectionPreview {
  building: {
    id: string;
    code: string;
    parcelNumber: string;
    sharedParcelNumbers: string[];
    zoneCode: string | null;
    zoneName: string | null;
    hasPin: boolean;
    updatedAt: string;
  };
  next: {
    parcelNumber: string;
    /** Predicted: allocated under the parcel lock on save, so a creation in between can move it on. */
    codeSuffix: string;
    code: string;
    zoneCode: string | null;
    zoneName: string | null;
    zoneChanged: boolean;
    /** Corrected back to a parcel it had left: it takes its own old code back. */
    reclaimsOwnCode: boolean;
    /** The right parcel was one of the building's shared ones. */
    wasSharedParcel: boolean;
  };
  cadastre: {
    known: boolean | null;
    point: { latitude: number; longitude: number } | null;
    pinInside: boolean | null;
  };
  /** Other structures standing on the right parcel — the duplicate question. */
  neighbours: Neighbour[];
  cards: {
    /** Linked cards naming the old parcel — they take the new number. */
    toRewrite: number;
    /** Of those, the current ones (the rest are ended tenancies and ownerships). */
    current: number;
    citizenCount: number;
    citizens: Array<{ citizenId: string; name: string }>;
    /** Linked cards naming one of the building's shared parcels — left as they are. */
    underSharedParcel: number;
    /** Linked cards naming neither — left as they are, for somebody to look at. */
    otherNumber: number;
  };
  /** Cards not linked to any building that name the old parcel — not changed. */
  unlinkedOnOldParcel: number;
  /** Cards not linked to any building that name the right parcel — possibly this building. */
  unlinkedOnNewParcel: number;
  /** Cases about this building under the old number — they take the new one. */
  cases: number;
}

export interface ParcelCorrectionResult {
  building: {
    id: string;
    parcelNumber: string;
    codeSuffix: string;
    code: string;
    sharedParcelNumbers: string[];
    updatedAt: string;
  };
  previousCode: string;
  reclaimedOwnCode: boolean;
  cardsCorrected: number;
  citizensAffected: number;
  casesCorrected: number;
  pinInsideNewParcel: boolean | null;
}
