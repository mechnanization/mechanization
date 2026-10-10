import {
  citizenDisplayName,
  DEFAULT_EXCHANGE_TOLERANCE_PERCENT,
  DEFAULT_LARGE_EXCHANGE_THRESHOLD,
  NON_PERSON_RESIDENCE,
} from '@mechanization/shared-schemas';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type $Enums } from '../../../generated/tenant-client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WHISH_GATEWAY } from '../../../domain/interfaces/whish-gateway.interface';
import type {
  WhishCallback,
  WhishGateway,
} from '../../../domain/interfaces/whish-gateway.interface';
import type {
  CreateFeeNotice,
  DeclarePayment,
  FeeAssessment,
  FeeBasis,
  FeeBearer,
  PaymentMethod,
  SystemSettingsInput,
} from '@mechanization/shared-schemas';
import {
  BACKDATE_WINDOW_DAYS,
  canOverrideCashRules,
  daysBetween,
  isOccupiedByOthers,
  isUnoccupied,
  municipalToday,
  ownerShareOf,
  roundRate,
} from '@mechanization/shared-schemas';
import {
  billableUnits,
  isUnsurveyed,
  type BillablePropertyEntry,
  type BillableUnit,
} from '../../../domain/entities/billable-unit';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber, allocateDocumentNumbers } from '../../common/document-number';
import { unitsUnderReview } from '../buildings/unit-status';
import { uninhabitableUnitIds } from '../buildings/habitability';
import { ownerBillingRules } from '../buildings/owner-billing';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/exceptions';
import { exchangeRuleChangeAllowed } from '../treasury/transfers.plan';
import { assertNotMergedAway } from '../citizens/merged-away';
import { likePattern, searchTokens } from '../../common/search-terms';
import { citizenSearchText } from '../../common/citizen-search';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { PaymentLedgerService, type Tender } from './payment-ledger.service';
import { AuditService, type AuditEntryInput } from '../audit/audit.service';

/** Property categories that live on `PropertyEntry.propertyType`. */
const PROPERTY_TYPE_CATEGORIES = new Set(['BUILDING', 'HOUSE', 'LAND', 'TENT']);

/**
 * How many citizens one assessment round-trip reads at a time.
 *
 * Bounds the result set and the bind list on an ALL_CITIZENS run, which is the
 * only place this query sees the whole register at once. Large enough that a
 * municipality of ordinary size still assesses in a handful of queries.
 */
const ASSESSMENT_BATCH_SIZE = 500;

/** One citizen's bill under this notice, and how it was arrived at. */
export interface CitizenAssessment {
  citizenId: string;
  amount: number;
  /** Null under a flat charge, which needs no explanation beyond its amount. */
  assessment: FeeAssessment | null;
  /** The flats held under review on this bill — for counting each once across a run. Not stored. */
  heldUnitIds?: string[];
  /** The flats held as «غير صالحة للسكن» on this bill, for the same reason. Not stored. */
  uninhabitableUnitIds?: string[];
  /** The units «معفاة من الرسوم» on this bill, for the same reason. Not stored. */
  exemptUnitIds?: string[];
  /** The co-owned flats another owner pays for, for the same reason. Not stored. */
  coOwnerPaidUnitIds?: string[];
}

/** What one citizen holds today, as billing reads it. See `FeesService.holdingsOf`. */
export interface CitizenHoldings {
  citizenId: string;
  name: string;
  /** The latest registration's current cards, occupancies attached. */
  entries: BillablePropertyEntry[];
  /** Where those holdings sit — how a change on a unit is traced to a bill. */
  buildingIds: string[];
  unitCodes: string[];
}

/** Someone the notice targets whose holdings cannot be measured. */
export interface UnassessableCitizen {
  citizenId: string;
  name: string;
  reason: string;
}

/**
 * Whether a unit is one of the things this notice charges for.
 *
 * A category names either a نوع العقار (the whole card) or a نوع الوحدة (one
 * unit inside it), which is why the check has to look at both depths. A notice
 * with no category at all — ALL_CITIZENS, or one aimed at a single citizen —
 * charges for everything the citizen holds.
 */
function unitMatches(unit: BillableUnit, category?: string): boolean {
  if (!category) return true;
  if (PROPERTY_TYPE_CATEGORIES.has(category)) return unit.propertyType === category;
  return unit.unitType === category;
}

/**
 * Whether this notice's bearer makes *this* person liable for *this* unit.
 *
 * The sibling of `unitMatches` above: that one asks whether the unit is the
 * kind of thing the notice charges for, this one asks whether the citizen
 * holding it is the person who owes for it. Both have to be true.
 *
 * The rule is short and every clause in it is load-bearing:
 *
 *  - **An owner-borne fee** (الأرصفة, المجاري) follows the deed. Every unit on
 *    an OWNER card counts, whatever its state — an empty flat still fronts the
 *    same pavement — and a tenant's card contributes nothing, because a tenant
 *    owns none of what they occupy.
 *
 *  - **An occupant-borne fee** (النظافة, القيمة التأجيرية) follows who is
 *    inside. A مستأجر or a شاغل بتسامح is by definition the occupant of the
 *    card they filed, so it always counts. An owner's unit counts unless they
 *    have said someone else is in it (مؤجرة or مشغولة بتسامح — that person is
 *    billed on their own card, and charging both is the double-count this whole
 *    enum exists to end) or that nobody is (شاغرة, قيد الإنجاز).
 *
 * The owner's exemption reads `isOccupiedByOthers`, not `!== 'RENTED'`, and the
 * difference is not cosmetic. The register has three ways to be the شاغل and
 * had only two ways to say so, so a شاغل بتسامح fell through the comparison:
 * their owner answered «مشغولة من المالك» — the only value left — and paid the
 * occupancy fee on a flat somebody else lived in, while that somebody paid it
 * too. `FREE_OCCUPIED` is the missing value and this is the predicate that
 * reads it. See `OCCUPIED_BY_OTHERS`.
 *
 * Null status counts as charged, as everywhere else: it means the question was
 * never put, not that the flat is empty. That is what makes OCCUPANT safe as a
 * default — on a register with no حالة الوحدة recorded anywhere, this function
 * returns true for every unit and the arithmetic is exactly what it was before
 * the column existed.
 */
function bearsFee(unit: BillableUnit, bearer: FeeBearer): boolean {
  if (bearer === 'OWNER') return unit.occupancyType === 'OWNER';

  // A non-owner card is the occupant's own, and carries no status to consult.
  if (unit.occupancyType !== 'OWNER') return true;

  return !isOccupiedByOthers(unit.unitStatus) && !isUnoccupied(unit.unitStatus);
}

/**
 * The part of a unit this person is billed for: their share of a co-owned
 * flat on an owner's card (`ownerShareOf`), else the whole of it. 0 means
 * another co-owner — the responsible one under «مالك مسؤول» — pays for it.
 */
function ownerWeight(unit: BillableUnit): number {
  return unit.occupancyType === 'OWNER' && unit.ownerShare
    ? unit.ownerShare.numerator / unit.ownerShare.denominator
    : 1;
}

type HeldEntry = {
  heldUnitIds?: readonly string[];
  uninhabitableUnitIds?: readonly string[];
  exemptUnitIds?: readonly string[];
  coOwnerPaidUnitIds?: readonly string[];
  assessment?: FeeAssessment | null;
};

/** Flats one hold covers across a run, each counted once — by id where known, by count where not. */
function distinctUnits(
  assessed: readonly HeldEntry[],
  idsOf: (entry: HeldEntry) => readonly string[] | undefined,
  countOf: (assessment: FeeAssessment) => number | undefined,
): number {
  const ids = new Set<string>();
  let unidentified = 0;
  for (const entry of assessed) {
    const known = idsOf(entry) ?? [];
    for (const id of known) ids.add(id);
    unidentified += Math.max(0, (entry.assessment ? countOf(entry.assessment) ?? 0 : 0) - known.length);
  }
  return ids.size + unidentified;
}

/** Flats held under review across a run (`assessCitizen`). */
function distinctHeld(assessed: readonly HeldEntry[]): number {
  return distinctUnits(assessed, (entry) => entry.heldUnitIds, (assessment) => assessment.heldUnitCount);
}

/** Units «معفاة من الرسوم» across a run (`assessCitizen`). */
function distinctExempt(assessed: readonly HeldEntry[]): number {
  return distinctUnits(
    assessed,
    (entry) => entry.exemptUnitIds,
    (assessment) => assessment.exemptUnitCount,
  );
}

/** Flats held as «غير صالحة للسكن» across a run (`assessCitizen`). */
function distinctUninhabitable(assessed: readonly HeldEntry[]): number {
  return distinctUnits(
    assessed,
    (entry) => entry.uninhabitableUnitIds,
    (assessment) => assessment.uninhabitableUnitCount,
  );
}

/**
 * Co-owned flats another owner — the responsible one — pays for, across a run
 * (`assessCitizen`). Each flat once: three brothers who pay nothing for one shop
 * are one shop paid by the fourth, not three.
 */
function distinctCoOwnerPaid(assessed: readonly HeldEntry[]): number {
  return distinctUnits(
    assessed,
    (entry) => entry.coOwnerPaidUnitIds,
    (assessment) => assessment.coOwnerPaidUnitCount,
  );
}

/**
 * Whether an unsurveyed building could hold any of what this notice charges for.
 *
 * The refusal below is expensive on purpose — it drops a citizen out of a
 * billing run — so it has to fire only where the missing survey could actually
 * change the number. A building's units are always `propertyType: 'BUILDING'`,
 * so a notice aimed at أرض or خيمة cannot gain or lose a single billable unit
 * from anything found inside one. Blocking there would leave a citizen unbilled
 * for their land because of a building the notice never charged for — the same
 * silent under-collection the refusal exists to prevent, arrived at backwards.
 */
function unsurveyedCanMatter(category?: string): boolean {
  if (!category) return true;
  if (PROPERTY_TYPE_CATEGORIES.has(category)) return category === 'BUILDING';
  /*
    A منزل مستقل is the one unit type a building cannot contain.

    It is what a whole HOUSE card *is* — a standalone dwelling — so surveying a
    building can never turn up another one, and refusing to bill a citizen for
    their house because they also own an unsurveyed building would strand them
    over a number the notice never depended on. That is the same silent
    under-collection this guard exists to prevent, arrived at backwards; see
    the note above about أرض.

    Every other unit-type category — محل, مستودع, مكتب — is exactly what an
    unsurveyed building is most likely to be hiding.
  */
  return category !== 'INDEPENDENT_HOUSE';
}

/**
 * One citizen's bill, from their registered holdings.
 *
 * Refusing to guess is the whole design of this function. There are two ways a
 * rate can be multiplied by a number that is not the truth, and both bill the
 * wrong person the wrong way round:
 *
 *  - A **building nobody surveyed** has no unit rows. Counted as zero, the
 *    largest building in the municipality pays nothing at all, and the fee
 *    schedule ends up most generous to exactly the properties worth the most.
 *  - A unit with **no recorded area** cannot be charged per square metre. Read
 *    as zero it is free; read as some default it is fiction with a number
 *    attached, and the citizen disputing it at the counter would be right.
 *
 * Both stop the assessment for that citizen rather than producing a figure. The
 * caller reports them by name so the municipality chases the survey — which is
 * work someone can actually do — instead of quietly under-collecting, which is
 * work nobody can see.
 *
 * A citizen who simply holds none of what the notice charges for is a different
 * case entirely and not an error: they owe nothing, and are skipped.
 *
 * **Units the citizen does not bear the fee for are subtracted rather than
 * refused** — the one thing here that is quietly dropped instead of stopping
 * the assessment. That is safe because it is not a gap in the register: the
 * notice has said who owes it, and the register has said what this person's
 * relationship to each unit is. Both facts are present; the unit simply is not
 * this person's to pay for. See `bearsFee`.
 */
export function assessCitizen(
  entries: readonly BillablePropertyEntry[],
  notice: {
    amount: number;
    basis: FeeBasis;
    targetCategory?: string;
    /** Who owes it. Absent means `OCCUPANT` — see `FEE_BEARER`. */
    bearer?: FeeBearer;
  },
):
  | {
      kind: 'assessed';
      amount: number;
      assessment: FeeAssessment;
      heldUnitIds?: string[];
      uninhabitableUnitIds?: string[];
      exemptUnitIds?: string[];
      coOwnerPaidUnitIds?: string[];
    }
  | { kind: 'unassessable'; reason: string } {
  /*
    A flat charge never asks the register anything.

    It is the notice's own amount, for everyone it targets, and it is checked
    first so that neither guard below can refuse it. Ordering matters: `issue`
    short-circuits FLAT before it reaches here, so a FLAT notice reaching this
    function through any other caller would otherwise have been dropped for a
    citizen whose building was never surveyed — refusing to compute a number
    that does not depend on the survey at all.
  */
  if (notice.basis === 'FLAT') {
    return {
      kind: 'assessed',
      amount: Math.round(notice.amount),
      assessment: {
        basis: 'FLAT',
        rate: notice.amount,
        unitCount: 0,
        totalArea: 0,
        excludedUnitCount: 0,
        heldUnitCount: 0,
        uninhabitableUnitCount: 0,
        sharedUnitCount: 0,
        coOwnerPaidUnitCount: 0,
        exemptUnitCount: 0,
        lines: [],
      },
    };
  }

  const unsurveyed = unsurveyedCanMatter(notice.targetCategory)
    ? entries.find(isUnsurveyed)
    : undefined;
  if (unsurveyed) {
    return {
      kind: 'unassessable',
      reason: `مبنى على العقار ${unsurveyed.propertyNumber ?? '—'} لم تُجرد وحداته بعد`,
    };
  }

  const matching = entries
    .flatMap(billableUnits)
    .filter((unit) => unitMatches(unit, notice.targetCategory));
  /*
    «معفاة من الرسوم» comes off first, under every notice and whoever bears it
    (migration 0077; the user's decision, 2026-10-07): the mosque on a waqf
    parcel, a public building. Before the review hold and the bearer rule, so
    an exempt unit is reported as exempt and nothing else. Counted, so the bill
    says so rather than reading as a smaller holding.
  */
  const exemptUnits = matching.filter((unit) => unit.exempt);
  const held = matching.filter((unit) => !unit.exempt);

  /*
    Split rather than filtered, so the ones left out can be counted.

    An assessment that quietly omits three flats is indistinguishable from an
    assessment of a smaller building, and the resident who believes they were
    charged for them has nothing to point at. `excludedUnitCount` is what turns
    a dropped unit into a line someone can check — and, when it is wrong,
    dispute against the property card that caused it.
  */
  const bearer = notice.bearer ?? 'OCCUPANT';

  /*
    A flat under review is not charged its occupancy fee — to anybody — until
    its records agree (the user's decision, 2026-09-30).

    «Under review» is `settleUnitStatus` finding a conflict it cannot settle: a
    flat marked «مؤجرة» with no tenant registered, or an owner's card
    contradicting the unit about who pays. Charging on either is a guess about
    who lives there, and the guesses that were being made — the owner exempt,
    or the owner and the tenant both — are the two this whole rule exists to
    stop. Held rather than dropped: counted on the bill (`heldUnitCount`), and
    charged from the next period once the flat is settled. The held period
    itself is not charged by any later run — a period's invoice is written once
    — so recovering it is a deliberate charge, as with any missed period.

    Only the occupancy fee. An owner-borne fee follows the deed, and nobody
    disputes whose deed it is.

    Held *before* the bearer rule, not after it: the owner's exemption on a flat
    marked «مؤجرة» with nobody in it is exactly the guess under review, so
    counting it as an exemption would report as settled what is not.
  */
  const reviewing = bearer === 'OCCUPANT' ? held.filter((unit) => unit.underReview) : [];
  /** Held under review for this notice — the occupancy fee only, as above. */
  const inReview = (unit: BillableUnit) => bearer === 'OCCUPANT' && unit.underReview;
  /*
    A flat nobody can live in is charged nothing — to anybody, under any
    rate-based notice — until a re-inspection reads it habitable (the user's
    decisions of 2026-10-05 and 2026-10-07: «غير صالحة للسكن» exempts).

    The rental-value fee is due only for actual occupancy (Law 60/1988 Art.
    11), and the annual maintenance fee follows it (Art. 79); a flat whose
    current damage reading says «غير صالحة للسكن» cannot be occupied in the
    sense either article means. Since 2026-10-07 the owner-borne fees are not
    charged on it either: the user decided «not habitable → exempt», not
    «occupancy fee held». Counted apart from the review hold: the clerk
    settles a review in the register and an uninhabitable flat with a visit.
    A flat that is both, under an occupancy notice, is counted as under
    review — that is the hold someone in the office can lift.

    Not back-billed: a period's invoice is written once, so the months a flat
    was uninhabitable are simply not charged.
  */
  const unlivable = held.filter((unit) => !inReview(unit) && unit.uninhabitable);
  const decided = held.filter((unit) => !inReview(unit) && !unit.uninhabitable);
  const owed = decided.filter((unit) => bearsFee(unit, bearer));
  const excludedUnitCount = decided.length - owed.length;
  /*
    A flat several people own is divided between them, not billed to each in
    full («توزيع الرسم على المالكين», the user's decision, 2026-10-07).

    Every co-owner's own file claims the flat, and this function sees one
    citizen at a time — so before this, each was billed for the whole of it:
    four brothers, one shop, four bills for it. `holdingsOf` attaches this
    owner's part (`ownerShareOf`): 1/N by default, their أسهم over everyone's
    under «حسب الأسهم», all or nothing under «مالك مسؤول». Only an owner's
    unit carries one — a tenant pays for what they occupy whatever the deed
    says — and only a unit this owner already owes for reaches here, so the
    bearer rule has decided first that the owners pay at all.

    «حسب الأسهم» with an owner whose أسهم nobody recorded cannot be divided.
    Refused rather than guessed, as a flat with no area is: the officer
    records the أسهم, or chooses another method.
  */
  const undecidable = owed.find((unit) => unit.occupancyType === 'OWNER' && unit.ownerShareUndecidable);
  if (undecidable) {
    return {
      kind: 'unassessable',
      reason: `وحدة ${undecidable.unitCode ?? ''} على العقار ${undecidable.propertyNumber ?? '—'} يتوزّع رسمها «حسب الأسهم» وأسهم أحد مالكيها غير مسجّلة`,
    };
  }
  // Paid by the responsible owner named on the flat — not this person's to pay.
  const paidByCoOwner = owed.filter((unit) => ownerWeight(unit) === 0);
  const units = owed.filter((unit) => ownerWeight(unit) > 0);
  const shared = units.filter((unit) => unit.occupancyType === 'OWNER' && unit.ownerShare);
  const heldUnitCount = reviewing.length;
  const uninhabitableUnitCount = unlivable.length;
  // Which flats, so a run can count each once — an owner and a tenant hold the same one.
  const heldUnitIds = reviewing.map((unit) => unit.unitId).filter((id): id is string => Boolean(id));
  const uninhabitableUnitIds = unlivable
    .map((unit) => unit.unitId)
    .filter((id): id is string => Boolean(id));
  const exemptUnitIds = exemptUnits.map((unit) => unit.unitId).filter((id): id is string => Boolean(id));
  const coOwnerPaidUnitIds = paidByCoOwner
    .map((unit) => unit.unitId)
    .filter((id): id is string => Boolean(id));

  if (notice.basis === 'PER_AREA') {
    /*
      Only the units being charged for need an area.

      A flat this person does not owe for is not a hole in the bill — it
      contributes nothing to it either way — so refusing the whole citizen over
      a missing مساحة there would strand a household for a measurement that
      could not change what they owe by a pound.
    */
    const missing = units.find((unit) => unit.unitArea === null);
    if (missing) {
      return {
        kind: 'unassessable',
        reason: `وحدة على العقار ${missing.propertyNumber ?? '—'} بلا مساحة مسجّلة`,
      };
    }
  }

  // A co-owned flat counts for this owner's part of its area, or of one unit.
  const totalArea = units.reduce((sum, unit) => sum + (unit.unitArea ?? 0) * ownerWeight(unit), 0);
  const chargedUnits = units.reduce((sum, unit) => sum + ownerWeight(unit), 0);

  // Only the two rate bases reach here; FLAT returned above.
  const multiplier = notice.basis === 'PER_AREA' ? totalArea : chargedUnits;

  return {
    kind: 'assessed',
    /*
      Rounded to the whole pound, because that is what a Lebanese municipal
      receipt is denominated in and `lbpAmount` refuses anything else. Rounding
      here rather than at the database keeps the stored breakdown and the stored
      amount describing the same arithmetic.
    */
    amount: Math.round(notice.amount * multiplier),
    heldUnitIds,
    uninhabitableUnitIds,
    exemptUnitIds,
    coOwnerPaidUnitIds,
    assessment: {
      basis: notice.basis,
      rate: notice.amount,
      unitCount: units.length,
      totalArea,
      excludedUnitCount,
      heldUnitCount,
      uninhabitableUnitCount,
      sharedUnitCount: shared.length,
      coOwnerPaidUnitCount: paidByCoOwner.length,
      exemptUnitCount: exemptUnits.length,
      ...(shared.length > 0 && notice.basis === 'PER_UNIT' ? { chargedUnits } : {}),
      lines: units.map((unit) => ({
        propertyNumber: unit.propertyNumber,
        propertyType: unit.propertyType,
        unitType: unit.unitType,
        unitArea: notice.basis === 'PER_AREA' ? unit.unitArea : null,
        ...(unit.unitCode ? { unitCode: unit.unitCode } : {}),
        ...(unit.occupancyType === 'OWNER' && unit.ownerShare
          ? {
              ownerShare: {
                mode: unit.ownerShare.mode as 'EQUAL' | 'BY_SHARES' | 'RESPONSIBLE_OWNER',
                numerator: unit.ownerShare.numerator,
                denominator: unit.ownerShare.denominator,
              },
            }
          : {}),
      })),
    },
  };
}

