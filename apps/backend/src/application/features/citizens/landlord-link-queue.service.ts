import { Injectable } from '@nestjs/common';
import { internationalPhone } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { CANDIDATE_SELECT, ENTRY_SELECT, LandlordCandidate, LandlordLinkService, LandlordProposal, MatchPair, PlanCitizen, fullName } from './landlord-link.service';
import { APP_CONFIG } from '../../common/app.config';

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

/**
 * The owner-link queue, read: who an owner's phone could be (`candidatesFor`),
 * the proposals and one proposal, the claims a file made or is named in, and
 * the units an owner holds that nobody is billed for (`unbilledOwnedUnits`).
 * Each proposal is planned as `confirm` would plan it (`hydrate`); the match
 * itself (`matchPairs`) stays with `LandlordLinkService`, whose confirm asks it
 * too. Out of `LandlordLinkService` (audit GOD-09).
 */
@Injectable()
export class LandlordLinkQueueService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly links: LandlordLinkService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

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

    /*
      Three columns, and the third is «رقم للتواصل» (0069).

      An elderly owner with no phone of their own is otherwise unreachable by
      any match: their tenant knows the son's number, types it as the
      landlord's, and the only citizen it finds is the son — who owns nothing.
      Matching the relative's number too is what puts the actual owner in
      front of the clerk.

      This is sound here *because* nothing is linked by it: `candidatesFor`
      feeds the form's question, and a link is only ever written by `confirm`,
      which a human answers. It is also the opposite of the 2026-09-15 error,
      where a relative's number sat in `phone` pretending to be the citizen's
      own — here the register has been told whose number it is.
    */
    const matches = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        OR: [{ phone: normalised }, { whatsapp: normalised }, { contactPhone: normalised }],
      },
      select: { ...CANDIDATE_SELECT, contactPhone: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    /*
      Said per candidate, as the queue says it: a number that is the person's
      own (`PHONE`) is a strong match the form may preselect; one recorded as
      a relative's «رقم للتواصل» (`CONTACT`) is not theirs, and the form must
      say so and make the officer choose.
    */
    return matches.map((citizen) => ({
      ...toCandidate(citizen),
      matchedBy:
        citizen.phone === normalised || citizen.whatsapp === normalised ? ('PHONE' as const) : ('CONTACT' as const),
    }));
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
    const limit = Math.min(Math.max(Math.trunc(page.limit) || APP_CONFIG.pagination.ownerLinks.default, 1), APP_CONFIG.pagination.ownerLinks.max);
    const offset = Math.max(Math.trunc(page.offset) || 0, 0);
    const pairs = await this.links.matchPairs({}, { limit, offset });
    return { items: await this.hydrate(pairs), total: pairs[0]?.total ?? 0 };
  }

  /**
   * One open claim, as the queue shows it — the same match and the same
   * hydration, so «فحص الرابط» and the row it was opened from cannot disagree.
   * Null when the claim is no longer open: linked, dismissed, ended, or naming
   * nobody registered.
   */
  async proposal(propertyEntryId: string): Promise<LandlordProposal | null> {
    const [proposal] = await this.hydrate(await this.links.matchPairs({ entryId: propertyEntryId }));
    return proposal ?? null;
  }

  /**
   * Claims filed *by* one registration that already name a registered citizen —
   * asked right after the save, while the officer is still with the tenant.
   */
  async claimsFiledBy(registrationId: string): Promise<LandlordProposal[]> {
    return this.hydrate(await this.links.matchPairs({ registrationId }));
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
    const citizen = await this.db.user.findFirst({
      where: { id: citizenId, kind: 'CITIZEN' },
      select: { kind: true, phone: true, whatsapp: true, contactPhone: true },
    });
    if (!citizen) return [];

    /*
      «رقم للتواصل» too: an elderly owner registering after their tenants is
      named on those tenants' cards by the son's number, the only one the
      tenant knew. `matchPairs` offers them by it as `CONTACT` — never
      preselected.
    */
    const numbers = [citizen.phone, citizen.whatsapp, citizen.contactPhone].filter(
      (value): value is string => Boolean(value),
    );

    /*
      No early return on a citizen with no phone any more: a tenant who named
      the owner and not the number is still naming them, and the name is now
      a second, weaker way the register can notice — see `matchPairs`.
    */
    const pairs = await this.links.matchPairs({ naming: { citizenId, phones: numbers } });
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
    const context = await this.links.loadPlanContext(entries, candidateIds);

    const proposals: LandlordProposal[] = [];
    for (const pair of pairs) {
      const entry = byId.get(pair.entryId);
      if (!entry) continue;

      const target = this.links.planTarget(entry, context);
      const candidates = pair.citizenIds
        .map((id) => context.citizens.get(id))
        .filter((citizen): citizen is PlanCitizen => Boolean(citizen))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((citizen) => {
          const plan = target.block ? null : this.links.planFor(target, citizen, context);
          return {
            ...toCandidate(citizen),
            /*
              Said per candidate, because one card can hold both kinds: the
              father on the household number and a namesake found by name.
            */
            matchedBy: pair.phoneCitizenIds.includes(citizen.id)
              ? ('PHONE' as const)
              : pair.contactCitizenIds.includes(citizen.id)
                ? ('CONTACT' as const)
                : pair.nameCitizenIds.includes(citizen.id)
                ? ('NAME' as const)
                : ('PROPERTY' as const),
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
        landlordPhone: entry.landlordPhone,
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
            AND pe."endedAt" IS NULL
            AND r."citizenId" = o."citizenId"
        )
    `;
    return { units: row?.units ?? 0, owners: row?.owners ?? 0 };
  }
}
