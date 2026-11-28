import {
  billOwesNothing,
  billRemaining,
  calendarDayOf,
  citizenDisplayName,
  effectiveOwnerBilling,
  isCoOwned,
  isFeeExemptOn,
  municipalToday,
  ownerShareOf,
} from '@mechanization/shared-schemas';
import type {
  BillArrearsView,
  FeeAssessment,
  OwnerBillingFallback,
  RequestStatus,
  RequestType,
  SharedUnitBillView,
} from '@mechanization/shared-schemas';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ARREARS_LINE_SELECT, arrearsView } from '../fees/bill-arrears';
import { writeOffView } from '../fees/bill-write-off';
import { attachOccupancies } from '../fees/fees.service';
import { billsOwedBy, SHARED_BILL_INCLUDE, sharedUnitView } from '../fees/shared-bill-view';
import { dashboardCacheKey } from './reporting.service';

/**
 * One «تأكيد الشغور» still standing on a unit, as a citizen's file reports it.
 *
 * A summary of `UnitVacancyConfirmation`, not the row: what a reader of this
 * file needs is that the municipality has called this flat empty, since when,
 * and on what — which is precisely what a resident or owner disputing the
 * absence of an occupancy fee is entitled to read (see the model's own note).
 * The officer's free-text `notes` stay out, because this shape is also what
 * the citizen's own portal renders.
 */
export interface CitizenProfileVacancy {
  id: string;
  /** Null only on a row migration 0043 backfilled — the question did not exist. */
  basis: string | null;
  observedAt: string;
}

/** One unit inside a BUILDING — شقة, عيادة or محل. */
export interface CitizenProfileUnit {
  id: string;
  /** This flat left the tenancy (migration 0046) — shown as history, billed for nothing. */
  endedAt: string | null;
  endReason: string | null;
  /**
   * Nullable since migration 0031 — a per-unit «غير مؤكَّد» flag blanks the
   * field it excuses, so the review screen has to be able to render a flat the
   * officer could not fully describe. Null here means "not established", never
   * "zero"; the reason is on the registration's `flaggedFields`.
   */
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: number | null;
  sharedRights: string[];
  /** حالة الوحدة — set by the building's owner. Null on a tenant's own card. */
  unitStatus: string | null;

  /** The censused `Unit` this line was linked to, when one was. */
  unitId: string | null;
  unitCode: string | null;
  unitPostedNumber: string | null;
  /**
   * حالة الوحدة as **سجل المباني** holds it, which is not always what the
   * owner's card says.
   *
   * Both are reported because billing reads the census first and the card
   * second, so where the two disagree the disagreement *is* the finding: a
   * card saying «مشغولة من المالك» over a census row saying «شاغرة» is either a
   * vacancy to lift or a card to correct, and a page showing one number cannot
   * say which. Null when the line was never linked to a censused unit.
   */
  censusUnitStatus: string | null;
  /**
   * «مسكن موسمي» — the months (1–12) its owners are usually present, when they
   * last stayed, and when a تصريح بالشغور was filed (migration 0040).
   *
   * Reported because the owner still bears the occupancy fee on a seasonal home
   * (`OWNER_BILLED_WHILE_ABSENT`) and these are the facts the council's decision
   * to shorten that rests on. Empty and null on every other unit.
   */
  presenceMonths: number[];
  ownerLastStayAt: string | null;
  vacancyDeclaredAt: string | null;
  /** The «تأكيد الشغور» standing on the censused unit, if one is. */
  vacancy: CitizenProfileVacancy | null;
  /**
   * Everyone سجل المباني records as a current owner of the linked flat, oldest
   * first, with their أسهم.
   *
   * On a tenancy card this is the flat's full ownership beside the one owner
   * the card is linked to: among co-owners the link names whoever the tenant
   * deals with, and the rest are read from here rather than hidden. Empty when
   * the line is not linked to a flat, or nobody is recorded owning it.
   *
   * `hasNoPhone` and `contactPhone` say how to reach an owner with no number
   * of their own («لا يملك رقم هاتف», «رقم للتواصل»). Staff only: the
   * citizen portal sends a co-owner's name and أسهم, nothing else.
   */
  owners: Array<{
    citizenId: string;
    name: string;
    phone: string | null;
    hasNoPhone: boolean;
    contactPhone: string | null;
    shares: number | null;
  }>;
  /**
   * «معفاة من الرسوم» (0077): why the linked unit is charged nothing, or null.
   * The reason only — the officer's note stays on the staff screens, because
   * this object reaches the citizen portal by spread.
   */
  feeExemption: 'PLACE_OF_WORSHIP' | 'PUBLIC_FACILITY' | 'OTHER' | null;
  /**
   * The exemption's last day, `YYYY-MM-DD`, or null for none (0104). Both are
   * as of today (`isFeeExemptOn`): an exemption that ran out reads as none,
   * since billing charges the unit again.
   */
  feeExemptionValidUntil: string | null;
  /**
   * «توزيع الرسم على المالكين» (migration 0075), when the linked flat has
   * several current owners; null otherwise. `share` is this file's owner's
   * part — what an owner-borne charge on the flat bills them for — or null
   * when it cannot be computed («حسب الأسهم» with أسهم missing), or when this
   * person is not among the owners (a tenancy card).
   */
  ownerBilling: {
    mode: 'EQUAL' | 'BY_SHARES' | 'RESPONSIBLE_OWNER' | null;
    effectiveMode: 'EQUAL' | 'BY_SHARES' | 'RESPONSIBLE_OWNER';
    responsibleOwnerId: string | null;
    /** Read without asking whether the responsible owner's file claims the flat (`RESPONSIBLE_NOT_BILLED`): see docs/code-quality.md. */
    fallback: OwnerBillingFallback | null;
    share: { numerator: number; denominator: number } | null;
  } | null;
}

