import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { internationalPhone, STRUCTURE_TYPE_MAP } from '@mechanization/shared-schemas';
import type { StructureType } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { NotFoundError, ValidationError } from '../../../domain/errors/domain-error';
import { BuildingsService } from '../buildings/buildings.service';

/**
 * Identifying the owner a مستأجر named, among the register's own citizens.
 *
 * ## The dead end this exists to remove
 *
 * `PropertyEntry.landlordPhone` has been collected since the first migration.
 * It is required of every TENANT card, normalised to E.164 on the way in by
 * `internationalPhone`, printed in reports and redacted in the audit log — and
 * it has never been compared against anything. The register could tell you
 * that the tenant in flat 3 named an owner on `+96103123456`, and could not
 * tell you that `+96103123456` is a citizen it registered last spring.
 *
 * That is not a tidiness problem. الأرصفة and المجاري fall on the deed holder
 * (`FeeNotice.bearer = 'OWNER'`), and an owner the register cannot recognise is
 * an owner nobody bills — with no row anywhere saying how much is going
 * uncollected, or on how many units. `bearsFee` is doing the right thing on the
 * data it has; the data simply never said who the owner was.
 *
 * ## Why the match is a query and not a table
 *
 * A candidate is any card whose `landlordPhone` equals some citizen's `phone`
 * or `whatsapp`. That is derivable, and a derived match cannot go stale, needs
 * no backfill for the cards already filed, and does not have to be regenerated
 * every time a number changes on either side of it. A proposals table would
 * have to be kept in step with both.
 *
 * The two things derivation *cannot* reproduce are a person's answers, which is
 * exactly why those are the only two columns this feature added:
 * `landlordCitizenId` (yes, same person) and `landlordLinkDismissedAt` (no).
 *
 * ## Why nothing links itself
 *
 * A phone is not an identity here, and the schema says so where it matters:
 * `User` is unique on the identity document *because* «a household commonly
 * shares one phone». A father and son on one line are one number and two
 * people, and a bare number match would attach the son's tenancy to the
 * father — or the reverse.
 *
 * It is also the wrong risk to take quietly, because this decides money. A
 * confirmed link can start billing someone for units they never declared, on
 * the strength of a number a *third party* typed into a form. A fee notice has
 * to be defensible at a counter. So the match is computed and offered, and a
 * person presses the button — inline in the form where the officer is standing
 * there anyway, or from the queue for the ones nobody has looked at yet.
 *
 * ## What a confirmation writes
 *
 * Three things: the link, an `OWNER` occupancy on each flat the tenant's card
 * names, and — where the owner had filed nothing on that structure — a property
 * card on their own file.
 *
 * That third write is the one worth explaining, because it is a decision and
 * not an obvious consequence. `PropertyEntry` is the citizen's record of *what
 * they filed*, so minting one asserts something on their behalf. It is done
 * anyway because the alternative was strictly worse in the field: `assessCitizen`
 * bills from property cards and `attachOccupancies` consults occupancies only to
 * itemise a مبنى card naming no flats of its own — so without a card, the
 * register knew the person owned the flat, showed them on the matrix, and billed
 * nobody for it. The الأرصفة and المجاري went uncollected on a unit the
 * municipality could name. See §13 of `docs/open-decisions.md`.
 *
 * `declareOwnership` states the two restraints that keep this honest: the card
 * carries **no unit rows**, so it claims the structure rather than a list of
 * flats nobody enumerated, and an **existing card is never touched**, because
 * that one is the owner's own account of what they hold.
 *
 * `unbilledOwnedUnits` still counts what remains unbilled — an owner whose only
 * card on the building was filed as a مستأجر, a `TENT_SHELTER` that cannot carry
 * the link. Revenue absent by design is still revenue absent, and it has to be a
 * number somebody can take to the council rather than a difference nobody sees.
 */
