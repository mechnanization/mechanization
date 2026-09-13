import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { internationalPhone, STRUCTURE_TYPE_MAP } from '@mechanization/shared-schemas';
import type { StructureType } from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../../domain/errors/domain-error';
import { BuildingsService } from '../buildings/buildings.service';
import type { FileLinkResult } from '../buildings/building.types';

/**
 * Identifying the owner a مستأجر named, among the register's own citizens.
 *
 * ## How the register learns that the owner exists
 *
 * Nothing about a pending match is stored. The only thing joining a tenant's
 * card to its owner is the number: `PropertyEntry.landlordPhone` against a
 * citizen's `phone` or `whatsapp`, both normalised to E.164 on the way in. So
 * the order the two were registered in does not matter — a tenant filed in
 * March names a number, the owner registered in June answers on it, and the
 * very next read that asks (the dialog after the owner's save, or the queue at
 * «روابط المالكين») finds the pair. A derived match cannot go stale and needs no
 * backfill; the only things stored are a person's answers.
 *
 * ## Why nothing links itself
 *
 * A phone is not an identity here — `User` is unique on the identity document
 * *because* «a household commonly shares one phone» — and a link decides money:
 * it puts a flat on somebody's bill. So the match is offered, a person presses
 * the button, and this service re-checks the question was real before writing.
 *
 * ## What a link writes, and why it records what it wrote
 *
 * The owner goes onto every flat the tenant's card names (`UnitOccupancy`, role
 * `OWNER`) and each of those flats onto a card on the owner's own file — the
 * half billing reads. Those rows belong to somebody else's records, so the link
 * keeps a **footprint** of exactly what it created (`LinkFootprint`) and
 * «إلغاء الربط» reverts exactly that: a row still holding the values the link
 * wrote is removed, a row a person has since edited is kept and reported. An
 * undo that inferred its rows afterwards would delete a real record the first
 * time a link and the matrix wrote the same flat.
 *
 * ## Why some links are refused until something else is fixed
 *
 * A link that cannot put the property on the owner's file is not a smaller
 * link, it is a false one: every screen says the owner is known and nobody is
 * billed. So a card that is not on a surveyed building, names no flat, or would
 * land the flat on a second card for the same parcel is **blocked** with the
 * step that unblocks it (`LinkBlock`), and stays on the queue until then.
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

  // ─────────────────────────────  The match  ─────────────────────────────

  /**
   * Every active citizen a typed number belongs to, for the form's lookup.
   *
   * All of them, not the first: a shared household line is exactly where the
   * officer at the door is the person best placed to say which of them the
   * tenant meant, and a control that fell silent there left the one answerable
   * case to a queue nobody would read for weeks.
   */
  async candidatesFor(phone: string): Promise<LandlordCandidate[]> {
    /*
      Normalised through the same transform the field itself uses. Every stored
      number is E.164, so «03 123456» compared as typed would find nobody and
      report a registered owner as unregistered — confidently wrong, in the
      direction of never linking.
    */
    const parsed = internationalPhone.safeParse(phone);
    if (!parsed.success) return [];
    const normalised = parsed.data;

    const matches = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        OR: [{ phone: normalised }, { whatsapp: normalised }],
      },
      select: CANDIDATE_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    return matches.map(toCandidate);
  }

  /**
   * The queue: unresolved claims whose number matches somebody, a page at a
   * time.
   *
   * One query finds the matching pairs in the database, so a claim naming a
   * number nobody is registered under — most of them, on a register where most
   * landlords are not citizens — is never read at all. It used to be: every
   * unresolved tenancy in the municipality was loaded on each visit to this
   * screen, to keep the few that matched.
   */
  async proposals(page: { limit: number; offset: number }): Promise<{
    items: LandlordProposal[];
    total: number;
  }> {
    const limit = Math.min(Math.max(Math.trunc(page.limit) || 20, 1), 100);
    const offset = Math.max(Math.trunc(page.offset) || 0, 0);
    const pairs = await this.matchPairs({}, { limit, offset });
    return { items: await this.hydrate(pairs), total: pairs[0]?.total ?? 0 };
  }

  /**
   * Claims filed *by* one registration that already name a registered citizen —
   * asked right after the save, while the officer is still with the tenant.
   */
  async claimsFiledBy(registrationId: string): Promise<LandlordProposal[]> {
    return this.hydrate(await this.matchPairs({ registrationId }));
  }

  /**
   * Claims naming *this* citizen, for the moment they are registered.
   *
   * The backward direction — the owner registering after their tenants — and
   * the answer to «how does the register know the owner has arrived»: it asks,
   * scoped to the numbers this citizen answers on, the moment their file is
   * saved. Read-only; nothing here links.
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

    const pairs = await this.matchPairs({ phones: numbers });
    /*
      Only the claims where *they* are a candidate. The query finds every claim
      naming a number they answer on, and a household line can resolve one of
      those to somebody else — the father is the landlord, the son just
      registered on the family phone.
    */
    const mine = pairs.filter((pair) => pair.citizenIds.includes(citizenId));
    return this.hydrate(mine);
  }

  /**
   * The matching pairs, found and paged in one statement.
   *
   * Raw SQL because `landlordPhone` is a plain column rather than a relation, so
   * Prisma cannot join on it; the schema is written into the SQL (see
   * `tenant-schema-ref.ts`). The two number columns are matched as two
   * equi-joins under a `UNION` rather than one `OR`, which lets Postgres hash
   * both instead of looping over every citizen for every claim.
   *
   * What is filtered out, and why each belongs in the database:
   *  - a claim naming its own filer — a household line again, and linking it
   *    records someone renting from themselves;
   *  - a citizen «لا أحد منهم» rejected on this card (`landlordLinkDismissedIds`);
   *  - for a dismissal from before those ids were kept, every citizen who was
   *    registered at the time — which is exactly who the clerk was shown. Anyone
   *    registered since is offered: the real owner arriving later on the same
   *    number was the case a card-wide dismissal lost forever.
   */
  private async matchPairs(
    scope: { registrationId?: string; phones?: readonly string[] },
    page?: { limit: number; offset: number },
  ): Promise<MatchPair[]> {
    const S = tenantSchemaRef(this.tenantContext.schemaName);
    const narrow = scope.registrationId
      ? Prisma.sql`AND pe."registrationId" = ${scope.registrationId}::uuid`
      : scope.phones
        ? Prisma.sql`AND pe."landlordPhone" = ANY(${[...scope.phones]}::text[])`
        : Prisma.empty;
    const paging = page ? Prisma.sql`LIMIT ${page.limit} OFFSET ${page.offset}` : Prisma.empty;

    return this.db.$queryRaw<MatchPair[]>`
      WITH open_claims AS (
        SELECT pe.id,
               pe."landlordPhone" AS phone,
               pe."createdAt" AS created_at,
               pe."landlordLinkDismissedAt" AS dismissed_at,
               pe."landlordLinkDismissedIds" AS dismissed_ids,
               r."citizenId" AS filer_id
        FROM ${S}property_entries pe
        JOIN ${S}registrations r ON r.id = pe."registrationId"
        WHERE pe."landlordCitizenId" IS NULL
          AND pe."landlordPhone" IS NOT NULL
          AND pe."occupancyType" <> 'OWNER'
          ${narrow}
      ),
      by_number AS (
        SELECT c.id, c.created_at, c.dismissed_at, c.dismissed_ids, c.filer_id,
               u.id AS citizen_id, u."createdAt" AS citizen_created_at
        FROM open_claims c
        JOIN ${S}users u ON u.phone = c.phone AND u.kind = 'CITIZEN' AND u."isActive"
        UNION
        SELECT c.id, c.created_at, c.dismissed_at, c.dismissed_ids, c.filer_id,
               u.id AS citizen_id, u."createdAt" AS citizen_created_at
        FROM open_claims c
        JOIN ${S}users u ON u.whatsapp = c.phone AND u.kind = 'CITIZEN' AND u."isActive"
      ),
      offered AS (
        SELECT id, created_at, citizen_id
        FROM by_number
        WHERE citizen_id <> filer_id
          AND NOT (citizen_id = ANY(dismissed_ids))
          AND NOT (
            dismissed_at IS NOT NULL
            AND cardinality(dismissed_ids) = 0
            AND citizen_created_at <= dismissed_at
          )
      )
      SELECT id AS "entryId",
             array_agg(DISTINCT citizen_id) AS "citizenIds",
             count(*) OVER()::int AS total
      FROM offered
      GROUP BY id, created_at
      ORDER BY created_at DESC, id
      ${paging}
    `;
  }

  /**
   * Turns matched pairs into proposals, each candidate carrying what a link
   * would do — or why it cannot be made yet.
   *
   * Batched: the whole page costs a fixed handful of reads however many cards
   * and candidates are on it (`loadPlanContext`), so a clerk sees the outcome
   * before pressing the button without every row paying for its own lookups.
   */
  private async hydrate(pairs: readonly MatchPair[]): Promise<LandlordProposal[]> {
    if (pairs.length === 0) return [];

    const entries = await this.db.propertyEntry.findMany({
      where: { id: { in: pairs.map((pair) => pair.entryId) } },
      select: ENTRY_SELECT,
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const candidateIds = [...new Set(pairs.flatMap((pair) => pair.citizenIds))];
    const context = await this.loadPlanContext(entries, candidateIds);

    const proposals: LandlordProposal[] = [];
    for (const pair of pairs) {
      const entry = byId.get(pair.entryId);
      if (!entry) continue;

      const target = this.planTarget(entry, context);
      const candidates = pair.citizenIds
        .map((id) => context.citizens.get(id))
        .filter((citizen): citizen is PlanCitizen => Boolean(citizen))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((citizen) => {
          const plan = target.block ? null : this.planFor(target, citizen, context);
          return {
            ...toCandidate(citizen),
            outcome: plan?.block ? null : (plan?.outcome ?? null),
            blocked: plan?.block ?? null,
          };
        });
      if (candidates.length === 0) continue;

      proposals.push({
        propertyEntryId: entry.id,
        occupancyType: entry.occupancyType,
        propertyType: entry.propertyType,
        landlordName: entry.landlordName,
        landlordPhone: entry.landlordPhone!,
        propertyNumber: entry.propertyNumber,
        buildingName: entry.buildingName,
        buildingId: entry.buildingId,
        buildingCode: entry.building?.code ?? null,
        units: target.units,
        linkedUnitCount: target.units.length,
        filedAt: entry.createdAt.toISOString(),
        filedBy: entry.registration
          ? {
              registrationId: entry.registration.id,
              referenceNumber: entry.registration.referenceNumber,
              citizenId: entry.registration.citizen.id,
              name: fullName(entry.registration.citizen),
            }
          : null,
        blocked: target.block,
        candidates,
      });
    }

    return proposals;
  }

  // ─────────────────────────────  The plan  ─────────────────────────────

  /**
   * Everything deciding what a link on these cards would do, in five reads.
   *
   * Shared by the queue (many cards, many candidates) and by `confirm` (one of
   * each), so the outcome a clerk is shown before pressing the button is
   * computed by the same code that then refuses or performs it.
   */
  private async loadPlanContext(
    entries: readonly PlanEntry[],
    candidateIds: readonly string[],
  ): Promise<PlanContext> {
    const buildingIds = [
      ...new Set(entries.map((entry) => entry.buildingId).filter((id): id is string => Boolean(id))),
    ];

    const buildings = buildingIds.length
      ? await this.db.building.findMany({
          where: { id: { in: buildingIds } },
          select: {
            id: true,
            parcelNumber: true,
            structureType: true,
            // Two is enough to tell "exactly one unit" from "more than one" —
            // the single-unit منزل inference `CensusSyncService` makes.
            units: { select: { id: true, unitCode: true }, take: 2, orderBy: { createdAt: 'asc' } },
          },
        })
      : [];
    const buildingById = new Map(buildings.map((building) => [building.id, building]));

    const unitIds = [
      ...new Set(
        entries.flatMap((entry) => [
          ...entry.units.map((unit) => unit.unitId).filter((id): id is string => Boolean(id)),
          ...(entry.buildingId ? (buildingById.get(entry.buildingId)?.units ?? []) : []).map(
            (unit) => unit.id,
          ),
        ]),
      ),
    ];
    const parcels = [
      ...new Set(buildings.map((building) => building.parcelNumber).filter(Boolean)),
    ] as string[];

    const [vacancies, citizens, cards, occupancies] = await Promise.all([
      unitIds.length
        ? this.db.unitVacancyConfirmation.findMany({
            where: { unitId: { in: unitIds }, endedAt: null },
            select: { unitId: true },
          })
        : Promise.resolve([]),
      candidateIds.length
        ? this.db.user.findMany({
            where: { id: { in: [...candidateIds] } },
            select: {
              ...CANDIDATE_SELECT,
              kind: true,
              isActive: true,
              _count: { select: { registrations: true } },
            },
          })
        : Promise.resolve([]),
      candidateIds.length && (buildingIds.length || parcels.length)
        ? this.db.propertyEntry.findMany({
            where: {
              registration: { citizenId: { in: [...candidateIds] } },
              OR: [
                ...(buildingIds.length ? [{ buildingId: { in: buildingIds } }] : []),
                ...(parcels.length
                  ? [
                      {
                        buildingId: null,
                        occupancyType: 'OWNER' as never,
                        propertyType: { in: ['BUILDING', 'HOUSE'] as never },
                        propertyNumber: { in: parcels },
                      },
                    ]
                  : []),
              ],
            },
            select: {
              id: true,
              occupancyType: true,
              propertyType: true,
              buildingId: true,
              propertyNumber: true,
              units: { select: { unitId: true } },
              registration: { select: { citizenId: true } },
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
      candidateIds.length && unitIds.length
        ? this.db.unitOccupancy.findMany({
            where: { citizenId: { in: [...candidateIds] }, unitId: { in: unitIds }, toDate: null },
            select: { unitId: true, citizenId: true, role: true },
          })
        : Promise.resolve([]),
    ]);

    const cardsByCitizen = new Map<string, PlanCard[]>();
    for (const card of cards) {
      const owner = card.registration.citizenId;
      const bucket = cardsByCitizen.get(owner) ?? [];
      bucket.push(card);
      cardsByCitizen.set(owner, bucket);
    }

    return {
      buildings: buildingById,
      vacantUnitIds: new Set(vacancies.map((row) => row.unitId)),
      citizens: new Map(citizens.map((citizen) => [citizen.id, citizen])),
      cardsByCitizen,
      occupancies,
    };
  }

  /**
   * Which flats a link on this card would claim, or why it cannot claim any.
   *
   * Asked of the card alone, so the answer is the same for every candidate —
   * which is why a blocked card shows its reason once, above the people, rather
   * than on each of them.
   */
  private planTarget(entry: PlanEntry, context: PlanContext): PlanTarget {
    const building = entry.buildingId ? context.buildings.get(entry.buildingId) : undefined;
    if (!building) {
      return { building: null, units: [], block: block('NOT_ON_SURVEY') };
    }

    /*
      The flats the card itself names, and only those in the building it names.
      A unit id pointing into another structure is a stale client — the same
      mismatch `CensusSyncService.applyOccupancy` refuses to act on.
    */
    const named = new Map<string, PlanUnit>();
    for (const row of entry.units) {
      if (row.unitId && row.unit?.buildingId === building.id && !named.has(row.unitId)) {
        named.set(row.unitId, { unitId: row.unitId, unitCode: row.unit.unitCode });
      }
    }

    let units = [...named.values()];
    /*
      A منزل on a structure with exactly one unit names no flat because it has
      nothing to tick — the one inference the census sync already makes, made
      here for the same reason and on the same condition.
    */
    if (units.length === 0 && entry.propertyType === 'HOUSE' && building.units.length === 1) {
      units = [{ unitId: building.units[0]!.id, unitCode: building.units[0]!.unitCode }];
    }
    if (units.length === 0) return { building, units, block: block('NO_UNITS') };

    const vacant = units.find((unit) => context.vacantUnitIds.has(unit.unitId));
    if (vacant) return { building, units, block: block('UNIT_VACANT', vacant.unitCode) };

    return { building, units, block: null };
  }

  /** What linking this card to this citizen would do, or why it may not. */
  private planFor(
    target: PlanTarget,
    citizen: PlanCitizen,
    context: PlanContext,
  ): { block: LinkBlock | null; outcome: LinkOutcome | null } {
    const building = target.building!;

    if (citizen._count.registrations === 0) return { block: block('OWNER_NO_FILE'), outcome: null };

    const cards = context.cardsByCitizen.get(citizen.id) ?? [];

    /*
      The owner already filed this parcel as theirs, without linking that card
      to the census. A link would put the flat on a *second* card for the same
      property, and billing reads both — the same flat charged twice, on two
      rows that are each correct.
    */
    const unlinked = cards.find(
      (card) =>
        card.buildingId === null &&
        card.occupancyType === 'OWNER' &&
        building.parcelNumber &&
        card.propertyNumber === building.parcelNumber,
    );
    if (unlinked) return { block: block('OWNER_CARD_UNLINKED'), outcome: null };

    /*
      The owner holds this building only as a مستأجر or شاغل. `claimOnFile`
      would tick the flat they own onto that card, and the role on a bill comes
      from the card — every owner-borne fee on the flat charged to them as a
      tenancy. An ownership card on their file is the step that fixes it, and
      `claimOnFile` prefers that card as soon as it exists.
    */
    const onBuilding = cards.filter((card) => card.buildingId === building.id);
    const ownerCard = onBuilding.find((card) => card.occupancyType === 'OWNER');
    if (onBuilding.length > 0 && !ownerCard) {
      return { block: block('OWNER_OTHER_CAPACITY'), outcome: null };
    }

    const unitIds = new Set(target.units.map((unit) => unit.unitId));
    const occupying = context.occupancies.find(
      (row) => row.citizenId === citizen.id && unitIds.has(row.unitId) && row.role !== 'OWNER',
    );
    if (occupying) {
      const code = target.units.find((unit) => unit.unitId === occupying.unitId)?.unitCode ?? null;
      return { block: block('OWNER_OCCUPIES_UNIT', code), outcome: null };
    }

    const mapped = STRUCTURE_TYPE_MAP[building.structureType as StructureType];
    if (mapped?.propertyType !== 'BUILDING' && mapped?.propertyType !== 'HOUSE') {
      return { block: null, outcome: 'OCCUPANCY_ONLY' };
    }
    if (!ownerCard) return { block: null, outcome: 'NEW_CARD' };

    const claimsAll = target.units.every(
      (unit) =>
        ownerCard.units.some((row) => row.unitId === unit.unitId) ||
        (ownerCard.propertyType === 'HOUSE' && building.units.length === 1) ||
        (ownerCard.propertyType === 'BUILDING' && ownerCard.units.length === 0),
    );
    return { block: null, outcome: claimsAll ? 'ALREADY_ON_FILE' : 'ADDED_TO_CARD' };
  }

  // ─────────────────────────────  Linking  ─────────────────────────────

  /**
   * Records that the landlord named on a card is this registered citizen, and
   * puts the property on their file.
   *
   * Every check runs before anything is written, and the writes run in one
   * transaction: the link, each owner occupancy, each row on the owner's card,
   * and the footprint of all of it commit together or not at all. A failure on
   * the third flat used to leave the link and two flats written and the rest
   * missing, with nothing recording which.
   */
  async confirm(input: {
    propertyEntryId: string;
    citizenId: string;
    actor: { id: string; role: string };
  }): Promise<LandlordLinkResult> {
    /*
      Checked before it reaches Prisma, which answers `where: { id: undefined }`
      with a validation error the filter renders as a 500.
    */
    if (!input.citizenId?.trim()) {
      throw new ValidationError('المواطن مطلوب', { citizenId: input.citizenId });
    }

    const entry = await this.db.propertyEntry.findUnique({
      where: { id: input.propertyEntryId },
      select: { ...ENTRY_SELECT, landlordLinkFootprint: true },
    });
    if (!entry) throw new NotFoundError('بطاقة العقار غير موجودة');

    const citizen = await this.db.user.findUnique({
      where: { id: input.citizenId },
      select: { id: true, kind: true, phone: true, whatsapp: true, isActive: true },
    });
    if (!citizen || citizen.kind !== 'CITIZEN') {
      throw new ValidationError('المواطن غير موجود', { citizenId: input.citizenId });
    }

    /*
      An OWNER card has no landlord to identify. `PropertyEntry.normalise`
      blanks the number on one, but the id arrives from a request, and a rule
      that decides who is billed should not rest on another layer tidying first.
    */
    if (entry.occupancyType === 'OWNER') {
      throw new ValidationError('بطاقة المالك لا تحمل اسم مالك آخر', {
        propertyEntryId: input.propertyEntryId,
      });
    }

    // A card cannot name its own filer — someone recorded renting from themselves.
    if (entry.registration?.citizen.id === input.citizenId) {
      throw new ValidationError('لا يمكن ربط البطاقة بمن قام بتقديمها', {
        propertyEntryId: input.propertyEntryId,
      });
    }

    /*
      The number has to actually match. Without this any account that can write
      could assert any citizen as any card's landlord and have every screen
      report it as a confirmed match. A clerk may answer the question; they may
      not invent it.
    */
    const claimed = entry.landlordPhone?.trim();
    if (!claimed || (claimed !== citizen.phone && claimed !== citizen.whatsapp)) {
      throw new ValidationError('رقم هاتف المالك لا يطابق هذا المواطن', {
        propertyEntryId: input.propertyEntryId,
        citizenId: input.citizenId,
      });
    }

    // Two clerks agreeing, or an offline queue delivering twice, is not an error.
    if (entry.landlordCitizenId === input.citizenId) {
      return { linked: false, occupanciesRecorded: 0, unitsClaimed: 0, ownerCardCreated: false };
    }

    /*
      Linked to somebody else already. Replacing it silently would move a flat
      from one person's bill to another's with the first person's footprint
      still standing — the undo has to run first, and a person has to choose it.
    */
    if (entry.landlordCitizenId) {
      throw new ConflictError('هذه البطاقة مربوطة بمالك آخر — ألغِ الربط أولاً', {
        propertyEntryId: input.propertyEntryId,
      });
    }

    if (!citizen.isActive) {
      throw new ValidationError('ملف هذا المواطن معطَّل', { citizenId: input.citizenId });
    }

    const context = await this.loadPlanContext([entry], [citizen.id]);
    const target = this.planTarget(entry, context);
    const plan = target.block
      ? { block: target.block, outcome: null }
      : this.planFor(target, context.citizens.get(citizen.id)!, context);
    if (plan.block) {
      throw new ConflictError(plan.block.message, { block: plan.block });
    }

    const footprint = await this.inTransaction(async () => {
      /*
        The card is claimed first, conditionally. It is the row lock that makes
        two clerks confirming the same card at once serialise — the second one's
        update waits, re-reads, matches nothing, and rolls back — rather than
        both writing occupancies.
      */
      const taken = await this.db.propertyEntry.updateMany({
        where: { id: entry.id, landlordCitizenId: null },
        data: { landlordCitizenId: citizen.id },
      });
      if (taken.count === 0) {
        throw new ConflictError('تغيّر ربط هذه البطاقة للتو — حدّث الصفحة', {
          propertyEntryId: entry.id,
        });
      }

      const next = emptyFootprint(citizen.id, input.actor.id);
      await this.applyUnits({
        entryId: entry.id,
        ownerId: citizen.id,
        occupiedBy: entry.occupancyType,
        units: target.units,
        footprint: next,
        actor: input.actor,
      });

      await this.db.propertyEntry.update({
        where: { id: entry.id },
        data: { landlordLinkFootprint: next as never },
      });
      return next;
    });

    this.announce({
      action: 'LANDLORD_LINKED',
      ownerId: citizen.id,
      tenantId: entry.registration?.citizen.id ?? null,
      entryId: entry.id,
      footprint,
      actor: input.actor,
    });

    return {
      linked: true,
      occupanciesRecorded: footprint.units.filter((unit) => unit.occupancyId).length,
      unitsClaimed: footprint.units.length,
      ownerCardCreated: footprint.mintedCardIds.length > 0,
      rowsAdded: footprint.units.filter((unit) => unit.row).length,
      outcome: plan.outcome,
    };
  }

  /**
   * Writes one link's flats, recording each thing written into `footprint`.
   *
   * Runs inside the caller's transaction. It delegates to `recordOccupancy` and
   * `ensureOnFile` rather than restating them — a second copy of which survey
   * states lift and which card a flat lands on is how the matrix and the bill
   * start disagreeing — and reads back what they wrote so the footprint holds
   * the values, not an assumption about them.
   */
  private async applyUnits(input: {
    entryId: string;
    ownerId: string;
    occupiedBy: string;
    units: readonly PlanUnit[];
    footprint: LinkFootprint;
    actor: { id: string; role: string };
  }): Promise<void> {
    /*
      What the tenant's card says about the flat, in the owner's vocabulary.
      A منزل bills its single unit from its own columns, so a card left saying
      nothing reads to `bearsFee` as "nobody was asked" — and charges the owner
      the occupancy fee the tenant is already paying.
    */
    const statement = input.occupiedBy === 'FREE_OCCUPANT' ? 'FREE_OCCUPIED' : 'RENTED';

    for (const planned of input.units) {
      if (input.footprint.units.some((unit) => unit.unitId === planned.unitId)) continue;

      const unit = await this.db.unit.findUnique({
        where: { id: planned.unitId },
        select: { id: true, buildingId: true, unitCode: true, unitStatus: true, surveyStatus: true },
      });
      if (!unit) {
        throw new ConflictError(`الوحدة ${planned.unitCode ?? ''} لم تعد موجودة — حدّث الصفحة`.trim());
      }

      const current = await this.db.unitOccupancy.findFirst({
        where: { unitId: unit.id, citizenId: input.ownerId, toDate: null },
        select: { id: true, role: true, shares: true },
      });
      if (current && current.role !== 'OWNER') {
        throw new ConflictError(block('OWNER_OCCUPIES_UNIT', unit.unitCode).message);
      }

      /*
        The حالة is filled, never overwritten. A status somebody set by hand is a
        finding, and a link is not the place to contradict one.
      */
      const fillsStatus = unit.unitStatus === null;
      const unitStatus = fillsStatus || unit.unitStatus === statement ? statement : null;

      /*
        The cases this flat's occupancy will close, read before it closes them,
        so an undo can put back exactly the ones this link answered.
      */
      const openCases = current
        ? []
        : await this.db.case.findMany({
            where: { unitId: unit.id, status: { in: ['OPEN', 'SCHEDULED'] as never } },
            select: { id: true, status: true, scheduledRevisitAt: true },
          });

      let occupancyId: string | null = null;
      let fileLink: FileLinkResult;

      if (current) {
        /*
          Already recorded as the owner — by the matrix, or by another tenant's
          link. Re-recording would rewrite that spell (its أسهم come from the
          input), so the census is left as it is and only the file is asked to
          back it.
        */
        fileLink = await this.buildings.ensureOnFile({
          unitId: unit.id,
          buildingId: unit.buildingId,
          citizenId: input.ownerId,
          role: 'OWNER',
          shares: current.shares ?? null,
          unitStatus,
        });
      } else {
        const recorded = await this.buildings.recordOccupancy(
          {
            unitId: unit.id,
            citizenId: input.ownerId,
            role: 'OWNER',
            ...(unitStatus ? { unitStatus } : {}),
          } as never,
          input.actor,
        );
        occupancyId = recorded.occupancy.id;
        fileLink = recorded.fileLink;
      }

      if (fileLink.outcome === 'NO_FILE' || fileLink.outcome === 'NO_BUILDING') {
        // The plan said the property would reach their file; it did not.
        throw new ConflictError(block('OWNER_NO_FILE').message);
      }

      const record: FootprintUnit = {
        unitId: unit.id,
        unitCode: unit.unitCode,
        occupancyId,
        row: null,
        filledUnitStatus: !current && fillsStatus && unitStatus ? unitStatus : null,
        liftedSurveyFrom:
          !current && OPEN_SURVEY_STATES.includes(unit.surveyStatus) ? unit.surveyStatus : null,
        cases: openCases.map((row) => ({
          id: row.id,
          status: row.status,
          scheduledRevisitAt: row.scheduledRevisitAt?.toISOString() ?? null,
        })),
      };

      if (
        (fileLink.outcome === 'UNIT_ADDED' || fileLink.outcome === 'ENTRY_CREATED') &&
        fileLink.propertyEntryId
      ) {
        const written = await this.db.buildingUnit.findFirst({
          where: { propertyEntryId: fileLink.propertyEntryId, unitId: unit.id },
          select: ROW_SELECT,
          orderBy: { createdAt: 'desc' },
        });
        if (written) {
          record.row = { propertyEntryId: fileLink.propertyEntryId, snapshot: rowSnapshot(written) };
        }
      }

      if (fileLink.outcome === 'ENTRY_CREATED' && fileLink.propertyEntryId) {
        const card = await this.db.propertyEntry.findUnique({
          where: { id: fileLink.propertyEntryId },
          select: CARD_SELECT,
        });
        if (card) {
          const settled =
            card.propertyType === 'HOUSE' && card.unitStatus === null
              ? { ...card, unitStatus: statement }
              : card;
          const mint: LinkMint = {
            v: 1,
            sourceEntryId: input.entryId,
            ownerId: input.ownerId,
            mintedAt: new Date().toISOString(),
            snapshot: cardSnapshot(settled),
          };
          await this.db.propertyEntry.update({
            where: { id: card.id },
            data: {
              landlordLinkMint: mint as never,
              ...(settled !== card ? { unitStatus: statement as never } : {}),
            },
          });
          input.footprint.mintedCardIds.push(card.id);
        }
      }

      input.footprint.units.push(record);
    }
  }

  /**
   * Applies the «نعم، هو المالك» answers that travelled with a submission.
   *
   * The answer is cheapest at the doorstep and the card does not exist until
   * the save has run, so it rides inside the payload — which is also what makes
   * it survive the offline queue — and is applied here through `confirm`, which
   * re-derives the match from the committed card and believes nothing the
   * client said except the person's answer.
   *
   * Paired by number and candidate rather than by position, so a save that
   * reordered or dropped a card cannot attach an answer to the wrong one. A
   * link that throws — including one the plan blocks — keeps its proposal in
   * `remaining`, so the dialog still asks and the queue still holds it.
   */
  async applyAgreements(input: {
    filed: LandlordProposal[];
    agreements: Array<{ phone: string; citizenId: string }>;
    actor: { id: string; role: string };
  }): Promise<{ remaining: LandlordProposal[]; linked: number }> {
    if (input.agreements.length === 0) return { remaining: input.filed, linked: 0 };

    const remaining: LandlordProposal[] = [];
    let linked = 0;

    for (const proposal of input.filed) {
      const agreed = input.agreements.find(
        (agreement) =>
          agreement.phone === proposal.landlordPhone &&
          proposal.candidates.some((candidate) => candidate.id === agreement.citizenId),
      );

      if (!agreed) {
        remaining.push(proposal);
        continue;
      }

      try {
        const result = await this.confirm({
          propertyEntryId: proposal.propertyEntryId,
          citizenId: agreed.citizenId,
          actor: input.actor,
        });
        if (result.linked) linked += 1;
      } catch (error) {
        this.logger.warn(
          `landlord agreement not applied for entry ${proposal.propertyEntryId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        remaining.push(proposal);
      }
    }

    return { remaining, linked };
  }

  /**
   * Brings a standing link into line with what the tenant's card now names.
   *
   * Run after a tenant's file is saved. The link was about the flats the card
   * named when it was confirmed; an officer who corrects flat 3 to flat 5 has
   * said the tenant rents flat 5, so the owner is taken off 3 (what the link
   * wrote there, and only that) and put on 5. A link confirmed before
   * footprints existed is completed the same way — every flat it now names
   * goes onto the owner's file — with anything already there counted as
   * pre-existing rather than as the link's.
   *
   * A card whose new state blocks the link is **left exactly as it was** and
   * reported. Undoing a person's confirmed answer because somebody edited an
   * unrelated field is the worse failure; the officer is told what to fix.
   */
  async reconcileRegistration(
    registrationId: string,
    actor: { id: string; role: string },
  ): Promise<ReconcileResult> {
    const linked = await this.db.propertyEntry.findMany({
      where: { registrationId, landlordCitizenId: { not: null } },
      select: { ...ENTRY_SELECT, landlordLinkFootprint: true },
    });
    const result: ReconcileResult = { updated: 0, blocked: [] };
    if (linked.length === 0) return result;

    const ownerIds = [...new Set(linked.map((entry) => entry.landlordCitizenId!))];
    const context = await this.loadPlanContext(linked, ownerIds);

    for (const entry of linked) {
      const ownerId = entry.landlordCitizenId!;
      const footprint = readFootprint(entry.landlordLinkFootprint, ownerId);
      const target = this.planTarget(entry, context);

      const wanted = new Set(target.units.map((unit) => unit.unitId));
      const had = new Set((footprint?.units ?? []).map((unit) => unit.unitId));
      const unchanged =
        footprint !== null &&
        wanted.size === had.size &&
        [...wanted].every((unitId) => had.has(unitId));
      if (unchanged) continue;

      const owner = context.citizens.get(ownerId);
      const plan = target.block
        ? { block: target.block }
        : owner
          ? this.planFor(target, owner, context)
          : { block: block('OWNER_NO_FILE') };
      if (plan.block) {
        /*
          Reported only where a footprint says the card *used* to be linkable.
          A link from before footprints that still cannot carry a property is in
          the same state it has been in since it was confirmed; restating that
          on every save of the tenant's file would be a warning people learn to
          dismiss.
        */
        if (footprint) result.blocked.push({ propertyEntryId: entry.id, block: plan.block });
        continue;
      }

      try {
        const events: PendingEvent[] = [];
        const next = await this.inTransaction(async () => {
          const working: LinkFootprint = footprint
            ? { ...footprint, units: [...footprint.units], mintedCardIds: [...footprint.mintedCardIds] }
            : emptyFootprint(ownerId, actor.id);

          const leaving = working.units.filter((unit) => !wanted.has(unit.unitId));
          if (leaving.length > 0) {
            const reverted = await this.revertUnits(this.db, {
              entryId: entry.id,
              ownerId,
              units: leaving,
              // A card still carrying one of the remaining flats has rows on it
              // and is kept by the same rule that keeps an edited one.
              mintedCardIds: working.mintedCardIds,
            });
            events.push(...reverted.events);
            working.units = working.units.filter((unit) => wanted.has(unit.unitId));
            working.mintedCardIds = working.mintedCardIds.filter(
              (id) => !reverted.report.removedCardIds.includes(id),
            );
          }

          await this.applyUnits({
            entryId: entry.id,
            ownerId,
            occupiedBy: entry.occupancyType,
            units: target.units,
            footprint: working,
            actor,
          });

          const saved = await this.db.propertyEntry.updateMany({
            where: { id: entry.id, landlordCitizenId: ownerId },
            data: { landlordLinkFootprint: working as never },
          });
          if (saved.count === 0) throw new ConflictError('تغيّر ربط هذه البطاقة أثناء التحديث');
          return working;
        });

        this.emitAll(events, actor);
        this.announce({
          action: 'LANDLORD_LINK_UPDATED',
          ownerId,
          tenantId: entry.registration?.citizen.id ?? null,
          entryId: entry.id,
          footprint: next,
          actor,
        });
        result.updated += 1;
      } catch (error) {
        this.logger.error(
          `landlord link reconcile failed for entry ${entry.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        result.blocked.push({
          propertyEntryId: entry.id,
          block: {
            code: 'RECONCILE_FAILED',
            message:
              error instanceof ConflictError
                ? error.message
                : 'تعذّر تحديث عقار المالك المرتبط — أعد الحفظ أو راجع الربط من ملف المستأجر',
            unitCode: null,
          },
        });
      }
    }

    return result;
  }

  // ─────────────────────────────  Undoing  ─────────────────────────────

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
        landlordCitizen: { select: { id: true, firstName: true, middleName: true, lastName: true } },
        units: { select: { unit: { select: { unitCode: true } } } },
      },
    });
    if (!entry) throw new NotFoundError('بطاقة العقار غير موجودة');
    if (!entry.landlordCitizenId || !entry.landlordCitizen) {
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
        registration: { select: { citizenId: true } },
        buildingId: true,
        units: { select: { unitId: true, unit: { select: { unitCode: true, buildingId: true } } } },
      },
    });
    if (!entry) throw new NotFoundError('بطاقة العقار غير موجودة');
    if (!entry.landlordCitizenId) return { ...emptyUnlink(), unlinked: false };

    const ownerId = entry.landlordCitizenId;
    const events: PendingEvent[] = [];

    const report = await this.inTransaction(async () => {
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
        throw new ConflictError('تغيّر ربط هذه البطاقة للتو — حدّث الصفحة', {
          propertyEntryId: entry.id,
        });
      }
      return outcome.report;
    });

    this.emitAll(events, input.actor);
    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: ownerId,
      action: 'LANDLORD_UNLINKED',
      after: { propertyEntryId: entry.id, ...summarise(report) },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
    if (entry.registration?.citizenId) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: entry.registration.citizenId,
        action: 'LANDLORD_UNLINKED',
        after: { propertyEntryId: entry.id, ownerId },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }

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

    return this.revertUnits(client, {
      entryId: input.entryId,
      ownerId: input.ownerId,
      units: footprint.units,
      mintedCardIds: footprint.mintedCardIds,
    });
  }

  private async revertUnits(
    client: Prisma.TransactionClient,
    input: {
      entryId: string;
      ownerId: string;
      units: readonly FootprintUnit[];
      mintedCardIds: readonly string[];
    },
  ): Promise<{ report: RevertReport; events: PendingEvent[] }> {
    const report = emptyReport();
    const events: PendingEvent[] = [];
    const now = new Date();

    /*
      The owner's other standing links. A flat another tenant's link also
      claims is still justified — co-tenants of one flat naming one owner — so
      its rows are not this undo's to remove; they move into that link's
      footprint instead, where undoing it later will find them.
    */
    const others = await client.propertyEntry.findMany({
      where: { landlordCitizenId: input.ownerId, id: { not: input.entryId } },
      select: {
        id: true,
        buildingId: true,
        landlordLinkFootprint: true,
        units: { select: { unitId: true } },
      },
    });
    const otherFootprints = new Map(
      others.map((other) => [other.id, readFootprint(other.landlordLinkFootprint, input.ownerId)]),
    );
    const claimedByOther = (unitId: string) =>
      others.find((other) => {
        const footprint = otherFootprints.get(other.id);
        return footprint
          ? footprint.units.some((unit) => unit.unitId === unitId)
          : other.units.some((row) => row.unitId === unitId);
      }) ?? null;
    const transfers = new Map<string, LinkFootprint>();

    const touchedCards = new Set<string>(input.mintedCardIds);

    /** Cards still carrying a row this revert deliberately kept — already reported. */
    const keptRowCards = new Set<string>();

    for (const unit of input.units) {
      const sharer = claimedByOther(unit.unitId);
      if (sharer) {
        const footprint = transfers.get(sharer.id) ?? otherFootprints.get(sharer.id) ?? null;
        if (footprint) {
          /*
            The other link keeps the flat, so it takes over what *this* link
            wrote there. When it confirmed second it found the owner already on
            the flat and recorded nothing of its own — merging is what lets its
            undo, later, end the spell and remove the row after all.
          */
          const theirs = footprint.units.find((row) => row.unitId === unit.unitId);
          const merged: FootprintUnit = theirs
            ? {
                ...theirs,
                occupancyId: theirs.occupancyId ?? unit.occupancyId,
                row: theirs.row ?? unit.row,
                filledUnitStatus: theirs.filledUnitStatus ?? unit.filledUnitStatus,
                liftedSurveyFrom: theirs.liftedSurveyFrom ?? unit.liftedSurveyFrom,
                cases: theirs.cases.length > 0 ? theirs.cases : unit.cases,
              }
            : unit;
          transfers.set(sharer.id, {
            ...footprint,
            units: theirs
              ? footprint.units.map((row) => (row.unitId === unit.unitId ? merged : row))
              : [...footprint.units, merged],
          });
        }
        report.kept.push({ unitCode: unit.unitCode, reason: 'SHARED' });
        continue;
      }

      if (unit.row) {
        touchedCards.add(unit.row.propertyEntryId);
        const rows = await client.buildingUnit.findMany({
          where: { propertyEntryId: unit.row.propertyEntryId, unitId: unit.unitId },
          select: { id: true, ...ROW_SELECT },
        });
        const pristine = rows.find((row) => sameRow(rowSnapshot(row), unit.row!.snapshot));

        if (rows.length > 0 && !pristine) {
          // Somebody has described this flat on the owner's card since.
          report.kept.push({ unitCode: unit.unitCode, reason: 'EDITED' });
          keptRowCards.add(unit.row.propertyEntryId);
          continue;
        }
        if (pristine) {
          await client.buildingUnit.delete({ where: { id: pristine.id } });
          report.rowsRemoved += 1;
          if (rows.length > 1) {
            report.kept.push({ unitCode: unit.unitCode, reason: 'EDITED' });
            keptRowCards.add(unit.row.propertyEntryId);
            continue;
          }
        }
      } else if (unit.occupancyId && (await this.ownerFileClaims(client, input.ownerId, unit.unitId))) {
        /*
          The link opened the spell but wrote no row, because a card the owner
          filed themselves already claimed the flat. That is the owner's own
          statement: ending the spell would split the two records, and the
          owner's next save would re-open it from their card anyway.
        */
        report.kept.push({ unitCode: unit.unitCode, reason: 'OWNER_FILE_CLAIMS' });
        continue;
      }

      if (unit.occupancyId) {
        const closing = await client.unitOccupancy.findFirst({
          where: { id: unit.occupancyId, citizenId: input.ownerId, role: 'OWNER', toDate: null },
          select: { id: true, unit: { select: { buildingId: true, unitCode: true } } },
        });
        if (closing) {
          await client.unitOccupancy.update({
            where: { id: closing.id },
            data: { toDate: now, endReason: 'RECORDED_IN_ERROR' },
          });
          report.occupanciesEnded += 1;
          events.push({
            name: 'building.changed',
            payload: {
              action: 'OCCUPANCY_ENDED',
              buildingId: closing.unit.buildingId,
              before: { unitCode: closing.unit.unitCode, citizenId: input.ownerId },
              after: { occupancyId: closing.id, reason: 'RECORDED_IN_ERROR', via: 'LANDLORD_UNLINK' },
            },
          });

          /*
            What the spell itself changed on the flat, put back only while nobody
            else is recorded there. A tenant still living in it makes «مؤجرة» and
            «مكتملة» true on their own account.
          */
          const stillOccupied = await client.unitOccupancy.count({
            where: { unitId: unit.unitId, toDate: null },
          });
          if (stillOccupied === 0) {
            if (unit.filledUnitStatus) {
              await client.unit.updateMany({
                where: { id: unit.unitId, unitStatus: unit.filledUnitStatus as never },
                data: { unitStatus: null },
              });
            }
            if (unit.liftedSurveyFrom) {
              await client.unit.updateMany({
                where: { id: unit.unitId, surveyStatus: 'COMPLETE' },
                data: { surveyStatus: unit.liftedSurveyFrom as never },
              });
            }
          }

          for (const answered of unit.cases) {
            const reopened = await client.case.updateMany({
              where: { id: answered.id, status: 'RESOLVED', resolvedCitizenId: input.ownerId },
              data: {
                status: answered.status as never,
                resolvedCitizenId: null,
                resolvedAt: null,
                scheduledRevisitAt: answered.scheduledRevisitAt
                  ? new Date(answered.scheduledRevisitAt)
                  : null,
              },
            });
            report.casesReopened += reopened.count;
          }
        }
      }
    }

    /*
      Cards the link created. Removed only while nothing a person said is on
      them: no unit rows left, no documents, no «غير مؤكَّد» flag, the fields
      that decide a bill unchanged — and no other link of this owner standing on
      the same structure.
    */
    for (const cardId of touchedCards) {
      const card = await client.propertyEntry.findUnique({
        where: { id: cardId },
        select: {
          ...CARD_SELECT,
          landlordLinkMint: true,
          registrationId: true,
          createdAt: true,
          _count: { select: { units: true, documents: true } },
        },
      });
      const mint = card ? readMint(card.landlordLinkMint, input.ownerId) : null;
      if (!card || !mint) continue;

      /*
        Another link of this owner still relies on the card: its rows are on it,
        or its tenant is in the same structure and the card claims their flat by
        itself (a منزل, or a مبنى card itemising nothing). The card stays, and
        is handed to that link — so when *it* is undone, the card is still
        recognised as a link's and removed then.
      */
      const footprintOf = (other: (typeof others)[number]) =>
        transfers.get(other.id) ?? otherFootprints.get(other.id) ?? null;
      const holder =
        others.find((other) => {
          const footprint = footprintOf(other);
          return (
            footprint?.mintedCardIds.includes(card.id) ||
            footprint?.units.some((unit) => unit.row?.propertyEntryId === card.id)
          );
        }) ??
        (card.buildingId ? others.find((other) => other.buildingId === card.buildingId) : undefined);

      if (holder) {
        const footprint = footprintOf(holder);
        if (footprint && !footprint.mintedCardIds.includes(card.id)) {
          transfers.set(holder.id, {
            ...footprint,
            mintedCardIds: [...footprint.mintedCardIds, card.id],
          });
        }
        continue;
      }

      if (card._count.units > 0) {
        // Rows somebody added — or the kept row reported above, said once.
        if (!keptRowCards.has(card.id)) {
          report.kept.push({ unitCode: null, reason: 'EDITED', propertyEntryId: card.id });
        }
        continue;
      }
      if (card._count.documents > 0) {
        report.kept.push({ unitCode: null, reason: 'HAS_DOCUMENTS', propertyEntryId: card.id });
        continue;
      }
      if (!sameCard(cardSnapshot(card), mint.snapshot)) {
        report.kept.push({ unitCode: null, reason: 'EDITED', propertyEntryId: card.id });
        continue;
      }

      const removed = await this.removeMintedCard(client, card.id, card.registrationId);
      if (removed === 'FLAGGED') {
        report.kept.push({ unitCode: null, reason: 'FLAGGED', propertyEntryId: card.id });
        continue;
      }
      report.cardsRemoved += 1;
      report.removedCardIds.push(card.id);
    }

    for (const [otherId, footprint] of transfers) {
      await client.propertyEntry.update({
        where: { id: otherId },
        data: { landlordLinkFootprint: footprint as never },
      });
    }

    return { report, events };
  }

  /**
   * Whether a card the owner filed themselves — not one a link created —
   * claims this flat, in either of the two shapes the census sync reads a
   * claim from: an itemised tick, or a منزل on a one-unit structure.
   */
  private async ownerFileClaims(
    client: Prisma.TransactionClient,
    ownerId: string,
    unitId: string,
  ): Promise<boolean> {
    const ownCards = {
      registration: { citizenId: ownerId },
      landlordLinkMint: { equals: Prisma.DbNull },
    };

    const ticked = await client.buildingUnit.count({
      where: { unitId, propertyEntry: ownCards },
    });
    if (ticked > 0) return true;

    const unit = await client.unit.findUnique({ where: { id: unitId }, select: { buildingId: true } });
    if (!unit) return false;

    const [houses, unitsInBuilding] = await Promise.all([
      client.propertyEntry.count({
        where: { ...ownCards, buildingId: unit.buildingId, propertyType: 'HOUSE' },
      }),
      client.unit.count({ where: { buildingId: unit.buildingId } }),
    ]);
    return houses > 0 && unitsInBuilding === 1;
  }

  /**
   * Deletes a card the link minted, keeping the registration's flags pointing
   * at the cards they were raised on.
   *
   * A flag names a card by its position — `properties.2.neighborhood` — in the
   * registration's cards ordered by creation. Deleting card 1 without shifting
   * would move every later card's «غير مؤكَّد» onto its neighbour. A flag on the
   * card itself means somebody recorded something about it, so it is kept.
   */
  private async removeMintedCard(
    client: Prisma.TransactionClient,
    cardId: string,
    registrationId: string,
  ): Promise<'REMOVED' | 'FLAGGED'> {
    const registration = await client.registration.findUnique({
      where: { id: registrationId },
      select: {
        flaggedFields: true,
        properties: { select: { id: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    const index = registration?.properties.findIndex((property) => property.id === cardId) ?? -1;
    const flags = Array.isArray(registration?.flaggedFields)
      ? (registration!.flaggedFields as Array<{ path?: unknown }>)
      : [];

    const shifted = flags.map((flag) => {
      const match = typeof flag.path === 'string' ? /^properties\.(\d+)\.(.+)$/.exec(flag.path) : null;
      if (!match) return { flag, onCard: false };
      const position = Number(match[1]);
      if (index >= 0 && position === index) return { flag, onCard: true };
      if (index >= 0 && position > index) {
        return { flag: { ...flag, path: `properties.${position - 1}.${match[2]}` }, onCard: false };
      }
      return { flag, onCard: false };
    });
    if (shifted.some((row) => row.onCard)) return 'FLAGGED';

    if (index >= 0 && shifted.some((row, at) => row.flag !== flags[at])) {
      await client.registration.update({
        where: { id: registrationId },
        data: { flaggedFields: shifted.map((row) => row.flag) as never },
      });
    }
    await client.propertyEntry.delete({ where: { id: cardId } });
    return 'REMOVED';
  }

  // ─────────────────────────────  Answers  ─────────────────────────────

  /**
   * «لا أحد منهم» — the citizens shown on this card are not its owner.
   *
   * Recorded per citizen, so the queue shrinks without closing the claim to the
   * person who has not registered yet. Written in one statement so a second
   * clerk's dismissal on the same card unions with the first instead of
   * replacing it — and a dismissal from before per-citizen answers is first
   * turned into the list it stood for, so adding to it rejects nobody new and
   * re-offers nobody old.
   */
  async dismiss(input: {
    propertyEntryId: string;
    candidateIds: readonly string[];
    actor: { id: string; role: string };
  }): Promise<{ dismissed: boolean }> {
    const ids = [...new Set(input.candidateIds.filter((id) => UUID.test(id)))];
    if (ids.length === 0) {
      throw new ValidationError('حدّد المواطنين المرفوضين', { candidateIds: input.candidateIds });
    }

    const S = tenantSchemaRef(this.tenantContext.schemaName);
    const now = new Date();
    const count = await this.db.$executeRaw`
      UPDATE ${S}property_entries AS pe
      SET "landlordLinkDismissedIds" = ARRAY(
            SELECT DISTINCT x FROM unnest(
              pe."landlordLinkDismissedIds"
              || ${ids}::uuid[]
              || CASE
                   WHEN pe."landlordLinkDismissedAt" IS NOT NULL
                        AND cardinality(pe."landlordLinkDismissedIds") = 0
                   THEN ARRAY(
                     SELECT u.id FROM ${S}users u
                     WHERE (u.phone = pe."landlordPhone" OR u.whatsapp = pe."landlordPhone")
                       AND u."createdAt" <= pe."landlordLinkDismissedAt"
                   )
                   ELSE ARRAY[]::uuid[]
                 END
            ) AS x
          ),
          "landlordLinkDismissedAt" = ${now},
          "updatedAt" = ${now}
      WHERE pe.id = ${input.propertyEntryId}::uuid
        AND pe."landlordCitizenId" IS NULL
    `;

    if (count > 0) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: ids[0],
        action: 'LANDLORD_MATCH_DISMISSED',
        after: { propertyEntryId: input.propertyEntryId, candidateIds: ids },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }
    return { dismissed: count > 0 };
  }

  /** The undo for `dismiss` — offers these citizens on the card again. */
  async undismiss(input: {
    propertyEntryId: string;
    candidateIds: readonly string[];
    actor: { id: string; role: string };
  }): Promise<{ restored: boolean }> {
    const ids = [...new Set(input.candidateIds.filter((id) => UUID.test(id)))];
    if (ids.length === 0) return { restored: false };

    const S = tenantSchemaRef(this.tenantContext.schemaName);
    const now = new Date();
    const count = await this.db.$executeRaw`
      UPDATE ${S}property_entries AS pe
      SET "landlordLinkDismissedIds" = ARRAY(
            SELECT x FROM unnest(pe."landlordLinkDismissedIds") AS x
            WHERE x <> ALL(${ids}::uuid[])
          ),
          "landlordLinkDismissedAt" = CASE
            WHEN cardinality(ARRAY(
              SELECT x FROM unnest(pe."landlordLinkDismissedIds") AS x
              WHERE x <> ALL(${ids}::uuid[])
            )) = 0 THEN NULL
            ELSE pe."landlordLinkDismissedAt"
          END,
          "updatedAt" = ${now}
      WHERE pe.id = ${input.propertyEntryId}::uuid
        AND pe."landlordCitizenId" IS NULL
        AND pe."landlordLinkDismissedIds" && ${ids}::uuid[]
    `;

    if (count > 0) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: ids[0],
        action: 'LANDLORD_MATCH_RESTORED',
        after: { propertyEntryId: input.propertyEntryId, candidateIds: ids },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }
    return { restored: count > 0 };
  }

  // ─────────────────────────────  Reporting  ─────────────────────────────

  /**
   * How much ownership the register knows about and does not bill: current
   * OWNER spells on units whose owner has filed no ownership card on that
   * building. One aggregate, rather than every owner spell in the municipality
   * loaded into memory on each visit to the queue.
   */
  async unbilledOwnedUnits(): Promise<{ units: number; owners: number }> {
    const S = tenantSchemaRef(this.tenantContext.schemaName);
    const [row] = await this.db.$queryRaw<Array<{ units: number; owners: number }>>`
      SELECT count(*)::int AS units, count(DISTINCT o."citizenId")::int AS owners
      FROM ${S}unit_occupancies o
      JOIN ${S}units un ON un.id = o."unitId"
      WHERE o.role = 'OWNER'
        AND o."toDate" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${S}property_entries pe
          JOIN ${S}registrations r ON r.id = pe."registrationId"
          WHERE pe."buildingId" = un."buildingId"
            AND pe."occupancyType" = 'OWNER'
            AND r."citizenId" = o."citizenId"
        )
    `;
    return { units: row?.units ?? 0, owners: row?.owners ?? 0 };
  }

  // ─────────────────────────────  Plumbing  ─────────────────────────────

  /**
   * Runs `work` in one transaction that every service it calls also writes
   * through.
   *
   * The link's writes go through `BuildingsService` and `CasesService`, which
   * read the tenant client from the request scope rather than taking one as an
   * argument. Re-entering the scope with the transaction client in place of
   * the pooled one makes all of them part of this transaction without widening
   * a single signature. Events they emit reach listeners inside the same scope,
   * so an audit row for an occupancy is written in — and rolled back with — the
   * transaction that recorded it.
   */
  private async inTransaction<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.tenantContext.require();
    return this.db.$transaction(
      (tx) => this.tenantContext.run({ ...scope, prisma: tx as never }, work),
      { maxWait: 15_000, timeout: 60_000 },
    );
  }

  /** Emits what a revert returned, once its transaction has committed. */
  emitAll(events: readonly PendingEvent[], actor: { id: string; role: string }): void {
    for (const event of events) {
      this.events.emit(event.name, {
        tenantSlug: this.tenantContext.tenantSlug,
        ...event.payload,
        actorId: actor.id,
        actorRole: actor.role,
      });
    }
  }

  private announce(input: {
    action: string;
    ownerId: string;
    tenantId: string | null;
    entryId: string;
    footprint: LinkFootprint;
    actor: { id: string; role: string };
  }): void {
    const after = {
      propertyEntryId: input.entryId,
      unitsClaimed: input.footprint.units.length,
      occupanciesRecorded: input.footprint.units.filter((unit) => unit.occupancyId).length,
      rowsAdded: input.footprint.units.filter((unit) => unit.row).length,
      cardsCreated: input.footprint.mintedCardIds.length,
    };
    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId: input.ownerId,
      action: input.action,
      after,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
    if (input.tenantId) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: input.tenantId,
        action: input.action,
        after: { ...after, ownerId: input.ownerId },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }
  }
}