/**
 * A FLAT notice aimed at a category («رسم المحلات», one amount per shop
 * holder), for one holder.
 *
 * The notice's own amount, as every FLAT notice charges — per holder, whatever
 * they hold of it — except a holder every one of whose units of that category
 * is charged nothing: «معفاة من الرسوم» (0077), «غير صالحة للسكن», or paid by
 * another co-owner under «مالك مسؤول» (this owner's part is 0). The waqf whose
 * one office is the mosque is not a holder of offices for this notice, a family
 * whose one shop is a ruin is not a shop holder (the user's decisions of
 * 2026-10-07: «not habitable → exempt», and the mosque exempt), and of four
 * brothers whose one shop the eldest pays for, only the eldest is (the user's
 * decision, 2026-10-08). Under «بالتساوي» and «حسب الأسهم» every co-owner is
 * still a holder and pays the amount once: a flat amount is not divided.
 *
 * Only that. The review hold and the bearer rule stay out of FLAT, as they
 * always have: a flat amount is a person's charge, not a flat's. A notice to
 * every citizen names no category and never reaches here. A holder with no
 * matching unit at all — `resolveTargets` is a superset — is charged, as
 * before: this decides exemption, not targeting.
 *
 * Counted when it lets someone off, so the issue summary says how many units
 * the notice was not charged for; a unit without a register row has no id to
 * count once by, so the assessment carries the counts too.
 */
export function flatCategoryCharge(
  entries: readonly BillablePropertyEntry[],
  notice: { amount: number; targetCategory: string },
): {
  amount: number;
  assessment: FeeAssessment | null;
  uninhabitableUnitIds?: string[];
  exemptUnitIds?: string[];
  coOwnerPaidUnitIds?: string[];
} {
  const matching = entries
    .flatMap(billableUnits)
    .filter((unit) => unitMatches(unit, notice.targetCategory));
  const exempt = matching.filter((unit) => unit.exempt);
  const unlivable = matching.filter((unit) => !unit.exempt && unit.uninhabitable);
  // In the order `assessCitizen` reports them: exempt, then uninhabitable, then another owner's to pay.
  const paidByCoOwner = matching.filter((unit) => !unit.exempt && !unit.uninhabitable && ownerWeight(unit) === 0);

  if (matching.length === 0 || exempt.length + unlivable.length + paidByCoOwner.length < matching.length) {
    return { amount: notice.amount, assessment: null };
  }

  const ids = (units: readonly BillableUnit[]) =>
    units.map((unit) => unit.unitId).filter((id): id is string => Boolean(id));
  return {
    amount: 0,
    uninhabitableUnitIds: ids(unlivable),
    exemptUnitIds: ids(exempt),
    coOwnerPaidUnitIds: ids(paidByCoOwner),
    assessment: {
      basis: 'FLAT',
      rate: notice.amount,
      unitCount: 0,
      totalArea: 0,
      excludedUnitCount: 0,
      heldUnitCount: 0,
      uninhabitableUnitCount: unlivable.length,
      sharedUnitCount: 0,
      coOwnerPaidUnitCount: paidByCoOwner.length,
      exemptUnitCount: exempt.length,
      lines: [],
    },
  };
}

/**
 * Five minutes. Contact details and office hours change a few times a year,
 * and a write drops the entry outright, so the TTL only bounds how long a
 * change made *outside* this service could go unseen.
 */
/** A pasted invoice id, in any casing. Used to route a search to `id` equality. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETTINGS_CACHE_TTL_SECONDS = 300;

/** Days in a UTC month. `day 0` of the next month is the last day of this one. */
function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Which billing period a date falls in, for a given recurrence.
 *
 * This string is the uniqueness key for an invoice, so its format is load
 * bearing: two dates in the same month must produce byte-identical values or
 * the same citizen gets billed twice for July.
 */
export function periodKeyFor(frequency: string, date: Date): string {
  const year = date.getUTCFullYear();
  switch (frequency) {
    case 'MONTHLY':
      return `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'HALF_YEARLY':
      return `${year}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
    case 'ANNUALLY':
      return String(year);
    default:
      // A one-off fee has exactly one period, forever.
      return 'ONCE';
  }
}

/**
 * The due date this notice carries in the period containing `now`.
 *
 * Rebuilt from the original's day-of-month, **clamped to the target month**.
 *
 * This used to walk forward one period at a time from the original, and the
 * comment here defended that choice against "rebuilding from the month" on the
 * grounds that `setUTCMonth` turns 31 January into 3 March. That overflow is
 * real — but stepping does not escape it, it *compounds* it, because every step
 * moves the accumulated value rather than the original:
 *
 *     notice due 2026-01-31, MONTHLY
 *       run 2026-02-05  period 2026-02  due 2026-03-03   ← dated outside its own period
 *       run 2026-03-05  period 2026-03  due 2026-03-03   ← February and March share a date
 *       run 2026-04-05  period 2026-04  due 2026-04-03   ← moved to the 3rd, permanently
 *
 * Annual notices were worse: a fee due 29 February walked to 1 March and stayed
 * in March for ever, including in the leap years it should have returned to.
 *
 * Rebuilding is correct as long as it clamps, which `setUTCMonth` does not do —
 * it overflows into the next month instead of stopping at the last valid day.
 * So the day is clamped explicitly: a fee due on the 31st falls due on the 30th
 * in April and on the 28th or 29th in February, and is back on the 31st the
 * next month it exists. A fee due on the 15th is due on the 15th, which is what
 * the old comment wanted and what stepping delivered only for mid-month dates.
 *
 * `runRecurringBilling` skips a notice whose own period is the current one and
 * any notice dated in the future, so `original <= now` whenever this is called.
 */
export function dueDateInCurrentPeriod(original: Date, frequency: string, now: Date): Date {
  // A one-off fee has exactly one period and one due date, forever.
  if (frequency !== 'MONTHLY' && frequency !== 'HALF_YEARLY' && frequency !== 'ANNUALLY') {
    return new Date(original);
  }

  const year = now.getUTCFullYear();
  const month =
    frequency === 'MONTHLY'
      ? now.getUTCMonth()
      : frequency === 'ANNUALLY'
        ? original.getUTCMonth()
        : // The same position within the half it started in: a fee first due in
          // February (month 1 of H1) falls due in August (month 1 of H2).
          (now.getUTCMonth() < 6 ? 0 : 6) + (original.getUTCMonth() % 6);

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(original.getUTCDate(), daysInUtcMonth(year, month)),
      original.getUTCHours(),
      original.getUTCMinutes(),
      original.getUTCSeconds(),
      original.getUTCMilliseconds(),
    ),
  );
}

/**
 * A short, safe classifier for a billing failure — never the driver's message.
 *
 * This string is stored in `billing_run_entries.failureKind`, and a Postgres
 * error quotes the row that caused it: a unique violation on a citizen's
 * national ID puts that number in `DETAIL`. Writing `error.message` into a
 * column would make the ledger a citizen-data table by accident, so it never
 * touches the message. A Prisma error code (`P2002`) and an error class name
 * carry no row content and are what an operator actually needs to tell a
 * timeout from a constraint. The message itself goes to the log, on a machine
 * that is allowed to hold it.
 */
function classifyBillingFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^P\d{4}$/.test(code)) return `prisma:${code}`;

    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return name;
  }
  return 'unknown';
}

export interface PaymentSummary {
  id: string;
  title: string;
  amount: number;
  /** Received so far. Below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero — what is still owed. */
  remaining: number;
  currency: string;
  dueDate: string;
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to the only question anyone actually asks at the counter, and
   * the one nobody could answer before: «ليش عليّ هالمبلغ؟». Null for a flat
   * charge, which explains itself.
   */
  assessment: FeeAssessment | null;
}

/**
 * Fees, the invoices they generate, and the settings the portal quotes.
 *
 * The one piece of real logic here is `issue`: an administrator writes a rule
 * once ("500,000 LBP, monthly, every resident") and this fans it out into a
 * row per citizen. Everything downstream — the portal's balance, the overdue
 * badge, the clerk's verification queue — reads those rows, never the rule,
 * so a later edit to the rule cannot rewrite a debt someone already settled.
 */
/** The shape `attachOccupancies` needs of a card, and nothing more. */
interface OccupancyClaimable {
  buildingId?: string | null;
  propertyType?: string | null;
  units?: unknown[];
}

/**
 * Hands each building's recorded occupancies to exactly one card.
 *
 * `heldThroughOccupancy` bills a مبنى card that itemises no flats from
 * `UnitOccupancy` — the only per-citizen table that can answer *which* flats
 * this person holds. The list used to be handed to **every** card linked to
 * that building, and nothing deduped it, so a citizen with two such cards on
 * one block and two flats recorded there was assessed for four. Under a
 * PER_UNIT notice that is double the bill, and every row involved is
 * individually valid.
 *
 * `CensusSyncService` dedupes the mirror of this on the write side with a `Map`
 * keyed by unit; this is the read side of the same fact. Two rules:
 *
 * - **Only a مبنى card with no unit rows may consume the list.** That is the
 *   only card `heldThroughOccupancy` answers for, and spending it on a card
 *   that itemises its own flats would leave a later card that needs it with
 *   nothing — under-billing a resident is worse than the double it fixes.
 * - **A منزل card on the same building suppresses it entirely.** That card
 *   already bills the structure's single unit from its own fields, and the
 *   census's single-unit inference has recorded an occupancy on that very flat,
 *   so the list would bill it a second time.
 *
 * Exported for its own tests: half of it is a rule about *which* card, and a
 * rule like that is invisible in an assessment that only ever sees one.
 */
export function attachOccupancies<T extends OccupancyClaimable, U>(
  properties: readonly T[],
  occupanciesByBuilding: Map<string, U[]>,
): Array<T & { occupiedUnits?: U[] }> {
  const suppressed = new Set(
    properties
      .filter((entry) => entry.buildingId && entry.propertyType !== 'BUILDING')
      .map((entry) => entry.buildingId as string),
  );
  const consumed = new Set<string>();

  return properties.map((entry) => {
    const buildingId = entry.buildingId;
    const claimable =
      buildingId != null &&
      entry.propertyType === 'BUILDING' &&
      (entry.units?.length ?? 0) === 0 &&
      !suppressed.has(buildingId) &&
      !consumed.has(buildingId);

    if (claimable) consumed.add(buildingId);

    return {
      ...entry,
      occupiedUnits: claimable ? occupanciesByBuilding.get(buildingId) : undefined,
    };
  });
}

/**
 * The status tab, as a predicate — because «متأخرة» is not a column.
 *
 * `toAdminPaymentItem` renders an UNPAID row past its due date as OVERDUE, and
 * **nothing writes that value**: `PaymentStatus.OVERDUE` exists in the enum
 * and no code path assigns it. So a raw `paymentStatus: 'OVERDUE'` predicate
 * matched nothing, and the tab returned an empty table over a register full of
 * late invoices — while the rows behind it went on displaying «متأخرة».
 *
 * The two have to be translated together, not just OVERDUE:
 *
 *   غير مدفوعة  → UNPAID and not yet due
 *   متأخرة      → UNPAID and past due
 *
 * Partitioning matters more than the new tab. If «غير مدفوعة» kept meaning
 * "every unpaid row", a late invoice would answer to two tabs while its own
 * status cell named only one of them, and the per-tab counts would not add up
 * to a total anybody could check them against.
 *
 * `now` is a parameter rather than read here, so the boundary is fixed by the
 * caller for the whole request — a row must not fall out of «غير مدفوعة» and
 * into «متأخرة» between the count query and the page query — and so this is
 * testable without freezing the clock.
 *
 * Exported for its own tests: the rule is one line of `where`, invisible in an
 * integration suite that has to reach a database to see it at all.
 */
export function paymentStatusWhere(
  status: string | undefined,
  now: Date,
): Record<string, unknown> {
  if (!status) return {};
  if (status === 'OVERDUE') return { paymentStatus: 'UNPAID', dueDate: { lt: now } };
  if (status === 'UNPAID') return { paymentStatus: 'UNPAID', dueDate: { gte: now } };
  return { paymentStatus: status };
}

