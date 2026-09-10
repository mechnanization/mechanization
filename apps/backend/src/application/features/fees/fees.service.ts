import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/tenant-client';
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
import { isUnoccupied } from '@mechanization/shared-schemas';
import {
  billableUnits,
  isUnsurveyed,
  type BillablePropertyEntry,
  type BillableUnit,
} from '../../../domain/entities/billable-unit';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { searchTokens } from '../../common/search-terms';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { PaymentLedgerService } from './payment-ledger.service';

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
 *    have said someone else is in it (مؤجرة — that tenant is billed on their
 *    own card, and charging both is the double-count this whole enum exists to
 *    end) or that nobody is (شاغرة, قيد الإنجاز).
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

  return unit.unitStatus !== 'RENTED' && !isUnoccupied(unit.unitStatus);
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
  | { kind: 'assessed'; amount: number; assessment: FeeAssessment }
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

  const held = entries
    .flatMap(billableUnits)
    .filter((unit) => unitMatches(unit, notice.targetCategory));

  /*
    Split rather than filtered, so the ones left out can be counted.

    An assessment that quietly omits three flats is indistinguishable from an
    assessment of a smaller building, and the resident who believes they were
    charged for them has nothing to point at. `excludedUnitCount` is what turns
    a dropped unit into a line someone can check — and, when it is wrong,
    dispute against the property card that caused it.
  */
  const bearer = notice.bearer ?? 'OCCUPANT';
  const units = held.filter((unit) => bearsFee(unit, bearer));
  const excludedUnitCount = held.length - units.length;

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

  const totalArea = units.reduce((sum, unit) => sum + (unit.unitArea ?? 0), 0);

  // Only the two rate bases reach here; FLAT returned above.
  const multiplier = notice.basis === 'PER_AREA' ? totalArea : units.length;

  return {
    kind: 'assessed',
    /*
      Rounded to the whole pound, because that is what a Lebanese municipal
      receipt is denominated in and `lbpAmount` refuses anything else. Rounding
      here rather than at the database keeps the stored breakdown and the stored
      amount describing the same arithmetic.
    */
    amount: Math.round(notice.amount * multiplier),
    assessment: {
      basis: notice.basis,
      rate: notice.amount,
      unitCount: units.length,
      totalArea,
      excludedUnitCount,
      lines: units.map((unit) => ({
        propertyNumber: unit.propertyNumber,
        propertyType: unit.propertyType,
        unitType: unit.unitType,
        unitArea: notice.basis === 'PER_AREA' ? unit.unitArea : null,
      })),
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

/** Guards the period walk below against an unreachable target date. */
const MAX_PERIOD_STEPS = 600;

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

/** Advances a date by exactly one billing period. */
function addPeriod(date: Date, frequency: string): Date {
  const next = new Date(date);
  switch (frequency) {
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
    case 'HALF_YEARLY':
      next.setUTCMonth(next.getUTCMonth() + 6);
      break;
    case 'ANNUALLY':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
    default:
      break;
  }
  return next;
}

/**
 * The due date this notice carries in the period containing `now`.
 *
 * Walked forward from the original rather than reconstructed from the month:
 * `setUTCMonth` clamps 31 January + 1 month to early March, so rebuilding the
 * date each period would drift. Stepping from the original keeps a fee due on
 * the 15th due on the 15th.
 */
function dueDateInCurrentPeriod(original: Date, frequency: string, now: Date): Date {
  const target = periodKeyFor(frequency, now);
  let due = new Date(original);

  for (let step = 0; step < MAX_PERIOD_STEPS; step++) {
    const key = periodKeyFor(frequency, due);
    if (key === target) return due;
    // Already past the current period — a notice dated in the future is not
    // billable yet, so hand back what it has.
    if (due > now) return due;
    due = addPeriod(due, frequency);
  }
  return due;
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
@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    @Inject(WHISH_GATEWAY) private readonly whish: WhishGateway,
    private readonly cache: RedisCacheService,
    private readonly ledger: PaymentLedgerService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
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
          targetCitizen: { select: { firstName: true, lastName: true } },
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
      targetCitizenName: row.targetCitizen
        ? `${row.targetCitizen.firstName} ${row.targetCitizen.lastName}`
        : null,
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
      throw new ConflictError(
        'لا يوجد مواطنون مطابقون لهذه الفئة — لن يتم إصدار أي إشعار',
      );
    }

    const dueDate = new Date(input.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      throw new ConflictError('تاريخ الاستحقاق غير صالح');
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

    if (billable.length === 0) {
      /*
        Three ways to bill nobody, and telling them apart is the whole value of
        the message. "Nobody matched" sends a clerk to check the target
        category; "needs a survey" sends them to the field; "everything is
        exempt" tells them the exemption they just switched on covers every unit
        the notice was aimed at — which is usually a mis-set toggle, and would
        otherwise read as a fee that targets nobody.
      */
      throw new ConflictError(
        exemptedUnits > 0 && unassessable.length === 0
          ? 'كل الوحدات المستهدفة مسجَّلة شاغرة أو قيد الإنجاز وهذا الرسم يعفيها — لن يتم إصدار أي إشعار'
          : unassessable.length > 0
            ? 'لا يمكن احتساب هذا الرسم لأي مواطن — السجلات المستهدفة تحتاج إلى جرد ميداني أولاً'
            : 'لا يوجد مواطنون مطابقون لهذه الفئة — لن يتم إصدار أي إشعار',
      );
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
    return { ...result, unassessable, exemptedUnits };
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
  }> {
    const notices = await withConnectionRetry(() =>
      this.db.feeNotice.findMany({
        where: { isActive: true, frequency: { not: 'ONCE' } },
      }),
    );

    let invoicesCreated = 0;

    for (const notice of notices) {
      const periodKey = periodKeyFor(notice.frequency, now);

      // The notice's own first period. Anything earlier than the notice's
      // start would be back-billing someone for a fee that did not exist.
      if (periodKey === periodKeyFor(notice.frequency, notice.dueDate)) continue;
      if (notice.dueDate > now) continue;

      const dueDate = dueDateInCurrentPeriod(notice.dueDate, notice.frequency, now);

      // Targets are re-resolved every period rather than frozen at issue time:
      // someone who registered a shop last week should be in this month's
      // billing, and someone deactivated should drop out of it.
      const citizenIds = await this.resolveTargets({
        targetType: notice.targetType as never,
        targetCategory: notice.targetCategory ?? undefined,
        targetCitizenId: notice.targetCitizenId ?? undefined,
      } as never);

      if (citizenIds.length === 0) continue;

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
      if (billable.length === 0) continue;

      if (unassessable.length > 0) {
        this.logger.warn(
          `Recurring "${notice.title}" (${periodKey}): ${unassessable.length} citizen(s) not assessed — ${unassessable
            .map((entry) => `${entry.name} (${entry.reason})`)
            .join('; ')}`,
        );
      }

      const created = await this.db.citizenPayment.createMany({
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
        });
      }

      invoicesCreated += created.count;
    }

    return { noticesConsidered: notices.length, invoicesCreated };
  }

  /** Stops or resumes a recurring notice without touching its past invoices. */
  async setNoticeActive(id: string, isActive: boolean) {
    const notice = await this.db.feeNotice.findUnique({ where: { id }, select: { id: true } });
    if (!notice) throw new NotFoundError('FeeNotice', id);

    await this.db.feeNotice.update({ where: { id }, data: { isActive } });
    return { isActive };
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
  }): Promise<string[]> {
    if (input.targetType === 'INDIVIDUAL_CITIZEN') {
      const citizen = await this.db.user.findFirst({
        where: { id: input.targetCitizenId, kind: 'CITIZEN', isActive: true },
        select: { id: true },
      });
      if (!citizen) throw new NotFoundError('Citizen', input.targetCitizenId ?? '');
      return [citizen.id];
    }

    if (input.targetType === 'ALL_CITIZENS') {
      const rows = await this.db.user.findMany({
        where: { kind: 'CITIZEN', isActive: true },
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
    const propertyWhere = PROPERTY_TYPE_CATEGORIES.has(category)
      ? { propertyType: category as never }
      : {
          OR: [
            { unitType: category as never },
            { units: { some: { unitType: category as never } } },
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
            { units: { some: { unit: { unitType: category as never } } } },
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
    if (notice.basis === 'FLAT') {
      return {
        assessed: citizenIds.map((citizenId) => ({
          citizenId,
          amount: notice.amount,
          assessment: null,
        })),
        unassessable: [],
      };
    }

    const assessed: CitizenAssessment[] = [];
    const unassessable: UnassessableCitizen[] = [];

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
            registrations: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                properties: {
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
                      select: {
                        unitType: true,
                        unitArea: true,
                        unitStatus: true,
                        unit: {
                          select: { unitType: true, unitArea: true, unitStatus: true },
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
                    buildingId: true,
                    unitType: true,
                    unitArea: true,
                    unitStatus: true,
                  },
                },
              },
            },
          },
        }),
      );

      for (const row of rows) {
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
        }>>();
        for (const occupancy of row.unitOccupancies) {
          const buildingId = occupancy.unit.buildingId;
          const list = occupanciesByBuilding.get(buildingId) ?? [];
          list.push({
            role: occupancy.role,
            unitType: occupancy.unit.unitType,
            unitArea: occupancy.unit.unitArea,
            unitStatus: occupancy.unit.unitStatus,
          });
          occupanciesByBuilding.set(buildingId, list);
        }

        const entries = (row.registrations[0]?.properties ?? []).map((entry) => ({
          ...entry,
          occupiedUnits: entry.buildingId
            ? occupanciesByBuilding.get(entry.buildingId)
            : undefined,
        }));
        const name = [row.firstName, row.lastName].filter(Boolean).join(' ');
        const outcome = assessCitizen(entries as never, notice);

        if (outcome.kind === 'unassessable') {
          unassessable.push({ citizenId: row.id, name, reason: outcome.reason });
          continue;
        }

        assessed.push({
          citizenId: row.id,
          amount: outcome.amount,
          assessment: outcome.assessment,
        });
      }
    }

    return { assessed, unassessable };
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
    if (!payment) throw new NotFoundError('Payment', input.paymentId);

    if (payment.paymentStatus === 'PAID') {
      throw new ConflictError('هذه الدفعة مسدّدة بالفعل');
    }
    if (payment.paymentStatus === 'PENDING_REVIEW') {
      throw new ConflictError('هذه الدفعة قيد المراجعة بالفعل');
    }

    await this.db.citizenPayment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: 'PENDING_REVIEW',
        paymentMethod: input.method as never,
        whishTransactionRef: input.whishTransactionRef ?? null,
        isSeen: false,
        // Cleared so a previous rejection's note does not sit alongside a
        // fresh claim as though it applied to it.
        reviewNote: null,
      },
    });

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
            select: { id: true, firstName: true, lastName: true, phone: true, referenceNumber: true },
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
      citizenName: `${row.citizen.firstName} ${row.citizen.lastName}`,
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
    if (!payment) throw new NotFoundError('Payment', paymentId);

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
    if (!payment) throw new NotFoundError('Payment', input.paymentId);

    if (payment.paymentStatus !== 'PENDING_REVIEW') {
      throw new ConflictError('لا توجد دفعة معلّقة للمراجعة على هذا السجل');
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
       */
      await this.db.citizenPayment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: 'UNPAID',
          paymentMethod: null,
          whishTransactionRef: null,
          reviewedById: input.actor.id,
          reviewNote: input.note ?? null,
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
      throw new ConflictError('لا يوجد رصيد مستحق على هذه المطالبة');
    }

    const settled = await this.ledger.record({
      paymentId: payment.id,
      amount: outstanding,
      method: (payment.paymentMethod ?? 'WHISH_MONEY') as PaymentMethod,
      externalRef: payment.whishTransactionRef,
      recordedById: input.actor.id,
      note: input.note,
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
    if (!citizen) throw new NotFoundError('Citizen', input.citizenId);

    const created = await this.db.citizenPayment.create({
      data: {
        citizenId: citizen.id,
        title: input.title,
        amount: input.amount,
        dueDate: new Date(input.dueDate),
      },
      select: { id: true },
    });

    return { id: created.id };
  }

  /** The include this app always joins onto a `CitizenPayment` for admin use — kept
   *  in one place so `getPaymentById` and `listAllPayments` read the identical shape. */
  private readonly ADMIN_PAYMENT_INCLUDE = {
    citizen: {
      select: { id: true, firstName: true, lastName: true, phone: true, referenceNumber: true },
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
       * `settle` stamps `paidAt` only when the invoice is *fully* covered
       * (`paidAt: fullySettled ? new Date() : null`), so a part-payment — real
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
      citizenName: `${row.citizen.firstName} ${row.citizen.lastName}`,
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
    if (!row) throw new NotFoundError('Payment', id);
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

    const where = {
      ...(filter.citizenId ? { citizenId: filter.citizenId } : {}),
      ...(filter.status ? { paymentStatus: filter.status as never } : {}),
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
              AND: tokens.map((token) => ({
                OR: [
                  { searchText: { contains: token } },
                  { citizen: { searchText: { contains: token } } },
                ],
              })),
            }
          : {}),
    };

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
          where: { ...where, paymentStatus: 'PENDING_REVIEW' },
        }),
      ]),
    );

    const now = new Date();
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
        citizen: { select: { firstName: true, lastName: true } },
      },
    });

    if (!payment || payment.citizenId !== input.citizenId) {
      // Same error for "no such invoice" and "not yours", so the endpoint
      // cannot be used to discover which payment ids exist.
      throw new NotFoundError('Payment', input.paymentId);
    }
    if (payment.paymentStatus === 'PAID') {
      throw new ConflictError('هذه المطالبة مسدّدة بالفعل');
    }
    if (payment.paymentStatus === 'PENDING_REVIEW') {
      throw new ConflictError('هناك دفعة قيد التأكيد على هذه المطالبة');
    }

    const outstanding = Number(payment.amount) - Number(payment.paidAmount);
    if (outstanding <= 0) {
      throw new ConflictError('لا يوجد رصيد مستحق على هذه المطالبة');
    }

    const checkout = await this.whish.createCheckout({
      paymentId: payment.id,
      amount: outstanding,
      currency: payment.currency,
      citizenName: `${payment.citizen.firstName} ${payment.citizen.lastName}`,
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
    });

    await this.db.citizenPayment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: 'PENDING_REVIEW',
        paymentMethod: 'WHISH_MONEY',
        // The provider's handle for this attempt. Also what the clerk sees in
        // the verification queue while a live callback is still in flight.
        whishTransactionRef: checkout.externalRef,
      },
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
    const payment = await this.db.citizenPayment.findFirst({
      where: { whishTransactionRef: callback.externalRef },
      select: { id: true, amount: true, paidAmount: true, paymentStatus: true, citizenId: true },
    });

    if (!payment) {
      this.logger.warn(`Whish callback for unknown reference ${callback.externalRef}`);
      return { applied: false };
    }
    /**
     * Idempotent by construction: a provider that does not get a 200 retries,
     * and a retry must not bank the money twice or stamp a second `paidAt`.
     */
    if (payment.paymentStatus === 'PAID') return { applied: false };

    if (!callback.succeeded) {
      // No money moved, so nothing is written to the ledger. The invoice goes
      // back to UNPAID and releases the reference so the citizen can start
      // again rather than being stuck behind a PENDING_REVIEW that will never
      // resolve.
      await this.db.citizenPayment.update({
        where: { id: payment.id },
        data: { paymentStatus: 'UNPAID', paymentMethod: null, whishTransactionRef: null },
      });
      return { applied: true };
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
      select: { amount: true, paidAmount: true, citizenId: true },
    });
    if (!invoice) throw new NotFoundError('Payment', input.paymentId);

    const received =
      input.amount ?? Number(invoice.amount) - Number(invoice.paidAmount);

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
    });

    this.events.emit('payment.reviewed', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId: input.paymentId,
      citizenId: invoice.citizenId,
      confirmed: true,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return {
      paymentStatus: settled.paymentStatus,
      received: settled.received,
      paidAmount: settled.paidAmount,
      remaining: settled.remaining,
      /** The citizen's handle on this movement, and what a reprint looks up. */
      receiptNumber: settled.receiptNumber,
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