// ─────────────────────────────  Shapes  ─────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The survey states an occupancy lifts to «مكتملة» — see `recordOccupancy`. */
const OPEN_SURVEY_STATES: readonly string[] = ['NOT_SURVEYED', 'VISITED_NO_ANSWER', 'PARTIAL'];

const CANDIDATE_SELECT = {
  id: true,
  firstName: true,
  middleName: true,
  lastName: true,
  motherName: true,
  phone: true,
  whatsapp: true,
  referenceNumber: true,
  residence: true,
  createdAt: true,
} as const;

const ENTRY_SELECT = {
  id: true,
  landlordName: true,
  landlordPhone: true,
  landlordCitizenId: true,
  occupancyType: true,
  propertyType: true,
  propertyNumber: true,
  buildingName: true,
  buildingId: true,
  createdAt: true,
  building: { select: { code: true } },
  registration: {
    select: {
      id: true,
      referenceNumber: true,
      citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } },
    },
  },
  units: { select: { unitId: true, unit: { select: { buildingId: true, unitCode: true } } } },
} as const;

const ROW_SELECT = {
  unitType: true,
  floor: true,
  side: true,
  unitArea: true,
  unitStatus: true,
  sharedRights: true,
} as const;

/** The fields on a card that decide what it bills — what "edited since" compares. */
const CARD_SELECT = {
  id: true,
  occupancyType: true,
  propertyType: true,
  buildingId: true,
  propertyNumber: true,
  unitType: true,
  unitStatus: true,
  unitArea: true,
  shares: true,
  landType: true,
  sharedRights: true,
} as const;

