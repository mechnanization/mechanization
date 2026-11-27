import { randomUUID } from 'node:crypto';
import { citizenDisplayName, feeNoticeScopeSchema } from '@mechanization/shared-schemas';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/tenant-client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  CreateFeeNotice,
  FeeAssessment,
  FeeBasis,
  FeeBearer,
  FeeMatrixBracket,
  FeeNoticeDuplicate,
  FeeNoticePeriodSummary,
  FeeNoticePreviewInput,
  FeeNoticePreviewResult,
  FeeNoticeScope,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumbers } from '../../common/document-number';
import { cancelRequestOfCancelledBill } from '../citizen-requests/cancelled-bill';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import {
  splitSharedUnitBills,
  type OutsideUnit,
  type SharedUnitBill,
  type SharedUnitConflict,
  type TieredCitizen,
} from './tiered-area';
import { sameMonth, sameTarget, unconfirmed } from './duplicate-notice';
import { PaymentLedgerService } from './payment-ledger.service';
import { AuditService } from '../audit/audit.service';
import { billCancelRefusal } from './bill-lifecycle.service';
import {
  CitizenAssessment,
  FeesService,
  UnassessableCitizen,
  categoriesOf,
  issueBillingDay,
  periodBeforeCutoff,
  periodKeyFor,
  periodYearOf,
  scopeOf,
} from './fees.service';

/**
 * The scope a notice is issued with, as stored in `fee_notices.scope`: only
 * what departs from the defaults, so a notice that names none of it stores
 * NULL and reads back exactly as before. One category is `targetCategory`'s;
 * a list goes here. The statuses are not stored under FLAT, which ignores them.
 */
function storedScope(input: {
  basis: FeeBasis;
  targetCategories?: readonly string[];
  unitStates?: readonly string[];
  residences?: readonly string[];
  acknowledgedWarnings?: readonly string[];
}): FeeNoticeScope | null {
  const scope = {
    ...(input.targetCategories ? { categories: [...input.targetCategories] } : {}),
    ...(input.unitStates && input.basis !== 'FLAT' ? { unitStates: [...input.unitStates] } : {}),
    ...(input.residences ? { residences: [...input.residences] } : {}),
    ...(input.acknowledgedWarnings?.length ? { acknowledgedWarnings: [...input.acknowledgedWarnings] } : {}),
  };
  return Object.keys(scope).length > 0 ? (feeNoticeScopeSchema.parse(scope) as FeeNoticeScope) : null;
}

/** Two lists holding the same values, in any order; absent equals absent only. */
function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((value) => b.includes(value));
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
 * Units a notice's «حالة الوحدة» filter left out across a run (0100), by state,
 * each once: a rented flat out of scope is on its owner's card and its tenant's,
 * one flat. A unit with no census id has nothing to count once by and is
 * counted where it is found, as `distinctUnits` does.
 */
function distinctOutOfScope(assessed: readonly CitizenAssessment[]): Partial<Record<string, number>> {
  const byId = new Map<string, string>();
  const counts: Partial<Record<string, number>> = {};
  for (const entry of assessed) {
    for (const unit of entry.outOfScopeUnits ?? []) {
      if (unit.unitId) {
        byId.set(unit.unitId, unit.state);
      } else {
        counts[unit.state] = (counts[unit.state] ?? 0) + 1;
      }
    }
  }
  for (const state of byId.values()) counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}

/**
 * Units a TIERED_AREA notice's table does not price, across a run, by type
 * (decision D11): each unit once by id, a card with no census unit once per
 * holder. `null` is a card with no unit type — a أرض or a خيمة.
 */
