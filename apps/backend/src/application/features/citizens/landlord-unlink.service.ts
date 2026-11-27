import { Injectable } from '@nestjs/common';
import { citizenStoredName } from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError, NotFoundError } from '../../../domain/errors/domain-error';
import { claimsFlat } from '../../../domain/entities/census-claim';
import { AnnouncedChange, LandlordLinkService, PendingEvent, RevertReport, SaleRelease, UnlinkPreview, UnlinkResult, emptyReport, fullName, readFootprint } from './landlord-link.service';

function emptyUnlink(): UnlinkResult {
  return { unlinked: false, ...emptyReport(), reviewUnits: [] };
}

function summarise(report: RevertReport) {
  return {
    legacy: report.legacy,
    occupanciesEnded: report.occupanciesEnded,
    rowsRemoved: report.rowsRemoved,
    cardsRemoved: report.cardsRemoved,
    casesReopened: report.casesReopened,
    kept: report.kept.length,
  };
}

/**
 * Undoing an owner link: «فك الربط» and its preview (`unlinkPreview`, `unlink`,
 * `revertLink`), and what a sale or an ended tenancy takes back (`releaseForSale`,
 * `detachUnits`). Each reverts exactly what the link wrote, read from its
 * footprint by `LandlordLinkService.revertUnits`, which the reconcile on a save
 * shares. Out of `LandlordLinkService` (audit GOD-08).
 */