@Injectable()
export class LandlordLinkService {
  private readonly logger = new Logger(LandlordLinkService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly buildings: BuildingsService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * The registered citizen a number belongs to, for the form's inline lookup.
   *
   * This is the *forward* direction and the one worth optimising for, because
   * the officer is standing in front of the tenant with the question already
   * open. Confirming here costs one tap and produces a link nobody has to
   * review later; the queue exists for the other direction, where the owner
   * registers months afterwards and there is no longer anyone to ask.
   *
   * Returns at most one candidate, and returns **none** where several citizens
   * share the number. That is the shared-household case the schema warns about,
   * and it is the one case where picking is guessing — so the control says
   * nothing rather than offering an arbitrary one of them as though it were the
   * answer. The card still saves; it simply saves unlinked, and the queue can
   * show a person all the candidates at once later.
   */
  async candidateFor(phone: string): Promise<LandlordCandidate | null> {
    /*
      Normalised through the same transform the field itself uses.

      This is the one entry point that takes a number straight from a keyboard:
      the officer has typed «03 123456» and every stored number is E.164, so an
      exact comparison would find nothing and the control would report "not
      registered" about a citizen the register holds — the worst possible
      answer, because it is confidently wrong in the direction of not linking.
      `proposals` needs none of this; both sides of that match are already
      stored values.

      A number too malformed to normalise simply has no candidate. It is being
      typed, and the field's own validation is what tells them it is wrong.
    */
    const parsed = internationalPhone.safeParse(phone);
    if (!parsed.success) return null;
    const normalised = parsed.data;

    const matches = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        OR: [{ phone: normalised }, { whatsapp: normalised }],
      },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        referenceNumber: true,
      },
      take: 2,
    });

    if (matches.length !== 1) return null;
    return toCandidate(matches[0]!);
  }

  /**
   * Unresolved claims whose number matches a registered citizen.
   *
   * Two queries rather than a join, because `landlordPhone` is a plain column
   * and not a relation — Prisma cannot join on it, and dropping to raw SQL here
   * would take a hand-written `search_path` with it in a schema-per-tenant
   * database. The first query is bounded by the open claims (a small minority
   * of cards on a mature register, and indexed), the second by the distinct
   * numbers among them.
   */
  async proposals(): Promise<LandlordProposal[]> {
    return this.matchClaims({});
  }

  /**
   * Claims filed *by* one registration that already name a registered citizen.
   *
   * The forward direction, answered the moment the card is saved. The officer
   * typed the owner's number a few seconds ago and is still with the tenant, so
   * «المالك الذي ذكرته مسجَّل: فلان — هل نربطه؟» is a question they can settle
   * on the spot; left to the queue it becomes work for somebody with no memory
   * of the household.
   *
   * Asked *after* the save rather than during it, which is what keeps the
   * submission honest: the client never asserts a link, it is offered one
   * against a card the server has already written and can verify the number of.
   */
  async claimsFiledBy(registrationId: string): Promise<LandlordProposal[]> {
    return this.matchClaims({ registrationId });
  }

  /**
   * The match itself, scoped by whichever question is being asked.
   *
   * Both scopes narrow in the *database* rather than in memory, and that is not
   * a micro-optimisation: `claimsNaming` runs after every citizen save, and an
   * unscoped read would load every open claim in the municipality on each one
   * to keep the handful that mention one number. On a mature register that is
   * the whole tail of unresolved tenancies, fetched to discard.
   */
  private async matchClaims(scope: {
    registrationId?: string;
    /** Stored E.164 numbers — both sides of this comparison are stored values. */
    phones?: readonly string[];
  }): Promise<LandlordProposal[]> {
    const claims = await this.db.propertyEntry.findMany({
      where: {
        ...(scope.registrationId ? { registrationId: scope.registrationId } : {}),
        landlordCitizenId: null,
        landlordLinkDismissedAt: null,
        /*
          One filter, not two. Written as a spread beside `{ not: null }` these
          share a key, so whichever came second silently won — and with the
          narrowing lost, `claimsNaming` would read every open claim in the
          municipality and filter in memory, which is the exact cost this scope
          exists to avoid. A list of stored numbers already excludes null.
        */
        landlordPhone: scope.phones ? { in: [...scope.phones] } : { not: null },
      },
      select: {
        id: true,
        landlordName: true,
        landlordPhone: true,
        occupancyType: true,
        propertyNumber: true,
        buildingName: true,
        buildingId: true,
        registration: {
          select: {
            id: true,
            referenceNumber: true,
            citizen: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        units: { select: { unitId: true } },
      },
    });

    if (claims.length === 0) return [];

    const numbers = [...new Set(claims.map((claim) => claim.landlordPhone!))];
    const citizens = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        OR: [{ phone: { in: numbers } }, { whatsapp: { in: numbers } }],
      },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        whatsapp: true,
        referenceNumber: true,
      },
    });

    /*
      Every citizen reachable on a number, not merely the first.

      A shared household line genuinely resolves to several people, and the
      queue is the one screen that can show that honestly and let somebody pick.
      `candidateFor` above refuses the same situation because it has nobody to
      ask; here there is a person looking at it.
    */
    const byNumber = new Map<string, LandlordCandidate[]>();
    for (const citizen of citizens) {
      for (const number of [citizen.phone, citizen.whatsapp]) {
        if (!number) continue;
        const bucket = byNumber.get(number) ?? [];
        // A citizen whose phone and whatsapp are the same number is one
        // candidate on it, not two.
        if (!bucket.some((row) => row.id === citizen.id)) bucket.push(toCandidate(citizen));
        byNumber.set(number, bucket);
      }
    }

    const proposals: LandlordProposal[] = [];
    for (const claim of claims) {
      const candidates = byNumber.get(claim.landlordPhone!);
      if (!candidates || candidates.length === 0) continue;

      /*
        A card cannot name its own filer as its landlord.

        Reachable without anybody doing anything strange: a household shares a
        line, the son files as a مستأجر and writes the family number as his
        landlord's. Offering to link the card to the person who filed it would
        record someone as renting from themselves, and — since the link can bill
        — bill them as their own landlord.
      */
      const filerId = claim.registration?.citizen.id;
      const offered = candidates.filter((candidate) => candidate.id !== filerId);
      if (offered.length === 0) continue;

      proposals.push({
        propertyEntryId: claim.id,
        occupancyType: claim.occupancyType,
        landlordName: claim.landlordName,
        landlordPhone: claim.landlordPhone!,
        propertyNumber: claim.propertyNumber,
        buildingName: claim.buildingName,
        buildingId: claim.buildingId,
        linkedUnitCount: claim.units.filter((unit) => unit.unitId).length,
        filedBy: claim.registration
          ? {
              registrationId: claim.registration.id,
              referenceNumber: claim.registration.referenceNumber,
              citizenId: claim.registration.citizen.id,
              name: `${claim.registration.citizen.firstName} ${claim.registration.citizen.lastName}`.trim(),
            }
          : null,
        candidates: offered,
      });
    }

    return proposals;
  }

  /**
   * Claims naming *this* citizen, for the moment they are registered.
   *
   * The backward direction, answered at the one instant it can be answered
   * well: the officer who just registered the owner is still at the desk, and
   * «هذا الشخص مذكور كمالك في ٣ بطاقات — هل نربطها؟» is a question they can
   * settle now. Left to the queue it becomes work for somebody with no memory
   * of either household.
   *
   * Read-only and cheap enough to run on every save. It writes nothing — the
   * link is still a person pressing a button — so a failure here can never cost
   * a registration, and the caller treats it the same way it treats a census
   * sync that could not keep up.
   */
  async claimsNaming(citizenId: string): Promise<LandlordProposal[]> {
    const citizen = await this.db.user.findUnique({
      where: { id: citizenId },
      select: { kind: true, phone: true, whatsapp: true },
    });
    if (!citizen || citizen.kind !== 'CITIZEN') return [];

    const numbers = [citizen.phone, citizen.whatsapp].filter(
      (value): value is string => Boolean(value),
    );
    if (numbers.length === 0) return [];

    /*
      Scoped to this citizen's own numbers before the read, then filtered to the
      ones where *they* are a candidate. Both steps are needed: the query finds
      claims naming a number they answer on, and the filter drops any that
      resolve to somebody else sharing that line — a household where the father
      is the landlord and the son has just registered.
    */
    const claims = await this.matchClaims({ phones: numbers });
    return claims.filter((proposal) =>
      proposal.candidates.some((candidate) => candidate.id === citizenId),
    );
  }

  /**
   * Records that the landlord named on a card is this registered citizen.
   *
   * Everything this writes is narrowed to the unresolved case, so replaying a
   * confirmation — an offline queue delivering it twice, two clerks reaching
   * the same proposal — produces the same register as running it once.
   */
  async confirm(input: {
    propertyEntryId: string;
    citizenId: string;
    actor: { id: string; role: string };
  }): Promise<LandlordLinkResult> {
    const entry = await this.db.propertyEntry.findUnique({
      where: { id: input.propertyEntryId },
      select: {
        id: true,
        occupancyType: true,
        landlordPhone: true,
        landlordCitizenId: true,
        buildingId: true,
        // Copied onto the owner's own card when one is minted — see
        // `declareOwnership`. Both describe the same structure, so the tenant's
        // answers are the register's best answers for it.
        neighborhood: true,
        propertyNumber: true,
        registration: { select: { citizenId: true } },
        units: { select: { unitId: true } },
      },
    });
    if (!entry) throw new NotFoundError('بطاقة العقار غير موجودة');

    /*
      Checked before it reaches Prisma, which answers a `where: { id: undefined }`
      with a validation error the filter renders as a 500. A body that simply
      omitted the citizen is a caller mistake and deserves to be told so.
    */
    if (!input.citizenId?.trim()) {
      throw new ValidationError('المواطن مطلوب', { citizenId: input.citizenId });
    }

    const citizen = await this.db.user.findUnique({
      where: { id: input.citizenId },
      select: { id: true, kind: true, phone: true, whatsapp: true },
    });
    if (!citizen || citizen.kind !== 'CITIZEN') {
      throw new ValidationError('المواطن غير موجود', { citizenId: input.citizenId });
    }

    /*
      An OWNER card has no landlord to identify.

      `PropertyEntry.normalise` already blanks `landlordPhone` on one, so this
      is unreachable through the form — but `propertyEntryId` arrives from a
      request, and a rule that decides who gets billed should not rest on
      another layer having tidied up first.
    */
    if (entry.occupancyType === 'OWNER') {
      throw new ValidationError('بطاقة المالك لا تحمل اسم مالك آخر', {
        propertyEntryId: input.propertyEntryId,
      });
    }

    /*
      The card must not name its own filer.

      Same case `proposals` filters out, refused again here because this is the
      layer that writes. Linking them records a citizen as renting from
      themselves, and an `OWNER` occupancy beside their own `TENANT` one on a
      single flat is a contradiction the matrix would then display forever.
    */
    if (entry.registration?.citizenId === input.citizenId) {
      throw new ValidationError('لا يمكن ربط البطاقة بمن قام بتقديمها', {
        propertyEntryId: input.propertyEntryId,
      });
    }

    /*
      The number has to actually match.

      `citizenId` arrives from a request and nothing upstream has proved it is
      the person the card names. Without this check the endpoint would let any
      account that can write assert *any* citizen as *any* card's landlord —
      which, since the link can bill, is a way to attach someone else's property
      to a person by hand and have every screen report it as a confirmed match.
      A clerk may answer the question; they may not invent it.
    */
    const claimed = entry.landlordPhone?.trim();
    if (!claimed || (claimed !== citizen.phone && claimed !== citizen.whatsapp)) {
      throw new ValidationError('رقم هاتف المالك لا يطابق هذا المواطن', {
        propertyEntryId: input.propertyEntryId,
        citizenId: input.citizenId,
      });
    }

    // Already settled, and settled the same way. Idempotent rather than a
    // conflict: two clerks agreeing is not an error.
    if (entry.landlordCitizenId === input.citizenId) {
      return { linked: false, occupanciesRecorded: 0, unitsClaimed: 0, ownerCardCreated: false };
    }

    await this.db.propertyEntry.update({
      where: { id: entry.id },
      data: {
        landlordCitizenId: input.citizenId,
        // A confirmation supersedes an earlier rejection of the same claim.
        landlordLinkDismissedAt: null,
      },
    });

    /*
      The owner goes onto every flat the tenant's card names.

      Delegated to `recordOccupancy` rather than restated, for the reason
      `CensusSyncService` delegates the same facts: a second copy of "which
      survey statuses may be lifted" is how the map and the ledger start
      disagreeing. It also gets the part that matters most here for free —
      `unitStatusForRole('OWNER')` returns null, so recording the owner does
      **not** overwrite the «مؤجرة» the tenant's own occupancy established.
      A deed is not a statement of residence.
    */
    const unitIds = [...new Set(entry.units.map((unit) => unit.unitId).filter(Boolean))] as string[];
    let recorded = 0;
    for (const unitId of unitIds) {
      try {
        await this.buildings.recordOccupancy(
          { unitId, citizenId: input.citizenId, role: 'OWNER' },
          input.actor,
        );
        recorded += 1;
      } catch (error) {
        /*
          Kept, not fatal. The link itself is committed and correct, and the
          flats are independent of one another — stopping at the first failure
          would leave more of the matrix wrong than carrying on does. A unit
          that failed is simply one the owner is not yet shown on, and
          re-confirming picks it up.
        */
        this.logger.error(
          `landlord link: unit ${unitId} failed for entry ${entry.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    /*
      And the property appears on the owner's own file.

      This was deliberately not done at first, and the reason it is done now is
      a decision rather than a discovery: `PropertyEntry` is the citizen's
      record of *what they filed*, so minting one they never filed asserts
      something on their behalf. The alternative was worse in practice — the
      register knew the person owned the flat, showed them on the matrix, and
      still billed nobody for it, because `assessCitizen` reads property cards
      and a confirmed link is not one. See §13 of docs/open-decisions.md, which
      records the call and what it rests on.
    */
    const declared = await this.declareOwnership({
      citizenId: input.citizenId,
      buildingId: entry.buildingId,
      neighborhood: entry.neighborhood,
      propertyNumber: entry.propertyNumber,
      occupiedBy: entry.occupancyType,
      actor: input.actor,
    });

    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: input.citizenId,
      action: 'LANDLORD_LINKED',
      after: {
        propertyEntryId: entry.id,
        unitsClaimed: unitIds.length,
        ownerCardCreated: declared.created,
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return {
      linked: true,
      occupanciesRecorded: recorded,
      unitsClaimed: unitIds.length,
      ownerCardCreated: declared.created,
    };
  }

  /**
   * Puts the structure on the owner's own file, so the register bills it.
   *
   * ## Why a card has to exist at all
   *
   * `assessCitizen` computes a bill from the property cards a citizen filed.
   * `attachOccupancies` consults `UnitOccupancy` only to itemise a مبنى card
   * that names no flats of its own. So an `OWNER` occupancy with no card behind
   * it is *invisible to billing* — the matrix shows the owner, the file shows
   * nothing, and الأرصفة and المجاري go uncollected on a unit the municipality
   * can name. That was the whole of the gap.
   *
   * ## Why the card is created with no unit rows, and that is the careful part
   *
   * A مبنى card with an empty `units` array is exactly what
   * `heldThroughOccupancy` answers for: billing reads the owner's flats from
   * their occupancies instead. That matters twice over.
   *
   * It is **honest** — the card asserts "this citizen holds property in this
   * structure", which is what the clerk confirmed, and not a list of flats
   * nobody enumerated on their behalf. And it is **self-maintaining**: the next
   * tenant linked to the same owner adds an occupancy and is billed for
   * automatically, with no second card and no re-itemisation. Writing unit rows
   * here would freeze the claim at whatever this one tenant's card happened to
   * name.
   *
   * ## Why an existing card is never touched
   *
   * If the owner already filed for this building, that card is *their* account
   * of what they hold and this has no business editing it. Adding rows to an
   * itemised card would also silently change how it is billed — an itemised
   * card stops consuming the occupancy list, so topping one up with the flats
   * from a single tenancy could *reduce* what the owner is charged. Left alone,
   * the card keeps whatever behaviour it already had and the new occupancies
   * feed it if it was the empty kind.
   */
  private async declareOwnership(input: {
    citizenId: string;
    buildingId: string | null;
    neighborhood: string | null;
    propertyNumber: string | null;
    /** The tenant's relationship, which decides the unit's حالة. */
    occupiedBy: string;
    actor: { id: string; role: string };
  }): Promise<{ created: boolean }> {
    if (!input.buildingId) return { created: false };

    const building = await this.db.building.findUnique({
      where: { id: input.buildingId },
      select: { id: true, parcelNumber: true, name: true, structureType: true },
    });
    if (!building) return { created: false };

    /*
      Already on their file — in any capacity.

      Not narrowed to `occupancyType: 'OWNER'`: a citizen who filed a مستأجر
      card on this building and has now been confirmed as an owner of a
      *different* flat in it is a real and complicated situation, and minting a
      second card under them is not this service's call to make. The link and
      the occupancy are recorded either way; the matrix shows both.
    */
    const existing = await this.db.propertyEntry.findFirst({
      where: { buildingId: building.id, registration: { citizenId: input.citizenId } },
      select: { id: true },
    });
    if (existing) return { created: false };

    /*
      The owner's most recent registration is where the card goes.

      Same convention `CitizensService.update` follows when it reconciles
      property entries — a citizen's current file *is* their latest
      registration. A citizen with none cannot receive a card at all, which is
      not reachable through the register (a citizen exists because a
      registration created them) but is refused rather than assumed.
    */
    const registration = await this.db.registration.findFirst({
      where: { citizenId: input.citizenId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    if (!registration) return { created: false };

    const mapped = STRUCTURE_TYPE_MAP[building.structureType as StructureType];

    /*
      A خيمة cannot carry the link and must not be minted as a holding.

      `branchFieldsOnly` drops `buildingId` from anything but مبنى and منزل, so
      a `TENT_SHELTER` structure would produce a card that silently lost its
      link the first time anyone edited it — a holding attached to nothing. The
      occupancy still records who owns what; only the card is withheld.
    */
    if (mapped.propertyType !== 'BUILDING' && mapped.propertyType !== 'HOUSE') {
      return { created: false };
    }

    await this.db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: mapped.propertyType as never,
        buildingId: building.id,
        /*
          The parcel is the building's own; الحي is copied from the tenant's
          card because the cadastre has no neighbourhood layer to ask and both
          cards describe one structure. Null only where the tenant's card had
          none either — the same absence, not an invention.
        */
        propertyNumber: building.parcelNumber || input.propertyNumber,
        neighborhood: input.neighborhood,
        buildingName: building.name,
        /*
          A منزل bills its single unit from its own columns, so it has to say
          who is in it or `bearsFee` reads the null as "nobody was asked" and
          charges the owner the occupancy fee the tenant is already paying. A
          مبنى carries no unit rows here by design and states nothing.
        */
        ...(mapped.propertyType === 'HOUSE'
          ? {
              unitType: mapped.defaultUnitType as never,
              unitStatus: (input.occupiedBy === 'FREE_OCCUPANT'
                ? 'FREE_OCCUPIED'
                : 'RENTED') as never,
            }
          : {}),
      },
    });

    return { created: true };
  }

  /**
   * Records that the match on this card was looked at and rejected.
   *
   * The one piece of state the derived match cannot reproduce. Without it a
   * rejected proposal is recomputed and re-offered every time the queue is
   * opened, and a queue that cannot shrink is one people stop reading.
   *
   * Stored as a timestamp rather than a boolean so the audit answers *when*
   * somebody decided, which is the question asked of every other resolution in
   * this register.
   */
  async dismiss(input: {
    propertyEntryId: string;
    actor: { id: string; role: string };
  }): Promise<{ dismissed: boolean }> {
    const updated = await this.db.propertyEntry.updateMany({
      where: {
        id: input.propertyEntryId,
        landlordCitizenId: null,
        landlordLinkDismissedAt: null,
      },
      data: { landlordLinkDismissedAt: new Date() },
    });

    return { dismissed: updated.count > 0 };
  }

  /**
   * Undoes a link, leaving the claim matchable again.
   *
   * The correction path for the mistake this feature can make: a clerk
   * confirmed the wrong person off a shared household number. Clearing the
   * column puts the card back in the queue rather than pretending nobody ever
   * answered.
   *
   * The `OWNER` occupancies it created are deliberately **not** withdrawn here.
   * An occupancy is a statement about a flat with its own history (D2), other
   * paths write the same rows, and inferring which of them this link is
   * responsible for would be guessing. `endOccupancy` on the matrix is the
   * control that ends a spell, and it is the one that already records who ended
   * it and when.
   */
  async unlink(input: {
    propertyEntryId: string;
    actor: { id: string; role: string };
  }): Promise<{ unlinked: boolean }> {
    const updated = await this.db.propertyEntry.updateMany({
      where: { id: input.propertyEntryId, landlordCitizenId: { not: null } },
      data: { landlordCitizenId: null },
    });

    return { unlinked: updated.count > 0 };
  }

  /**
   * How much ownership the register knows about and does not bill.
   *
   * The number this whole feature exists to make sayable. A confirmed link
   * records that a citizen owns a flat; it does not, on its own, put that flat
   * on a bill, because billing reads the cards a citizen *filed* and this is
   * somebody else's statement about them. That gap is a deliberate choice — see
   * the class docblock — and a deliberate gap still has to be countable, for
   * the same reason `excludedUnitCount` is stored on every invoice.
   *
   * Counts current OWNER spells on units whose owner has filed no property card
   * naming that building. Those are the units an owner-borne fee would charge
   * for if the municipality decided this evidence were enough to bill on.
   */
  async unbilledOwnedUnits(): Promise<{ units: number; owners: number }> {
    const owned = await this.db.unitOccupancy.findMany({
      where: { role: 'OWNER', toDate: null },
      select: { citizenId: true, unit: { select: { id: true, buildingId: true } } },
    });
    if (owned.length === 0) return { units: 0, owners: 0 };

    const declared = await this.db.propertyEntry.findMany({
      where: {
        buildingId: { in: [...new Set(owned.map((row) => row.unit.buildingId))] },
        occupancyType: 'OWNER',
      },
      select: { buildingId: true, registration: { select: { citizenId: true } } },
    });

    const declaredPairs = new Set(
      declared
        .filter((entry) => entry.registration)
        .map((entry) => `${entry.registration!.citizenId}:${entry.buildingId}`),
    );

    const owners = new Set<string>();
    let units = 0;
    for (const row of owned) {
      if (declaredPairs.has(`${row.citizenId}:${row.unit.buildingId}`)) continue;
      units += 1;
      owners.add(row.citizenId);
    }

    return { units, owners: owners.size };
  }

}

function toCandidate(citizen: {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  phone: string | null;
  referenceNumber?: string | null;
}): LandlordCandidate {
  return {
    id: citizen.id,
    name: [citizen.firstName, citizen.middleName, citizen.lastName]
      .filter(Boolean)
      .join(' ')
      .trim(),
    phone: citizen.phone,
    referenceNumber: citizen.referenceNumber ?? null,
  };
}

/** A registered citizen a claimed landlord number could belong to. */
export interface LandlordCandidate {
  id: string;
  name: string;
  phone: string | null;
  referenceNumber: string | null;
}

/** One unresolved claim, with whoever its number resolves to. */
export interface LandlordProposal {
  propertyEntryId: string;
  occupancyType: string;
  landlordName: string | null;
  landlordPhone: string;
  propertyNumber: string | null;
  buildingName: string | null;
  buildingId: string | null;
  /** Flats on this card that name a canonical unit — what a link would claim. */
  linkedUnitCount: number;
  filedBy: {
    registrationId: string;
    referenceNumber: string;
    citizenId: string;
    name: string;
  } | null;
  /** Usually one. More than one is a shared household line — see `proposals`. */
  candidates: LandlordCandidate[];
}

/** What one confirmation changed. */
export interface LandlordLinkResult {
  /** False when the card already named this citizen — a replay, not a failure. */
  linked: boolean;
  occupanciesRecorded: number;
  unitsClaimed: number;
  /** Whether the structure was added to the owner's own file by this link. */
  ownerCardCreated: boolean;
}