@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    @Inject(WHISH_GATEWAY) private readonly whish: WhishGateway,
    private readonly cache: RedisCacheService,
    private readonly ledger: PaymentLedgerService,
    private readonly auditTrail: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ───────────────────────────  Settings  ───────────────────────────

  /** Namespaced per tenant so one municipality's entry cannot serve another. */
  private settingsCacheKey(includeLogo: boolean): string {
    return `settings:${this.tenantContext.tenantSlug}:${includeLogo ? 'full' : 'lite'}`;
  }

  async getSettings(includeLogo = false) {
    /*
     * Cached, because this is the most-read row in the schema.
     *
     * The fees screen, the payments screen, every citizen profile and the
     * citizen-facing pay dialog all read it on load, for a phone number and
     * some opening hours that change a few times a year. Five minutes rather
     * than the dashboard's sixty seconds for the same reason: nothing here is
     * time-sensitive, and `updateSettings` drops the entry anyway, so an edit
     * is visible immediately regardless of the TTL.
     *
     * Keyed on `includeLogo` so the cheap payload and the one carrying the
     * crest cannot be served for one another.
     */
    const key = this.settingsCacheKey(includeLogo);
    const cached = await this.cache.get<Awaited<ReturnType<FeesService['readSettings']>>>(key);
    if (cached) return cached;

    const settings = await this.readSettings(includeLogo);
    await this.cache.set(key, settings, SETTINGS_CACHE_TTL_SECONDS);
    return settings;
  }

  private async readSettings(includeLogo: boolean) {
    const row = await withConnectionRetry(() =>
      this.db.systemSettings.findFirst({ where: { singleton: true } }),
    );

    return {
      whishMoneyNumber: row?.whishMoneyNumber ?? null,
      cashOfficeHours: row?.cashOfficeHours ?? null,
      cashOfficeAddress: row?.cashOfficeAddress ?? null,
      contactPhone: row?.contactPhone ?? null,
      whatsappNumber: row?.whatsappNumber ?? null,

      nameAr: row?.nameAr ?? null,
      nameEn: row?.nameEn ?? null,
      contactEmail: row?.contactEmail ?? null,
      website: row?.website ?? null,
      governorate: row?.governorate ?? null,
      district: row?.district ?? null,
      town: row?.town ?? null,
      councilDecisionRef: row?.councilDecisionRef ?? null,
      // `undefined` rather than null for a citizen: the key is absent, so a
      // client cannot mistake "not sent to you" for "no logo configured".
      logoDataUri: includeLogo ? (row?.logoDataUri ?? null) : undefined,

      // The defaults here match the column defaults, so a municipality whose
      // settings row predates this migration reads the same as one that has
      // simply never opened the finance section.
      defaultFeeFrequency: row?.defaultFeeFrequency ?? 'ANNUALLY',
      defaultDueDays: row?.defaultDueDays ?? 30,
      priceDisplay: row?.priceDisplay ?? 'compact',
      // Decimal → number at the boundary, for JSON. Anything computing a charge
      // must read the column, not this.
      defaultRatePercent: row ? Number(row.defaultRatePercent) : 0,
      baseCurrency: row?.baseCurrency ?? 'LBP',
      secondaryCurrency: row?.secondaryCurrency ?? null,
      exchangeRate: row?.exchangeRate == null ? null : Number(row.exchangeRate),
      exchangeRateUpdatedAt: row?.exchangeRateUpdatedAt?.toISOString() ?? null,
      exchangeRateTolerancePercent: row ? Number(row.exchangeRateTolerancePercent) : DEFAULT_EXCHANGE_TOLERANCE_PERCENT,
      largeExchangeThreshold: row ? Number(row.largeExchangeThreshold) : DEFAULT_LARGE_EXCHANGE_THRESHOLD,

      numberingSequences: (row?.numberingSequences as SystemSettingsInput['numberingSequences']) ?? null,
      backupSchedule: (row?.backupSchedule as SystemSettingsInput['backupSchedule']) ?? null,

      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async updateSettings(input: SystemSettingsInput, actor: { id: string; role: string }) {
    // Empty string means "clear it", which has to reach the database as NULL —
    // otherwise the portal would print an empty Whish number as if it were one.
    // `undefined` means "not sent", which Prisma leaves alone; that difference
    // is what lets one section of the settings screen save without wiping the
    // fields owned by the five it did not render.
    const blankToNull = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() === '' ? null : value.trim();

    /*
      The exchange rule decides which exchanges an auditor reviews, and the
      accountant — who may save this section — books them. Moving it is the
      manager's alone (docs/finance.md §6.3); the same values sent back are fine.
    */
    if (input.exchangeRateTolerancePercent !== undefined || input.largeExchangeThreshold !== undefined) {
      const rule = await withConnectionRetry(() =>
        this.db.systemSettings.findFirst({
          where: { singleton: true },
          select: { exchangeRateTolerancePercent: true, largeExchangeThreshold: true },
        }),
      );
      const allowed = exchangeRuleChangeAllowed({
        role: actor.role,
        current: {
          tolerancePercent: rule ? Number(rule.exchangeRateTolerancePercent) : DEFAULT_EXCHANGE_TOLERANCE_PERCENT,
          largeThreshold: rule ? Number(rule.largeExchangeThreshold) : DEFAULT_LARGE_EXCHANGE_THRESHOLD,
        },
        requested: {
          tolerancePercent: input.exchangeRateTolerancePercent,
          largeThreshold: input.largeExchangeThreshold,
        },
      });
      if (!allowed) {
        throw new ForbiddenError({
          code: 'EXCHANGE_RULE_MANAGER_ONLY',
          message: 'Only the manager changes the exchange tolerance and the large-exchange threshold.',
        });
      }
    }

    /*
     * Stamped here, not by the client.
     *
     * The timestamp answers "how stale is this rate", and a browser's clock is
     * not evidence of when the server accepted a value — nor should a client be
     * able to claim a rate was refreshed today by sending a date. Only a rate
     * that actually changes moves it: re-saving the finance section with the
     * same number must not make a month-old rate look current.
     */
    const previous =
      input.exchangeRate === undefined
        ? null
        : await withConnectionRetry(() =>
            this.db.systemSettings.findFirst({
              where: { singleton: true },
              select: { exchangeRate: true },
            }),
          );
    const rateChanged =
      input.exchangeRate !== undefined &&
      (previous?.exchangeRate == null
        ? input.exchangeRate !== null
        : Number(previous.exchangeRate) !== input.exchangeRate);

    const data = {
      whishMoneyNumber: blankToNull(input.whishMoneyNumber),
      cashOfficeHours: blankToNull(input.cashOfficeHours),
      cashOfficeAddress: blankToNull(input.cashOfficeAddress),
      contactPhone: blankToNull(input.contactPhone),
      whatsappNumber: blankToNull(input.whatsappNumber),

      nameAr: blankToNull(input.nameAr),
      nameEn: blankToNull(input.nameEn),
      contactEmail: blankToNull(input.contactEmail),
      website: blankToNull(input.website),
      governorate: blankToNull(input.governorate),
      district: blankToNull(input.district),
      town: blankToNull(input.town),
      councilDecisionRef: blankToNull(input.councilDecisionRef),
      logoDataUri: blankToNull(input.logoDataUri),

      defaultFeeFrequency: input.defaultFeeFrequency,
      defaultDueDays: input.defaultDueDays,
      priceDisplay: input.priceDisplay,
      defaultRatePercent: input.defaultRatePercent,
      baseCurrency: input.baseCurrency,
      secondaryCurrency: input.secondaryCurrency,
      exchangeRate: input.exchangeRate,
      ...(rateChanged
        ? { exchangeRateUpdatedAt: input.exchangeRate === null ? null : new Date() }
        : {}),
      exchangeRateTolerancePercent: input.exchangeRateTolerancePercent,
      largeExchangeThreshold: input.largeExchangeThreshold,

      numberingSequences: input.numberingSequences,
      backupSchedule: input.backupSchedule,

      updatedById: actor.id,
    };

    await this.db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, ...data },
      update: data,
    });

    /*
     * Dropped before the read below, not left to expire.
     *
     * Both variants go: a clerk who saves and is then shown the value they
     * replaced would reasonably conclude the save failed and do it again. Five
     * minutes of that is worse than no cache at all, which is why the write
     * path owns the invalidation rather than the TTL.
     */
    await this.cache.invalidatePrefix(`settings:${this.tenantContext.tenantSlug}:`);

    this.events.emit('settings.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      actorId: actor.id,
      actorRole: actor.role,
      // Only what was actually sent. Listing every column on every save would
      // make the audit trail claim a clerk edited the exchange rate whenever
      // they corrected a phone number.
      changed: Object.entries(data)
        .filter(([key, value]) => key !== 'updatedById' && value !== undefined)
        .map(([key]) => key),
    });

    return this.getSettings(true);
  }

  // ──────────────────────────  Fee notices  ──────────────────────────

  async listNotices() {
    const rows = await withConnectionRetry(() =>
      this.db.feeNotice.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          targetCitizen: { select: { firstName: true, lastName: true, residence: true } },
          _count: { select: { payments: true } },
        },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      /** Under FLAT the whole invoice; under the other two a rate. Read with `basis`. */
      amount: Number(row.amount),
      basis: row.basis,
      /** Who owes it — see `FEE_BEARER`. Meaningless under FLAT. */
      bearer: row.bearer,
      currency: row.currency,
      frequency: row.frequency,
      targetType: row.targetType,
      targetCategory: row.targetCategory,
      targetCitizenName: row.targetCitizen ? citizenDisplayName(row.targetCitizen, { middleName: false }) : null,
      dueDate: row.dueDate.toISOString(),
      instructions: row.instructions,
      /** How many citizens this notice actually billed. */
      issuedCount: row._count.payments,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Writes the rule and bills everyone it applies to, in one transaction.
   *
   * Not two steps: a notice that exists but billed nobody looks identical to
   * one that billed everybody, and a clerk would have no way to tell which
   * happened before re-running it and double-charging the municipality's
   * residents.
   */
  async issue(input: CreateFeeNotice, actor: { id: string; role: string }) {
    const citizenIds = await this.resolveTargets(input);

    if (citizenIds.length === 0) {
      throw new ConflictError({
        code: 'FEE_NO_MATCHING_CITIZENS',
        message: 'No citizens match this category, so no notice will be issued.',
      });
    }

    const dueDate = new Date(input.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      throw new ConflictError({
        code: 'FEE_DUE_DATE_INVALID',
        message: 'The due date is not valid.',
      });
    }

    const { assessed, unassessable } = await this.assessTargets(citizenIds, input);

    /*
      A citizen who holds none of what this notice charges for owes nothing, and
      an invoice for zero is not a bill — it is a letter telling someone they
      owe nothing, arriving with a due date. Skipped rather than raised.
    */
    const billable = assessed.filter((entry) => entry.amount > 0);

    /** Units this notice declined to charge for. Reported, never silent. */
    const exemptedUnits = assessed.reduce(
      (sum, entry) => sum + (entry.assessment?.excludedUnitCount ?? 0),
      0,
    );
    /** Flats whose occupancy fee is held under review — see `assessCitizen`. Each flat once. */
    const heldUnits = distinctHeld(assessed);
    /** Flats held as «غير صالحة للسكن» — exempt from every fee; see `assessCitizen`. Each flat once. */
    const uninhabitableUnits = distinctUninhabitable(assessed);
    /** Units «معفاة من الرسوم» (0077) — see `assessCitizen`. Each unit once. */
    const feeExemptUnits = distinctExempt(assessed);
    /** Co-owned flats the responsible owner pays for, not the person assessed — see `assessCitizen`. Each flat once. */
    const coOwnerPaidUnits = distinctCoOwnerPaid(assessed);

    if (billable.length === 0) {
      /*
        Three ways to bill nobody, and telling them apart is the whole value of
        the message. "Nobody matched" sends a clerk to check the target
        category; "needs a survey" sends them to the field; "everything is
        exempt" tells them the exemption they just switched on covers every unit
        the notice was aimed at — which is usually a mis-set toggle, and would
        otherwise read as a fee that targets nobody.
      */
      /*
        Every reason that applies, not the first one: a notice that held three
        flats and exempted five was reported as "everything held", and the
        clerk went looking for the wrong thing. A flat «مالك مسؤول» pays for is
        a reason too: a notice aimed at the brother who pays nothing matched
        him, and «لا يوجد مواطنون مطابقون» sent the clerk to the wrong place.
      */
      if (
        heldUnits + uninhabitableUnits + exemptedUnits + feeExemptUnits + coOwnerPaidUnits + unassessable.length ===
        0
      ) {
        throw new ConflictError({
          code: 'FEE_NO_MATCHING_CITIZENS',
          message: 'No citizen matches this notice, so nothing was issued',
        });
      }
      throw new ConflictError({
        code: 'FEE_NOTHING_TO_CHARGE',
        message:
          'Every unit this notice targets is held, exempted, paid by another co-owner or unassessable, so nothing was issued',
        params: {
          held: heldUnits,
          uninhabitable: uninhabitableUnits,
          exempted: exemptedUnits,
          feeExempt: feeExemptUnits,
          coOwnerPaid: coOwnerPaidUnits,
          unassessable: unassessable.length,
        },
      });
    }

    const result = await this.db.$transaction(async (tx) => {
      const notice = await tx.feeNotice.create({
        data: {
          title: input.title,
          amount: input.amount,
          basis: input.basis as never,
          bearer: input.bearer as never,
          frequency: input.frequency as never,
          targetType: input.targetType as never,
          targetCategory: input.targetCategory ?? null,
          targetCitizenId: input.targetCitizenId ?? null,
          dueDate,
          instructions: input.instructions ?? null,
          issuedById: actor.id,
        },
        select: { id: true },
      });

      // Taken before the insert; see `numberInvoices`.
      const raisedAt = new Date();
      const created = await tx.citizenPayment.createMany({
        data: billable.map((entry) => ({
          citizenId: entry.citizenId,
          feeNoticeId: notice.id,
          title: input.title,
          /*
            One invoice per citizen, whatever the basis — never one per unit.

            Every downstream flow keys on a single payment row: the settlement
            screen, the Whish callback, the collector's round, the receipt
            facsimile. Splitting a six-shop bill into six rows would multiply
            all of that, and hand the citizen six pieces of paper for one visit
            to one counter. What they get instead is one bill that can say why.
          */
          amount: entry.amount,
          assessment: (entry.assessment ?? undefined) as never,
          dueDate,
          // The first period is the one the chosen due date falls in; the
          // recurring job takes over from the next one.
          periodKey: periodKeyFor(input.frequency, dueDate),
        })),
        // The unique (citizenId, feeNoticeId, periodKey) triple means a retried
        // request tops up missing rows instead of failing the whole batch.
        skipDuplicates: true,
      });

      await this.numberInvoices(
        tx,
        notice.id,
        periodKeyFor(input.frequency, dueDate),
        created.count,
        raisedAt,
      );

      return { noticeId: notice.id, issued: created.count };
    });

    this.logger.log(
      `Fee "${input.title}" issued to ${result.issued} citizen(s) in ${this.tenantContext.tenantSlug}`,
    );

    if (unassessable.length > 0) {
      this.logger.warn(
        `Fee "${input.title}": ${unassessable.length} citizen(s) could not be assessed — ${unassessable
          .map((entry) => `${entry.name} (${entry.reason})`)
          .join('; ')}`,
      );
    }

    /*
      How much of the town this notice let off, in one number.

      An exemption nobody counted is the same shape of problem as an unbilled
      unsurveyed building: revenue that is absent by design, and indisputable
      afterwards only if somebody wrote down how much of it there was. A clerk
      who exempts empty units and sees «٣١٤ وحدة معفاة» has been told something
      they can take to the council; one who sees only the invoice count has not.
    */
    if (exemptedUnits > 0) {
      this.logger.log(
        `Fee "${input.title}": ${exemptedUnits} unit(s) exempted as شاغرة / قيد الإنجاز`,
      );
    }

    this.events.emit('fee.issued', {
      tenantSlug: this.tenantContext.tenantSlug,
      noticeId: result.noticeId,
      title: input.title,
      amount: input.amount,
      basis: input.basis,
      targetType: input.targetType,
      issuedCount: result.issued,
      unassessableCount: unassessable.length,
      exemptedUnitCount: exemptedUnits,
      heldUnitCount: heldUnits,
      uninhabitableUnitCount: uninhabitableUnits,
      feeExemptUnitCount: feeExemptUnits,
      coOwnerPaidUnitCount: coOwnerPaidUnits,
      actorId: actor.id,
      actorRole: actor.role,
    });

    /*
      The skipped are returned, not just logged.

      A clerk who issues «رسم المحلات» to two hundred citizens and is told only
      that two hundred invoices were raised has no way to know that eleven
      buildings went unbilled because nobody has been inside them. Naming them
      turns an invisible shortfall into a list someone can work through — which
      is the entire argument for refusing to guess at the number in the first
      place.
    */
    if (heldUnits > 0) {
      this.logger.log(
        `Fee "${input.title}": ${heldUnits} unit(s) held under review (تعارض في حالة الوحدة)`,
      );
    }
    if (uninhabitableUnits > 0) {
      this.logger.log(
        `Fee "${input.title}": ${uninhabitableUnits} unit(s) not charged as uninhabitable (غير صالحة للسكن)`,
      );
    }
    if (feeExemptUnits > 0) {
      this.logger.log(`Fee "${input.title}": ${feeExemptUnits} unit(s) exempt from fees (معفاة من الرسوم)`);
    }

    if (coOwnerPaidUnits > 0) {
      this.logger.log(
        `Fee "${input.title}": ${coOwnerPaidUnits} co-owned unit(s) paid by their responsible owner (مالك مسؤول)`,
      );
    }

    return {
      ...result,
      unassessable,
      exemptedUnits,
      heldUnits,
      uninhabitableUnits,
      feeExemptUnits,
      coOwnerPaidUnits,
    };
  }

  /**
   * Re-issues every active recurring notice for the period we are now in.
   *
   * Runs against whichever tenant scope is active — the caller is responsible
   * for establishing one per municipality (see `RecurringBillingJob`).
   *
   * Safe to run repeatedly. The work is a `createMany ... skipDuplicates`
   * against a unique (citizen, notice, period) triple, so a second run in the
   * same month writes nothing; there is no "have I already billed?" flag to
   * get out of step with reality. That also means a municipality that adds a
   * resident mid-month gets them billed on the next run rather than never.
   */
  async runRecurringBilling(now = new Date()): Promise<{
    noticesConsidered: number;
    invoicesCreated: number;
    /** Notices whose own run threw. The rest still ran; see `billing_run_entries`. */
    noticesFailed: number;
  }> {
    const notices = await withConnectionRetry(() =>
      this.db.feeNotice.findMany({
        where: { isActive: true, frequency: { not: 'ONCE' } },
      }),
    );

    let invoicesCreated = 0;

    let noticesFailed = 0;

    for (const notice of notices) {
      const periodKey = periodKeyFor(notice.frequency, now);
      const startedAt = new Date();

      /*
        One notice's failure must not abandon the rest.

        `RecurringBillingJob` already catches per *tenant*, so one broken
        municipality does not stop the others. This loop had no equivalent, so
        a single notice that threw — a target query timing out, an assessment
        hitting a bad row — abandoned every notice after it for that
        municipality, for that period, silently. The job logged one error and
        reported success for the tenants it had reached.

        And because the biller only ever computes the period containing `now`,
        an abandoned period is not retried: the next run computes the next
        period and the gap closes over with no error and no row.
      */
      try {
        // The notice's own first period. Anything earlier than the notice's
        // start would be back-billing someone for a fee that did not exist.
        if (periodKey === periodKeyFor(notice.frequency, notice.dueDate)) {
          await this.recordBillingRun(notice.id, periodKey, startedAt, { outcome: 'SKIPPED' });
          continue;
        }
        if (notice.dueDate > now) {
          await this.recordBillingRun(notice.id, periodKey, startedAt, { outcome: 'SKIPPED' });
          continue;
        }

      const dueDate = dueDateInCurrentPeriod(notice.dueDate, notice.frequency, now);

      // Targets are re-resolved every period rather than frozen at issue time:
      // someone who registered a shop last week should be in this month's
      // billing, and someone deactivated should drop out of it.
      const citizenIds = await this.resolveTargets({
        targetType: notice.targetType as never,
        targetCategory: notice.targetCategory ?? undefined,
        targetCitizenId: notice.targetCitizenId ?? undefined,
        basis: notice.basis,
      } as never);

      if (citizenIds.length === 0) {
        await this.recordBillingRun(notice.id, periodKey, startedAt, { outcome: 'SKIPPED' });
        continue;
      }

      /*
        Re-assessed every period, not carried over from the first issue.

        Same reasoning as re-resolving the targets: a citizen who added two
        shops last month should be billed for them this month, and one who sold
        a building should stop paying for it. A frozen assessment would make the
        register's accuracy irrelevant to the bill after the first period, which
        is the failure the whole feature exists to correct.
      */
      const { assessed, unassessable } = await this.assessTargets(citizenIds, {
        amount: Number(notice.amount),
        basis: notice.basis as FeeBasis,
        targetCategory: notice.targetCategory ?? undefined,
        // Re-read from the notice every period, like the basis and the targets
        // above it: a council that changes who bears a fee in March expects
        // April's run to honour it without the notice being reissued.
        bearer: notice.bearer as FeeBearer,
      });

      const billable = assessed.filter((entry) => entry.amount > 0);
      /*
        Flats held under review this period — logged, never silent. They are
        not charged for this period by this run or any later one (a period's
        invoice is written once); charging them for it after the review is the
        municipality's decision, not the job's.
      */
      const heldUnits = distinctHeld(assessed);
      if (heldUnits > 0) {
        this.logger.warn(
          `Recurring "${notice.title}" (${periodKey}): ${heldUnits} unit(s) held under review (تعارض في حالة الوحدة) — not charged this period`,
        );
      }
      /*
        Units charged nothing this period — logged, never silent, as `issue`
        logs them. Not a hold: an uninhabitable unit and an exempt one are
        settled decisions, and nothing is owed for the period afterwards.
      */
      const uninhabitableUnits = distinctUninhabitable(assessed);
      if (uninhabitableUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${uninhabitableUnits} unit(s) not charged as uninhabitable (غير صالحة للسكن)`,
        );
      }
      const feeExemptUnits = distinctExempt(assessed);
      if (feeExemptUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${feeExemptUnits} unit(s) exempt from fees (معفاة من الرسوم)`,
        );
      }
      // Paid in full by their responsible owner — a choice, not a hold, so logged rather than warned.
      const coOwnerPaidUnits = distinctCoOwnerPaid(assessed);
      if (coOwnerPaidUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${coOwnerPaidUnits} co-owned unit(s) paid by their responsible owner (مالك مسؤول)`,
        );
      }
      if (billable.length === 0) {
        await this.recordBillingRun(notice.id, periodKey, startedAt, {
          outcome: 'SKIPPED',
          citizensConsidered: citizenIds.length,
        });
        continue;
      }

      if (unassessable.length > 0) {
        this.logger.warn(
          `Recurring "${notice.title}" (${periodKey}): ${unassessable.length} citizen(s) not assessed — ${unassessable
            .map((entry) => `${entry.name} (${entry.reason})`)
            .join('; ')}`,
        );
      }

      /*
        The insert and the numbering share a transaction, so a period is never
        left with bills that carry no number. It holds this month's invoice
        counter for the length of the batch — acceptable here because the
        recurring job runs at 2am and is the only thing issuing bills at that
        hour, and the alternative is a half-numbered period.
      */
      const created = await this.db.$transaction(async (tx) => {
        const inserted = await tx.citizenPayment.createMany({
          data: billable.map((entry) => ({
            citizenId: entry.citizenId,
            feeNoticeId: notice.id,
            title: notice.title,
            amount: entry.amount,
            assessment: (entry.assessment ?? undefined) as never,
            dueDate,
            periodKey,
          })),
          skipDuplicates: true,
        });
        await this.numberInvoices(tx, notice.id, periodKey, inserted.count, startedAt);
        return inserted;
      });

      if (created.count > 0) {
        this.logger.log(
          `Recurring: "${notice.title}" → ${created.count} invoice(s) for ${periodKey}`,
        );
        this.events.emit('fee.issued', {
          tenantSlug: this.tenantContext.tenantSlug,
          noticeId: notice.id,
          title: notice.title,
          amount: Number(notice.amount),
          targetType: notice.targetType,
          issuedCount: created.count,
          recurring: true,
          periodKey,
          heldUnitCount: heldUnits,
          uninhabitableUnitCount: uninhabitableUnits,
          feeExemptUnitCount: feeExemptUnits,
          coOwnerPaidUnitCount: coOwnerPaidUnits,
        });
      }

        invoicesCreated += created.count;

        await this.recordBillingRun(notice.id, periodKey, startedAt, {
          outcome: 'ISSUED',
          citizensConsidered: citizenIds.length,
          invoicesCreated: created.count,
        });
      } catch (error) {
        noticesFailed += 1;
        this.logger.error(
          `Recurring "${notice.title}" (${periodKey}) failed; continuing with the rest: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        await this.recordBillingRun(notice.id, periodKey, startedAt, {
          outcome: 'FAILED',
          failureKind: classifyBillingFailure(error),
        });
      }
    }

    return { noticesConsidered: notices.length, invoicesCreated, noticesFailed };
  }

  /**
   * Records what a run did to one notice in one period (migration 0056).
   *
   * **This does not back-bill.** A FAILED row is a fact for a human to act on,
   * not an instruction to the next run. A citizen receiving a quarter of
   * invoices at once because a pooler was down in February is a worse outcome
   * than a municipality seeing a gap and deciding what to do about it; issuing
   * a missed period stays a deliberate act. See docs/open-decisions.md.
   *
   * Upserted rather than inserted: the job is safe to run repeatedly within a
   * period, so the second run updates the account of the attempt rather than
   * appending a second one. The unique `(feeNoticeId, periodKey)` is what makes
   * that the same row.
   *
   * Its own failure is swallowed. The ledger exists to make a billing failure
   * visible, and a ledger write that could itself abort the run would have
   * turned "one notice failed" into "the run died" — the failure it was added
   * to prevent.
   */
  private async recordBillingRun(
    feeNoticeId: string,
    periodKey: string,
    startedAt: Date,
    result: {
      outcome: 'ISSUED' | 'SKIPPED' | 'FAILED';
      citizensConsidered?: number;
      invoicesCreated?: number;
      failureKind?: string;
    },
  ): Promise<void> {
    const data = {
      outcome: result.outcome,
      citizensConsidered: result.citizensConsidered ?? 0,
      invoicesCreated: result.invoicesCreated ?? 0,
      failureKind: result.failureKind ?? null,
      startedAt,
      finishedAt: new Date(),
    };

    try {
      await this.db.billingRunEntry.upsert({
        where: { feeNoticeId_periodKey: { feeNoticeId, periodKey } },
        create: { feeNoticeId, periodKey, ...data },
        update: data,
      });
    } catch (error) {
      this.logger.error(
        `could not record the billing run for notice ${feeNoticeId} (${periodKey}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Stops or resumes a recurring notice without touching its past invoices. */
  async setNoticeActive(id: string, isActive: boolean) {
    const notice = await this.db.feeNotice.findUnique({ where: { id }, select: { id: true } });
    if (!notice) throw new NotFoundError({
      code: 'FEE_NOTICE_NOT_FOUND',
      message: `FeeNotice ${id} was not found`,
    });

    await this.db.feeNotice.update({ where: { id }, data: { isActive } });
    return { isActive };
  }

  /**
   * Everyone a flat charge aimed at this category would reach today.
   *
   * What a FLAT bill «would be now» turns on: its amount never depends on the
   * register, but whether the citizen is on it at all does. The same query a
   * notice is issued with, so the answer cannot drift from it.
   */
  async categoryHolders(category: string): Promise<Set<string>> {
    return new Set(await this.resolveTargets({ targetType: 'BUILDING_CATEGORY', targetCategory: category }));
  }

  /**
   * Which citizens a notice applies to.
   *
   * Only active citizens, and for a category only those with a *registered*
   * property of that kind — billing someone for a shop they never registered
   * is the error this whole feature would be judged on.
   */
  private async resolveTargets(input: {
    targetType: string;
    targetCategory?: string;
    targetCitizenId?: string;
    /** The notice's basis — a flat charge falls on people, not on estates or institutions. */
    basis?: string;
  }): Promise<string[]> {
    if (input.targetType === 'INDIVIDUAL_CITIZEN') {
      const citizen = await this.db.user.findFirst({
        where: { id: input.targetCitizenId, kind: 'CITIZEN', isActive: true },
        select: { id: true },
      });
      if (!citizen) throw new NotFoundError({
        code: 'CITIZEN_NOT_FOUND',
        message: `Citizen ${input.targetCitizenId ?? ''} was not found`,
      });
      return [citizen.id];
    }

    if (input.targetType === 'ALL_CITIZENS') {
      const rows = await this.db.user.findMany({
        where: {
          kind: 'CITIZEN',
          isActive: true,
          /*
            A flat charge is one per person, and an estate or an institution
            (0076) is not a person: «ورثة المرحوم …» and «وقف مسجد البلدة» own
            property and are billed for it by the rate-based notices, never per
            head. A rate-based notice still reaches them through what they hold.
          */
          ...(input.basis === 'FLAT' ? { residence: { notIn: [...NON_PERSON_RESIDENCE] } } : {}),
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    /*
      BUILDING_CATEGORY — the category names either a property type or a unit
      type, and the two live at different depths of the registration tree.

      A unit type is matched in *both* places it can occur, which it was not.
      Looking only inside `units` finds the flats and shops of a building and
      misses every card that carries its own type on the row — which since
      `INDEPENDENT_HOUSE` became derivable is every منزل in the register. The
      effect was a notice aimed at «منازل مستقلة» resolving to nobody and
      reporting that no citizen matched the category, which reads as a
      municipality that has no houses rather than as a query looking in one
      place.
    */
    const category = input.targetCategory!;
    // A tenancy that ended (migration 0046) holds nothing to charge for.
    const propertyWhere = PROPERTY_TYPE_CATEGORIES.has(category)
      ? { propertyType: category as never, endedAt: null }
      : {
          endedAt: null,
          OR: [
            { unitType: category as never },
            { units: { some: { unitType: category as never, endedAt: null } } },
            /*
              And the canonical row, since P2-T8 made it the authority.

              Selection and assessment have to look in the same places or they
              disagree in the one direction nobody notices: a shop whose type
              lives only on its linked `Unit` would be counted by
              `assessCitizen` and yet never put its owner on the notice, so the
              register would report that the municipality has no shops while
              happily charging for them the moment someone was targeted another
              way.
            */
            { units: { some: { endedAt: null, unit: { unitType: category as never } } } },
          ],
        };

    /*
      Held on a card, *or* held through an occupancy.

      A citizen whose only محل is a flat the census recorded them in — their card
      itemising nothing — is charged for it by `assessCitizen` and would never
      have been put on the notice by the card query alone.

      Deliberately a superset rather than an exact mirror of the assessment.
      Reproducing "a BUILDING card with no unit rows linked to this building" in
      SQL would be a second copy of a rule that already lives in one place, and
      the two would drift. Over-selecting is free — `assessCitizen` returns
      nothing for a citizen who holds none of what the notice charges for, and
      they are skipped. Under-selecting is the silent one: a resident simply
      never billed, which nothing downstream reports.
    */
    const occupancyWhere = PROPERTY_TYPE_CATEGORIES.has(category)
      ? undefined
      : { some: { toDate: null, unit: { unitType: category as never } } };

    const rows = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        OR: [
          { registrations: { some: { properties: { some: propertyWhere } } } },
          ...(occupancyWhere ? [{ unitOccupancies: occupancyWhere }] : []),
        ],
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * What each targeted citizen owes, and who could not be assessed at all.
   *
   * Under `FLAT` this is the behaviour that has always existed, spelled out:
   * everyone the notice targets owes the notice's amount, and there is nothing
   * to explain. The two other bases make `amount` a rate and ask the register
   * how much of the thing being charged for each citizen actually holds.
   *
   * **Which registration counts.** The citizen's latest, not all of them. A
   * citizen may hold several — someone who came back a year later with a
   * second building — and summing every one would bill a household twice for
   * the same flat the day they re-registered it. The edit form already treats
   * the latest registration as the record's current state; billing agrees with
   * it rather than inventing a second answer.
   */
  private async assessTargets(
    citizenIds: readonly string[],
    notice: {
      amount: number;
      basis: FeeBasis;
      targetCategory?: string;
      bearer?: FeeBearer;
    },
  ): Promise<{ assessed: CitizenAssessment[]; unassessable: UnassessableCitizen[] }> {
    if (notice.basis === 'FLAT' && !notice.targetCategory) {
      return {
        assessed: citizenIds.map((citizenId) => ({
          citizenId,
          amount: notice.amount,
          assessment: null,
        })),
        unassessable: [],
      };
    }

    if (notice.basis === 'FLAT') {
      // Per holder — unless all they hold of the category is charged nothing (`flatCategoryCharge`).
      const targetCategory = notice.targetCategory!;
      const assessed: CitizenAssessment[] = [];
      const seen = new Set<string>();
      for await (const batch of this.holdingsOf(citizenIds)) {
        for (const holding of batch) {
          seen.add(holding.citizenId);
          const charge = flatCategoryCharge(holding.entries, { amount: notice.amount, targetCategory });
          assessed.push({ citizenId: holding.citizenId, ...charge });
        }
      }
      // Never fewer bills than before: a target the register read did not return is charged as one.
      for (const citizenId of citizenIds) {
        if (!seen.has(citizenId)) assessed.push({ citizenId, amount: notice.amount, assessment: null });
      }
      return { assessed, unassessable: [] };
    }

    const assessed: CitizenAssessment[] = [];
    const unassessable: UnassessableCitizen[] = [];

    for await (const batch of this.holdingsOf(citizenIds)) {
      for (const holding of batch) {
        const outcome = assessCitizen(holding.entries, notice);

        if (outcome.kind === 'unassessable') {
          unassessable.push({ citizenId: holding.citizenId, name: holding.name, reason: outcome.reason });
          continue;
        }

        assessed.push({
          citizenId: holding.citizenId,
          amount: outcome.amount,
          assessment: outcome.assessment,
          heldUnitIds: outcome.heldUnitIds,
          uninhabitableUnitIds: outcome.uninhabitableUnitIds,
          exemptUnitIds: outcome.exemptUnitIds,
          coOwnerPaidUnitIds: outcome.coOwnerPaidUnitIds,
        });
      }
    }

    return { assessed, unassessable };
  }

  /**
   * What each citizen holds today, as billing reads it — one batch at a time.
   *
   * The register half of `assessTargets`, apart so that «فواتير تأثّرت
   * بتصحيحات» can ask what a bill *would* be now through exactly the reading a
   * billing run makes. A second copy of this query would be a second answer to
   * «what does this person hold», and the two would drift.
   *
   * Also returns where the holdings sit — the buildings and unit codes — so a
   * change recorded against a unit can be traced back to the bills it moves.
   */
  async *holdingsOf(citizenIds: readonly string[]): AsyncGenerator<CitizenHoldings[]> {
    /*
      Read in batches rather than one `IN (...)` over the whole register.

      An ALL_CITIZENS notice targets every active citizen, and this is the only
      query in the fee path that pulls their property cards *and* every unit row
      under them. Asked for all of it at once, a municipality of any size builds
      one result set holding its entire property inventory before a single
      invoice is computed — and hands the driver a bind list of the same length.
      Batching bounds both, and costs nothing: the work is a pure fold, so the
      batches never need to meet.
    */
    for (let offset = 0; offset < citizenIds.length; offset += ASSESSMENT_BATCH_SIZE) {
      const batch = citizenIds.slice(offset, offset + ASSESSMENT_BATCH_SIZE);

      const rows = await withConnectionRetry(() =>
        this.db.user.findMany({
          where: { id: { in: [...batch] } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            residence: true,
            registrations: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                properties: {
                  /*
                    Current tenancies and holdings only. A card whose tenancy
                    ended (migration 0046) stays on the file as history, and a
                    former tenant billed for the flat they left is the failure
                    this exists to prevent — the same reason occupancies below
                    are filtered to `toDate: null`.
                  */
                  where: { endedAt: null },
                  select: {
                    propertyType: true,
                    propertyNumber: true,
                    unitType: true,
                    unitArea: true,
                    /*
                      Both halves of the bearer rule, read here rather than
                      joined later. `occupancyType` says whether this citizen
                      owns the card or occupies it; `unitStatus` says, on an
                      owner's card, whether they are the one inside. A card
                      fetched without either would be assessed as an owner
                      living in every unit they hold.
                    */
                    occupancyType: true,
                    unitStatus: true,
                    /*
                      P2-T8 — the authority flip.

                      Each card line now carries the canonical `Unit` it was
                      linked to, where one exists, and `billableUnits` prefers
                      it field by field. The municipality's own row is the
                      better record of a flat: it survives the card being
                      edited, it is what an officer corrects from the matrix,
                      and it is what two cards describing the same flat both
                      point at.

                      The fallback is not transitional. A منزل, an أرض and a
                      خيمة never get a `Unit`, and neither does a building on a
                      parcel nobody has surveyed — a biller that could only read
                      the new tables would stop charging for most of the
                      register.

                      A card with no unit rows of its own is not automatically
                      unassessable any more: `buildingId` plus this citizen's
                      own occupancies (loaded beside the registration below)
                      answer "which flats do they hold here" — which is the
                      question, and the one a building's unit *count* cannot
                      answer. See `heldThroughOccupancy`.
                    */
                    buildingId: true,
                    units: {
                      where: { endedAt: null },
                      select: {
                        unitType: true,
                        unitArea: true,
                        unitStatus: true,
                        unit: {
                          select: {
                            id: true,
                            unitType: true,
                            unitArea: true,
                            unitStatus: true,
                            unitCode: true,
                            // «معفاة من الرسوم» (0077) — charged nothing, whoever bears the fee.
                            feeExemption: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            /*
              This citizen's current occupancies, for the cards that itemise
              nothing themselves.

              Loaded on the user rather than per property card, and filtered to
              the ones still running: an occupancy that ended is a fact about
              the flat's history, not about what this person holds today, and
              billing a former tenant for a flat they moved out of is the
              clearest possible way to lose a resident's trust.

              One extra join for the whole batch — the same 500-citizen page the
              registrations come from — so this stays the same number of
              queries it was.
            */
            unitOccupancies: {
              where: { toDate: null },
              select: {
                role: true,
                unit: {
                  select: {
                    id: true,
                    buildingId: true,
                    unitType: true,
                    unitArea: true,
                    unitStatus: true,
                    unitCode: true,
                    feeExemption: true,
                  },
                },
              },
            },
          },
        }),
      );

      /*
        The flats under review among this batch's — the same rule the census
        writes by (`settleUnitStatus`), recomputed rather than read from the case
        list, so a case closed by hand does not release a flat whose records
        still disagree, and a flat fixed from any screen is released without
        anyone closing anything. Scoped to the flats this batch holds (and every
        flat of a structure a منزل card here names, which is how a منزل finds its
        one flat), for the reason the batching above gives.
      */
      const heldHere = new Set<string>();
      for (const row of rows) {
        for (const card of row.registrations[0]?.properties ?? []) {
          for (const line of card.units) if (line.unit?.id) heldHere.add(line.unit.id);
        }
        for (const occupancy of row.unitOccupancies) heldHere.add(occupancy.unit.id);
      }
      /** The one flat of each structure a منزل card here names — what the card bills. */
      const soleUnits = new Map<
        string,
        { id: string; unitStatus: string | null; unitCode: string; feeExemption: string | null }
      >();
      const houseBuildings = [
        ...new Set(
          rows.flatMap((row) =>
            (row.registrations[0]?.properties ?? [])
              .filter((card) => card.propertyType === 'HOUSE' && card.units.length === 0 && card.buildingId)
              .map((card) => card.buildingId!),
          ),
        ),
      ];
      if (houseBuildings.length > 0) {
        const houseUnits = await withConnectionRetry(() =>
          this.db.unit.findMany({
            where: { buildingId: { in: houseBuildings } },
            select: { id: true, buildingId: true, unitStatus: true, unitCode: true, feeExemption: true },
          }),
        );
        const perBuilding = new Map<string, typeof houseUnits>();
        for (const unit of houseUnits) {
          heldHere.add(unit.id);
          perBuilding.set(unit.buildingId, [...(perBuilding.get(unit.buildingId) ?? []), unit]);
        }
        for (const [buildingId, units] of perBuilding) if (units.length === 1) soleUnits.set(buildingId, units[0]!);
      }
      const review: Awaited<ReturnType<typeof unitsUnderReview>> =
        heldHere.size === 0
          ? new Map()
          : await withConnectionRetry(() => unitsUnderReview(this.db, [...heldHere]));
      /** Held: the flat's records disagree in a way the rule cannot settle. */
      const underReview = (unitId: string | undefined | null) =>
        Boolean(unitId && (review.get(unitId)?.conflicts.length ?? 0) > 0);
      /*
        The flats nobody can live in, by the same reading the screens show
        (`isUninhabitableReading`): recomputed from the damage log every run,
        so a re-inspection that reads a flat habitable releases it from the
        next run on, from whichever screen recorded it.
      */
      const unlivable =
        heldHere.size === 0
          ? new Set<string>()
          : await withConnectionRetry(() => uninhabitableUnitIds(this.db, this.S, [...heldHere]));
      /** Held: the flat's current damage reading says «غير صالحة للسكن». */
      const uninhabitable = (unitId: string | undefined | null) => Boolean(unitId && unlivable.has(unitId));
      /*
        The status the rule decides, where the stored one lags it — a flat with a
        registered tenant still stored as «مشغولة من المالك» is billed as the
        «مؤجرة» it is, so the tenant pays and the owner does not, today, rather
        than after somebody next saves it.
      */
      const settledStatus = (unitId: string | undefined | null, stored: string | null) =>
        unitId && review.has(unitId) ? review.get(unitId)!.status : stored;
      /*
        «توزيع الرسم على المالكين» for the co-owned flats among them — every
        current owner of each, not just this batch's, because one owner's part
        depends on how many others there are and what أسهم they hold.
      */
      const coOwnership =
        heldHere.size === 0
          ? new Map()
          : await withConnectionRetry(() => ownerBillingRules(this.db, [...heldHere]));
      /** This owner's part of a flat others own too; nothing for a flat they own alone. */
      const ownerShareFor = (
        unitId: string | undefined | null,
        citizenId: string,
      ): { ownerShare?: { mode: string; numerator: number; denominator: number }; ownerShareUndecidable?: boolean } => {
        const rule = unitId ? coOwnership.get(unitId) : undefined;
        if (!rule) return {};
        const outcome = ownerShareOf(rule, citizenId);
        if (outcome.kind === 'SHARE') return { ownerShare: outcome.share };
        if (outcome.kind === 'UNDECIDABLE') return { ownerShareUndecidable: true };
        return {};
      };
      const reviewedSoleUnit = new Set(
        [...review.values()]
          .filter((fact) => fact.soleUnitOfBuilding && fact.conflicts.length > 0)
          .map((fact) => fact.buildingId),
      );

      yield rows.map((row) => {
        /*
          Occupancies attached to the card they belong to.

          Grouped by building so a citizen who holds flats in two of them does
          not have one card's holdings counted against the other. A card with no
          `buildingId` gets nothing, which is correct — there is no building to
          hold flats in.
        */
        const occupanciesByBuilding = new Map<string, Array<{
          role: string;
          unitType: string | null;
          unitArea: unknown;
          unitStatus: string | null;
          underReview: boolean;
          uninhabitable: boolean;
          unitId: string;
          unitCode: string;
          ownerShare?: { mode: string; numerator: number; denominator: number };
          ownerShareUndecidable?: boolean;
          exempt: boolean;
        }>>();
        for (const occupancy of row.unitOccupancies) {
          const buildingId = occupancy.unit.buildingId;
          const list = occupanciesByBuilding.get(buildingId) ?? [];
          list.push({
            role: occupancy.role,
            unitType: occupancy.unit.unitType,
            unitArea: occupancy.unit.unitArea,
            unitId: occupancy.unit.id,
            unitStatus: settledStatus(occupancy.unit.id, occupancy.unit.unitStatus),
            underReview: underReview(occupancy.unit.id),
            uninhabitable: uninhabitable(occupancy.unit.id),
            unitCode: occupancy.unit.unitCode,
            exempt: occupancy.unit.feeExemption !== null,
            ...(occupancy.role === 'OWNER' ? ownerShareFor(occupancy.unit.id, row.id) : {}),
          });
          occupanciesByBuilding.set(buildingId, list);
        }

        /*
          Each building's holdings are counted once, by one card.

          The list used to be handed to *every* card linked to the building, and
          `heldThroughOccupancy` fires for any مبنى card with no unit rows — so a
          citizen with two such cards on one block and two flats recorded there
          was assessed for four. Under a PER_UNIT notice that is simply double
          the bill, and every row involved is individually valid.

          `CensusSyncService` dedupes the mirror of this on the write side with a
          `Map` keyed by unit; this is the read side of the same fact. Two rules:

          - **Only a مبنى card with no unit rows can consume the list**, because
            that is the only card `heldThroughOccupancy` answers for. Spending it
            on a card that itemises its flats would leave a later card that needs
            it with nothing, and under-billing is worse than the double it fixes.
          - **A منزل card linked to the same building suppresses it entirely.**
            That card already bills the structure's single unit from its own
            fields, and `CensusSyncService`'s single-unit inference has recorded
            an occupancy on that very flat — so the list would bill it a second
            time.
        */
        const entries = attachOccupancies(
          (row.registrations[0]?.properties ?? []).map((card) => ({
            ...card,
            // A منزل bills its one flat from its own columns; under review is that flat's.
            underReview:
              card.propertyType === 'HOUSE' &&
              card.units.length === 0 &&
              Boolean(card.buildingId && reviewedSoleUnit.has(card.buildingId)),
            ...(card.propertyType === 'HOUSE' && card.units.length === 0 && card.buildingId && soleUnits.has(card.buildingId)
              ? (() => {
                  const sole = soleUnits.get(card.buildingId!)!;
                  return {
                    soleUnitId: sole.id,
                    soleUnitCode: sole.unitCode,
                    exempt: sole.feeExemption !== null,
                    ...(card.occupancyType === 'OWNER' ? ownerShareFor(sole.id, row.id) : {}),
                    uninhabitable: uninhabitable(sole.id),
                    /*
                      A منزل card that states nothing bills by its flat's answer —
                      «مؤجرة» with a tenant registered in it, «شاغرة» under a
                      confirmed vacancy — rather than as "nobody was asked", which
                      charged the owner beside the tenant. A card that states
                      something keeps its own (a disagreement there is a review).
                    */
                    unitStatus: (card.unitStatus ?? settledStatus(sole.id, sole.unitStatus)) as never,
                  };
                })()
              : {}),
            units: card.units.map((line) => ({
              ...line,
              unit: line.unit
                ? {
                    ...line.unit,
                    unitStatus: settledStatus(line.unit.id, line.unit.unitStatus) as never,
                    underReview: underReview(line.unit.id),
                    uninhabitable: uninhabitable(line.unit.id),
                    exempt: line.unit.feeExemption !== null,
                    ...(card.occupancyType === 'OWNER' ? ownerShareFor(line.unit.id, row.id) : {}),
                  }
                : line.unit,
            })),
          })),
          occupanciesByBuilding,
        );
        const properties = row.registrations[0]?.properties ?? [];
        const buildingIds = new Set<string>();
        const unitCodes = new Set<string>();
        for (const entry of properties) {
          if (entry.buildingId) buildingIds.add(entry.buildingId);
          for (const line of entry.units) if (line.unit?.unitCode) unitCodes.add(line.unit.unitCode);
        }
        for (const occupancy of row.unitOccupancies) {
          buildingIds.add(occupancy.unit.buildingId);
          unitCodes.add(occupancy.unit.unitCode);
        }

        return {
          citizenId: row.id,
          name: citizenDisplayName(row, { middleName: false }),
          entries: entries as unknown as BillablePropertyEntry[],
          buildingIds: [...buildingIds],
          unitCodes: [...unitCodes],
        };
      });
    }
  }

  // ────────────────────────────  Payments  ────────────────────────────

  /** One citizen's own bills, newest obligation first. */
  async listForCitizen(citizenId: string): Promise<PaymentSummary[]> {
    const rows = await withConnectionRetry(() =>
      this.db.citizenPayment.findMany({
        where: { citizenId },
        orderBy: [{ paymentStatus: 'asc' }, { dueDate: 'asc' }],
        include: { feeNotice: { select: { frequency: true } } },
      }),
    );

    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      remaining: Math.max(Number(row.amount) - Number(row.paidAmount), 0),
      currency: row.currency,
      dueDate: row.dueDate.toISOString(),
      // OVERDUE is derived on read rather than written by a nightly job: a
      // stored status would be wrong for every hour between the due date
      // passing and the job next running.
      paymentStatus:
        row.paymentStatus === 'UNPAID' && row.dueDate < now ? 'OVERDUE' : row.paymentStatus,
      paymentMethod: row.paymentMethod,
      whishTransactionRef: row.whishTransactionRef,
      paidAt: row.paidAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      frequency: row.feeNotice?.frequency ?? null,
      assessment: (row.assessment as FeeAssessment | null) ?? null,
    }));
  }

  /**
   * The citizen's claim that they have paid.
   *
   * Moves to PENDING_REVIEW, never to PAID. Nothing here is verifiable by this
   * system — the Whish reference is a string read off the citizen's own
   * receipt — so the money is only confirmed once a clerk has matched it
   * against the municipality's account.
   */
  /**
   * Moves an invoice between statuses, conditionally.
   *
   * The `WHERE` carries the status the caller decided on, so a settlement that
   * commits between the read and this write is not overwritten: the update
   * matches nothing and the caller is refused instead.
   *
   * `PaymentLedgerService` gets the same guarantee a different way — it holds
   * the row with `SELECT … FOR UPDATE` and re-reads every value it decides on
   * under that lock, which is why its own `update` needs no predicate and must
   * not grow one. These paths move no money, so they take the guarantee from
   * the predicate rather than from a lock.
   *
   * Without this, an invoice settled at the counter could be dragged back to
   * PENDING_REVIEW or UNPAID by a citizen's portal click or a late provider
   * callback — leaving `paidAmount == amount` and a real ledger row on a bill
   * the register calls unpaid, which nothing in the system self-corrects.
   */
  private async transition(input: {
    paymentId: string;
    from: $Enums.PaymentStatus | $Enums.PaymentStatus[];
    to: $Enums.PaymentStatus;
    /** Extra predicate the caller already relied on: ownership, a live ref. */
    guard?: Prisma.CitizenPaymentWhereInput;
    // The `Unchecked` variant, because `reviewedById` is a relation scalar and
    // Prisma keeps those out of the plain update-many input — `updateMany` has
    // no `connect`, so the foreign key has to be assignable directly.
    data?: Prisma.CitizenPaymentUncheckedUpdateManyInput;
    /**
     * The audit row for this change — Tier 1 (docs/security.md). Written in the
     * same transaction as the status, so a declaration or a refusal is never
     * on the invoice without its row, nor the row without the change.
     */
    audit: AuditEntryInput;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.citizenPayment.updateMany({
        where: {
          id: input.paymentId,
          paymentStatus: Array.isArray(input.from) ? { in: input.from } : input.from,
          ...input.guard,
        },
        data: { ...input.data, paymentStatus: input.to },
      });

      if (count === 0) {
        throw new ConflictError({
          code: 'PAYMENT_STATE_CHANGED',
          message: `Payment ${input.paymentId} is no longer in the state this change expected`,
        });
      }

      await this.auditTrail.recordInTransaction(input.audit, tx);
    });
  }

  async declare(input: {
    paymentId: string;
    citizenId: string;
    method: DeclarePayment['method'];
    whishTransactionRef?: string;
  }) {
    const payment = await this.db.citizenPayment.findFirst({
      where: { id: input.paymentId, citizenId: input.citizenId },
      select: { id: true, paymentStatus: true },
    });
    if (!payment) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${input.paymentId} was not found`,
    });

    // Kept ahead of the write: this is what separates "not yours / no such
    // invoice" from the two specific states a citizen can act on. The
    // predicate below only fires on the genuine race.
    if (payment.paymentStatus === 'PAID') {
      throw new ConflictError({
        code: 'PAYMENT_ALREADY_PAID',
        message: 'This payment has already been settled.',
      });
    }
    if (payment.paymentStatus === 'PENDING_REVIEW') {
      throw new ConflictError({
        code: 'PAYMENT_ALREADY_UNDER_REVIEW',
        message: 'This payment is already under review.',
      });
    }

    await this.transition({
      paymentId: payment.id,
      // OVERDUE is derived on read and never stored, but naming it here means
      // a stored one could not strand a citizen who wants to declare.
      from: ['UNPAID', 'OVERDUE'],
      to: 'PENDING_REVIEW',
      guard: { citizenId: input.citizenId },
      data: {
        paymentMethod: input.method as never,
        whishTransactionRef: input.whishTransactionRef ?? null,
        isSeen: false,
        // Cleared so a previous rejection's note does not sit alongside a
        // fresh claim as though it applied to it.
        reviewNote: null,
      },
      audit: {
        actorId: input.citizenId,
        actorType: 'CITIZEN',
        action: 'PAYMENT_DECLARED',
        entityType: 'Payment',
        entityId: payment.id,
        after: { method: input.method },
      },
    });

    // For the caches that list this invoice; the audit row is already written.
    this.events.emit('payment.declared', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId: payment.id,
      citizenId: input.citizenId,
      method: input.method,
    });

    return { paymentStatus: 'PENDING_REVIEW' as const };
  }

  /** The clerk's verification queue: everything claimed but not yet confirmed. */
  async listPendingReview(unseenOnly: boolean = false) {
    const rows = await withConnectionRetry(() =>
      this.db.citizenPayment.findMany({
        where: {
          paymentStatus: 'PENDING_REVIEW',
          ...(unseenOnly ? { isSeen: false } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          citizen: {
            select: { id: true, firstName: true, lastName: true, phone: true, referenceNumber: true, residence: true },
          },
        },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      remaining: Math.max(Number(row.amount) - Number(row.paidAmount), 0),
      currency: row.currency,
      dueDate: row.dueDate.toISOString(),
      paymentMethod: row.paymentMethod,
      whishTransactionRef: row.whishTransactionRef,
      isSeen: row.isSeen,
      citizenId: row.citizen.id,
      // «ورثة المرحوم …» for an estate (0076): the heirs owe, not the deceased.
      citizenName: citizenDisplayName(row.citizen, { middleName: false }),
      citizenPhone: row.citizen.phone,
      citizenReference: row.citizen.referenceNumber,
    }));
  }

  /** Marks a pending payment notification as seen. */
  async markAsSeen(paymentId: string) {
    const payment = await this.db.citizenPayment.findUnique({
      where: { id: paymentId },
      select: { id: true, paymentStatus: true },
    });
    if (!payment) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${paymentId} was not found`,
    });

    const updated = await withConnectionRetry(() =>
      this.db.citizenPayment.update({
        where: { id: paymentId },
        data: { isSeen: true },
        select: { id: true, isSeen: true },
      }),
    );

    return { id: updated.id, isSeen: updated.isSeen };
  }

  /** Marks all pending payment notifications as seen. */
  async markAllPendingAsSeen() {
    const result = await withConnectionRetry(() =>
      this.db.citizenPayment.updateMany({
        where: { paymentStatus: 'PENDING_REVIEW', isSeen: false },
        data: { isSeen: true },
      }),
    );

    return { updatedCount: result.count };
  }

  /**
   * A clerk confirming the money arrived, or sending the claim back.
   *
   * Confirmation is a *ledger entry*, not a status flip. It used to set
   * `paidAmount = amount` outright, which quietly overwrote any counter cash
   * already recorded against the same invoice and left no record of what the
   * confirmation itself received.
   */
  async review(input: {
    paymentId: string;
    confirmed: boolean;
    note?: string;
    actor: { id: string; role: string };
  }) {
    const payment = await this.db.citizenPayment.findUnique({
      where: { id: input.paymentId },
      select: {
        id: true,
        paymentStatus: true,
        citizenId: true,
        amount: true,
        paidAmount: true,
        paymentMethod: true,
        whishTransactionRef: true,
      },
    });
    if (!payment) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${input.paymentId} was not found`,
    });

    if (payment.paymentStatus !== 'PENDING_REVIEW') {
      throw new ConflictError({
        code: 'PAYMENT_NO_PENDING_REVIEW',
        message: 'There is no pending payment to review on this record.',
      });
    }

    if (!input.confirmed) {
      /**
       * Back to UNPAID, and the method and reference go with it — they
       * described a transfer the municipality could not find.
       *
       * Nothing is written to the ledger, and `paidAmount` is untouched: a
       * refused *claim* is not a movement of money, and it says nothing about
       * cash already taken at the counter on the same invoice. That history now
       * lives in its own rows, so refusing a claim can no longer disturb it.
       *
       * The status predicate matters most here: the guard above read the row
       * before the clerk decided, and a counter settlement committing in that
       * window would otherwise be overwritten with UNPAID — an invoice marked
       * unpaid, with the cash in the drawer and a printed receipt, and a
       * `reviewNote` that reads as a refusal of money the municipality holds.
       */
      await this.transition({
        paymentId: payment.id,
        from: 'PENDING_REVIEW',
        to: 'UNPAID',
        data: {
          paymentMethod: null,
          whishTransactionRef: null,
          reviewedById: input.actor.id,
          reviewNote: input.note ?? null,
        },
        audit: {
          actorId: input.actor.id,
          actorType: 'STAFF',
          actorRole: input.actor.role as never,
          action: 'PAYMENT_REJECTED',
          entityType: 'Payment',
          entityId: payment.id,
          after: { citizenId: payment.citizenId, confirmed: false },
        },
      });

      this.events.emit('payment.reviewed', {
        tenantSlug: this.tenantContext.tenantSlug,
        paymentId: payment.id,
        citizenId: payment.citizenId,
        confirmed: false,
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });

      return { paymentStatus: 'UNPAID' as const };
    }

    /**
     * The citizen declared a transfer for the whole *outstanding* balance —
     * the portal offers no way to declare part of one — so confirming it
     * receives exactly that, not the invoice's face value. On an invoice
     * already carrying counter cash those are different numbers, and using the
     * face value is what erased the cash.
     */
    const outstanding = Number(payment.amount) - Number(payment.paidAmount);
    if (outstanding <= 0) {
      throw new ConflictError({
        code: 'PAYMENT_NOTHING_OUTSTANDING',
        message: 'Nothing is outstanding on this charge.',
      });
    }

    const settled = await this.ledger.record({
      paymentId: payment.id,
      amount: outstanding,
      method: (payment.paymentMethod ?? 'WHISH_MONEY') as PaymentMethod,
      externalRef: payment.whishTransactionRef,
      recordedById: input.actor.id,
      note: input.note,
      audit: (movement) => ({
        actorId: input.actor.id,
        actorType: 'STAFF',
        actorRole: input.actor.role as never,
        action: 'PAYMENT_CONFIRMED',
        entityType: 'Payment',
        entityId: payment.id,
        after: { citizenId: payment.citizenId, confirmed: true, receiptNumber: movement.receiptNumber },
      }),
    });

    await this.db.citizenPayment.update({
      where: { id: payment.id },
      data: { reviewedById: input.actor.id, reviewNote: input.note ?? null },
    });

    this.events.emit('payment.reviewed', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId: payment.id,
      citizenId: payment.citizenId,
      confirmed: true,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      receiptNumber: settled.receiptNumber,
    });

    return { paymentStatus: settled.paymentStatus };
  }

  /**
   * Raises a one-off charge against a single citizen with no notice behind it.
   *
   * Kept separate from `issue` because it is a different act: no rule, no
   * recurrence, nothing to re-run next month.
   */
  async chargeIndividual(input: {
    citizenId: string;
    title: string;
    amount: number;
    dueDate: string;
    actor: { id: string; role: string };
  }) {
    const citizen = await this.db.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN' },
      select: { id: true },
    });
    if (!citizen) throw new NotFoundError({
      code: 'CITIZEN_NOT_FOUND',
      message: `Citizen ${input.citizenId} was not found`,
    });
    // A bill on a file folded into another is one the person never sees.
    await assertNotMergedAway(this.db, citizen.id);

    /*
      One bill, so the number goes straight into the row rather than through
      `numberInvoices` — there is no notice to scope an after-the-fact update
      by, and nothing here is skipped as a duplicate. The transaction is what
      ties the number to the bill: drawn and then not used, it would be printed
      on nothing.
    */
    const created = await this.db.$transaction(async (tx) => {
      const invoiceNumber = await allocateDocumentNumber(tx, this.S, 'INVOICE');
      return tx.citizenPayment.create({
        data: {
          citizenId: citizen.id,
          title: input.title,
          amount: input.amount,
          dueDate: new Date(input.dueDate),
          invoiceNumber,
        },
        select: { id: true },
      });
    });

    return { id: created.id };
  }

  /**
   * Puts «INV-2610-0001» on the bills just raised, in the order they were created.
   *
   * Numbered **after** the insert rather than in it, because `createMany` runs
   * with `skipDuplicates`: a block reserved beforehand would be sized to what we
   * meant to write, and a re-run that inserts nothing would burn a month's worth
   * of numbers on documents that do not exist. `count` is `createMany`'s own
   * return, so exactly as many numbers are drawn as there are rows to carry them.
   *
   * `since` is taken before the insert and is what keeps this off bills raised
   * earlier. Without it, a recurring notice re-billed for a period that was
   * already billed before migration 0079 would hand this run's numbers to those
   * older, unnumbered rows — the oldest first, by this very ordering — and leave
   * the new ones blank. Bills issued before 0079 stay unnumbered on purpose.
   *
   * The numbers are formatted once, in TypeScript, and carried into the
   * statement as a VALUES list: building them in SQL instead would be a second
   * copy of `formatDocumentNumber` waiting to drift from the first.
   */
  private async numberInvoices(
    tx: Prisma.TransactionClient,
    noticeId: string,
    periodKey: string,
    count: number,
    since: Date,
  ): Promise<void> {
    if (count < 1) return;

    const numbers = await allocateDocumentNumbers(tx, this.S, 'INVOICE', count);
    const assigned = Prisma.join(
      numbers.map((number, index) => Prisma.sql`(${index + 1}::bigint, ${number}::text)`),
    );

    await tx.$executeRaw`
      WITH ordered AS (
        SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "rn"
          FROM ${this.S}citizen_payments
         WHERE "feeNoticeId" = ${noticeId}::uuid
           AND "periodKey" = ${periodKey}
           AND "invoiceNumber" IS NULL
           AND "createdAt" >= ${since}
      ),
      assigned ("rn", "number") AS (VALUES ${assigned})
      UPDATE ${this.S}citizen_payments AS p
         SET "invoiceNumber" = assigned."number"
        FROM ordered, assigned
       WHERE assigned."rn" = ordered."rn"
         AND p."id" = ordered."id"
    `;
  }

  /** The include this app always joins onto a `CitizenPayment` for admin use — kept
   *  in one place so `getPaymentById` and `listAllPayments` read the identical shape. */
  private readonly ADMIN_PAYMENT_INCLUDE = {
    citizen: {
      select: { id: true, firstName: true, lastName: true, phone: true, referenceNumber: true, residence: true },
    },
    collectedBy: { select: { firstName: true, lastName: true } },
    feeNotice: { select: { frequency: true } },
  } satisfies Prisma.CitizenPaymentInclude;

  /** One row, in the shape the admin ledger and the settle page both read. */
  private toAdminPaymentItem(
    row: Prisma.CitizenPaymentGetPayload<{ include: FeesService['ADMIN_PAYMENT_INCLUDE'] }>,
    now: Date,
  ) {
    return {
      id: row.id,
      title: row.title,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      remaining: Math.max(Number(row.amount) - Number(row.paidAmount), 0),
      currency: row.currency,
      dueDate: row.dueDate.toISOString(),
      paymentStatus:
        row.paymentStatus === 'UNPAID' && row.dueDate < now ? 'OVERDUE' : row.paymentStatus,
      paymentMethod: row.paymentMethod,
      whishTransactionRef: row.whishTransactionRef,
      paidAt: row.paidAt?.toISOString() ?? null,
      /**
       * Exposed because `paidAt` is not the whole answer.
       *
       * The ledger stamps `paidAt` only when the invoice is *fully* covered
       * (the date of the last money received), so a part-payment — real
       * money, taken at the counter — leaves it null. A transactions screen
       * with a blank date on every partial is worse than useless, so the row
       * carries its last-write time too and the UI falls back to it, labelled
       * as approximate rather than passed off as the moment of payment.
       */
      updatedAt: row.updatedAt.toISOString(),
      /** Set only on a COLLECTOR payment — who is holding the money. */
      collectedByName: row.collectedBy
        ? `${row.collectedBy.firstName} ${row.collectedBy.lastName}`.trim()
        : null,
      frequency: row.feeNotice?.frequency ?? null,
      /**
       * How this amount was arrived at, when it was not simply the notice's own.
       *
       * Carried on the admin row as well as the citizen's, because the ledger
       * and the settle page are where the question is actually asked out loud:
       * a collector taking a disputed «600,000» needs to be able to read back
       * «6 محل تجاري × 100,000» without leaving the screen they are settling on.
       * Null for a flat charge, which explains itself.
       */
      assessment: (row.assessment as FeeAssessment | null) ?? null,
      citizenId: row.citizen.id,
      // «ورثة المرحوم …» for an estate (0076): the heirs owe, not the deceased.
      citizenName: citizenDisplayName(row.citizen, { middleName: false }),
      citizenPhone: row.citizen.phone,
      citizenReference: row.citizen.referenceNumber,
    };
  }

  /**
   * One invoice, loaded directly by id rather than found in an already-loaded
   * list.
   *
   * Exists for تسجيل دفعة as a full page rather than a dialog: a page can be
   * linked to, refreshed, or opened straight from a receipt or a citizen's
   * profile, none of which carry the row in memory the way opening a dialog
   * from a table does. Same shape as a row from `listAllPayments`, so the page
   * and the ledger table render the payment identically.
   */
  async getPaymentById(id: string) {
    const row = await withConnectionRetry(() =>
      this.db.citizenPayment.findUnique({
        where: { id },
        include: this.ADMIN_PAYMENT_INCLUDE,
      }),
    );
    if (!row) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${id} was not found`,
    });
    return this.toAdminPaymentItem(row, new Date());
  }

  /**
   * Every invoice in the municipality, newest obligation first.
   *
   * The admin counterpart to `listForCitizen`: same OVERDUE derivation, plus
   * who owes it — a clerk taking cash at the counter needs to find the row by
   * the name in front of them.
   */
  /** Returns unique fee titles registered in the municipality. */
  async listDistinctTitles(): Promise<string[]> {
    const [notices, payments] = await withConnectionRetry(() =>
      Promise.all([
        this.db.feeNotice.findMany({
          select: { title: true },
          distinct: ['title'],
          orderBy: { title: 'asc' },
        }),
        this.db.citizenPayment.findMany({
          select: { title: true },
          distinct: ['title'],
          orderBy: { title: 'asc' },
        }),
      ]),
    );

    const set = new Set<string>();
    for (const n of notices) {
      if (n.title?.trim()) set.add(n.title.trim());
    }
    for (const p of payments) {
      if (p.title?.trim()) set.add(p.title.trim());
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }

  /**
   * The filter vocabularies إدارة الرسوم and سجل العمليات actually need.
   *
   * Both screens built their filter rows out of arrays written into the page —
   * four status tabs, four method tabs — which is the enum restated in a
   * second place rather than the register described. A municipality that has
   * never taken a Whish transfer was still shown a «Whish» tab, and pressing
   * it emptied the table; a status the state machine has not reached yet was
   * offered the same way.
   *
   * Read off the rows instead, so every option on screen is one that can
   * return something.
   *
   * `paymentMethod` is a stored column and answers for itself. `paymentStatus`
   * does not, and assuming it did is what hid «متأخرة» from every municipality
   * in the country: OVERDUE is derived on read — `toAdminPaymentItem` returns
   * it for an UNPAID row past its due date — and **nothing writes it**, so a
   * `groupBy(['paymentStatus'])` can never yield it however many late invoices
   * the register holds. The screen went on rendering rows as متأخرة with no tab
   * to filter them by.
   *
   * So it is asked the way it is derived, with the same predicate
   * `listAllPayments` applies, which is what keeps the offered tab and the
   * filter behind it from drifting apart. UNPAID is asked the same way for the
   * same reason: once «متأخرة» is its own tab, «غير مدفوعة» means the invoices
   * that are not yet late, and a municipality whose every unpaid bill is
   * overdue should not be offered a tab that comes back empty.
   *
   * Sequential rather than `Promise.all`: a pooler with `connection_limit=1`
   * queues a fan-out and hits P2024. The client caches this for the session,
   * so the round trips are paid once.
   */
  async filterOptions(): Promise<{ statuses: string[]; methods: string[]; titles: string[] }> {
    const now = new Date();
    const stored = await withConnectionRetry(() =>
      this.db.citizenPayment.groupBy({
        by: ['paymentStatus'],
        orderBy: { paymentStatus: 'asc' },
      }),
    );
    // Split the stored UNPAID bucket the way the list and the status cell do.
    const overdue = await withConnectionRetry(() =>
      this.db.citizenPayment.count({
        where: { paymentStatus: 'UNPAID', dueDate: { lt: now } },
      }),
    );
    const notYetDue = await withConnectionRetry(() =>
      this.db.citizenPayment.count({
        where: { paymentStatus: 'UNPAID', dueDate: { gte: now } },
      }),
    );
    const storedStatuses = stored.map((row) => String(row.paymentStatus));
    const statuses = [
      // Only UNPAID is re-derived from scratch; every other stored value
      // answers for itself.
      ...storedStatuses.filter((status) => status !== 'UNPAID' && status !== 'OVERDUE'),
      ...(notYetDue > 0 ? ['UNPAID'] : []),
      /*
        Unioned rather than overwritten. Nothing in this codebase writes
        OVERDUE and nothing in its history did — but the column accepts the
        value, and this repository does run hand-written data repairs against
        production. If one ever lands there, dropping it here would leave a row
        that no tab can reach, which is the failure this whole change is about.
      */
      ...(overdue > 0 || storedStatuses.includes('OVERDUE') ? ['OVERDUE'] : []),
    ];
    const methods = await withConnectionRetry(() =>
      this.db.citizenPayment.groupBy({
        by: ['paymentMethod'],
        // A row nobody has paid has no method. It is not a fifth method, and
        // listing `null` as one would put an unselectable tab on the screen.
        where: { paymentMethod: { not: null } },
        orderBy: { paymentMethod: 'asc' },
      }),
    );

    return {
      statuses,
      methods: methods
        .map((row) => row.paymentMethod)
        .filter((method): method is NonNullable<typeof method> => method !== null)
        .map(String),
      titles: await this.listDistinctTitles(),
    };
  }

  async listAllPayments(
    filter: {
      status?: string;
      search?: string;
      feeTitle?: string;
      citizenId?: string;
      /** CASH | WHISH_MONEY. */
      method?: string;
      /**
       * Narrows the ledger to rows where money actually moved — or is claimed
       * to have. An invoice nobody has paid is an obligation, not a
       * transaction, and listing it on a transactions screen means most rows
       * have no method, no reference and no date.
       */
      transactionsOnly?: boolean;
      /** Page size. Capped server-side so a client cannot ask for everything. */
      limit?: number;
      offset?: number;
    } = {},
    /** The caller — «مشاهد فقط» searches without the payer's رقم مرجعي (`citizenSearchText`). */
    viewer?: { role: string },
  ) {
    /*
      A pasted invoice id is a lookup, not a search.

      Handled as its own branch because `id` is a `uuid` column: it has no
      `LIKE`, so it cannot take part in the substring matching below, and a
      UUID folded into tokens would match nothing anyway. Whole-value equality
      is also the only sensible reading — nobody types a fragment of one.
    */
    const search = filter.search?.trim();
    const exactId = search && UUID.test(search) ? search.toLowerCase() : undefined;
    const tokens = exactId ? [] : searchTokens(search);
    /*
      «مشاهد فقط» is shown a payer's رقم مرجعي masked, so its search must not
      match on it. Prisma's `where` cannot fold a column, so for that role the
      payer side of each word is resolved first, through the same
      reference-free text the register search uses.
    */
    const payerMatches =
      viewer?.role === 'VIEWER' && tokens.length
        ? await Promise.all(
            tokens.map((token) =>
              withConnectionRetry(() =>
                this.db.$queryRaw<Array<{ id: string }>>`
                  SELECT u.id FROM ${this.S}users u
                   WHERE u.kind = 'CITIZEN'
                     AND ${citizenSearchText(this.S, viewer.role)} LIKE ${likePattern(token)}`,
              ),
            ),
          )
        : null;

    /**
     * The page, and the ceiling on it.
     *
     * A single citizen's drill-down is exempt from the *default* but not from
     * the cap: their whole history has to be reconcilable in one view, while a
     * municipality-wide request for 50,000 invoices is a mistake whatever the
     * caller believes.
     */
    const take = Math.min(Math.max(filter.limit ?? (filter.citizenId ? 500 : 25), 1), 500);
    const skip = Math.max(filter.offset ?? 0, 0);

    /*
      Everything except the status tab.

      Split out because the «بانتظار المراجعة» tile below counts PENDING_REVIEW
      *whatever tab is selected*, and it used to do that by spreading `where`
      and overriding the one `paymentStatus` key. That trick stops working the
      moment a status is more than one key: «متأخرة» is `paymentStatus` **and**
      `dueDate`, so an override would replace the status and leave the date
      behind, and the tile would quietly report "pending review, and not yet
      due" — a smaller number, on a tile whose whole job is to be the count
      nobody has dealt with yet.
    */
    const whereWithoutStatus = {
      ...(filter.citizenId ? { citizenId: filter.citizenId } : {}),
      ...(filter.method ? { paymentMethod: filter.method as never } : {}),
      ...(filter.feeTitle
        ? {
            OR: [
              { feeNotice: { title: { equals: filter.feeTitle } } },
              { searchText: { contains: searchTokens(filter.feeTitle)[0] || filter.feeTitle } },
            ],
          }
        : {}),
      // PENDING_REVIEW belongs here despite `paidAmount` still being zero:
      // the citizen has declared a transfer, so there is a claimed
      // transaction with a method and a reference to show — it is simply
      // not confirmed yet.
      ...(filter.transactionsOnly
        ? { OR: [{ paidAmount: { gt: 0 } }, { paymentStatus: 'PENDING_REVIEW' as never }] }
        : {}),
      /*
        Every word of the query, somewhere in the folded text of the invoice or
        its payer.

        What was here could not match a person's name at all. It ORed
        `firstName contains` against `middleName contains` against
        `lastName contains`, so «أحمد نصرالله» asked for a *single column*
        holding both words — and none does. Every two-word search on this
        screen and on إدارة الرسوم returned nothing, which is not a
        near-miss but the most ordinary way anyone looks anyone up.

        `searchText` is a generated column per side of the join (migration
        0018), folded to one alphabet; `searchTokens` folds the query the same
        way. AND across tokens, OR across the two sides: both words have to
        appear, either may appear on either side.

        The payment's `id` is compared whole rather than by substring. It is a
        `uuid` column, which has no `LIKE`, and nobody types a fragment of a
        v4 UUID — it is pasted from a link or a log, entire.
      */
      ...(exactId
        ? { id: exactId }
        : tokens.length
          ? {
              AND: tokens.map((token, index) => ({
                OR: [
                  { searchText: { contains: token } },
                  payerMatches
                    ? { citizenId: { in: payerMatches[index]!.map((row) => row.id) } }
                    : { citizen: { searchText: { contains: token } } },
                ],
              })),
            }
          : {}),
    };

    /*
      One clock for the whole request.

      The tab predicate and the status cell both compare `dueDate` against
      "now", and they have to be the same "now": read twice, they are separated
      by the `$transaction` round trip below, and an invoice due in that gap
      would be filtered as «غير مدفوعة» and then rendered «متأخرة» in its own
      row. It is a narrow window and it is the one this function is judged on,
      because the two numbers a clerk compares are on the same screen.
    */
    const now = new Date();
    const where = { ...whereWithoutStatus, ...paymentStatusWhere(filter.status, now) };

    /**
     * The page and the count in one round trip.
     *
     * `$transaction` rather than two awaits so both read the same snapshot — a
     * payment settled between the two would otherwise give a total that
     * disagrees with the rows beside it, and the page counter would flicker
     * against a list that had not changed.
     */
    const [rows, total, collected, byMethod, awaiting] = await withConnectionRetry(() =>
      this.db.$transaction([
        this.db.citizenPayment.findMany({
          where,
          /**
           * A transactions view is a chronology, so it is ordered by when the
           * money moved — newest first — rather than by what is most overdue.
           * `paidAt` sorts nulls last so a part-payment (which never gets one,
           * see below) falls to `updatedAt` instead of to the top.
           *
           * `id` breaks every tie. Without it two rows sharing a timestamp can
           * come back in either order between queries, and a row seen at the
           * foot of page one reappears at the head of page two — the classic
           * unstable-sort duplicate that makes a paginated list untrustworthy.
           */
          orderBy: filter.transactionsOnly
            ? [{ paidAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }, { id: 'asc' }]
            : [{ paymentStatus: 'asc' }, { dueDate: 'asc' }, { id: 'asc' }],
          take,
          skip,
          include: this.ADMIN_PAYMENT_INCLUDE,
        }),
        this.db.citizenPayment.count({ where }),
        /**
         * Aggregates over the *whole filtered set*, not the page.
         *
         * The screen's summary tiles read "إجمالي المحصّل" and "نقداً / Whish /
         * محصّل". Once the rows became one page of many, computing those in the
         * browser would have quietly turned them into "…on this page" — a
         * total that shrinks when the clerk changes the page size, which is the
         * kind of wrong number nobody notices until it is quoted in a meeting.
         */
        this.db.citizenPayment.aggregate({
          where: { ...where, paidAmount: { gt: 0 } },
          _sum: { paidAmount: true },
        }),
        this.db.citizenPayment.groupBy({
          by: ['paymentMethod'],
          where: { ...where, paidAmount: { gt: 0 } },
          _count: { _all: true },
        }),
        this.db.citizenPayment.count({
          // `whereWithoutStatus`, not `where` — see the note on its declaration.
          where: { ...whereWithoutStatus, paymentStatus: 'PENDING_REVIEW' },
        }),
      ]),
    );

    // The same `now` the tab predicate used — see the note above `where`.
    const items = rows.map((row) => this.toAdminPaymentItem(row, now));

    const methodCount = (method: string) =>
      byMethod.find((group) => group.paymentMethod === method)?._count._all ?? 0;

    return {
      items,
      total,
      /** Across every row the filters match — never just the page. */
      totals: {
        collected: Number(collected._sum.paidAmount ?? 0),
        cash: methodCount('CASH'),
        whish: methodCount('WHISH_MONEY'),
        collector: methodCount('COLLECTOR'),
        awaiting,
      },
    };
  }

  /**
   * Starts an online Whish payment for one of the signed-in citizen's bills.
   *
   * Ownership is checked here rather than trusted from the route: the payment
   * id comes from the browser, and without this a citizen could open a checkout
   * against somebody else's invoice — which would let them *pay* it, but also
   * disclose its amount and title in the process.
   *
   * In sandbox the invoice moves to PENDING_REVIEW, which is precisely what the
   * existing manual declaration does and is the honest state: the citizen has
   * said they are paying, and nothing has confirmed it. It reaches PAID only
   * through `settleFromWhishCallback`, behind a verified signature.
   */
  async startWhishCheckout(input: {
    paymentId: string;
    citizenId: string;
    callbackUrl: string;
    returnUrl: string;
  }): Promise<{ redirectUrl: string; pending: boolean }> {
    const payment = await this.db.citizenPayment.findUnique({
      where: { id: input.paymentId },
      select: {
        id: true,
        citizenId: true,
        amount: true,
        paidAmount: true,
        currency: true,
        paymentStatus: true,
        citizen: { select: { firstName: true, lastName: true, residence: true } },
      },
    });

    if (!payment || payment.citizenId !== input.citizenId) {
      // Same error for "no such invoice" and "not yours", so the endpoint
      // cannot be used to discover which payment ids exist.
      throw new NotFoundError({
        code: 'PAYMENT_NOT_FOUND',
        message: `Payment ${input.paymentId} was not found`,
      });
    }
    if (payment.paymentStatus === 'PAID') {
      throw new ConflictError({
        code: 'CHARGE_ALREADY_PAID',
        message: 'This charge has already been paid.',
      });
    }
    if (payment.paymentStatus === 'PENDING_REVIEW') {
      throw new ConflictError({
        code: 'CHARGE_PAYMENT_PENDING',
        message: 'A payment on this charge is awaiting confirmation.',
      });
    }

    const outstanding = Number(payment.amount) - Number(payment.paidAmount);
    if (outstanding <= 0) {
      throw new ConflictError({
        code: 'PAYMENT_NOTHING_OUTSTANDING',
        message: 'Nothing is outstanding on this charge.',
      });
    }

    const checkout = await this.whish.createCheckout({
      paymentId: payment.id,
      amount: outstanding,
      currency: payment.currency,
      citizenName: citizenDisplayName(payment.citizen, { middleName: false }),
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
    });

    /**
     * The widest race in this service: the guard above was read before an
     * outbound HTTP call to the provider, so hundreds of milliseconds — or
     * seconds — separate the decision from this write. A counter settlement
     * landing in that window would otherwise be pulled back to PENDING_REVIEW.
     *
     * Refusing here leaves a checkout live at the provider that no row
     * references. That is a smaller problem than silently unsettling a paid
     * invoice, but it is not nothing: see docs/open-decisions.md §15 — whether
     * to reserve the row before calling the provider, or cancel the checkout on
     * refusal, is a decision this code does not get to make.
     *
     * All three writes are one transaction. The `whish_checkouts` row is what a
     * callback will be matched against, so an invoice that says PENDING_REVIEW
     * with no checkout row — or a checkout row against an invoice that was never
     * claimed — is a state no callback could be resolved from.
     */
    await this.db.$transaction(async (tx) => {
      /*
        Any earlier attempt on this invoice stops being live. A citizen who
        abandons a checkout and starts again leaves the first one open at the
        provider, and `whish_checkouts_one_open_per_payment_key` allows exactly
        one — which is the point: two open checkouts on one bill are two ways to
        pay it and a race to bank the second. The old row is marked, not
        deleted, because the provider may still call back about it and "we know,
        and we stopped waiting" is worth being able to say.
      */
      await tx.whishCheckout.updateMany({
        where: { paymentId: payment.id, state: 'OPEN' },
        data: { state: 'ABANDONED', settledAt: new Date() },
      });

      const { count } = await tx.citizenPayment.updateMany({
        where: {
          id: payment.id,
          citizenId: input.citizenId,
          paymentStatus: { in: ['UNPAID', 'OVERDUE'] },
        },
        data: {
          paymentStatus: 'PENDING_REVIEW',
          paymentMethod: 'WHISH_MONEY',
          // Kept in step for now. `whish_checkouts.externalRef` is what the
          // callback resolves by; this column is the pre-0057 path and is due
          // to be dropped in its own later release.
          whishTransactionRef: checkout.externalRef,
        },
      });

      if (count === 0) {
        throw new ConflictError({
          code: 'CHARGE_CHANGED_DURING_CHECKOUT',
          message: 'This charge changed while the payment was being prepared. Refresh the page.',
        });
      }

      await tx.whishCheckout.create({
        data: {
          externalRef: checkout.externalRef,
          paymentId: payment.id,
          citizenId: input.citizenId,
          // What was quoted to the provider, captured now. Not re-read off the
          // invoice when the callback lands: by then the outstanding balance
          // may have moved, and the callback answers what was asked for.
          amount: outstanding,
          currency: payment.currency,
        },
      });
    });

    return { redirectUrl: checkout.redirectUrl, pending: !this.whish.isLive };
  }

  /**
   * Verifies a raw callback body. Returns `null` unless the signature checks
   * out — the controller has no other way to obtain a payload, so an unsigned
   * body cannot reach `settleFromWhishCallback` by mistake.
   */
  parseWhishCallback(input: { rawBody: string; signature?: string }): WhishCallback | null {
    return this.whish.parseCallback(input);
  }

  /**
   * Applies a verified Whish callback.
   *
   * Idempotent by construction: it matches on `whishTransactionRef` and skips
   * anything already PAID, because a provider that does not get a 200 will
   * retry, and a retry must not take the money twice or stamp a second
   * `paidAt`. A failed callback returns the invoice to UNPAID and clears the
   * reference, so the citizen can start again rather than being stuck behind a
   * PENDING_REVIEW that will never resolve.
   */
  async settleFromWhishCallback(callback: WhishCallback): Promise<{ applied: boolean }> {
    /*
      Resolved against `whish_checkouts`, not against
      `citizen_payments.whishTransactionRef` (migration 0057).

      That column was the wrong key in two compounding ways: it is not unique,
      and it is mutable — the ledger overwrites it on settlement and the failure
      path nulls it. So the handle the provider holds could stop existing on the
      row it belonged to while the provider still believed it was live.

      The shape that lost money: a citizen abandons checkout #1 and opens #2, so
      the column now names #2. A late *failure* callback for #1 found the
      invoice by that column, cleared it, and #2's own success callback then
      arrived to a reference no row carried — logged as unknown, money never
      banked.

      A checkout row is immutable and uniquely keyed, so a callback resolves to
      exactly one attempt or to none, for ever.
    */
    const checkout = await this.db.whishCheckout.findUnique({
      where: { externalRef: callback.externalRef },
      select: {
        id: true,
        state: true,
        paymentId: true,
        payment: {
          select: { id: true, amount: true, paidAmount: true, paymentStatus: true, citizenId: true },
        },
      },
    });

    if (!checkout) {
      this.logger.warn(`Whish callback for unknown reference ${callback.externalRef}`);
      return { applied: false };
    }

    // A checkout the citizen walked away from. Recorded rather than deleted
    // precisely so this answer exists: we know about it, and we stopped waiting.
    if (checkout.state !== 'OPEN') {
      this.logger.warn(
        `Whish callback for reference ${callback.externalRef}, which is already ${checkout.state}`,
      );
      return { applied: false };
    }

    const payment = checkout.payment;
    /**
     * Idempotent by construction: a provider that does not get a 200 retries,
     * and a retry must not bank the money twice or stamp a second `paidAt`.
     */
    if (payment.paymentStatus === 'PAID') return { applied: false };

    if (!callback.succeeded) {
      /*
        No money moved, so nothing is written to the ledger. The invoice goes
        back to UNPAID so the citizen can start again rather than being stuck
        behind a PENDING_REVIEW that will never resolve.

        Two predicates on the invoice, not one. `paymentStatus` stops a counter
        settlement that landed since the read above from being overwritten with
        UNPAID — an invoice marked unpaid with the cash already in the drawer.
        `whishTransactionRef` keeps this attempt from clearing a reference a
        newer attempt has since claimed.

        The checkout and the invoice move together: a FAILED checkout beside an
        invoice still sitting at PENDING_REVIEW would leave the citizen unable
        to retry and nothing to explain why.

        This deliberately does not throw. The controller answers 200 to every
        callback so the provider stops retrying, and a 409 here would be an
        infinite retry loop. `{ applied: false }` is already this method's word
        for "nothing to do".
      */
      const count = await this.db.$transaction(async (tx) => {
        const invoice = await tx.citizenPayment.updateMany({
          where: {
            id: payment.id,
            paymentStatus: 'PENDING_REVIEW',
            whishTransactionRef: callback.externalRef,
          },
          data: { paymentStatus: 'UNPAID', paymentMethod: null, whishTransactionRef: null },
        });

        await tx.whishCheckout.updateMany({
          where: { id: checkout.id, state: 'OPEN' },
          data: {
            state: 'FAILED',
            settledAt: new Date(),
            providerTxnRef: callback.transactionRef ?? null,
          },
        });

        return invoice.count;
      });

      if (count === 0) {
        this.logger.warn(
          `Whish failure callback for ${callback.externalRef} changed nothing: the invoice ` +
            'moved on, or the reference is no longer live.',
        );
      }
      return { applied: count > 0 };
    }

    /**
     * The provider is the authority on what it took, but it must not exceed
     * what was still owed — a mismatch is a bug or a tampered payload, and
     * banking more than the balance would silently create a credit this system
     * has no way to represent.
     *
     * Capped against the *outstanding* balance rather than the invoice face
     * value, because `startWhishCheckout` quotes the outstanding figure to the
     * provider: on a part-settled invoice those two differ, and the face value
     * is the wrong ceiling.
     *
     * The ledger recomputes both under a row lock and refuses an overpayment
     * itself; this only keeps a legitimate callback from being rejected for
     * arithmetic the provider did correctly.
     */
    const outstanding = Number(payment.amount) - Number(payment.paidAmount);
    const received = Math.min(callback.amount, outstanding);

    if (received <= 0) return { applied: false };

    const settled = await this.ledger.record({
      paymentId: payment.id,
      amount: received,
      method: 'WHISH_MONEY',
      externalRef: callback.transactionRef,
      note: 'دفع إلكتروني عبر Whish',
      /*
        A system row: no staff member acted. `actorId` is a uuid column and
        `actorRole` the staff-role enum, so the provider is named in `after`.
        Before this, the row was written with `actorId: 'WHISH'`, which the
        database refused — and the refusal was caught and logged, so no Whish
        settlement had ever been audited.
      */
      audit: (movement) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'PAYMENT_CONFIRMED',
        entityType: 'Payment',
        entityId: payment.id,
        after: {
          citizenId: payment.citizenId,
          confirmed: true,
          provider: 'WHISH',
          receiptNumber: movement.receiptNumber,
          amount: movement.received,
          externalRef: callback.transactionRef ?? null,
        },
      }),
    });

    /*
      Closed after the ledger, not with it.

      `ledger.record` holds the invoice under `SELECT … FOR UPDATE` and is the
      authority on whether the money was banked; joining it to this write would
      mean a failure to close the checkout could roll back a settlement that
      genuinely happened. The wrong way round: money banked with a checkout
      still OPEN is a retry that finds `state !== 'OPEN'` and declines, which is
      correct. Money not banked because bookkeeping failed is not.
    */
    await this.db.whishCheckout
      .updateMany({
        where: { id: checkout.id, state: 'OPEN' },
        data: {
          state: 'SUCCEEDED',
          settledAt: new Date(),
          providerTxnRef: callback.transactionRef ?? null,
        },
      })
      .catch((error: unknown) => {
        this.logger.error(
          `settled ${callback.externalRef} but could not close its checkout row: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    this.events.emit('payment.reviewed', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId: payment.id,
      citizenId: payment.citizenId,
      confirmed: true,
      actorId: null,
      actorRole: 'WHISH',
      receiptNumber: settled.receiptNumber,
    });

    return { applied: true };
  }

  /**
   * A clerk recording money taken at the counter — in full, or in part.
   *
   * Goes straight to PAID with no PENDING_REVIEW in between, and that is the
   * point: the person confirming it is the person who took the notes. The
   * review step exists to verify a transfer nobody in the building witnessed —
   * applying it to cash in hand would ask a clerk to verify themselves.
   *
   * `amount` is optional and defaults to whatever is still outstanding, so the
   * common case (someone paying the lot) needs no figure typed. Anything less
   * is a partial: `paidAmount` moves, the row stays UNPAID, and the balance
   * carries. Anything *more* is refused rather than quietly recorded as
   * credit — this system has no notion of an overpayment to carry forward, so
   * accepting one would silently lose the difference.
   */
  async settleInPerson(input: {
    paymentId: string;
    amount?: number;
    // The shared enum's type rather than a hand-written union: this listed two
    // methods and had to be found by the compiler when a third was added.
    method: PaymentMethod;
    /** Required by the schema when `method` is WHISH_MONEY; ignored for cash. */
    whishTransactionRef?: string;
    /** Required by the schema when `method` is COLLECTOR; ignored otherwise. */
    collectedById?: string;
    note?: string;
    /** `YYYY-MM-DD`, not in the future (the schema's rule). Omitted means now. */
    paidOn?: string;
    /** The notes handed over; the credit is worked out from them, here. */
    tendered?: { local: number; foreign: number; foreignCurrency: string; exchangeRate?: number };
    /** Required when the rate differs from the municipality's, or the date is not today. */
    adjustmentReason?: string;
    /** The page's id for this press of the button — a retry returns the first receipt. */
    clientRequestId?: string;
    actor: { id: string; role: string };
  }) {
    /**
     * The outstanding balance, read only to default `amount`.
     *
     * Deliberately *not* the figure the settlement is computed from: this read
     * is outside any lock, so it can be stale by the time the write happens.
     * `PaymentLedgerService.record` re-reads under `SELECT … FOR UPDATE` and
     * validates against that, which is what makes two clerks settling the same
     * invoice in the same second safe. This value only answers "how much did
     * they mean, when they typed nothing?".
     */
    const invoice = await this.db.citizenPayment.findUnique({
      where: { id: input.paymentId },
      select: { amount: true, paidAmount: true, citizenId: true, currency: true },
    });
    if (!invoice) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${input.paymentId} was not found`,
    });

    /*
      «20$ و200,000 ليرة» — the credit is what the notes are worth in the
      invoice's currency, computed here and never taken from the client, which
      could send a total that disagrees with its own parts. Rounded to the
      whole unit for a ليرة invoice, where there are no fractions to pay in,
      and to the cent otherwise. The ledger then refuses it, under its lock,
      if it is more than is owed.
    */
    const settings = input.tendered ? await this.getSettings(false) : null;
    const tender = input.tendered
      ? toTender(
          input.tendered,
          invoice.currency,
          officialRateFor(settings, invoice.currency, input.tendered.foreignCurrency),
        )
      : null;
    const received = tender
      ? creditOf(tender, invoice.currency)
      : (input.amount ?? Number(invoice.amount) - Number(invoice.paidAmount));

    const adjustment = assertCashAdjustment({
      tender,
      paidOn: input.paidOn,
      reason: input.adjustmentReason,
      role: input.actor.role,
    });

    const settled = await this.ledger.record({
      paymentId: input.paymentId,
      amount: received,
      method: input.method,
      /**
       * Carried on the transaction rather than only on the invoice. A row can
       * reach here twice — a citizen declares a transfer, it is refused, and
       * the money arrives at the counter in notes — and the ledger keeps both
       * movements with their own method and reference instead of the second
       * overwriting the first.
       */
      externalRef: input.method === 'WHISH_MONEY' ? (input.whishTransactionRef ?? null) : null,
      collectedById: input.method === 'COLLECTOR' ? (input.collectedById ?? null) : null,
      recordedById: input.actor.id,
      note: input.note,
      tendered: tender,
      occurredAt: occurredAtFor(input.paidOn),
      adjustmentReason: adjustment.required ? (input.adjustmentReason ?? null) : null,
      clientRequestId: input.clientRequestId ?? null,
      /*
        What a Court of Audit reviewer asks of a cash entry: how much, on which
        receipt, on what day, in which notes, at what rate against the official
        one, and — when either departs from the ordinary — why. Written in the
        ledger's transaction; a retry answered from the first row writes none.
      */
      audit: (movement) => ({
        actorId: input.actor.id,
        actorType: 'STAFF',
        actorRole: input.actor.role as never,
        action: 'PAYMENT_CONFIRMED',
        entityType: 'Payment',
        entityId: input.paymentId,
        after: {
          citizenId: invoice.citizenId,
          confirmed: true,
          receiptNumber: movement.receiptNumber,
          method: input.method,
          amount: movement.received,
          currency: invoice.currency,
          occurredAt: movement.occurredAt,
          ...(input.paidOn ? { paidOn: input.paidOn, backdatedDays: adjustment.backdatedDays } : {}),
          ...(tender
            ? {
                tenderedLocal: tender.local,
                tenderedForeign: tender.foreign,
                tenderedForeignCurrency: tender.foreignCurrency,
                exchangeRate: tender.exchangeRate,
                officialExchangeRate: tender.officialExchangeRate,
                rateOverridden: adjustment.rateOverridden,
                changeGiven: movement.changeGiven,
              }
            : {}),
          ...(adjustment.required ? { adjustmentReason: input.adjustmentReason } : {}),
        },
      }),
    });

    // For the caches that show this invoice. A replayed retry changed nothing.
    if (!settled.replayed) {
      this.events.emit('payment.reviewed', {
        tenantSlug: this.tenantContext.tenantSlug,
        paymentId: input.paymentId,
        citizenId: invoice.citizenId,
        confirmed: true,
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }

    return {
      paymentStatus: settled.paymentStatus,
      received: settled.received,
      paidAmount: settled.paidAmount,
      remaining: settled.remaining,
      /** The citizen's handle on this movement, and what a reprint looks up. */
      receiptNumber: settled.receiptNumber,
      /** The day the money moved — what the receipt prints, back-dated or not. */
      occurredAt: settled.occurredAt,
      changeGiven: settled.changeGiven,
      exchangeRate: tender?.exchangeRate ?? null,
      officialExchangeRate: tender?.officialExchangeRate ?? null,
    };
  }

  /** Every movement of money against one invoice, oldest first. */
  async listTransactions(paymentId: string) {
    return this.ledger.listForPayment(paymentId);
  }

  /**
   * Reverses one recorded movement, as an opposing ledger row.
   *
   * The correction path a mutable `paidAmount` could not offer: a
   * mis-keyed figure used to be fixed by overwriting the total, which left no
   * trace that the first entry had ever existed.
   */
  async reverseTransaction(input: {
    transactionId: string;
    note?: string;
    actor: { id: string; role: string };
  }) {
    const reversed = await this.ledger.reverse({
      transactionId: input.transactionId,
      recordedById: input.actor.id,
      note: input.note,
      /*
        Tier 1, and new: `payment.reversed` had no listener, so a reversal —
        money taken back out of the register's totals — left no audit row at all.
      */
      audit: (movement) => ({
        actorId: input.actor.id,
        actorType: 'STAFF',
        actorRole: input.actor.role as never,
        action: 'PAYMENT_REVERSED',
        entityType: 'PaymentTransaction',
        entityId: input.transactionId,
        after: {
          reversalTransactionId: movement.transactionId,
          receiptNumber: movement.receiptNumber,
          amount: movement.received,
          ...(input.note ? { note: input.note } : {}),
        },
      }),
    });

    this.events.emit('payment.reversed', {
      tenantSlug: this.tenantContext.tenantSlug,
      transactionId: input.transactionId,
      receiptNumber: reversed.receiptNumber,
      amount: reversed.received,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return reversed;
  }

  /** Headline numbers for the admin fee screen. */
  async summary() {
    const key = `fees:summary:${this.tenantContext.tenantSlug}`;
    const cached = await this.cache.get<{
      unpaidTotal: number;
      unpaidCount: number;
      pendingReviewCount: number;
      paidTotal: number;
      paidCount: number;
    }>(key);
    if (cached) return cached;

    const [unpaid, pending, collected, settledCount] = await Promise.all([
      this.db.citizenPayment.aggregate({
        where: { paymentStatus: 'UNPAID' },
        // Both sums, because a part-paid invoice owes its *balance*, not its
        // face value — charging the full amount again would double-count every
        // pound already taken at the counter.
        _sum: { amount: true, paidAmount: true },
        _count: { _all: true },
      }),
      this.db.citizenPayment.count({ where: { paymentStatus: 'PENDING_REVIEW' } }),
      // Deliberately unfiltered: money received on a *partly* settled invoice
      // is still in the municipality's drawer, and a PAID-only sum would leave
      // it out of "collected" entirely.
      this.db.citizenPayment.aggregate({ _sum: { paidAmount: true } }),
      this.db.citizenPayment.count({ where: { paymentStatus: 'PAID' } }),
    ]);

    const result = {
      unpaidTotal:
        Number(unpaid._sum.amount ?? 0) - Number(unpaid._sum.paidAmount ?? 0),
      unpaidCount: unpaid._count._all,
      pendingReviewCount: pending,
      paidTotal: Number(collected._sum.paidAmount ?? 0),
      paidCount: settledCount,
    };
    await this.cache.set(key, result, 30);
    return result;
  }
}

/**
 * The municipality's own rate for this pair, from الإعدادات: ليرة per one unit
 * of its configured second currency. Null when the bill is not in the base
 * currency, the notes are in another currency, or no rate has been set —
 * every one of which leaves no official figure to take the notes at.
 */
export function officialRateFor(
  settings: { baseCurrency: string; secondaryCurrency: string | null; exchangeRate: number | null } | null,
  invoiceCurrency: string,
  foreignCurrency: string,
): number | null {
  if (!settings || !settings.exchangeRate || settings.exchangeRate <= 0) return null;
  if (settings.baseCurrency !== invoiceCurrency || settings.secondaryCurrency !== foreignCurrency) return null;
  return settings.exchangeRate;
}

/**
 * A cash tender, checked against the invoice it pays. The foreign part must
 * really be foreign: dollars handed against a dollar invoice are the local
 * part, and calling them foreign would apply a rate to a sum that needs none.
 *
 * The rate is the municipality's own unless the request names another; it is
 * kept to four places, and the credit is computed from the kept figure, so
 * the stored row always reproduces its own amount. Exported for its spec.
 */
export function toTender(
  input: { local: number; foreign: number; foreignCurrency: string; exchangeRate?: number },
  invoiceCurrency: string,
  officialRate: number | null,
): Tender {
  const foreign = input.foreign > 0 ? input.foreign : null;
  if (foreign !== null && input.foreignCurrency === invoiceCurrency) {
    throw new ValidationError({
      code: 'PAYMENT_CURRENCY_MISMATCH',
      message: `This invoice is in ${invoiceCurrency}. Enter the amount in the field for that currency.`,
      params: { currency: invoiceCurrency },
      details: {
        foreignCurrency: input.foreignCurrency,
      },
    });
  }
  const rate = foreign !== null ? roundRate(input.exchangeRate ?? officialRate ?? 0) : null;
  if (foreign !== null && !rate) {
    throw new ValidationError({
      code: 'EXCHANGE_RATE_MISSING',
      message: 'No official exchange rate is set. Enter a rate for this payment.',
      details: {
        exchangeRate: '',
      },
    });
  }
  return {
    local: input.local,
    foreign,
    foreignCurrency: foreign !== null ? input.foreignCurrency : null,
    exchangeRate: rate,
    officialExchangeRate: foreign !== null ? officialRate : null,
  };
}

/**
 * The two ways a cash entry departs from the ordinary, and who may make them.
 *
 * - A rate other than the municipality's own (or any rate where none is
 *   set): a finance decision — SUPER_ADMIN or ACCOUNTANT — with a reason. A
 *   collector takes the official rate.
 * - A date before today: any settling role within `BACKDATE_WINDOW_DAYS`,
 *   with a reason; further back is a correction for a finance role.
 *
 * Exported for its spec.
 */
export function assertCashAdjustment(input: {
  tender: Tender | null;
  paidOn: string | undefined;
  reason: string | undefined;
  role: string;
  today?: string;
}): { required: boolean; rateOverridden: boolean; backdatedDays: number } {
  const today = input.today ?? municipalToday();
  const tender = input.tender;
  const rateOverridden =
    !!tender &&
    tender.foreign !== null &&
    (tender.officialExchangeRate === null || tender.exchangeRate !== roundRate(tender.officialExchangeRate));
  const backdatedDays = input.paidOn && input.paidOn < today ? daysBetween(input.paidOn, today) : 0;
  const finance = canOverrideCashRules(input.role);

  if (rateOverridden && !finance) {
    throw tender?.officialExchangeRate
      ? new ForbiddenError({
          code: 'EXCHANGE_RATE_OVERRIDE_FORBIDDEN',
          message: `The official exchange rate is ${tender.officialExchangeRate}. Only an accountant or a system administrator can change it for one payment.`,
          params: { rate: tender.officialExchangeRate },
        })
      : new ForbiddenError({
          code: 'EXCHANGE_RATE_NOT_SET',
          message: 'No official exchange rate is set. Ask an accountant or a system administrator to set one.',
        });
  }
  if (backdatedDays > BACKDATE_WINDOW_DAYS && !finance) {
    throw new ForbiddenError({
      code: 'PAYMENT_BACKDATE_FORBIDDEN',
      message: `A payment cannot be dated more than ${BACKDATE_WINDOW_DAYS} days before today. That correction is for an accountant or a system administrator.`,
      params: { days: BACKDATE_WINDOW_DAYS },
    });
  }
  const required = rateOverridden || backdatedDays > 0;
  if (required && !input.reason?.trim()) {
    throw rateOverridden
      ? new ValidationError({
          code: 'PAYMENT_RATE_REASON_REQUIRED',
          message: 'Give the reason for using a rate other than the official one.',
          details: { adjustmentReason: '' },
        })
      : new ValidationError({
          code: 'PAYMENT_BACKDATE_REASON_REQUIRED',
          message: 'Give the reason for recording the payment with an earlier date.',
          details: { adjustmentReason: '' },
        });
  }
  return { required, rateOverridden, backdatedDays };
}

/** What a tender is worth in the invoice's currency — whole ليرة, or cents. Exported for its spec. */
export function creditOf(tender: Tender, invoiceCurrency: string): number {
  const raw = tender.local + (tender.foreign ?? 0) * (tender.exchangeRate ?? 0);
  return invoiceCurrency === 'LBP' ? Math.round(raw) : Math.round(raw * 100) / 100;
}

/**
 * When a payment taken on `paidOn` happened: midday of that day, so a
 * back-dated entry lands on its own date in every time zone the
 * municipality's reports are read in. Omitted means now — the page leaves it
 * out for a payment taken today, so its real time is kept.
 *
 * Not compared with the server's own «today»: that is UTC, a day behind
 * Lebanon between midnight and 3am, and a clerk recording yesterday's cash in
 * that window would have had it silently moved to now. Exported for its spec.
 */
export function occurredAtFor(paidOn: string | undefined): Date | undefined {
  if (!paidOn) return undefined;
  return new Date(`${paidOn}T12:00:00.000Z`);
}