interface MatchPair {
  entryId: string;
  citizenIds: string[];
  total: number;
}

interface PlanEntry {
  id: string;
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  units: Array<{ unitId: string | null; unit: { buildingId: string; unitCode: string } | null }>;
}

interface PlanUnit {
  unitId: string;
  unitCode: string | null;
}

interface PlanCard {
  id: string;
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  propertyNumber: string | null;
  units: Array<{ unitId: string | null }>;
}

interface PlanCitizen {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  motherName: string | null;
  phone: string | null;
  whatsapp: string | null;
  referenceNumber: string | null;
  residence: string;
  createdAt: Date;
  kind: string;
  isActive: boolean;
  _count: { registrations: number };
}

interface PlanBuilding {
  id: string;
  parcelNumber: string;
  structureType: string;
  units: Array<{ id: string; unitCode: string }>;
}

interface PlanContext {
  buildings: Map<string, PlanBuilding>;
  vacantUnitIds: Set<string>;
  citizens: Map<string, PlanCitizen>;
  cardsByCitizen: Map<string, PlanCard[]>;
  occupancies: Array<{ unitId: string; citizenId: string; role: string }>;
}

interface PlanTarget {
  building: PlanBuilding | null;
  units: PlanUnit[];
  block: LinkBlock | null;
}