/**
 * A property card as the citizen filed it.
 *
 * Everything the wizard's four property branches can collect is here, not just
 * the fields common to all of them: staff reviewing a claim were previously
 * shown a tenant's property with no landlord on it, a plot with no land type,
 * a tent with no location, and a building reduced to a unit *count* — all of
 * it stored correctly and simply never selected.
 */
export interface CitizenProfileProperty {
  id: string;
  /**
   * When this tenancy ended, and why (migration 0046). Null on a current card.
   * An ended card is kept on the file as history — with its lease — and bills
   * nothing.
   */
  endedAt: string | null;
  endReason: string | null;
  /**
   * Null when the officer recorded الحي or رقم العقار as «غير مؤكَّد».
   *
   * The profile is the record as it actually stands, so an absence shows as an
   * absence rather than as an empty string that reads like a rendering bug —
   * the registration's own flag list is what says why.
   */
  neighborhood: string | null;
  propertyNumber: string | null;
  propertyType: string;
  occupancyType: string;
  /**
   * Non-owner occupancies only. The name is required of both a مستأجر and a
   * شاغل بتسامح; the phone only of the first — see `occupancyBranch`.
   */
  /**
   * The owner's name as every screen should show it: the registered citizen's
   * own name while a link stands, what the tenant said otherwise.
   *
   * Resolved here, once, so the receipt, ملفّي and the review dialog — which all
   * print this field — show the confirmed owner without each learning about
   * links. What the tenant actually typed is kept in `landlordNameAsTyped`.
   */
  landlordName: string | null;
  /** The name as the tenant gave it, whatever the link says. */
  landlordNameAsTyped: string | null;
  landlordPhone: string | null;
  /**
   * The registered citizen this card's owner was confirmed to be, if anyone.
   *
   * Reported so the profile can link to that person's own file instead of
   * printing their name as loose text — «هذا المالك مسجّل عندنا» is a fact the
   * register already established (`confirmLandlordLink`) and the only page that
   * could show it was the queue where it was decided.
   */
  landlordCitizenId: string | null;
  /** That citizen's reference number, beside the name the card now shows. */
  landlordReferenceNumber: string | null;
  /** HOUSE only, owner only, and null wherever nobody was asked. */
  unitStatus: string | null;
  buildingName: string | null;
  /** HOUSE/LAND carry these directly; a BUILDING keeps them per unit below. */
  unitType: string | null;
  landType: string | null;
  floor: string | null;
  side: string | null;
  tentLocation: string | null;
  unitArea: number | null;
  /**
   * أسهم out of the cadastre's standard 2400 — a share of *ownership*, so it
   * is carried on an owner's card and is null on a tenant's or a free
   * occupant's (`branchFieldsOnly`).
   *
   * Selected here since it was stored: the column has been written by the form
   * since the LAND branch existed and never read back, so «الأسهم» was a row
   * the profile drew from a value that never arrived and therefore never drew
   * at all.
   */
  shares: number | null;
  sharedRights: string[];
  latitude: number | null;
  longitude: number | null;
  /**
   * The censused structure behind this card, when one was linked.
   *
   * Two codes, and they are not interchangeable (D14): `buildingCode` is the
   * municipality's own `ZONE-PARCEL-SUFFIX`, `buildingPostedNumber` is what is
   * painted on the wall. Where they disagree the collector in the street
   * trusts the paint, so a page that shows only one of them is showing the
   * wrong one half the time.
   */
  buildingId: string | null;
  buildingCode: string | null;
  buildingPostedNumber: string | null;
  /**
   * حالة المبنى — and the value this exists for is `WAR_DAMAGED_UNINHABITED`.
   *
   * A structure still standing, war-damaged, and established as empty. Its
   * units are recorded exactly as any building's are, so nothing else on this
   * card distinguishes a flat in it from a flat anybody lives in — which is a
   * gap on the page where a household's file and its invoices are read side by
   * side. Null on a card never linked to a censused building.
   */
  buildingLifecycleStatus: string | null;
  unitCount: number;
  units: CitizenProfileUnit[];
  /**
   * The census flats a card with no unit lines is billed through, read as
   * `holdingsOf` reads them: a منزل's one flat, or the flats this person is
   * recorded on in the building a مبنى card names. Only what changes the bill
   * — «معفاة من الرسوم» and the owners' split — since a line on `units`
   * carries both and these cards have none. Empty for every other card.
   */
  heldUnits: CitizenProfileHeldUnit[];
}

/** What `billedBareCards` reads of a card on the profile. */
export interface ProfileBillingCard {
  id: string;
  endedAt: Date | null;
  propertyType: string | null;
  buildingId: string | null;
  units: ReadonlyArray<{ endedAt: Date | null }>;
}