@Injectable()
export class LandlordUnlinkService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly links: LandlordLinkService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * What «إلغاء الربط» would do, for the confirmation dialog to state before
   * the button is pressed.
   */
  async unlinkPreview(propertyEntryId: string): Promise<UnlinkPreview> {
    const entry = await this.db.propertyEntry.findUnique({
      where: { id: propertyEntryId },
      select: {
        id: true,
        landlordCitizenId: true,
        landlordLinkFootprint: true,
        endedAt: true,
        landlordCitizen: { select: { id: true, firstName: true, middleName: true, lastName: true, residence: true } },
        units: { select: { unit: { select: { unitCode: true } } } },
      },
    });
    if (!entry) throw new NotFoundError({
      code: 'PROPERTY_CARD_NOT_FOUND',
      message: 'This property card could not be found.',
    });
    if (!entry.landlordCitizenId || !entry.landlordCitizen || entry.endedAt) {
      return {
        linked: false,
        ownerId: null,
        ownerName: null,
        legacy: false,
        linkedAt: null,
        unitCodes: [],
        cardsCreated: 0,
        invoicesSinceLink: 0,
      };
    }

    const footprint = readFootprint(entry.landlordLinkFootprint, entry.landlordCitizenId);
    /*
      Bills raised on the owner since the link are not touched by an undo — a
      notice somebody issued is the municipality's record of what was charged —
      but the clerk has to know they exist before deciding.
    */
    const invoicesSinceLink = footprint
      ? await this.db.citizenPayment.count({
          where: {
            citizenId: entry.landlordCitizenId,
            createdAt: { gte: new Date(footprint.linkedAt) },
          },
        })
      : 0;

    return {
      linked: true,
      ownerId: entry.landlordCitizen.id,
      ownerName: fullName(entry.landlordCitizen),
      legacy: footprint === null,
      linkedAt: footprint?.linkedAt ?? null,
      unitCodes: footprint
        ? footprint.units.map((unit) => unit.unitCode).filter((code): code is string => Boolean(code))
        : entry.units.map((row) => row.unit?.unitCode).filter((code): code is string => Boolean(code)),
      cardsCreated: footprint?.mintedCardIds.length ?? 0,
      invoicesSinceLink,
    };
  }

  /**
   * Undoes a link: the claim goes back to the queue, and what the link wrote
   * into the owner's records is reverted — exactly that, and only while it
   * still says what the link wrote.
   *
   * What survives, and why each is kept rather than deleted:
   *  - a unit row or card a person has edited since (or attached a deed to):
   *    that is now somebody's statement, reported for a person to review;
   *  - a flat another tenant's link on the same owner still claims: moved into
   *    that link's footprint, so undoing *that* link later reverts it;
   *  - a flat the owner's own card claimed before the link: the owner said so;
   *  - invoices: see `unlinkPreview`.
   *
   * Occupancies are ended «سُجِّل بالخطأ», never deleted (D2).
   */
  async unlink(input: {
    propertyEntryId: string;
    actor: { id: string; role: string };
  }): Promise<UnlinkResult> {
    const entry = await this.db.propertyEntry.findUnique({
      where: { id: input.propertyEntryId },
      select: {
        id: true,
        landlordCitizenId: true,
        landlordLinkFootprint: true,
        endedAt: true,
        registration: { select: { citizenId: true } },
        buildingId: true,
        units: { select: { unitId: true, unit: { select: { unitCode: true, buildingId: true } } } },
      },
    });
    if (!entry) throw new NotFoundError({
      code: 'PROPERTY_CARD_NOT_FOUND',
      message: 'This property card could not be found.',
    });
    if (!entry.landlordCitizenId) return { ...emptyUnlink(), unlinked: false };
    /*
      The link on an ended tenancy is the record of who the landlord was, and
      what it put on the owner's file became the owner's own when the tenancy
      ended. Undoing it now would revert nothing and falsify the history.
    */
    if (entry.endedAt) {
      throw new ConflictError({
        code: 'TENANCY_ENDED_LINK_KEPT',
        message: 'This tenancy has ended. The link is kept as the record of who the owner was.',
        details: {
          propertyEntryId: input.propertyEntryId,
        },
      });
    }

    const ownerId = entry.landlordCitizenId;
    const events: PendingEvent[] = [];
    let unlinked: AnnouncedChange[] = [];

    const report = await this.links.inTransaction(async () => {
      const outcome = await this.revertLink(this.db, {
        entryId: entry.id,
        ownerId,
        footprint: entry.landlordLinkFootprint,
      });
      events.push(...outcome.events);

      const cleared = await this.db.propertyEntry.updateMany({
        where: { id: entry.id, landlordCitizenId: ownerId },
        data: { landlordCitizenId: null, landlordLinkFootprint: Prisma.DbNull },
      });
      if (cleared.count === 0) {
        throw new ConflictError({
          code: 'LANDLORD_LINK_CHANGED_CONCURRENTLY',
          message: 'This card’s owner link just changed. Refresh the page.',
          details: {
            propertyEntryId: entry.id,
          },
        });
      }

      // Tier 1: the unlink and its rows commit together.
      unlinked = [
        {
          tenantSlug: this.tenantContext.tenantSlug,
          citizenId: ownerId,
          action: 'LANDLORD_UNLINKED',
          after: { propertyEntryId: entry.id, ...summarise(outcome.report) },
          actorId: input.actor.id,
          actorRole: input.actor.role,
        },
        ...(entry.registration?.citizenId
          ? [
              {
                tenantSlug: this.tenantContext.tenantSlug,
                citizenId: entry.registration.citizenId,
                action: 'LANDLORD_UNLINKED',
                after: { propertyEntryId: entry.id, ownerId },
                actorId: input.actor.id,
                actorRole: input.actor.role,
              },
            ]
          : []),
      ];
      await this.links.recordAnnouncement(unlinked);
      return outcome.report;
    });

    this.links.emitAll(events, input.actor);
    this.links.announce(unlinked);

    const reviewUnits = report.legacy
      ? entry.units
          .filter((row) => row.unitId && row.unit)
          .map((row) => ({
            unitId: row.unitId!,
            unitCode: row.unit!.unitCode,
            buildingId: row.unit!.buildingId,
          }))
      : [];

    return { unlinked: true, ...report, reviewUnits };
  }

  /**
   * The revert, against whichever client the caller is writing through.
   *
   * Takes the client as an argument because the citizen edit path deletes a
   * linked card, or changes the number a link was made against, inside its own
   * transaction — and the revert has to commit with that save or not at all.
   * Writes nothing through other services, so it needs no ambient scope; the
   * events it would emit are returned for the caller to emit after commit.
   */
  async revertLink(
    client: Prisma.TransactionClient,
    input: { entryId: string; ownerId: string; footprint: unknown },
  ): Promise<{ report: RevertReport; events: PendingEvent[] }> {
    const footprint = readFootprint(input.footprint, input.ownerId);
    if (!footprint) {
      /*
        Confirmed before footprints existed. Nothing records which rows this
        link wrote, and an owner occupancy looks the same whichever door wrote
        it — so nothing is inferred and nothing is deleted. The caller reports
        the flats for a person to check on the matrix.
      */
      return { report: { ...emptyReport(), legacy: true }, events: [] };
    }

    return this.links.revertUnits(client, {
      entryId: input.entryId,
      ownerId: input.ownerId,
      units: footprint.units,
      mintedCardIds: footprint.mintedCardIds,
    });
  }

  /**
   * What happens to a link when (part of) its tenancy ends.
   *
   * Two different answers, because the two ways a tenancy ends are opposite
   * statements about the past:
   *
   *  - **`KEEP` — the tenant left (`MOVED_OUT`).** The link was true. What it put
   *    on the owner's file — the spell, the row, a card — stays, and becomes the
   *    owner's own record: those flats drop out of the footprint (so a later undo
   *    can never revert them) and a card the link created loses its mark once no
   *    standing link still relies on it. The owner still owns the flat; a tenant
   *    moving out changes nothing about the deed.
   *  - **`REVERT` — the tenancy was recorded in error.** It never existed, so
   *    nothing it supported about the owner does either: those flats are reverted
   *    exactly as «إلغاء الربط» would revert them.
   *
   * When the whole card has ended, a `KEEP` leaves `landlordCitizenId` in place
   * — who the landlord was is history worth keeping — and a `REVERT` clears it.
   * Returns the column updates for the caller to write with the card's end, and
   * the events to emit after commit.
   */
  async detachUnits(
    client: Prisma.TransactionClient,
    input: {
      entryId: string;
      ownerId: string;
      footprint: unknown;
      unitIds: readonly string[];
      cardEnded: boolean;
      mode: 'KEEP' | 'REVERT';
    },
  ): Promise<{
    data: { landlordLinkFootprint?: unknown; landlordCitizenId?: null };
    events: PendingEvent[];
    report: RevertReport | null;
  }> {
    const footprint = readFootprint(input.footprint, input.ownerId);
    const leavingIds = new Set(input.unitIds);

    if (!footprint) {
      // Nothing recorded to keep or revert. An erroneous tenancy still names
      // no landlord once it has wholly ended.
      return {
        data: input.mode === 'REVERT' && input.cardEnded ? { landlordCitizenId: null } : {},
        events: [],
        report: input.mode === 'REVERT' ? { ...emptyReport(), legacy: true } : null,
      };
    }

    const leaving = footprint.units.filter((unit) => leavingIds.has(unit.unitId));
    const remaining = footprint.units.filter((unit) => !leavingIds.has(unit.unitId));

    if (input.mode === 'REVERT') {
      const reverted = await this.links.revertUnits(client, {
        entryId: input.entryId,
        ownerId: input.ownerId,
        units: leaving,
        mintedCardIds: input.cardEnded ? footprint.mintedCardIds : [],
      });
      const mintedCardIds = footprint.mintedCardIds.filter(
        (id) => !reverted.report.removedCardIds.includes(id),
      );
      return {
        data: input.cardEnded
          ? { landlordCitizenId: null, landlordLinkFootprint: Prisma.DbNull }
          : { landlordLinkFootprint: { ...footprint, units: remaining, mintedCardIds } },
        events: reverted.events,
        report: reverted.report,
      };
    }

    /*
      KEEP. A card this link created stops being "the link's" once nothing still
      standing claims it through a link — this one's remaining flats, or another
      tenant's link — so no future undo can delete what is now simply the
      owner's card.
    */
    const candidates = new Set<string>([
      ...leaving.map((unit) => unit.row?.propertyEntryId).filter((id): id is string => Boolean(id)),
      ...(input.cardEnded || remaining.length === 0 ? footprint.mintedCardIds : []),
    ]);
    const stillHere = (cardId: string) =>
      !input.cardEnded &&
      remaining.some((unit) => unit.row?.propertyEntryId === cardId);

    if (candidates.size > 0) {
      const others = await client.propertyEntry.findMany({
        where: { landlordCitizenId: input.ownerId, id: { not: input.entryId }, endedAt: null },
        select: { id: true, landlordLinkFootprint: true },
      });
      const claimedElsewhere = (cardId: string) =>
        others.some((other) => {
          const theirs = readFootprint(other.landlordLinkFootprint, input.ownerId);
          return Boolean(
            theirs?.mintedCardIds.includes(cardId) ||
              theirs?.units.some((unit) => unit.row?.propertyEntryId === cardId),
          );
        });

      for (const cardId of candidates) {
        if (stillHere(cardId) || claimedElsewhere(cardId)) continue;
        await client.propertyEntry.updateMany({
          where: { id: cardId, NOT: { landlordLinkMint: { equals: Prisma.DbNull } } },
          data: { landlordLinkMint: Prisma.DbNull },
        });
      }
    }

    const mintedCardIds = footprint.mintedCardIds.filter((id) => stillHere(id));
    return {
      data: {
        landlordLinkFootprint:
          input.cardEnded || remaining.length === 0
            ? Prisma.DbNull
            : { ...footprint, units: remaining, mintedCardIds },
      },
      events: [],
      report: null,
    };
  }

  /**
   * An owner sold flats their tenants' links name — release those links.
   *
   * ## Why a sale cannot leave the link standing
   *
   * A link says «this card's flats are rented from X», and
   * `reconcileRegistration` acts on it: on the tenant's next save it puts X on
   * every flat the card names that X's footprint does not cover. Leave the link
   * after a sale and the first edit of the tenant's phone number quietly makes
   * the seller the owner again — the sale undone by nobody.
   *
   * ## What is kept, and where
   *
   * The link was true until the sale, so this is `detachUnits`' KEEP, never a
   * revert: what it wrote on the seller's file stays theirs (now ended by the
   * sale), and those flats leave the footprint so no later undo can delete that
   * history. Then, per card:
   *
   *  - **Every flat on it was sold** — the link itself ends. The card keeps the
   *    seller as its written landlord (filled in from the register where the
   *    link had supplied it, so the card still validates), and the seller is
   *    recorded as dismissed, so the owner-link queue does not offer them again
   *    for this card.
   *  - **Some were not** — the sold flats move to a card of their own, carrying
   *    the same written landlord and no link; the rest stay linked.
   *
   * Either way the tenancy itself is untouched: the tenant still lives there and
   * pays what they paid. Linking them to the new owner is a person's decision,
   * and the caller opens a case asking for it.
   */
  async releaseForSale(input: {
    ownerId: string;
    unitIds: readonly string[];
    buildingIds: readonly string[];
  }): Promise<{ released: SaleRelease[]; events: PendingEvent[] }> {
    const sold = [...new Set(input.unitIds)];
    if (sold.length === 0) return { released: [], events: [] };

    const cards = await this.db.propertyEntry.findMany({
      where: {
        landlordCitizenId: input.ownerId,
        endedAt: null,
        occupancyType: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
        OR: [
          { units: { some: { unitId: { in: sold }, endedAt: null } } },
          { buildingId: { in: [...new Set(input.buildingIds)] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        registrationId: true,
        occupancyType: true,
        propertyType: true,
        buildingId: true,
        landlordName: true,
        landlordPhone: true,
        landlordLinkFootprint: true,
        landlordLinkDismissedIds: true,
        registration: {
          select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true, residence: true } } },
        },
        units: { where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, unitId: true } },
      },
    });
    if (cards.length === 0) return { released: [], events: [] };

    const seller = await this.db.user.findUnique({
      where: { id: input.ownerId },
      select: { firstName: true, middleName: true, lastName: true, residence: true, phone: true },
    });
    // Written onto the tenant's card below: the row's own name, never «ورثة المرحوم …».
    const sellerName = seller ? citizenStoredName(seller) : null;

    const released: SaleRelease[] = [];
    const events: PendingEvent[] = [];

    for (const card of cards) {
      const tenantId = card.registration.citizen.id;
      // Which sold flats this card claims — the census's own rule, over the tenant's spells.
      const spells = card.buildingId
        ? await this.db.unitOccupancy.findMany({
            where: { citizenId: tenantId, toDate: null, unit: { buildingId: card.buildingId } },
            select: { unitId: true, role: true },
          })
        : [];
      /*
        A row names its flat. A card with no rows claims by inference, and a
        مبنى card with none "claims" every flat of its structure — so there the
        tenant must also be recorded living in the flat that was sold, or a sale
        of the flat next door would release their link.
      */
      const claimed = sold.filter((unitId) =>
        card.units.length > 0
          ? card.units.some((row) => row.unitId === unitId)
          : spells.some((spell) => spell.unitId === unitId && spell.role !== 'OWNER') &&
            claimsFlat([card], spells, unitId)(card),
      );
      if (claimed.length === 0) continue;

      const soldRows = card.units.filter((row) => row.unitId && claimed.includes(row.unitId));
      const keptRows = card.units.filter((row) => !soldRows.includes(row));

      const detached = await this.detachUnits(this.db, {
        entryId: card.id,
        ownerId: input.ownerId,
        footprint: card.landlordLinkFootprint,
        unitIds: claimed,
        cardEnded: false,
        mode: 'KEEP',
      });
      events.push(...detached.events);

      /*
        The written landlord the card is left with. A link can have supplied it
        (the registration form's owner prefill writes the agreement, not the
        tenant's words), and a tenancy card with no landlord fails the next save
        of the tenant's file — so the register's own record of the seller fills
        a blank, and never overwrites what the tenant said.
      */
      const writtenLandlord = {
        landlordName: card.landlordName?.trim() || sellerName,
        landlordPhone: card.landlordPhone?.trim() || seller?.phone || null,
      };
      const dismissed = [...new Set([...card.landlordLinkDismissedIds, input.ownerId])];

      if (keptRows.length === 0) {
        await this.db.propertyEntry.update({
          where: { id: card.id },
          data: {
            ...writtenLandlord,
            landlordCitizenId: null,
            landlordLinkFootprint: Prisma.DbNull,
            landlordLinkDismissedIds: dismissed,
          },
        });
        released.push({
          propertyEntryId: card.id,
          tenantId,
          tenantName: fullName(card.registration.citizen),
          unitIds: claimed,
          mode: 'RELEASED',
        });
        continue;
      }

      // Some flats stay with the seller: only the sold ones leave this card.
      await this.db.propertyEntry.update({
        where: { id: card.id },
        data: { landlordLinkFootprint: (detached.data.landlordLinkFootprint ?? card.landlordLinkFootprint) as never },
      });
      const movedTo: string[] = [];
      for (const row of soldRows) {
        const newCardId = await this.links.moveRowToOwnCard(card, row.id);
        await this.db.propertyEntry.update({
          where: { id: newCardId },
          data: { ...writtenLandlord, landlordLinkDismissedIds: [input.ownerId] },
        });
        movedTo.push(newCardId);
      }
      released.push({
        propertyEntryId: card.id,
        tenantId,
        tenantName: fullName(card.registration.citizen),
        unitIds: claimed,
        mode: 'SPLIT',
        movedToCardIds: movedTo,
      });
    }

    return { released, events };
  }
}