export interface PendingEvent {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * Why a link cannot be made yet — each one names the step that unblocks it.
 */
export type LinkBlockCode =
  | 'NOT_ON_SURVEY'
  | 'NO_UNITS'
  | 'UNIT_VACANT'
  | 'OWNER_NO_FILE'
  | 'OWNER_CARD_UNLINKED'
  | 'OWNER_OTHER_CAPACITY'
  | 'OWNER_OCCUPIES_UNIT'
  | 'RECONCILE_FAILED';

export interface LinkBlock {
  code: LinkBlockCode;
  message: string;
  unitCode: string | null;
}

function block(code: LinkBlockCode, unitCode: string | null = null): LinkBlock {
  const unit = unitCode ? ` ${unitCode}` : '';
  const messages: Record<LinkBlockCode, string> = {
    NOT_ON_SURVEY:
      'بطاقة المستأجر غير مربوطة بمبنى في سجل المباني. افتح ملف المستأجر واربط البطاقة بالمبنى ووحدتها أولاً.',
    NO_UNITS:
      'بطاقة المستأجر لا تحدد الوحدة التي يسكنها. افتح ملف المستأجر وحدّد وحدته في المبنى أولاً.',
    UNIT_VACANT: `الوحدة${unit} مؤكَّد شغورها، وبطاقة المستأجر تقول إنه يسكنها. راجع الوحدة في مصفوفة المبنى أولاً.`,
    OWNER_NO_FILE: 'لا يوجد ملف لهذا المواطن يمكن إضافة العقار إليه.',
    OWNER_CARD_UNLINKED:
      'سجّل هذا المالك العقار نفسه في ملفه دون ربطه بسجل المباني. اربط بطاقته بالمبنى أولاً حتى لا يُحتسب العقار مرتين.',
    OWNER_OTHER_CAPACITY:
      'هذا المواطن مسجَّل في المبنى نفسه كمستأجر أو شاغل. أضف له بطاقة «مالك» لهذا المبنى في ملفه أولاً.',
    OWNER_OCCUPIES_UNIT: `هذا المواطن مسجَّل مستأجراً أو شاغلاً في الوحدة${unit} نفسها، فلا يمكن تسجيله مالكاً لها.`,
    RECONCILE_FAILED: 'تعذّر تحديث عقار المالك المرتبط.',
  };
  return { code, message: messages[code], unitCode };
}

/** What a link would do on the owner's file, stated before it is done. */
export type LinkOutcome = 'NEW_CARD' | 'ADDED_TO_CARD' | 'ALREADY_ON_FILE' | 'OCCUPANCY_ONLY';

interface RowSnapshot {
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: string | null;
  unitStatus: string | null;
  sharedRights: string[];
}

interface CardSnapshot {
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  propertyNumber: string | null;
  unitType: string | null;
  unitStatus: string | null;
  unitArea: string | null;
  shares: number | null;
  landType: string | null;
  sharedRights: string[];
}

interface FootprintUnit {
  unitId: string;
  unitCode: string | null;
  /** The OWNER spell this link opened; null when the owner already held one. */
  occupancyId: string | null;
  /** The row this link put on an owner card, with the values it wrote. */
  row: { propertyEntryId: string; snapshot: RowSnapshot } | null;
  /** The حالة the spell filled into a unit that had none. */
  filledUnitStatus: string | null;
  /** The survey state the spell lifted to «مكتملة», if it lifted one. */
  liftedSurveyFrom: string | null;
  /** Cases the spell closed, with what they were before. */
  cases: Array<{ id: string; status: string; scheduledRevisitAt: string | null }>;
}

/**
 * Everything one owner link wrote into somebody else's records.
 *
 * Stored on the tenant's card (`landlordLinkFootprint`). Versioned because it
 * outlives the code that wrote it; a shape this build does not recognise is
 * treated as absent — the conservative reading, which reverts nothing.
 */
export interface LinkFootprint {
  v: 1;
  ownerId: string;
  linkedAt: string;
  actorId: string;
  units: FootprintUnit[];
  mintedCardIds: string[];
}

/** Stored on an owner card a link created (`landlordLinkMint`). */
export interface LinkMint {
  v: 1;
  sourceEntryId: string;
  ownerId: string;
  mintedAt: string;
  snapshot: CardSnapshot;
}

function emptyFootprint(ownerId: string, actorId: string): LinkFootprint {
  return {
    v: 1,
    ownerId,
    linkedAt: new Date().toISOString(),
    actorId,
    units: [],
    mintedCardIds: [],
  };
}

export function readFootprint(value: unknown, ownerId: string): LinkFootprint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LinkFootprint>;
  if (candidate.v !== 1 || candidate.ownerId !== ownerId) return null;
  if (!Array.isArray(candidate.units) || !Array.isArray(candidate.mintedCardIds)) return null;
  return {
    ...(candidate as LinkFootprint),
    units: candidate.units.map((unit) => ({
      ...unit,
      cases: Array.isArray(unit.cases) ? unit.cases : [],
      filledUnitStatus: unit.filledUnitStatus ?? null,
      liftedSurveyFrom: unit.liftedSurveyFrom ?? null,
    })),
  };
}