function outsideTableByType(
  assessed: readonly { outsideUnits?: readonly OutsideUnit[] }[],
): Array<{ unitType: string | null; count: number }> {
  const byId = new Map<string, string | null>();
  const counts = new Map<string | null, number>();
  for (const entry of assessed) {
    for (const unit of entry.outsideUnits ?? []) {
      if (unit.unitId) {
        byId.set(unit.unitId, unit.unitType);
      } else {
        counts.set(unit.unitType, (counts.get(unit.unitType) ?? 0) + 1);
      }
    }
  }
  for (const unitType of byId.values()) counts.set(unitType, (counts.get(unitType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([unitType, count]) => ({ unitType, count }))
    .sort((a, b) => b.count - a.count || String(a.unitType).localeCompare(String(b.unitType)));
}

/**
 * A fee notice's life: «إشعارات الرسوم» (`listNotices`), «معاينة قبل الإصدار»
 * (`previewNotice`), the issue and the bills it writes (`issue`, `writeBills`,
 * `numberInvoices`), «إيقاف الإشعار» (`setNoticeActive`) and «إلغاء الإشعار»
 * (`noticePeriods`, `cancelNoticeBatch`). Who a notice reaches and what each
 * owes stay with `FeesService` (`resolveTargets`, `assessTargets`), which the
 * citizen's own bills and the correction list read too. Out of `FeesService`
 * (audit GOD-02).
 */
@Injectable()
export class FeeNoticesService {
  private readonly logger = new Logger(FeeNoticesService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly ledger: PaymentLedgerService,
    private readonly auditTrail: AuditService,
    private readonly fees: FeesService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * One page of «إشعارات الرسوم», newest first, and how many there are (PAG-04).
   * `id` breaks a tie on `createdAt`, so a page boundary cannot show one
   * notice twice and skip another.
   */
  async listNotices(page: { limit: number; offset: number }) {
    const [rows, total] = await withConnectionRetry(() =>
      Promise.all([
        this.db.feeNotice.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: page.limit,
          skip: page.offset,
          include: {
            targetCitizen: { select: { firstName: true, lastName: true, residence: true } },
            _count: { select: { payments: true } },
          },
        }),
        this.db.feeNotice.count(),
      ]),
    );

    const items = rows.map((row) => {
      const scope = scopeOf(row);
      return {
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
      /** «من يشمل الإشعار» (0100): each null when the notice named none — every category, the bearer's statuses, every file. */
      targetCategories: row.targetType === 'BUILDING_CATEGORY' ? scope.categories ?? null : null,
      unitStates: scope.unitStates ?? null,
      residences: scope.residences ?? null,
      targetCitizenName: row.targetCitizen ? citizenDisplayName(row.targetCitizen, { middleName: false }) : null,
      dueDate: row.dueDate.toISOString(),
      instructions: row.instructions,
      /** How many citizens this notice actually billed. */
      issuedCount: row._count.payments,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      };
    });
    return { items, total };
  }

  /**
   * What a notice would bill, read and assessed, with nothing written: the
   * half of `issue` the preview shares, so the two cannot disagree.
   *
   * Under TIERED_AREA the units several citizens are charged for come off
   * their own bills and become shared unit bills (`splitSharedUnitBills`, D5).
   * The counts are each unit once across the run, as the issue has always
   * reported them.
   */
  async planNotice(
    input: {
      amount: number;
      basis: FeeBasis;
      targetCategory?: string;
      targetCategories?: readonly string[];
      bearer?: FeeBearer;
      unitStates?: readonly string[];
      matrixBrackets?: readonly FeeMatrixBracket[];
    },
    citizenIds: readonly string[],
    /** The first day of the period billed (`billingDayOfPeriod`): a unit's exemption is judged on it (0104). */
    exemptOn: string,
  ): Promise<{
    /**
     * Every citizen assessed, before the shared units came off, and the
     * unassessable with what could still be priced (D10): what the recurring
     * run splits again once it knows what the period already billed (D8).
     */
    raw: CitizenAssessment[];
    withheld: TieredCitizen[];
    /** Every citizen assessed, own bills after the shared units came off, a bill of 0 included. */
    assessed: CitizenAssessment[];
    /**
     * The citizens who get a bill of their own. One who holds none of what the
     * notice charges for owes nothing, and an invoice for zero is not a bill —
     * it is a letter telling someone they owe nothing, arriving with a due
     * date. Skipped rather than raised.
     */
    billable: CitizenAssessment[];
    shared: SharedUnitBill[];
    conflicts: SharedUnitConflict[];
    unassessable: UnassessableCitizen[];
    counts: {
      /** Units this notice declined to charge for under the bearer rule. Reported, never silent. */
      exemptedUnits: number;
      /** Flats whose occupancy fee is held under review — see `assessCitizen`. Each flat once. */
      heldUnits: number;
      /** Flats held as «غير صالحة للسكن» — exempt from every fee; see `assessCitizen`. Each flat once. */
      uninhabitableUnits: number;
      /** Units «معفاة من الرسوم» (0077) — see `assessCitizen`. Each unit once. */
      feeExemptUnits: number;
      /** Co-owned flats the responsible owner pays for, not the person assessed. Each flat once. */
      coOwnerPaidUnits: number;
      /** Units whose حالة الوحدة the notice does not charge (0100). Each unit once. */
      outOfScopeUnits: number;
      /** The same, by state. */
      outOfScopeByState: Partial<Record<string, number>>;
      /** Under TIERED_AREA, units the table does not price (D11). Each unit once. */
      outsideTableUnits: number;
    };
    /** The same units by type; empty under every other basis. */
    outsideTable: Array<{ unitType: string | null; count: number }>;
  }> {
    const { assessed: raw, unassessable, withheld } = await this.fees.assessTargets(citizenIds, input, exemptOn);
    const { own: assessed, shared, conflicts } =
      input.basis === 'TIERED_AREA'
        ? splitSharedUnitBills(raw, { withheld })
        : { own: raw, shared: [], conflicts: [] };
    const outOfScopeByState = distinctOutOfScope(assessed);
    const outsideTable = outsideTableByType(assessed);

    return {
      raw,
      withheld,
      assessed,
      billable: assessed.filter((entry) => entry.amount > 0),
      shared,
      conflicts,
      unassessable,
      counts: {
        exemptedUnits: assessed.reduce((sum, entry) => sum + (entry.assessment?.excludedUnitCount ?? 0), 0),
        heldUnits: distinctHeld(assessed),
        uninhabitableUnits: distinctUninhabitable(assessed),
        feeExemptUnits: distinctExempt(assessed),
        coOwnerPaidUnits: distinctCoOwnerPaid(assessed),
        outOfScopeUnits: Object.values(outOfScopeByState).reduce<number>((sum, count) => sum + (count ?? 0), 0),
        outOfScopeByState,
        outsideTableUnits: outsideTable.reduce((sum, row) => sum + row.count, 0),
      },
      outsideTable,
    };
  }

  /**
   * No year billed twice (old-debts task 6): a notice whose first period is a year before
   * `system_settings.arrearsCutoffYear` is refused. Those years come in as old debts through
   * an approved batch (docs/old-debts-plan.md), and a notice for one would bill it a second
   * time. While no cutoff is set nothing is refused. An invalid date is the issue's own
   * refusal (`FEE_DUE_DATE_INVALID`), not this one.
   */
  private async assertPeriodNotBeforeCutoff(db: Prisma.TransactionClient, frequency: string, dueDate: Date): Promise<void> {
    if (Number.isNaN(dueDate.getTime())) return;
    const cutoffYear = (await db.systemSettings.findFirst({ select: { arrearsCutoffYear: true } }))?.arrearsCutoffYear ?? null;
    const periodKey = periodKeyFor(frequency, dueDate);
    if (periodBeforeCutoff(periodKey, dueDate, cutoffYear)) {
      throw new ValidationError({
        code: 'FEE_PERIOD_BEFORE_ARREARS_CUTOFF',
        message: 'This notice would bill a year that old debts cover; enter it as old debts instead',
        params: { year: periodYearOf(periodKey, dueDate), cutoffYear: cutoffYear! },
      });
    }
  }

  /**
   * «معاينة قبل الإصدار»: what issuing this notice now would bill, without
   * billing anyone (Phase 4 of docs/fees-system-rearchitecture-specification.md).
   *
   * Reads the targets and the register exactly as `issue` does (`planNotice`)
   * and writes nothing: no notice, no bill, no audit row, no event. The answer
   * is the revenue, the bills, each bracket's units and subtotal, what is not
   * charged and why, the citizens who cannot be assessed, and the shared units
   * whose records disagree. A notice that targets nobody previews as zeros
   * rather than refusing: telling the clerk so is the preview's job.
   */
  async previewNotice(input: FeeNoticePreviewInput): Promise<FeeNoticePreviewResult> {
    // Refused here as the issue refuses it, so the clerk learns at the preview, not at the press.
    await this.assertPeriodNotBeforeCutoff(this.db as Prisma.TransactionClient, input.frequency, new Date(input.dueDate));
    const citizenIds = await this.fees.resolveTargets(input);
    // Judged on the day the issue would judge it, so the preview and the issue agree (0104).
    const plan = await this.planNotice(input, citizenIds, issueBillingDay(input.frequency, input.dueDate));
    /*
      Who the residence filter left out (0100): the files the same notice would
      reach with every kind ticked, less the ones it reaches. One more read of
      the targets, and only when a kind was left out.
    */
    const residenceLeftOut =
      input.residences && input.targetType !== 'INDIVIDUAL_CITIZEN'
        ? (await this.fees.resolveTargets({ ...input, residences: undefined })).length - citizenIds.length
        : 0;

    const brackets = new Map(
      (input.basis === 'TIERED_AREA' ? input.matrixBrackets ?? [] : []).map((row) => [
        row.code,
        { code: row.code, label: row.labelAr, unitCount: 0, subtotal: 0 },
      ]),
    );
    const count = (code: string | undefined, amount: number) => {
      const row = code === undefined ? undefined : brackets.get(code);
      if (!row) return;
      row.unitCount += 1;
      row.subtotal += amount;
    };
    for (const entry of plan.billable) {
      for (const unit of entry.tieredUnits ?? []) count(unit.bracketCode, unit.amount);
    }
    for (const bill of plan.shared) count(bill.assessment.lines[0]?.bracketCode, bill.amount);

    return {
      targetedCitizens: citizenIds.length,
      billedCitizens: plan.billable.length,
      sharedBills: plan.shared.length,
      expectedRevenue:
        plan.billable.reduce((sum, entry) => sum + entry.amount, 0) +
        plan.shared.reduce((sum, bill) => sum + bill.amount, 0),
      // Every notice is issued in pounds: the notice form has no currency (`createFeeNoticeSchema`).
      currency: 'LBP',
      brackets: [...brackets.values()],
      notCharged: {
        // `exemptedUnits` in the issue's own answer: the units the bearer rule left out, not «معفاة».
        excludedUnits: plan.counts.exemptedUnits,
        heldUnits: plan.counts.heldUnits,
        uninhabitableUnits: plan.counts.uninhabitableUnits,
        feeExemptUnits: plan.counts.feeExemptUnits,
        coOwnerPaidUnits: plan.counts.coOwnerPaidUnits,
        outOfScopeUnits: plan.counts.outOfScopeUnits,
        outOfScopeByState: plan.counts.outOfScopeByState as FeeNoticePreviewResult['notCharged']['outOfScopeByState'],
        residenceLeftOut: Math.max(0, residenceLeftOut),
        outsideTableUnits: plan.counts.outsideTableUnits,
      },
      outsideTable: plan.outsideTable,
      unassessable: plan.unassessable,
      duplicates: await this.duplicateNotices(this.db as Prisma.TransactionClient, input),
      conflicts: plan.conflicts.map((conflict) => ({
        unitId: conflict.unitId,
        unitCode: conflict.unitCode,
        propertyNumber: conflict.propertyNumber,
        citizenCount: conflict.citizenIds.length,
        bracketCodes: conflict.bracketCodes,
      })),
    };
  }

  /**
   * Writes the rule and bills everyone it applies to, in one transaction.
   *
   * Not two steps: a notice that exists but billed nobody looks identical to
   * one that billed everybody, and a clerk would have no way to tell which
   * happened before re-running it and double-charging the municipality's
   * residents.
   */
  async issue(request: CreateFeeNotice, actor: { id: string; role: string }) {
    /*
      A category belongs to a notice aimed at one (decision D13, 2026-10-26).
      The route's schema refuses it on any other target; a caller inside the
      server skips the schema, so it is dropped here too, before anything reads
      it — the assessment filters every unit by it.
    */
    const input: CreateFeeNotice =
      request.targetType === 'BUILDING_CATEGORY' ? request : { ...request, targetCategory: undefined };

    /*
      A notice is issued once per press of «إصدار» (finance audit B3). A retry
      after a lost answer — or a double press past the wizard's lock — carries
      the same key and is answered with the first notice; before this it created
      a second notice and billed everyone it targets a second time, since a
      bill's uniqueness is (citizen, notice, period). Asked here, before the
      assessment, and again under the key's advisory lock inside the write.
      The route's schema requires the key; a caller inside the server that
      sends none (a script, a spec) issues as before, unguarded.
    */
    const earlier = input.clientRequestId
      ? await this.replayNotice(this.db as Prisma.TransactionClient, input)
      : null;
    if (earlier) return earlier;

    // Before the assessment, so a duplicate is refused without reading the register; asked again under the issue lock.
    await this.refuseUnconfirmedDuplicates(this.db as Prisma.TransactionClient, input);

    const citizenIds = await this.fees.resolveTargets(input);

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

    await this.assertPeriodNotBeforeCutoff(this.db as Prisma.TransactionClient, input.frequency, dueDate);

    // The same reading the preview makes (`planNotice`): what the preview showed is what this bills.
    const { billable, shared, conflicts, unassessable, counts } = await this.planNotice(
      input,
      citizenIds,
      issueBillingDay(input.frequency, input.dueDate),
    );
    const { heldUnits, uninhabitableUnits, feeExemptUnits, coOwnerPaidUnits, outOfScopeUnits, outsideTableUnits } =
      counts;
    /*
      What the issue has always called «exempted»: the units this notice let
      off for their state or their payer — شاغرة, قيد الإنجاز, let to a tenant
      billed on their own card. Since 0100 the first two are counted as out of
      the notice's scope; the answer and the refusal keep the one figure.
    */
    const exemptedUnits = counts.exemptedUnits + outOfScopeUnits;

    // Nothing to bill: no citizen's own bill, and under TIERED_AREA no shared unit bill either.
    if (billable.length === 0 && shared.length === 0) {
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
      // A shared unit whose holders' records disagree (`splitSharedUnitBills`) is a reason too: billed to nobody, reported.
      // So is a unit the table does not price (D11): a table naming no type the town holds bills nothing.
      if (
        heldUnits +
          uninhabitableUnits +
          exemptedUnits +
          feeExemptUnits +
          coOwnerPaidUnits +
          outsideTableUnits +
          unassessable.length +
          conflicts.length ===
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
          outsideTable: outsideTableUnits,
          unassessable: unassessable.length,
        },
      });
    }

    /*
      `runInTenantTransaction` (audit ARCH-01), so a service or a listener
      called inside writes through this transaction too, and its limits
      (15 s / 60 s) rather than Prisma's 5 s default: a town-wide notice writes
      and numbers tens of thousands of bills in here, and past five seconds
      Prisma closes the transaction under the insert.
    */
    /** The duplicates found under the issue lock that the clerk confirmed, for the audit row. */
    let duplicatesConfirmed: string[] = [];
    const result = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      /*
        Serialised before anything is written; the key names the schema, so two
        municipalities never wait on each other. Lower-cased: the column is a
        UUID and compares without case, so the lock key must too.
      */
      if (input.clientRequestId) {
        const lockKey = `${this.tenantContext.schemaName}:fee-notice:${input.clientRequestId.toLowerCase()}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const raced = await this.replayNotice(tx, input);
        if (raced) return { noticeId: raced.noticeId, issued: raced.issued, replayed: true as const };
      }

      /*
        Two issuers with two keys (finding F11): each passed the check above
        before either had written, and each would bill the town. One lock per
        municipality for every issue, taken after the key's, so the second
        waits for the first to commit its notice and its bills and then finds
        them. Issuing is rare; a notice waiting on another is the point.
      */
      const issueLock = `${this.tenantContext.schemaName}:fee-notice-issue`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${issueLock}))`;
      duplicatesConfirmed = await this.refuseUnconfirmedDuplicates(tx, input);

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
          // «من يشمل الإشعار» (0100): only what departs from the defaults; NULL when nothing does.
          scope: (storedScope(input) ?? Prisma.DbNull) as never,
          dueDate,
          instructions: input.instructions ?? null,
          issuedById: actor.id,
          clientRequestId: input.clientRequestId ?? null,
          // The bracket table, under TIERED_AREA only (CHECK fee_notices_matrix_brackets_basis).
          ...(input.basis === 'TIERED_AREA' ? { matrixBrackets: input.matrixBrackets as never } : {}),
        },
        select: { id: true },
      });

      const written = await this.writeBills(tx, {
        noticeId: notice.id,
        title: input.title,
        dueDate,
        // The first period is the one the chosen due date falls in; the
        // recurring job takes over from the next one.
        periodKey: periodKeyFor(input.frequency, dueDate),
        // Who raised them (0091, finance audit B4).
        issuedById: actor.id,
        own: billable,
        shared,
      });

      return {
        noticeId: notice.id,
        issued: written.own + written.shared,
        sharedBills: written.shared,
        replayed: false as const,
      };
    });

    // A press that raced the first one and lost: answered from it, and nothing more is written or emitted.
    if (result.replayed) return this.replayedNoticeResult(result.noticeId, result.issued);

    this.logger.log(
      `Fee "${input.title}" issued to ${result.issued} citizen(s) in ${this.tenantContext.tenantSlug}`,
    );

    if (unassessable.length > 0) {
      // Citizens by id, never by name: a log line leaves the database (docs/security.md, logging).
      this.logger.warn(
        `Fee "${input.title}": ${unassessable.length} citizen(s) could not be assessed — ${unassessable
          .map((entry) => `${entry.citizenId} (${entry.reason})`)
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
        `Fee "${input.title}": ${exemptedUnits} unit(s) not charged for their state or their payer (${outOfScopeUnits} outside the notice's unit states)`,
      );
    }

    this.events.emit('fee.issued', {
      tenantSlug: this.tenantContext.tenantSlug,
      noticeId: result.noticeId,
      title: input.title,
      amount: input.amount,
      basis: input.basis,
      targetType: input.targetType,
      // What the clerk chose and confirmed, for the audit row (0100); null when the notice named no scope.
      scope: storedScope(input),
      duplicatesConfirmed,
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

    if (outsideTableUnits > 0) {
      this.logger.log(`Fee "${input.title}": ${outsideTableUnits} unit(s) outside the bracket table, not charged`);
    }

    if (conflicts.length > 0) {
      // By unit, never by citizen name (docs/security.md, logging).
      this.logger.warn(
        `Fee "${input.title}": ${conflicts.length} shared unit(s) not billed — their holders' records put them in different brackets (${conflicts
          .map((conflict) => conflict.unitId)
          .join(', ')})`,
      );
    }

    return {
      noticeId: result.noticeId,
      /** Every bill raised: the citizens' own and the shared unit bills. */
      issued: result.issued,
      /** Of `issued`, the shared unit bills (TIERED_AREA, D5). */
      sharedBills: result.sharedBills,
      replayed: false,
      unassessable,
      exemptedUnits,
      heldUnits,
      uninhabitableUnits,
      feeExemptUnits,
      coOwnerPaidUnits,
      /** Units the bracket table does not price (D11): not charged, counted. */
      outsideTableUnits,
      /** Shared units billed to nobody because their holders' records disagree; see `splitSharedUnitBills`. */
      sharedUnitConflicts: conflicts.map((conflict) => ({
        unitId: conflict.unitId,
        unitCode: conflict.unitCode,
        propertyNumber: conflict.propertyNumber,
        citizenCount: conflict.citizenIds.length,
        bracketCodes: conflict.bracketCodes,
      })),
    };
  }

  /**
   * Writes one period's bills for a notice: the citizens' own, and under
   * TIERED_AREA the shared unit bills with their debtors (0099, D5) — then
   * numbers them all, in the caller's transaction.
   *
   * Safe to run twice for one period. The own bills skip a duplicate on the
   * (citizen, notice, period) key, the shared ones on (unit, notice, period);
   * a shared bill is given its id here so its debtors are written only for the
   * bills this call actually inserted, never for one an earlier run raised.
   */
  async writeBills(
    tx: Prisma.TransactionClient,
    bills: {
      noticeId: string;
      title: string;
      dueDate: Date;
      periodKey: string;
      /** The notice's issuer, the staff member who started a recurring run, or nobody for the scheduled run. */
      issuedById: string | null;
      own: readonly CitizenAssessment[];
      shared: readonly SharedUnitBill[];
    },
  ): Promise<{ own: number; shared: number }> {
    // Taken before the insert; see `numberInvoices`.
    const raisedAt = new Date();
    const own = await tx.citizenPayment.createMany({
      data: bills.own.map((entry) => ({
        citizenId: entry.citizenId,
        feeNoticeId: bills.noticeId,
        title: bills.title,
        /*
          One invoice per citizen, whatever the basis — never one per unit.

          Every downstream flow keys on a single payment row: the settlement
          screen, the Whish callback, the collector's round, the receipt
          facsimile. Splitting a six-shop bill into six rows would multiply all
          of that, and hand the citizen six pieces of paper for one visit to one
          counter. What they get instead is one bill that can say why. A shared
          unit bill is the one exception, and it is one bill for one unit.
        */
        amount: entry.amount,
        assessment: (entry.assessment ?? undefined) as never,
        dueDate: bills.dueDate,
        periodKey: bills.periodKey,
        issuedById: bills.issuedById,
      })),
      // The unique (citizenId, feeNoticeId, periodKey) triple means a retried
      // request tops up missing rows instead of failing the whole batch.
      skipDuplicates: true,
    });

    let shared = 0;
    if (bills.shared.length > 0) {
      const rows = bills.shared.map((bill) => ({ id: randomUUID(), bill }));
      const created = await tx.citizenPayment.createMany({
        data: rows.map(({ id, bill }) => ({
          id,
          citizenId: null,
          unitId: bill.unitId,
          feeNoticeId: bills.noticeId,
          title: bills.title,
          amount: bill.amount,
          assessment: bill.assessment as never,
          dueDate: bills.dueDate,
          periodKey: bills.periodKey,
          issuedById: bills.issuedById,
        })),
        // One per unit, notice and period (`citizen_payments_unitId_feeNoticeId_periodKey_key`).
        skipDuplicates: true,
      });
      shared = created.count;
      const inserted = new Set(
        (
          await tx.citizenPayment.findMany({
            where: { id: { in: rows.map((row) => row.id) } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      await tx.citizenPaymentDebtor.createMany({
        data: rows
          .filter((row) => inserted.has(row.id))
          .flatMap(({ id, bill }) =>
            bill.debtors.map((debtor) => ({ paymentId: id, citizenId: debtor.citizenId, role: debtor.role as never })),
          ),
      });
    }

    await this.numberInvoices(tx, bills.noticeId, bills.periodKey, own.count + shared, raisedAt);
    return { own: own.count, shared };
  }

  /**
   * The units already on a bill of this TIERED_AREA notice for this period
   * (decision D8): a shared bill's own `unitId`, and each line's `unitId` on a
   * citizen's own bill. Every status, cancelled included, as the two unique
   * keys count them: a bill cancelled in its period is not raised again by the
   * next night's run, and neither is the unit it charged.
   */
  async unitsBilledInPeriod(
    tx: Prisma.TransactionClient,
    noticeId: string,
    periodKey: string,
  ): Promise<Set<string>> {
    const rows = await tx.$queryRaw<Array<{ unitId: string }>>`
      SELECT p."unitId"::text AS "unitId"
        FROM ${this.S}citizen_payments p
       WHERE p."feeNoticeId" = ${noticeId}::uuid
         AND p."periodKey" = ${periodKey}
         AND p."unitId" IS NOT NULL
      UNION
      SELECT line ->> 'unitId'
        FROM ${this.S}citizen_payments p
       CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(p.assessment -> 'lines') = 'array' THEN p.assessment -> 'lines' ELSE '[]'::jsonb END
             ) AS line
       WHERE p."feeNoticeId" = ${noticeId}::uuid
         AND p."periodKey" = ${periodKey}
         AND p."unitId" IS NULL
         AND line ->> 'unitId' IS NOT NULL
    `;
    return new Set(rows.map((row) => row.unitId));
  }

  /**
   * The active notices this one would duplicate (finding F11): the same basis,
   * frequency and target (`sameTarget`), and the same period — a bill not
   * cancelled in the new notice's first period, and for a one-off notice a due
   * date in the same month (`sameMonth`). See `feeNoticeDuplicateSchema`. Read
   * by the preview, and by the issue before its assessment and again under its
   * lock.
   */
  private async duplicateNotices(
    client: Prisma.TransactionClient,
    input: {
      basis: FeeBasis;
      frequency: string;
      targetType: string;
      targetCategory?: string;
      targetCategories?: readonly string[];
      targetCitizenId?: string;
      dueDate: string;
    },
  ): Promise<FeeNoticeDuplicate[]> {
    const dueDate = new Date(input.dueDate);
    // An invalid date is the issue's own refusal (`FEE_DUE_DATE_INVALID`); there is no period to compare.
    if (Number.isNaN(dueDate.getTime())) return [];

    const candidates = await client.feeNotice.findMany({
      where: {
        isActive: true,
        basis: input.basis as never,
        frequency: input.frequency as never,
        targetType: input.targetType as never,
      },
      select: {
        id: true,
        title: true,
        amount: true,
        basis: true,
        bearer: true,
        frequency: true,
        targetCategory: true,
        targetCitizenId: true,
        scope: true,
        dueDate: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const target = {
      targetType: input.targetType,
      targetCitizenId: input.targetCitizenId ?? null,
      categories: categoriesOf(input),
    };
    const periodKey = periodKeyFor(input.frequency, dueDate);
    const found: FeeNoticeDuplicate[] = [];
    for (const notice of candidates) {
      const theirs = {
        targetType: input.targetType,
        targetCitizenId: notice.targetCitizenId,
        categories: scopeOf(notice).categories,
      };
      if (!sameTarget(target, theirs)) continue;
      if (input.frequency === 'ONCE' && !sameMonth(notice.dueDate, dueDate)) continue;
      // Shared unit bills (0099) carry the notice and the period too, so they count.
      const billCount = await client.citizenPayment.count({
        where: { feeNoticeId: notice.id, periodKey, paymentStatus: { not: 'CANCELLED' } },
      });
      if (billCount === 0) continue;
      found.push({
        id: notice.id,
        title: notice.title,
        amount: Number(notice.amount),
        basis: notice.basis as FeeNoticeDuplicate['basis'],
        bearer: notice.bearer as FeeNoticeDuplicate['bearer'],
        frequency: notice.frequency as FeeNoticeDuplicate['frequency'],
        dueDate: notice.dueDate.toISOString(),
        issuedAt: notice.createdAt.toISOString(),
        billCount,
      });
    }
    return found;
  }

  /**
   * Refuses the issue while it duplicates an active notice the request did
   * not confirm (`acknowledgedDuplicates`, by id), and answers the ones it did
   * confirm. Confirmed by id rather than by a yes: a notice someone else issued
   * after the clerk's preview is not covered by a box ticked before it existed.
   */
  private async refuseUnconfirmedDuplicates(
    client: Prisma.TransactionClient,
    input: CreateFeeNotice,
  ): Promise<string[]> {
    const duplicates = await this.duplicateNotices(client, input);
    const open = unconfirmed(duplicates, input.acknowledgedDuplicates);
    if (open.length > 0) {
      throw new ConflictError({
        code: 'FEE_NOTICE_DUPLICATE',
        message: 'An active notice already bills the same people for the same period',
        params: { title: open[0].title, count: open.length },
        details: { duplicates: open },
      });
    }
    return duplicates.map((duplicate) => duplicate.id);
  }

  /**
   * The notice a retry key already issued, as `issue` answers it, or null.
   *
   * Bound to its act: the same title, figure, basis, bearer, recurrence, target,
   * scope (0100: the categories, unit states and kinds of file) and due date.
   * A key that issued another notice can only mean a page reused
   * an id, and answering with that notice would tell the clerk the wrong fee was
   * raised (`FEE_NOTICE_REQUEST_REUSED`). The counts beside the bills are not
   * replayed: they described the register as it stood at the first press.
   */
  private async replayNotice(tx: Prisma.TransactionClient, input: CreateFeeNotice) {
    const notice = await tx.feeNotice.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: {
        id: true,
        title: true,
        amount: true,
        basis: true,
        bearer: true,
        frequency: true,
        targetType: true,
        targetCategory: true,
        targetCitizenId: true,
        scope: true,
        dueDate: true,
      },
    });
    if (!notice) return null;
    const stored = scopeOf(notice);
    const same =
      notice.title === input.title &&
      Number(notice.amount) === input.amount &&
      notice.basis === input.basis &&
      notice.bearer === input.bearer &&
      notice.frequency === input.frequency &&
      notice.targetType === input.targetType &&
      (notice.targetCategory ?? null) === (input.targetCategory ?? null) &&
      (notice.targetCitizenId ?? null)?.toLowerCase() === (input.targetCitizenId ?? null)?.toLowerCase() &&
      sameSet(stored.categories, categoriesOf(input)) &&
      sameSet(stored.unitStates, input.basis === 'FLAT' ? undefined : input.unitStates) &&
      sameSet(stored.residences, input.residences) &&
      notice.dueDate.getTime() === new Date(input.dueDate).getTime();
    if (!same) {
      throw new ConflictError({
        code: 'FEE_NOTICE_REQUEST_REUSED',
        message: 'This request id was already used to issue a different notice.',
      });
    }
    /*
      What the first press raised: its own period's bills, the ones it wrote,
      cancelled since or not. Not every bill of the notice — a recurring notice
      has raised later periods since, and the press did not raise those.
    */
    const issued = await tx.citizenPayment.count({
      where: { feeNoticeId: notice.id, periodKey: periodKeyFor(notice.frequency, notice.dueDate) },
    });
    return this.replayedNoticeResult(notice.id, issued);
  }

  /** `issue`'s answer for a notice a retry key had already issued. */
  private replayedNoticeResult(noticeId: string, issued: number) {
    return {
      noticeId,
      issued,
      replayed: true,
      unassessable: [] as UnassessableCitizen[],
      exemptedUnits: 0,
      heldUnits: 0,
      uninhabitableUnits: 0,
      feeExemptUnits: 0,
      coOwnerPaidUnits: 0,
    };
  }

  /**
   * Stops or resumes a recurring notice without touching its past invoices.
   *
   * «إيقاف الإشعار» is how a fee stops (decision D12, 2026-10-26): the bills
   * already raised stay owed — a council that ends a fee from next month has not
   * waived last month's — and only «إلغاء الإشعار» withdraws bills, for the
   * periods the manager names. Taken under the notice's row lock, as the
   * recurring run and the cancel take it, and written to the trail.
   */
  async setNoticeActive(id: string, isActive: boolean, actor: { id: string; role: string }) {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const [notice] = await tx.$queryRaw<Array<{ title: string; isActive: boolean }>>`
        SELECT "title", "isActive" FROM ${this.S}fee_notices WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (!notice) throw new NotFoundError({
        code: 'FEE_NOTICE_NOT_FOUND',
        message: `FeeNotice ${id} was not found`,
      });
      if (notice.isActive === isActive) return { isActive };

      await tx.feeNotice.update({ where: { id }, data: { isActive } });
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: isActive ? 'FEE_NOTICE_RESUMED' : 'FEE_NOTICE_STOPPED',
        entityType: 'FeeNotice',
        entityId: id,
        before: { isActive: notice.isActive },
        after: { isActive, title: notice.title },
      });
      return { isActive };
    });
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
   * statement as one `text[]` parameter, unnested with their position: building
   * them in SQL instead would be a second copy of `formatDocumentNumber` waiting
   * to drift from the first. One array, not a VALUES list of pairs — Postgres
   * takes at most 32,767 bind variables in a statement, so two per bill failed
   * from 16,384 bills, a town-wide notice, and rolled the whole issue back.
   *
   * `createdAt` is a zoneless `timestamp` holding UTC wall-clock time, and a bound
   * `Date` arrives as `timestamptz`, so a bare `>=` converts the column through the
   * session time zone: correct in UTC, and 0 rows matched (the issue rolled back)
   * on a database set to Asia/Beirut. `since` is brought to the column instead.
   *
   * `createdAt >= since` relies on Prisma stamping `@default(now())` itself, at
   * the moment of the insert, after `since` was read. Were the column filled by
   * the database's own default — the transaction's start, which is before
   * `since` — nothing would match. So the count is checked, and a mismatch
   * rolls the issue back instead of leaving a period half-numbered.
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

    const numbered = await tx.$executeRaw`
      WITH ordered AS (
        SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "rn"
          FROM ${this.S}citizen_payments
         WHERE "feeNoticeId" = ${noticeId}::uuid
           AND "periodKey" = ${periodKey}
           AND "invoiceNumber" IS NULL
           AND "createdAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
      ),
      assigned AS (
        SELECT drawn."number", drawn."rn"
          FROM unnest(${numbers}::text[]) WITH ORDINALITY AS drawn("number", "rn")
      )
      UPDATE ${this.S}citizen_payments AS p
         SET "invoiceNumber" = assigned."number"
        FROM ordered, assigned
       WHERE assigned."rn" = ordered."rn"
         AND p."id" = ordered."id"
    `;
    if (numbered !== count) {
      throw new Error(`numberInvoices: numbered ${numbered} of the ${count} bills raised on notice ${noticeId}`);
    }
  }

  /**
   * «إلغاء الإشعار» — the manager withdraws a notice's bills, for the periods
   * he names, in one step (decisions D6 of 2026-10-23 and D12 of 2026-10-26,
   * docs/fees-system-rearchitecture-specification.md): a notice issued with the
   * wrong table, the wrong target, the wrong amount.
   *
   * Every bill of those periods that `cancelBill` would cancel is cancelled —
   * the citizens' own and the shared unit bills alike, each with who, when and
   * why and its own Tier 1 row, as one press of «إلغاء الفاتورة» writes. Every
   * bill it would refuse is left exactly as it is and reported with the reason:
   * money on it, or a citizen's claim waiting on it. The notice stops:
   * `isActive` false, so the recurring run raises nothing more for it.
   *
   * Only the periods named. A period's correct bills are revenue the law does
   * not let a municipality waive (exemption is by law only), so a fee that is
   * merely ending is stopped (`setNoticeActive`), not cancelled, and a wrong
   * period is cancelled without the right ones around it.
   *
   * One transaction. The notice's row is locked first, as the recurring run
   * locks it, so a run and a cancel of one notice wait for each other; then
   * every bill, so a payment cannot land between the reading and the writing.
   * The statuses are one write and the audit rows one statement, one row per
   * bill, because a bill's own history is where «who cancelled this» is looked up.
   */
  async cancelNoticeBatch(
    noticeId: string,
    input: { reason: string; periodKeys: readonly string[] },
    actor: { id: string; role: string },
  ) {
    const why = input.reason.trim();
    const periodKeys = [...new Set(input.periodKeys)];
    const outcome = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const [notice] = await tx.$queryRaw<Array<{ title: string; isActive: boolean }>>`
        SELECT "title", "isActive" FROM ${this.S}fee_notices WHERE "id" = ${noticeId}::uuid FOR UPDATE
      `;
      if (!notice) {
        throw new NotFoundError({ code: 'FEE_NOTICE_NOT_FOUND', message: `FeeNotice ${noticeId} was not found` });
      }

      const rows = await tx.citizenPayment.findMany({
        where: { feeNoticeId: noticeId, periodKey: { in: periodKeys }, paymentStatus: { not: 'CANCELLED' } },
        select: { id: true, invoiceNumber: true, title: true, periodKey: true },
      });
      const meta = new Map(rows.map((row) => [row.id, row]));
      const bills = await this.ledger.lockInvoices(
        tx,
        rows.map((row) => row.id),
      );

      const cancellable = bills.filter((bill) => billCancelRefusal(bill) === null);
      const skipped = bills.flatMap((bill) => {
        const refusal = billCancelRefusal(bill);
        return refusal ? [{ paymentId: bill.id, invoiceNumber: meta.get(bill.id)?.invoiceNumber ?? null, reason: refusal }] : [];
      });

      if (cancellable.length > 0) {
        const written = await tx.citizenPayment.updateMany({
          // The rows are locked; the status and the money are asked again all the same.
          where: {
            id: { in: cancellable.map((bill) => bill.id) },
            paymentStatus: { notIn: ['CANCELLED', 'WRITTEN_OFF', 'PAID', 'PENDING_REVIEW'] },
            paidAmount: 0,
          },
          data: { paymentStatus: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.id, cancellationReason: why },
        });
        if (written.count !== cancellable.length) {
          throw new Error(`cancelNoticeBatch: cancelled ${written.count} of the ${cancellable.length} bills found cancellable`);
        }
        await this.auditTrail.recordManyInTransaction(
          cancellable.map((bill) => {
            const row = meta.get(bill.id);
            return {
              actorId: actor.id,
              actorType: 'STAFF' as const,
              actorRole: actor.role as never,
              action: 'FEE_BILL_CANCELLED',
              entityType: 'Payment',
              entityId: bill.id,
              before: { paymentStatus: bill.paymentStatus },
              after: {
                citizenId: bill.citizenId,
                invoiceNumber: row?.invoiceNumber ?? null,
                title: row?.title ?? null,
                periodKey: row?.periodKey ?? null,
                amount: bill.amount,
                currency: bill.currency,
                reason: why,
                // Withdrawn with the notice, not on its own.
                noticeId,
              },
            };
          }),
        );
        // A municipal request waiting on one of these bills is cancelled with it, as with one bill (0094).
        const waiting = await tx.citizenRequest.findMany({
          where: { citizenPaymentId: { in: cancellable.map((bill) => bill.id) } },
          select: { citizenPaymentId: true },
        });
        for (const request of waiting) {
          if (request.citizenPaymentId) {
            await cancelRequestOfCancelledBill(tx, this.auditTrail, { billId: request.citizenPaymentId, actor });
          }
        }
      }

      if (notice.isActive) {
        await tx.feeNotice.update({ where: { id: noticeId }, data: { isActive: false } });
      }
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'FEE_NOTICE_CANCELLED',
        entityType: 'FeeNotice',
        entityId: noticeId,
        before: { isActive: notice.isActive },
        after: {
          isActive: false,
          title: notice.title,
          periodKeys,
          cancelled: cancellable.length,
          skipped: skipped.length,
          reason: why,
        },
      });

      return { cancelled: cancellable.length, skipped, deactivated: notice.isActive };
    });

    // For the caches that count what is owed; the audit rows are already written.
    if (outcome.cancelled > 0) {
      this.events.emit('payment.cancelled', {
        tenantSlug: this.tenantContext.tenantSlug,
        noticeId,
        actorId: actor.id,
        actorRole: actor.role,
      });
    }
    return { noticeId, ...outcome };
  }

  /**
   * A notice's periods as «إلغاء الإشعار» shows them before the press (D12):
   * each period's bills, how many the cancel would cancel and for how much, and
   * how many it would leave and why — by `billCancelRefusal`'s own order, so the
   * figures are the cancel's: cancelled first, then written off, then a claim under review, then
   * money taken. Newest period first.
   */
  async noticePeriods(noticeId: string): Promise<FeeNoticePeriodSummary[]> {
    const notice = await this.db.feeNotice.findUnique({ where: { id: noticeId }, select: { id: true } });
    if (!notice) throw new NotFoundError({ code: 'FEE_NOTICE_NOT_FOUND', message: `FeeNotice ${noticeId} was not found` });

    const rows = await withConnectionRetry(() =>
      this.db.$queryRaw<
        Array<{
          periodKey: string;
          bills: number;
          cancellable: number;
          cancellableAmount: number;
          withPayments: number;
          underReview: number;
          alreadyCancelled: number;
          writtenOff: number;
          currency: string;
        }>
      >`
        SELECT p."periodKey",
               count(*)::int AS "bills",
               count(*) FILTER (
                 WHERE p."paymentStatus"::text NOT IN ('CANCELLED', 'WRITTEN_OFF', 'PENDING_REVIEW', 'PAID') AND p."paidAmount" = 0
               )::int AS "cancellable",
               COALESCE(sum(p.amount) FILTER (
                 WHERE p."paymentStatus"::text NOT IN ('CANCELLED', 'WRITTEN_OFF', 'PENDING_REVIEW', 'PAID') AND p."paidAmount" = 0
               ), 0)::float8 AS "cancellableAmount",
               count(*) FILTER (
                 WHERE p."paymentStatus"::text NOT IN ('CANCELLED', 'WRITTEN_OFF', 'PENDING_REVIEW')
                   AND (p."paymentStatus"::text = 'PAID' OR p."paidAmount" > 0)
               )::int AS "withPayments",
               count(*) FILTER (WHERE p."paymentStatus"::text = 'PENDING_REVIEW')::int AS "underReview",
               count(*) FILTER (WHERE p."paymentStatus"::text = 'CANCELLED')::int AS "alreadyCancelled",
               count(*) FILTER (WHERE p."paymentStatus"::text = 'WRITTEN_OFF')::int AS "writtenOff",
               min(p.currency) AS "currency"
          FROM ${this.S}citizen_payments p
         WHERE p."feeNoticeId" = ${noticeId}::uuid
         GROUP BY p."periodKey"
         ORDER BY p."periodKey" DESC
      `,
    );
    return rows;
  }
}