/**
 * The cards with no current unit lines that billing bills through the census,
 * chosen exactly as `holdingsOf` chooses them, so the file shows «معفاة» and
 * the owners' split on the cards a bill is actually raised from:
 *
 *  - the latest registration only (`registrations` comes latest first, as
 *    `holdingsOf` reads `take: 1` by `submittedAt desc`);
 *  - current cards only, and a line counts only while current — a card whose
 *    every line has ended has none (`endedAt: null` on both, in billing);
 *  - a منزل card with a building bills that building's one flat;
 *  - a مبنى card with a building is the one `attachOccupancies` lets claim
 *    the person's recorded flats there: the first such card, and none when any
 *    other non-مبنى card names the same building.
 *
 * Shares `attachOccupancies` rather than restating it, so the file and the
 * bill cannot pick different cards.
 */
export function billedBareCards<C extends ProfileBillingCard>(
  registrations: ReadonlyArray<{ properties: readonly C[] }>,
): { houses: C[]; blocks: C[] } {
  const current = (registrations[0]?.properties ?? [])
    .filter((card) => !card.endedAt)
    .map((card) => ({ card, buildingId: card.buildingId, propertyType: card.propertyType, units: card.units.filter((line) => !line.endedAt) }));
  const houses = current
    .filter((entry) => entry.propertyType === 'HOUSE' && entry.buildingId && entry.units.length === 0)
    .map((entry) => entry.card);
  // Every building marked, so a claiming card comes back with a list and every other card without one.
  const marked = new Map(current.filter((entry) => entry.buildingId).map((entry) => [entry.buildingId!, [] as never[]]));
  const blocks = attachOccupancies(current, marked)
    .filter((entry) => entry.occupiedUnits !== undefined)
    .map((entry) => entry.card);
  return { houses, blocks };
}

/** A census flat a card bills through without a unit line — see `CitizenProfileProperty.heldUnits`. */
export interface CitizenProfileHeldUnit {
  unitId: string;
  unitCode: string;
  feeExemption: CitizenProfileUnit['feeExemption'];
  feeExemptionValidUntil: CitizenProfileUnit['feeExemptionValidUntil'];
  ownerBilling: CitizenProfileUnit['ownerBilling'];
}

export interface CitizenProfileDocument {
  id: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  propertyEntryId: string | null;
  createdAt: string;
}

export interface CitizenProfileRegistration {
  id: string;
  referenceNumber: string;
  submittedAt: string;
  /** `REQUIRES_REVIEW` when `flags` is non-empty; `PENDING` otherwise. */
  status: string;
  flags: Array<{ path: string; reason: string }>;
  /** «ملاحظات» — what the last officer learned by standing there, or null. */
  notes: string | null;
  properties: CitizenProfileProperty[];
  documents: CitizenProfileDocument[];
}

/**
 * The stored flags, read back without trusting the json column's shape.
 *
 * Same reasoning as `CitizensService.readFlags` — an entry missing either half
 * is dropped, because a flag with no reason is the exact thing this feature
 * exists to prevent and rendering one would report the gap as explained when
 * nobody explained it. Duplicated rather than shared because these two
 * services deliberately have no dependency between them.
 */
function readRegistrationFlags(value: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, reason } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof reason !== 'string') return [];
    return [{ path, reason }];
  });
}

/** One invoice on the citizen's profile — the same shape the portal shows them. */
export interface CitizenProfilePayment {
  id: string;
  title: string;
  amount: number;
  /** Received so far — below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero. */
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived from the due date on read, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  /**
   * «INV-2610-0001» — the number on the bill itself (migration 0079).
   *
   * Null on every bill raised before that migration, which is why the receipt
   * falls back to a reference derived from the id: those documents were issued
   * without a number and inventing one now would be a lie on a printed page.
   */
  invoiceNumber: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟», and the reason the breakdown is stored
   * on the payment at all. `FeesService.listForCitizen` has carried it to the
   * portal's bill list since per-unit billing existed; this response — the one
   * behind both the staff profile and ملفّي — did not, so the single page that
   * shows a citizen's bills beside the properties they were assessed from was
   * the one page that could not explain them.
   *
   * Null on a flat charge, which explains itself, and on every invoice raised
   * before per-unit billing existed.
   */
  assessment: FeeAssessment | null;
  /**
   * The municipal request whose fee this bill is (0092), or null. Named on the
   * bill's page and in «إلغاء الفاتورة»'s dialog: cancelling the bill cancels
   * a request still open on it (review of PR #122). Its status moves with the
   * bill's money events, which clear this cache.
   */
  request: { id: string; requestNumber: string; requestType: RequestType; status: RequestStatus } | null;
  /**
   * On a shared unit bill (0099, D5) this citizen owes with others: the unit
   * and how many may pay it, never who (O2). Null on their own bill.
   */
  sharedUnit: SharedUnitBillView | null;
  /**
   * «متأخرات سنوات سابقة» (task 10): the year, the fee, the رقم العقار and the
   * old books' reference behind an «ARR-» bill; null on any other bill. The
   * reference is the municipality's, so the portal's summary nulls it.
   */
  arrears: BillArrearsView | null;
}

/**
 * Where this citizen stands with the municipality's fees.
 *
 * `overdueTotal` is the unpaid amount whose due date has passed. This system
 * levies no penalty on top of a late fee, so a late fee *is* the unpaid fee —
 * reported as its own total because "owes 400,000" and "owes 400,000, all of
 * it late" are different conversations at the counter.
 */