function readMint(value: unknown, ownerId: string): LinkMint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LinkMint>;
  if (candidate.v !== 1 || candidate.ownerId !== ownerId || !candidate.snapshot) return null;
  return candidate as LinkMint;
}

function decimalText(value: { toString(): string } | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? String(parsed) : value.toString();
}

function rowSnapshot(row: {
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: { toString(): string } | number | null;
  unitStatus: string | null;
  sharedRights: string[];
}): RowSnapshot {
  return {
    unitType: row.unitType ?? null,
    floor: row.floor ?? null,
    side: row.side ?? null,
    unitArea: decimalText(row.unitArea),
    unitStatus: row.unitStatus ?? null,
    sharedRights: [...(row.sharedRights ?? [])].sort(),
  };
}

function cardSnapshot(card: {
  occupancyType: string;
  propertyType: string;
  buildingId: string | null;
  propertyNumber: string | null;
  unitType: string | null;
  unitStatus: string | null;
  unitArea: { toString(): string } | number | null;
  shares: number | null;
  landType: string | null;
  sharedRights: string[];
}): CardSnapshot {
  return {
    occupancyType: card.occupancyType,
    propertyType: card.propertyType,
    buildingId: card.buildingId ?? null,
    propertyNumber: card.propertyNumber ?? null,
    unitType: card.unitType ?? null,
    unitStatus: card.unitStatus ?? null,
    unitArea: decimalText(card.unitArea),
    shares: card.shares ?? null,
    landType: card.landType ?? null,
    sharedRights: [...(card.sharedRights ?? [])].sort(),
  };
}

