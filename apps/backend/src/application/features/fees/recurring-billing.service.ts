
import { feeMatrixSchema } from '@mechanization/shared-schemas';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/tenant-client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { FeeBasis, FeeBearer } from '@mechanization/shared-schemas';
import { municipalToday } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { billingDayOfPeriod } from '../buildings/fee-exemption';
import { splitSharedUnitBills, type SharedUnitBill } from './tiered-area';
import { CitizenAssessment, FeesService, dueDateInCurrentPeriod, periodBeforeCutoff, periodKeyFor, scopeOf } from './fees.service';
import { FeeNoticesService } from './fee-notices.service';

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

/**
 * The recurring run: every active recurring notice billed for the period we
 * are in, each notice on its own, and what each run did recorded in
 * `billing_run_entries`. Driven by `RecurringBillingJob` (the schedule and
 * `InternalCronController`) and by `POST fees/recurring/run`. Out of
 * `FeesService` (audit GOD-03).
 */
@Injectable()
export class RecurringBillingService {
  private readonly logger = new Logger(RecurringBillingService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly fees: FeesService,
    private readonly notices: FeeNoticesService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
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
   *
   * `actor` is the staff member who started the run through `POST
   * fees/recurring/run` (no screen calls it: the fees page lost its button in
   * `d346729`); the scheduled run has none, and its audit rows are the system's
   * (`actorId` NULL, `actorType` SYSTEM).
   */
  async runRecurringBilling(
    now = new Date(),
    actor?: { id: string; role: string },
  ): Promise<{
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

    // Read once per run: the same for every notice (old-debts task 6).
    const cutoffYear =
      (await withConnectionRetry(() => this.db.systemSettings.findFirst({ select: { arrearsCutoffYear: true } })))
        ?.arrearsCutoffYear ?? null;

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
        // A year old debts cover is never billed by a notice (old-debts task 6): the period is skipped and said.
        if (periodBeforeCutoff(periodKey, notice.dueDate, cutoffYear)) {
          this.logger.warn(
            `Recurring "${notice.title}" (${periodKey}): skipped, the period is before the old-debts cutoff year (${cutoffYear})`,
          );
          await this.recordBillingRun(notice.id, periodKey, startedAt, { outcome: 'SKIPPED' });
          continue;
        }

      const dueDate = dueDateInCurrentPeriod(notice.dueDate, notice.frequency, now);

      // Targets are re-resolved every period rather than frozen at issue time:
      // someone who registered a shop last week should be in this month's
      // billing, and someone deactivated should drop out of it. Through the
      // scope the notice was issued with (0100), read back like its table.
      const scope = scopeOf(notice);
      const citizenIds = await this.fees.resolveTargets({
        targetType: notice.targetType as never,
        targetCategories: scope.categories,
        targetCitizenId: notice.targetCitizenId ?? undefined,
        residences: scope.residences,
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
      /*
        A TIERED_AREA notice is priced by the table it was issued with, read
        back through the same schema that let it in: a stored table that no
        longer parses fails this notice's run, named, rather than pricing the
        period by guess.
      */
      const matrixBrackets =
        notice.basis === 'TIERED_AREA' ? feeMatrixSchema.parse(notice.matrixBrackets) : undefined;
      // The same reading `issue` and the preview make, shared units split off.
      const { raw, withheld, billable, shared, conflicts, unassessable, counts } = await this.notices.planNotice(
        {
          amount: Number(notice.amount),
          basis: notice.basis as FeeBasis,
          targetCategories: scope.categories,
          // Re-read from the notice every period, like the basis and the targets
          // above it: a council that changes who bears a fee in March expects
          // April's run to honour it without the notice being reissued.
          bearer: notice.bearer as FeeBearer,
          unitStates: scope.unitStates,
          matrixBrackets,
        },
        citizenIds,
        // A unit whose exemption runs out before this period starts is billed for it (0104).
        billingDayOfPeriod(periodKey, municipalToday(now)),
      );

      /*
        Flats held under review this period — logged, never silent. They are
        not charged for this period by this run or any later one (a period's
        invoice is written once); charging them for it after the review is the
        municipality's decision, not the job's.
      */
      const { heldUnits, uninhabitableUnits, feeExemptUnits, coOwnerPaidUnits } = counts;
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
      if (uninhabitableUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${uninhabitableUnits} unit(s) not charged as uninhabitable (غير صالحة للسكن)`,
        );
      }
      if (feeExemptUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${feeExemptUnits} unit(s) exempt from fees (معفاة من الرسوم)`,
        );
      }
      // Paid in full by their responsible owner — a choice, not a hold, so logged rather than warned.
      if (coOwnerPaidUnits > 0) {
        this.logger.log(
          `Recurring "${notice.title}" (${periodKey}): ${coOwnerPaidUnits} co-owned unit(s) paid by their responsible owner (مالك مسؤول)`,
        );
      }
      if (conflicts.length > 0) {
        // By unit, never by citizen name (docs/security.md, logging).
        this.logger.warn(
          `Recurring "${notice.title}" (${periodKey}): ${conflicts.length} shared unit(s) not billed — their holders' records put them in different brackets (${conflicts
            .map((conflict) => conflict.unitId)
            .join(', ')})`,
        );
      }
      if (billable.length === 0 && shared.length === 0) {
        await this.recordBillingRun(notice.id, periodKey, startedAt, {
          outcome: 'SKIPPED',
          citizensConsidered: citizenIds.length,
        });
        continue;
      }

      if (unassessable.length > 0) {
        // By id, never by name (docs/security.md, logging).
        this.logger.warn(
          `Recurring "${notice.title}" (${periodKey}): ${unassessable.length} citizen(s) not assessed — ${unassessable
            .map((entry) => `${entry.citizenId} (${entry.reason})`)
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
      const created = await runInTenantTransaction(
        this.tenantContext,
        async () => {
          const tx = this.db as Prisma.TransactionClient;
          /*
            The notice's row first, as «إلغاء الإشعار» takes it (`cancelNoticeBatch`):
            a run and a cancel of the same notice wait for each other instead of
            crossing — a cancel landing mid-run would otherwise be followed by
            this run's bills on a notice the manager had just stopped. Read
            again under the lock: a notice stopped since the list was read bills
            nothing.
          */
          const [live] = await tx.$queryRaw<Array<{ isActive: boolean }>>`
            SELECT "isActive" FROM ${this.S}fee_notices WHERE "id" = ${notice.id}::uuid FOR UPDATE
          `;
          if (!live?.isActive) return { count: 0, stopped: true };

          /*
            A period's bill stands (decision D8, 2026-10-26). The run comes back
            every night and the register moves between nights: a flat billed to
            its one owner on the 1st and given a second owner on the 10th would
            otherwise be billed again on the 11th, as a shared bill, while the
            first bill still charged it. So the units already on a bill of this
            notice for this period — cancelled ones too, as the two unique keys
            treat them — are taken off every bill this run would add; a change of
            holders counts from the next period.
          */
          let own: readonly CitizenAssessment[] = billable;
          let sharedBills: readonly SharedUnitBill[] = shared;
          if (notice.basis === 'TIERED_AREA') {
            const alreadyBilled = await this.notices.unitsBilledInPeriod(tx, notice.id, periodKey);
            if (alreadyBilled.size > 0) {
              const split = splitSharedUnitBills(raw, { withheld, alreadyBilled });
              own = split.own.filter((entry) => entry.amount > 0);
              sharedBills = split.shared;
            }
          }

          const written = await this.notices.writeBills(tx, {
            noticeId: notice.id,
            title: notice.title,
            dueDate,
            periodKey,
            // Who started the run (`POST fees/recurring/run`), or nobody for the scheduled run (0091).
            issuedById: actor?.id ?? null,
            own,
            shared: sharedBills,
          });
          return { count: written.own + written.shared, stopped: false };
        },
        // `runInTenantTransaction`'s limits (15 s / 60 s), as on the first issue:
        // a period of a town-wide notice is more than five seconds of work.
      );

      if (created.stopped) {
        await this.recordBillingRun(notice.id, periodKey, startedAt, {
          outcome: 'SKIPPED',
          citizensConsidered: citizenIds.length,
        });
        continue;
      }

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
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
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
}