export interface CitizenFeeTotals {
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/** One card naming this citizen as its confirmed landlord. */
export interface CitizenProfileLandlordOf {
  propertyEntryId: string;
  occupancyType: string;
  tenant: { id: string; name: string; referenceNumber: string | null };
  buildingName: string | null;
  buildingCode: string | null;
  propertyNumber: string | null;
  unitCodes: string[];
  /** Null on a link confirmed before migration 0045 recorded when. */
  linkedAt: string | null;
  /** Set when the tenancy has ended — the link is then history, not a live claim. */
  endedAt: string | null;
}

/** The staff-facing view of one citizen and everything they have filed. */
export interface CitizenProfile {
  id: string;
  fullName: string;
  /** اسم الأم وشهرتها. Null on records filed before migration 0044 — «لم يُسأل». */
  motherName: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** «لا يملك رقم هاتف» — a finished answer, not a gap (0069). */
  hasNoPhone: boolean;
  /** «رقم للتواصل» — a relative's number, never the citizen's own (0069). */
  contactPhone: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residencyNumber: string | null;
  residentStatus: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  maritalStatus: string | null;
  bloodType: string | null;
  referenceNumber: string | null;
  /** نوع الملف — a household, or «غير مقيم في البلدة» (stored as NON_RESIDENT_OWNER). */
  residence: string;
  residencePlace: string | null;
  localContactName: string | null;
  localContactPhone: string | null;
  registeredAt: string;
  /** False for a deactivated record — kept for its history, refused a session. */
  isActive: boolean;
  registrations: CitizenProfileRegistration[];
  /**
   * Tenancy cards other households filed that were confirmed as naming this
   * citizen as their landlord.
   *
   * The owner's half of the link. Until it was listed here the only place a
   * confirmed link could be seen, or undone, was the tenant's file — so the
   * person billed because of it had no way to see why from their own page.
   */
  landlordOf: CitizenProfileLandlordOf[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

/**
 * One citizen's file as staff read it, and as «ملفّي» reads it once
 * `CitizenController.mySummary` has cut it down (reference-only login).
 *
 * Its own service since audit GOD-12 (2026-11-27), out of `ReportingService`. The
 * cached profile keeps its key in the dashboard's namespace (`dashboardCacheKey`),
 * so `ReportingService.onDashboardDataChanged` clears it with everything else
 * the events it listens to make stale.
 */
@Injectable()
export class CitizenProfileService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get cacheTtlSeconds(): number {
    return this.config.getOrThrow<number>('DASHBOARD_CACHE_TTL_SECONDS');
  }

  /**
   * Everything staff see on one citizen's page: who they are, and every
   * property they have filed.
   *
   * Returns null rather than throwing so the controller decides the HTTP shape
   * — this layer has no opinion about 404s.
   */
  async getCitizenProfile(citizenId: string): Promise<CitizenProfile | null> {
    const key = dashboardCacheKey(this.tenantContext.tenantSlug, `citizen:${citizenId}`);
    const cached = await this.cache.get<CitizenProfile>(key);
    if (cached) return cached;

    const profile = await this.computeCitizenProfile(citizenId);
    // A missing citizen isn't cached: caching the 404 would keep serving it
    // for the TTL window even after the citizen is created moments later.
    if (profile) await this.cache.set(key, profile, this.cacheTtlSeconds);
    return profile;
  }

  private async computeCitizenProfile(citizenId: string): Promise<CitizenProfile | null> {
    // The day a unit's fee exemption is read on (0104).
    const today = municipalToday();
    const citizen = await withConnectionRetry(() => this.db.user.findFirst({
      // `kind` is part of the filter, not an afterthought: without it a staff
      // id in the URL would render a staff member through the citizen view.
      where: { id: citizenId, kind: 'CITIZEN' },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        motherName: true,
        phone: true,
        whatsapp: true,
        hasNoPhone: true,
        contactPhone: true,
        gender: true,
        nationality: true,
        isLebanese: true,
        residencyNumber: true,
        residentStatus: true,
        identityDocType: true,
        identityDocNumber: true,
        civilRecordNumber: true,
        totalRegisteredMembers: true,
        actualHouseholdMembers: true,
        maritalStatus: true,
        bloodType: true,
        referenceNumber: true,
        residence: true,
        residencePlace: true,
        localContactName: true,
        localContactPhone: true,
        // The owner's side of every confirmed link — see `landlordOf`.
        namedAsLandlordOn: {
          orderBy: [{ endedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
          select: {
            id: true,
            endedAt: true,
            occupancyType: true,
            buildingName: true,
            propertyNumber: true,
            landlordLinkFootprint: true,
            building: { select: { code: true } },
            units: { select: { unit: { select: { unitCode: true } } } },
            registration: {
              select: {
                citizen: {
                  select: {
                    id: true,
                    firstName: true,
                    middleName: true,
                    lastName: true,
                    residence: true,
                    referenceNumber: true,
                  },
                },
              },
            },
          },
        },
        isActive: true,
        createdAt: true,
        registrations: {
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true,
            referenceNumber: true,
            submittedAt: true,
            status: true,
            flaggedFields: true,
            notes: true,
            properties: {
              /*
                Current cards first, in the order the edit form lists them — the
                order «غير مؤكَّد» flags count positions in — and ended tenancies
                after them, as the history they are.
              */
              orderBy: [{ endedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
              select: {
                id: true,
                endedAt: true,
                endReason: true,
                neighborhood: true,
                propertyNumber: true,
                propertyType: true,
                occupancyType: true,
                landlordName: true,
                landlordPhone: true,
                // The registered citizen an officer confirmed this owner to be,
                // so the card can link to their file instead of naming them.
                landlordCitizenId: true,
                landlordCitizen: {
                  select: { firstName: true, middleName: true, lastName: true, residence: true, referenceNumber: true },
                },
                unitStatus: true,
                buildingName: true,
                unitType: true,
                landType: true,
                floor: true,
                side: true,
                tentLocation: true,
                unitArea: true,
                // أسهم — stored since the LAND branch existed, never read back.
                shares: true,
                sharedRights: true,
                latitude: true,
                longitude: true,
                /*
                  The censused structure behind the card, when there is one.

                  Two fields and they are not interchangeable (D14): `code` is
                  the municipality's own `ZONE-PARCEL-SUFFIX`, and
                  `postedNumber` is what is actually painted on the building.
                  A notice prints both, because where they disagree the
                  collector standing in the street trusts the paint.
                */
                buildingId: true,
                /*
                  `lifecycleStatus` alongside the two codes, because it can now
                  say «متضررة من الحرب وغير مسكونة» — a structure still standing
                  and established as empty (migration 0041). That is a fact
                  about every card attached to it: somebody reading a household
                  file, or an invoice raised against a flat in it, is reading
                  about a building nobody is living in, and no other field on
                  this response says so.
                */
                building: {
                  select: { code: true, postedNumber: true, lifecycleStatus: true },
                },
                // The units themselves, not just how many: a landlord's claim
                // over a building *is* the unit list, and a bare count told a
                // reviewer nothing about which floors were being claimed.
                units: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    endedAt: true,
                    endReason: true,
                    unitType: true,
                    floor: true,
                    side: true,
                    unitArea: true,
                    sharedRights: true,
                    unitStatus: true,
                    unitId: true,
                    /*
                      The censused unit behind the line, not just its code.

                      Three things on it change what this flat is billed, and
                      none of them is knowable from the owner's card: سجل
                      المباني's own حالة الوحدة (which billing reads first), a
                      «تأكيد الشغور» standing on it (which exempts the owner),
                      and the مسكن موسمي facts (which are why an owner who is
                      away all year is billed anyway). A file that shows the
                      bill and not these cannot answer the one question asked
                      about it.
                    */
                    unit: {
                      select: {
                        unitCode: true,
                        postedNumber: true,
                        unitStatus: true,
                        ownerBillingMode: true,
                        responsibleOwnerId: true,
                        feeExemption: true,
                        feeExemptionValidUntil: true,
                        presenceMonths: true,
                        ownerLastStayAt: true,
                        vacancyDeclaredAt: true,
                        /*
                          At most one row comes back: a partial unique index
                          (migration 0041) allows a single confirmation with a
                          null `endedAt` per unit. `take: 1` states that here
                          too, so a future index change degrades to "the newest
                          one" rather than to an unbounded list on a page.
                        */
                        vacancies: {
                          where: { endedAt: null },
                          orderBy: { observedAt: 'desc' },
                          take: 1,
                          select: { id: true, basis: true, observedAt: true },
                        },
                        // The flat's current owners — see `CitizenProfileUnit.owners`.
                        occupancies: {
                          where: { toDate: null, role: 'OWNER' },
                          orderBy: { createdAt: 'asc' },
                          select: {
                            citizenId: true,
                            shares: true,
                            citizen: {
                              select: {
                                firstName: true,
                                middleName: true,
                                lastName: true,
                                residence: true,
                                phone: true,
                                hasNoPhone: true,
                                contactPhone: true,
                                // Billing divides a flat between open files only (0075).
                                isActive: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            // Staff previously had no way to see a citizen's uploaded proofs
            // from this page at all — the documents existed (uploaded and
            // stored correctly) but were never queried here.
            documents: {
              select: {
                id: true,
                type: true,
                mimeType: true,
                sizeBytes: true,
                propertyEntryId: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    }));

    if (!citizen) return null;

    /*
      The citizen's ledger, alongside their claims rather than a page away.
      Staff reviewing a registration are routinely also the people asked "what
      do I owe?", and until now the answer lived only on the fees screen, keyed
      by a name they had to search for again. What they owe is their own bills
      and the shared unit bills they are a debtor on (0099, D5), so it is read
      by that rule rather than through the citizen's own `payments`.
    */
    const ledger = await withConnectionRetry(() =>
      this.db.citizenPayment.findMany({
        where: billsOwedBy(citizen.id),
        orderBy: [{ paymentStatus: 'asc' }, { dueDate: 'asc' }],
        select: {
          id: true,
          title: true,
          amount: true,
          paidAmount: true,
          currency: true,
          dueDate: true,
          paymentStatus: true,
          paymentMethod: true,
          invoiceNumber: true,
          whishTransactionRef: true,
          paidAt: true,
          reviewNote: true,
          // Why the manager cancelled it, when he did (0091).
          cancellationReason: true,
          // «شطب» (0107): when, how much, why and on which decision.
          writtenOffAt: true,
          writeOffAmount: true,
          writeOffReason: true,
          writeOffDecisionRef: true,
          writeOffDecisionDate: true,
          // «ليش عليّ هالمبلغ؟» — see `CitizenProfilePayment.assessment`.
          assessment: true,
          feeNotice: { select: { frequency: true } },
          citizenRequest: { select: { id: true, requestNumber: true, requestType: true, status: true } },
          // An old debt's line (task 10).
          arrearsLine: ARREARS_LINE_SELECT,
          ...SHARED_BILL_INCLUDE,
        },
      }),
    );

    const now = new Date();

    // OVERDUE is derived here for the same reason `FeesService` derives it: a
    // status written by a nightly job is wrong for every hour between a due
    // date passing and the job next running.
    const payments = ledger.map((payment) => ({
      id: payment.id,
      title: payment.title,
      amount: Number(payment.amount),
      paidAmount: Number(payment.paidAmount),
      remaining: billRemaining({
        paymentStatus: payment.paymentStatus,
        amount: Number(payment.amount),
        paidAmount: Number(payment.paidAmount),
      }),
      currency: payment.currency,
      dueDate: payment.dueDate.toISOString(),
      paymentStatus:
        payment.paymentStatus === 'UNPAID' && payment.dueDate < now
          ? 'OVERDUE'
          : payment.paymentStatus,
      paymentMethod: payment.paymentMethod,
      invoiceNumber: payment.invoiceNumber,
      whishTransactionRef: payment.whishTransactionRef,
      paidAt: payment.paidAt?.toISOString() ?? null,
      reviewNote: payment.reviewNote,
      cancellationReason: payment.cancellationReason,
      writeOff: writeOffView(payment),
      // Staff read the old ledger reference too; `CitizenController.mySummary` clears it before the portal sees it.
      arrears: arrearsView(payment, 'STAFF'),
      frequency: payment.feeNotice?.frequency ?? null,
      assessment: (payment.assessment as FeeAssessment | null) ?? null,
      request: payment.citizenRequest
        ? {
            id: payment.citizenRequest.id,
            requestNumber: payment.citizenRequest.requestNumber,
            requestType: payment.citizenRequest.requestType as RequestType,
            status: payment.citizenRequest.status as RequestStatus,
          }
        : null,
      // A shared unit bill this person owes with others: the unit and how many, never who (O2).
      sharedUnit: sharedUnitView(payment),
    }));

    // Summed from the rows just mapped rather than by a second set of
    // aggregate queries: the totals and the list a reviewer reads them against
    // then cannot disagree, which they could if one was cached a moment apart
    // from the other.
    // `field` rather than always `amount`, because since partial payments the
    // three totals below measure different columns: what was billed, what has
    // been received, and what is still owed.
    const sum = (rows: typeof payments, field: 'amount' | 'paidAmount' | 'remaining') =>
      rows.reduce((total, payment) => total + payment[field], 0);
    const overdue = payments.filter((payment) => payment.paymentStatus === 'OVERDUE');
    const heldUnits = await this.profileHeldUnits(citizen.id, citizen.registrations);

    return {
      id: citizen.id,
      // «ورثة المرحوم …» for an estate (0076).
      fullName: citizenDisplayName(citizen),
      motherName: citizen.motherName,
      phone: citizen.phone,
      whatsapp: citizen.whatsapp,
      hasNoPhone: citizen.hasNoPhone,
      contactPhone: citizen.contactPhone,
      gender: citizen.gender,
      nationality: citizen.nationality,
      isLebanese: citizen.isLebanese,
      residencyNumber: citizen.residencyNumber,
      residentStatus: citizen.residentStatus,
      identityDocType: citizen.identityDocType,
      identityDocNumber: citizen.identityDocNumber,
      civilRecordNumber: citizen.civilRecordNumber,
      totalRegisteredMembers: citizen.totalRegisteredMembers,
      actualHouseholdMembers: citizen.actualHouseholdMembers,
      maritalStatus: citizen.maritalStatus,
      bloodType: citizen.bloodType,
      referenceNumber: citizen.referenceNumber,
      residence: citizen.residence,
      residencePlace: citizen.residencePlace,
      localContactName: citizen.localContactName,
      localContactPhone: citizen.localContactPhone,
      registeredAt: citizen.createdAt.toISOString(),
      isActive: citizen.isActive,
      payments,
      fees: {
        // A cancelled bill was withdrawn, not billed (decision of 2026-10-13). Of a written-off
        // one (0107) only what was paid stands as billed: the rest was forgiven
        // (`paidAmount + writeOffAmount = amount`), so billed stays paid plus outstanding.
        feesTotal: payments
          .filter((payment) => payment.paymentStatus !== 'CANCELLED')
          .reduce((total, payment) => total + (payment.paymentStatus === 'WRITTEN_OFF' ? payment.paidAmount : payment.amount), 0),
        // Every pound received, across all rows — a part-payment sitting on an
        // UNPAID invoice is money the municipality has, and filtering to PAID
        // would leave it out.
        paidTotal: sum(payments, 'paidAmount'),
        // What is left on rows not fully settled, not their face value. A bill
        // the manager cancelled owes nothing (0090), named here rather than left
        // to its `remaining` of 0.
        outstandingTotal: sum(
          payments.filter((payment) => payment.paymentStatus !== 'PAID' && !billOwesNothing(payment.paymentStatus)),
          'remaining',
        ),
        overdueTotal: sum(overdue, 'remaining'),
        overdueCount: overdue.length,
        pendingReviewCount: payments.filter(
          (payment) => payment.paymentStatus === 'PENDING_REVIEW',
        ).length,
      },
      landlordOf: citizen.namedAsLandlordOn.map((card) => {
        const footprint = card.landlordLinkFootprint as { linkedAt?: unknown } | null;
        return {
          propertyEntryId: card.id,
          occupancyType: card.occupancyType,
          tenant: {
            id: card.registration.citizen.id,
            name: personName(card.registration.citizen),
            referenceNumber: card.registration.citizen.referenceNumber,
          },
          buildingName: card.buildingName,
          buildingCode: card.building?.code ?? null,
          propertyNumber: card.propertyNumber,
          unitCodes: card.units
            .map((row) => row.unit?.unitCode)
            .filter((code): code is string => Boolean(code)),
          linkedAt: typeof footprint?.linkedAt === 'string' ? footprint.linkedAt : null,
          endedAt: card.endedAt?.toISOString() ?? null,
        };
      }),
      registrations: citizen.registrations.map((registration) => ({
        id: registration.id,
        referenceNumber: registration.referenceNumber,
        submittedAt: registration.submittedAt.toISOString(),
        status: registration.status,
        /**
         * The «غير مؤكَّد» fields and the reason given for each.
         *
         * On the profile rather than only on the edit form because this is the
         * page a collector opens before knocking on a door: "we have no phone
         * number for this household, and here is why" is exactly what they
         * need before setting out, and it is not something to discover by
         * opening the record for editing.
         */
        flags: readRegistrationFlags(registration.flaggedFields),
        /*
          «ملاحظات» — on the profile for the same reason the flags above are.

          This is the page a collector opens before knocking on a door, and a
          note is frequently the single most useful thing on it: «الأسرة تنتقل
          نهاية الشهر» or «الدرج مكسور، الزيارة القادمة من الخلف» is what the
          last officer learned by standing there. A note visible only inside
          the edit form is a note nobody reads before setting out.
        */
        notes: registration.notes,
        properties: registration.properties.map((property) => ({
          id: property.id,
          endedAt: property.endedAt?.toISOString() ?? null,
          endReason: property.endReason,
          neighborhood: property.neighborhood,
          propertyNumber: property.propertyNumber,
          propertyType: property.propertyType,
          occupancyType: property.occupancyType,
          landlordName: property.landlordCitizen
            ? personName(property.landlordCitizen)
            : property.landlordName,
          landlordNameAsTyped: property.landlordName,
          landlordPhone: property.landlordPhone,
          landlordCitizenId: property.landlordCitizenId,
          landlordReferenceNumber: property.landlordCitizen?.referenceNumber ?? null,
          unitStatus: property.unitStatus,
          buildingName: property.buildingName,
          unitType: property.unitType,
          landType: property.landType,
          floor: property.floor,
          side: property.side,
          tentLocation: property.tentLocation,
          // Decimal → number at the edge; `Decimal` serialises as an object,
          // which the client would render as "[object Object]".
          unitArea: property.unitArea == null ? null : Number(property.unitArea),
          shares: property.shares,
          sharedRights: property.sharedRights,
          latitude: property.latitude,
          longitude: property.longitude,
          buildingId: property.buildingId,
          buildingCode: property.building?.code ?? null,
          buildingPostedNumber: property.building?.postedNumber ?? null,
          buildingLifecycleStatus: property.building?.lifecycleStatus ?? null,
          unitCount: property.units.filter((unit) => !unit.endedAt).length,
          heldUnits: heldUnits.get(property.id) ?? [],
          units: property.units.map((unit) => {
            // At most one by the partial unique index; see the select above.
            const vacancy = unit.unit?.vacancies[0];
            return {
              id: unit.id,
              endedAt: unit.endedAt?.toISOString() ?? null,
              endReason: unit.endReason,
              unitType: unit.unitType,
              floor: unit.floor,
              side: unit.side,
              unitArea: unit.unitArea == null ? null : Number(unit.unitArea),
              sharedRights: unit.sharedRights,
              unitStatus: unit.unitStatus,
              unitId: unit.unitId,
              unitCode: unit.unit?.unitCode ?? null,
              unitPostedNumber: unit.unit?.postedNumber ?? null,
              censusUnitStatus: unit.unit?.unitStatus ?? null,
              presenceMonths: unit.unit?.presenceMonths ?? [],
              ownerLastStayAt: unit.unit?.ownerLastStayAt?.toISOString() ?? null,
              vacancyDeclaredAt: unit.unit?.vacancyDeclaredAt?.toISOString() ?? null,
              vacancy: vacancy
                ? {
                    id: vacancy.id,
                    basis: vacancy.basis,
                    observedAt: vacancy.observedAt.toISOString(),
                  }
                : null,
              owners: (unit.unit?.occupancies ?? []).map((owner) => ({
                citizenId: owner.citizenId,
                name: personName(owner.citizen),
                phone: owner.citizen.phone,
                hasNoPhone: owner.citizen.hasNoPhone,
                contactPhone: owner.citizen.contactPhone,
                shares: owner.shares,
              })),
              ...exemptionToday(unit.unit, today),
              ownerBilling: profileOwnerBilling(unit.unit, citizenId),
            };
          }),
        })),
        documents: registration.documents.map((document) => ({
          id: document.id,
          type: document.type,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          propertyEntryId: document.propertyEntryId,
          createdAt: document.createdAt.toISOString(),
        })),
      })),
    };
  }

  /**
   * The census flats each card with no unit lines is billed through — see
   * `CitizenProfileProperty.heldUnits`. Which cards, as `billedBareCards`
   * chooses them; which flats, as `holdingsOf` reads them: a منزل bills its
   * building's one flat, a مبنى card the flats this person is recorded on there.
   */
  private async profileHeldUnits(
    citizenId: string,
    registrations: ReadonlyArray<{ properties: readonly ProfileBillingCard[] }>,
  ): Promise<Map<string, CitizenProfileHeldUnit[]>> {
    const { houses, blocks } = billedBareCards(registrations);
    const held = new Map<string, CitizenProfileHeldUnit[]>();
    if (houses.length + blocks.length === 0) return held;

    const houseBuildings = [...new Set(houses.map((card) => card.buildingId!))];
    const blockBuildings = [...new Set(blocks.map((card) => card.buildingId!))];
    const units = await withConnectionRetry(() =>
      this.db.unit.findMany({
        where: {
          OR: [
            { buildingId: { in: houseBuildings } },
            { buildingId: { in: blockBuildings }, occupancies: { some: { citizenId, toDate: null } } },
          ],
        },
        orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
        select: {
          id: true,
          buildingId: true,
          unitCode: true,
          feeExemption: true,
          feeExemptionValidUntil: true,
          ownerBillingMode: true,
          responsibleOwnerId: true,
          occupancies: {
            where: { toDate: null, role: 'OWNER' },
            select: { citizenId: true, shares: true, citizen: { select: { isActive: true } } },
          },
        },
      }),
    );
    const toHeld = (unit: (typeof units)[number]): CitizenProfileHeldUnit => ({
      unitId: unit.id,
      unitCode: unit.unitCode,
      ...exemptionToday(unit, municipalToday()),
      ownerBilling: profileOwnerBilling(unit, citizenId),
    });

    for (const card of houses) {
      const inBuilding = units.filter((unit) => unit.buildingId === card.buildingId);
      if (inBuilding.length === 1) held.set(card.id, [toHeld(inBuilding[0]!)]);
    }
    // `billedBareCards` never hands a building both a منزل and a مبنى card: the منزل suppresses it.
    for (const card of blocks) {
      held.set(
        card.id,
        units.filter((unit) => unit.buildingId === card.buildingId).map(toHeld),
      );
    }
    return held;
  }
}

/**
 * A unit's fee exemption as a file shows it today (0104): the reason and its
 * last day while it runs (`isFeeExemptOn`), none once it ran out — billing
 * charges it again. The note is never here: this reaches the portal by spread.
 */
function exemptionToday(
  unit: { feeExemption: CitizenProfileUnit['feeExemption']; feeExemptionValidUntil: Date | null } | null | undefined,
  today: string,
): Pick<CitizenProfileUnit, 'feeExemption' | 'feeExemptionValidUntil'> {
  if (!unit || !isFeeExemptOn(unit, today)) return { feeExemption: null, feeExemptionValidUntil: null };
  return {
    feeExemption: unit.feeExemption,
    feeExemptionValidUntil: unit.feeExemptionValidUntil ? calendarDayOf(unit.feeExemptionValidUntil) : null,
  };
}

/** «الاسم الأول اسم الأب الشهرة», skipping whichever part is missing. */
function personName(person: {
  firstName: string;
  middleName: string | null;
  lastName: string;
  residence?: string | null;
}): string {
  // «ورثة المرحوم …» for an estate (0076).
  return citizenDisplayName(person);
}

/** The co-ownership billing of a flat as the citizen's file shows it — see `CitizenProfileUnit.ownerBilling`. Exported for its tests. */
export function profileOwnerBilling(
  unit:
    | {
        ownerBillingMode: 'EQUAL' | 'BY_SHARES' | 'RESPONSIBLE_OWNER' | null;
        responsibleOwnerId: string | null;
        occupancies: ReadonlyArray<{ citizenId: string; shares: number | null; citizen: { isActive: boolean } }>;
      }
    | null
    | undefined,
  citizenId: string,
): CitizenProfileUnit['ownerBilling'] {
  if (!unit) return null;
  // The owners billing divides between — open files only, as `ownerBillingRules` reads them.
  const rule = {
    mode: unit.ownerBillingMode,
    responsibleOwnerId: unit.responsibleOwnerId,
    owners: unit.occupancies
      .filter((owner) => owner.citizen.isActive)
      .map((owner) => ({ citizenId: owner.citizenId, shares: owner.shares })),
  };
  if (!isCoOwned(rule)) return null;
  // A tenant's line: how the owners divide their bill is not this person's business.
  if (!rule.owners.some((owner) => owner.citizenId === citizenId)) return null;
  const effective = effectiveOwnerBilling(rule);
  const outcome = ownerShareOf(rule, citizenId);
  return {
    mode: rule.mode,
    effectiveMode: effective.mode,
    responsibleOwnerId: rule.responsibleOwnerId,
    fallback: effective.fallback,
    share:
      outcome.kind === 'SHARE'
        ? { numerator: outcome.share.numerator, denominator: outcome.share.denominator }
        : outcome.kind === 'WHOLE'
          ? { numerator: 1, denominator: 1 }
          : null,
  };
}