function sameRow(a: RowSnapshot, b: RowSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(rowSnapshot(b as never));
}

function sameCard(a: CardSnapshot, b: CardSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(cardSnapshot(b as never));
}

function emptyReport(): RevertReport {
  return {
    legacy: false,
    occupanciesEnded: 0,
    rowsRemoved: 0,
    cardsRemoved: 0,
    casesReopened: 0,
    removedCardIds: [],
    kept: [],
  };
}

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

function fullName(person: { firstName: string; middleName?: string | null; lastName: string }): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim();
}

function toCandidate(citizen: {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  motherName?: string | null;
  phone: string | null;
  referenceNumber: string | null;
  residence?: string;
  createdAt?: Date;
}): LandlordCandidate {
  return {
    id: citizen.id,
    name: fullName(citizen),
    fatherName: citizen.middleName ?? null,
    motherName: citizen.motherName ?? null,
    phone: citizen.phone,
    referenceNumber: citizen.referenceNumber ?? null,
    residence: citizen.residence ?? 'RESIDENT',
    registeredAt: citizen.createdAt ? citizen.createdAt.toISOString() : null,
  };
}

/** A registered citizen a claimed landlord number belongs to. */
export interface LandlordCandidate {
  id: string;
  name: string;
  /** The middle name — the father's, which is what tells brothers apart. */
  fatherName: string | null;
  /** A signal a person reads, never a key. See `User.motherName`. */
  motherName: string | null;
  phone: string | null;
  referenceNumber: string | null;
  residence: string;
  registeredAt: string | null;
}

/** One unresolved claim, with whoever its number resolves to. */
export interface LandlordProposal {
  propertyEntryId: string;
  occupancyType: string;
  propertyType: string;
  /** What the tenant said, as typed. */
  landlordName: string | null;
  landlordPhone: string;
  propertyNumber: string | null;
  buildingName: string | null;
  buildingId: string | null;
  buildingCode: string | null;
  /** The flats a link would put the owner on. Empty when the card is blocked. */
  units: PlanUnit[];
  linkedUnitCount: number;
  filedAt: string;
  filedBy: {
    registrationId: string;
    referenceNumber: string;
    citizenId: string;
    name: string;
  } | null;
  /** Why no link can be made from this card yet, whoever the owner is. */
  blocked: LinkBlock | null;
  /** Oldest registration first. More than one is a shared household line. */
  candidates: Array<
    LandlordCandidate & { outcome: LinkOutcome | null; blocked: LinkBlock | null }
  >;
}

/** What one confirmation changed. */
export interface LandlordLinkResult {
  /** False when the card already named this citizen — a replay, not a failure. */
  linked: boolean;
  occupanciesRecorded: number;
  unitsClaimed: number;
  /** Whether a card was created on the owner's own file by this link. */
  ownerCardCreated: boolean;
  rowsAdded?: number;
  outcome?: LinkOutcome | null;
}

export interface RevertReport {
  /** Confirmed before footprints existed — nothing could be reverted precisely. */
  legacy: boolean;
  occupanciesEnded: number;
  rowsRemoved: number;
  cardsRemoved: number;
  casesReopened: number;
  removedCardIds: string[];
  /** What was deliberately left standing, and why. */
  kept: Array<{
    unitCode: string | null;
    reason: 'EDITED' | 'SHARED' | 'OWNER_FILE_CLAIMS' | 'HAS_DOCUMENTS' | 'FLAGGED';
    propertyEntryId?: string;
  }>;
}

export interface UnlinkResult extends RevertReport {
  unlinked: boolean;
  /** For a link from before footprints: the flats to check by hand. */
  reviewUnits: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

export interface UnlinkPreview {
  linked: boolean;
  ownerId: string | null;
  ownerName: string | null;
  legacy: boolean;
  linkedAt: string | null;
  unitCodes: string[];
  cardsCreated: number;
  invoicesSinceLink: number;
}

export interface ReconcileResult {
  updated: number;
  blocked: Array<{ propertyEntryId: string; block: LinkBlock }>;
}
