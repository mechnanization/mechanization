import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  QUALITY_CHECK_ROLES,
  type AssignCheckInput,
  type CompleteCheckInput,
  type DrawSampleInput,
  type FieldFlag,
  type ReturnRecordInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';

/**
 * Where a filed record stands with its reviewer.
 *
 *  - `NEW` — nobody has looked at it.
 *  - `CORRECTED` — returned, and saved since: back with the reviewer.
 *  - `CHANGED` — approved, and edited since: the approval was of something else.
 *  - `RETURNED` — waiting on its officer.
 *  - `APPROVED` — approved, and unchanged since.
 *
 * Derived from the newest `record_reviews` row and the registration's own
 * `updatedAt` on every read, so a state can never disagree with the record.
 */
export const REVIEW_STATES = ['NEW', 'CORRECTED', 'CHANGED', 'RETURNED', 'APPROVED'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The tab a supervisor works from: everything that needs their eyes. */
export const TO_REVIEW: readonly ReviewState[] = ['NEW', 'CORRECTED', 'CHANGED'];

/** Roles that may approve or return a record. */
export const REVIEWER_ROLES = ['SUPER_ADMIN', 'AUDITOR', 'ADMINISTRATIVE_OFFICER'] as const;

/**
 * What this service writes to a citizen's audit trail. None of it changes the
 * record — a review is a message about it — so «آخر من عدّل الملف» must skip
 * these, or the officer fixing a returned record is told the reviewer edited it.
 */
export const REVIEW_AUDIT_ACTIONS = [
  'RECORD_APPROVED',
  'RECORD_RETURNED',
  'RECORD_CORRECTED',
  'QUALITY_CHECK_ASSIGNED',
  'QUALITY_CHECK_DONE',
] as const;

const canCheck = (role: string | null | undefined): boolean =>
  (QUALITY_CHECK_ROLES as readonly string[]).includes(role ?? '');

const MAX_PAGE = 100;

/**
 * One page of the queue, named so it can be cached.
 *
 * Derived from `hydrate` rather than written out: the card carries eighteen
 * fields across four joins, and a hand-kept copy of that shape is a copy that
 * drifts the first time a column is added to the card.
 */
export interface QueuePage {
  items: Array<Awaited<ReturnType<RecordReviewService['hydrate']>>[number] & { state: ReviewState }>;
  total: number;
  counts: Record<ReviewState, number>;
}

const fullName = (row: { firstName: string; middleName?: string | null; lastName: string }) =>
  [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ');

type Actor = { id: string; role: string };

/**
 * «مراجعة السجلات» and «عيّنة التحقق» — a supervisor's decision on a filed
 * record, and a random share of records re-checked on the ground.
 *
 * ## The four-eyes rule
 *
 * Nobody approves, returns or re-checks a record they filed. A review by its
 * own author is a signature on one's own homework, and the whole reason this
 * exists is that every field error of 2026-09-12 → 16 had passed its author.
 *
 * ## What it never does
 *
 * Edit the record, or touch pay. A return is a message with a reason; the fix
 * is the officer's ordinary edit, and saving it is what closes the return.
 * `getInspectorProfile` still counts every registration the officer filed.
 */
@Injectable()
export class RecordReviewService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  private queuePrefix(slug = this.tenantContext.tenantSlug): string {
    return `quality:${slug}:queue:`;
  }

  /** Shares `QUALITY_CACHE_TTL_SECONDS`; zero or less turns caching off. */
  private ttl(): number {
    return this.config.get<number>('QUALITY_CACHE_TTL_SECONDS') ?? 180;
  }

  /**
   * Clears the cached queue.
   *
   * Driven by events rather than by a short TTL, because this list is an action
   * surface: a reviewer approves a record and the next thing they look at is
   * the list it should have left. The three events below are every way a row's
   * state can move — a decision, an officer's correcting edit, and a new
   * filing — so the TTL is only a backstop for a write this process did not
   * see.
   *
   * From inside a transaction, cleared once it commits. Cleared before, a
   * concurrent read re-caches the queue the decision is about to change and
   * serves it for the whole TTL — see `ReportingService`, which states the
   * rule, and `DataQualityService.invalidate`, which follows it.
   */
  @OnEvent('quality.changed')
  @OnEvent('citizen.changed')
  @OnEvent('registration.submitted')
  async onQueueChanged(): Promise<void> {
    const scope = this.tenantContext.peek();
    if (!scope?.tenantSlug) return;
    const prefix = this.queuePrefix(scope.tenantSlug);
    try {
      if (scope.transaction) {
        scope.transaction.afterCommit.push(() => this.cache.invalidatePrefix(prefix));
        return;
      }
      await this.cache.invalidatePrefix(prefix);
    } catch {
      // A queue that lingers until the TTL is not worth failing a write over.
    }
  }

  // ─────────────────────────────  The queue  ─────────────────────────────

  /**
   * One row per citizen — their latest registration, which is the one the edit
   * form owns — classified by `REVIEW_STATES`, newest filing first.
   */
  async queue(filter: {
    states: readonly ReviewState[];
    officerId?: string;
    flaggedOnly?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), MAX_PAGE);
    const offset = Math.max(filter.offset ?? 0, 0);
    const S = this.S;

    /*
      Cached because the `classified` CTE below is evaluated twice per call —
      once for the page, once for the per-state counts the tabs show — and each
      pass is a `DISTINCT ON` over every registration with a LATERAL lookup of
      its newest review. Paging back and forth, or switching tabs and back,
      used to repeat both. `onQueueChanged` clears this on any decision, edit
      or new filing, so what is being traded away is only the seconds between
      another clerk's write and this reader's next request.
    */
    const ttl = this.ttl();
    const cacheKey =
      this.queuePrefix() +
      [
        [...filter.states].join('|'),
        filter.officerId ?? 'ALL',
        filter.flaggedOnly ? 'FLAGGED' : 'ALL',
        limit,
        offset,
      ].join(':');
    if (ttl > 0) {
      const cached = await this.cache.get<QueuePage>(cacheKey);
      if (cached) return cached;
    }

    const narrow = Prisma.join(
      [
        Prisma.sql`TRUE`,
        ...(filter.officerId ? [Prisma.sql`"createdById" = ${filter.officerId}::uuid`] : []),
        ...(filter.flaggedOnly ? [Prisma.sql`status::text = 'REQUIRES_REVIEW'`] : []),
      ],
      ' AND ',
    );

    const classified = Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (r."citizenId")
               r.id, r."citizenId", r."createdById", r."submittedAt", r."updatedAt", r.status
        FROM ${S}registrations r
        JOIN ${S}users u ON u.id = r."citizenId" AND u.kind = 'CITIZEN' AND u."isActive"
        ORDER BY r."citizenId", r."submittedAt" DESC
      ),
      classified AS (
        SELECT l.*,
               CASE
                 WHEN rv.id IS NULL THEN 'NEW'
                 WHEN rv.outcome = 'RETURNED' AND rv."resolvedAt" IS NULL THEN 'RETURNED'
                 WHEN rv.outcome = 'RETURNED' THEN 'CORRECTED'
                 WHEN l."updatedAt" > rv."createdAt" + interval '2 seconds' THEN 'CHANGED'
                 ELSE 'APPROVED'
               END AS state
        FROM latest l
        LEFT JOIN LATERAL (
          SELECT x.id, x.outcome, x."createdAt", x."resolvedAt"
          FROM ${S}record_reviews x
          WHERE x."registrationId" = l.id
          ORDER BY x."createdAt" DESC
          LIMIT 1
        ) rv ON TRUE
      )`;

    const [page, counts] = await Promise.all([
      this.db.$queryRaw<Array<{ id: string; state: ReviewState; total: number }>>`
        ${classified}
        SELECT id, state, count(*) OVER()::int AS total
        FROM classified
        WHERE state = ANY(${[...filter.states]}::text[]) AND ${narrow}
        ORDER BY "submittedAt" DESC, id
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.db.$queryRaw<Array<{ state: ReviewState; count: number }>>`
        ${classified}
        SELECT state, count(*)::int AS count FROM classified WHERE ${narrow} GROUP BY state
      `,
    ]);

    const stateById = new Map(page.map((row) => [row.id, row.state]));
    const items = await this.hydrate(page.map((row) => row.id));

    const result: QueuePage = {
      items: items.map((item) => ({ ...item, state: stateById.get(item.registrationId)! })),
      total: page[0]?.total ?? 0,
      counts: Object.fromEntries(
        REVIEW_STATES.map((state) => [state, counts.find((row) => row.state === state)?.count ?? 0]),
      ) as Record<ReviewState, number>,
    };

    if (ttl > 0) await this.cache.set(cacheKey, result, ttl);
    return result;
  }

  /** What a reviewer needs on one card to decide without opening the file. */
  private async hydrate(registrationIds: readonly string[]) {
    if (registrationIds.length === 0) return [];
    const rows = await this.db.registration.findMany({
      where: { id: { in: [...registrationIds] } },
      select: {
        id: true,
        referenceNumber: true,
        submittedAt: true,
        updatedAt: true,
        status: true,
        flaggedFields: true,
        notes: true,
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        citizen: {
          select: {
            id: true,
            firstName: true,
            middleName: true,
            lastName: true,
            motherName: true,
            referenceNumber: true,
            residence: true,
            actualHouseholdMembers: true,
          },
        },
        properties: {
          where: { endedAt: null },
          orderBy: { createdAt: 'asc' },
          select: {
            propertyType: true,
            occupancyType: true,
            propertyNumber: true,
            buildingName: true,
            unitArea: true,
            building: { select: { id: true, code: true } },
            units: { where: { endedAt: null }, select: { id: true } },
          },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            outcome: true,
            reason: true,
            fields: true,
            createdAt: true,
            resolvedAt: true,
            reviewedBy: { select: { firstName: true, lastName: true } },
            resolvedBy: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return registrationIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => ({
        registrationId: row.id,
        referenceNumber: row.referenceNumber,
        submittedAt: row.submittedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        requiresReview: row.status === 'REQUIRES_REVIEW',
        flags: (Array.isArray(row.flaggedFields) ? (row.flaggedFields as unknown as FieldFlag[]) : []).map(
          (flag) => ({ path: flag.path, reason: flag.reason, kind: flag.kind ?? 'UNESTABLISHED' }),
        ),
        notes: row.notes,
        officer: row.createdBy
          ? { id: row.createdBy.id, name: `${row.createdBy.firstName} ${row.createdBy.lastName}` }
          : null,
        citizen: {
          id: row.citizen.id,
          name: fullName(row.citizen),
          motherName: row.citizen.motherName,
          referenceNumber: row.citizen.referenceNumber,
          residence: row.citizen.residence,
          householdMembers: row.citizen.actualHouseholdMembers,
        },
        properties: row.properties.map((card) => ({
          propertyType: card.propertyType,
          occupancyType: card.occupancyType,
          propertyNumber: card.propertyNumber,
          buildingName: card.buildingName,
          buildingCode: card.building?.code ?? null,
          buildingId: card.building?.id ?? null,
          unitCount: card.units.length,
          unitArea: card.unitArea != null ? Number(card.unitArea) : null,
        })),
        history: row.reviews.map((review) => ({
          id: review.id,
          outcome: review.outcome,
          reason: review.reason,
          fields: review.fields,
          at: review.createdAt.toISOString(),
          by: review.reviewedBy ? `${review.reviewedBy.firstName} ${review.reviewedBy.lastName}` : null,
          resolvedAt: review.resolvedAt?.toISOString() ?? null,
          resolvedBy: review.resolvedBy ? `${review.resolvedBy.firstName} ${review.resolvedBy.lastName}` : null,
        })),
      }));
  }

  // ─────────────────────────────  Decisions  ─────────────────────────────

  private async loadForDecision(registrationId: string, actor: Actor) {
    const registration = await this.db.registration.findUnique({
      where: { id: registrationId },
      select: { id: true, citizenId: true, createdById: true, referenceNumber: true },
    });
    if (!registration) throw new NotFoundError('السجل غير موجود');
    if (registration.createdById && registration.createdById === actor.id) {
      throw new ConflictError('لا يمكنك مراجعة سجل أنشأته بنفسك — يراجعه موظف آخر.');
    }
    return registration;
  }

  async approve(registrationId: string, actor: Actor) {
    const registration = await this.loadForDecision(registrationId, actor);

    /*
      Approving a record that is waiting on its officer closes that return too:
      the reviewer changed their mind, and leaving the return open would show
      the officer a fix nobody wants any more.
    */
    const review = await this.db.$transaction(async (tx) => {
      await tx.recordReview.updateMany({
        where: { registrationId, outcome: 'RETURNED', resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedById: actor.id },
      });
      return tx.recordReview.create({
        data: { registrationId, outcome: 'APPROVED', reviewedById: actor.id },
        select: { id: true, createdAt: true },
      });
    });

    this.announce('RECORD_APPROVED', registration.citizenId, actor, {
      referenceNumber: registration.referenceNumber,
    });
    return { id: review.id, outcome: 'APPROVED' as const, at: review.createdAt.toISOString() };
  }

  async returnToOfficer(registrationId: string, input: ReturnRecordInput, actor: Actor) {
    const registration = await this.loadForDecision(registrationId, actor);

    const open = await this.db.recordReview.findFirst({
      where: { registrationId, outcome: 'RETURNED', resolvedAt: null },
      select: { id: true },
    });
    if (open) throw new ConflictError('هذا السجل مُعاد إلى موظفه بالفعل وينتظر التصحيح.');

    const review = await this.db.recordReview.create({
      data: {
        registrationId,
        outcome: 'RETURNED',
        reason: input.reason,
        fields: [...input.fields],
        reviewedById: actor.id,
      },
      select: { id: true, createdAt: true },
    });

    this.announce('RECORD_RETURNED', registration.citizenId, actor, {
      referenceNumber: registration.referenceNumber,
      reason: input.reason,
      fields: input.fields,
    });
    return { id: review.id, outcome: 'RETURNED' as const, at: review.createdAt.toISOString() };
  }

  /**
   * Saving a returned record is what corrects it.
   *
   * Listens rather than being called, so `CitizensService.update` needs no new
   * dependency: its `CITIZEN_UPDATED` event is emitted after the transaction
   * commits, which is the moment the fix exists.
   */
  @OnEvent('citizen.changed')
  async onCitizenChanged(payload: { citizenId: string; action: string; actorId?: string }): Promise<void> {
    if (payload.action !== 'CITIZEN_UPDATED' || !payload.actorId) return;
    try {
      const latest = await this.db.registration.findFirst({
        where: { citizenId: payload.citizenId },
        orderBy: { submittedAt: 'desc' },
        select: { id: true },
      });
      if (!latest) return;
      const closed = await this.db.recordReview.updateMany({
        where: { registrationId: latest.id, outcome: 'RETURNED', resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedById: payload.actorId },
      });
      if (closed.count > 0) {
        const actor = await this.db.user.findUnique({ where: { id: payload.actorId }, select: { role: true } });
        this.announce('RECORD_CORRECTED', payload.citizenId, { id: payload.actorId, role: actor?.role ?? '' }, {});
      }
    } catch {
      // The save already succeeded; a return left open is visible and can be
      // closed by saving again. Failing here must not look like a failed save.
    }
  }

  /** The open return on a citizen's current record, for the banner on its edit form. */
  async openReturnFor(citizenId: string) {
    const latest = await this.db.registration.findFirst({
      where: { citizenId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    if (!latest) return null;
    const open = await this.db.recordReview.findFirst({
      where: { registrationId: latest.id, outcome: 'RETURNED', resolvedAt: null },
      select: {
        reason: true,
        fields: true,
        createdAt: true,
        reviewedBy: { select: { firstName: true, lastName: true } },
      },
    });
    return open
      ? {
          reason: open.reason,
          fields: open.fields,
          at: open.createdAt.toISOString(),
          by: open.reviewedBy ? `${open.reviewedBy.firstName} ${open.reviewedBy.lastName}` : null,
        }
      : null;
  }

  // ─────────────────────────────  Officer's own work  ─────────────────────────────

  /**
   * What is waiting on this member of staff: their returned records, and checks
   * they can do — none for a role that cannot record a check's result.
   */
  async tasksFor(actor: Actor) {
    const [returned, checks] = await Promise.all([
      this.db.recordReview.findMany({
        where: {
          outcome: 'RETURNED',
          resolvedAt: null,
          registration: { createdById: actor.id },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          reason: true,
          fields: true,
          createdAt: true,
          reviewedBy: { select: { firstName: true, lastName: true } },
          registration: {
            select: {
              referenceNumber: true,
              citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } },
            },
          },
        },
      }),
      canCheck(actor.role) ? this.listChecks({ status: 'OPEN', availableTo: actor.id }) : Promise.resolve([]),
    ]);

    return {
      returned: returned.map((row) => ({
        citizenId: row.registration.citizen.id,
        citizenName: fullName(row.registration.citizen),
        referenceNumber: row.registration.referenceNumber,
        reason: row.reason,
        fields: row.fields,
        at: row.createdAt.toISOString(),
        by: row.reviewedBy ? `${row.reviewedBy.firstName} ${row.reviewedBy.lastName}` : null,
      })),
      checks,
    };
  }

  // ─────────────────────────────  Re-check sample  ─────────────────────────────

  /**
   * Picks a share of each officer's records in the period for a re-check.
   *
   * Per officer, not across the municipality: a 5% sample of everything would
   * be mostly the busiest officer's work and say little about anyone else's. At
   * least one record per officer who filed any. The share is of everything the
   * officer filed in the period, counting what is already in the sample — so
   * drawing twice over one week tops the sample up to its share instead of
   * growing it each time.
   */
  async drawSample(input: DrawSampleInput, actor: Actor) {
    const end = new Date(input.to);
    end.setUTCHours(23, 59, 59, 999);

    const filed = await this.db.registration.findMany({
      where: {
        submittedAt: { gte: input.from, lte: end },
        createdById: { not: null },
        citizen: { kind: 'CITIZEN', isActive: true },
      },
      select: { id: true, createdById: true, qualityChecks: { select: { id: true } } },
    });

    const byOfficer = new Map<string, { unsampled: string[]; total: number; alreadySampled: number }>();
    for (const row of filed) {
      const entry = byOfficer.get(row.createdById!) ?? { unsampled: [], total: 0, alreadySampled: 0 };
      entry.total += 1;
      if (row.qualityChecks.length > 0) entry.alreadySampled += 1;
      else entry.unsampled.push(row.id);
      byOfficer.set(row.createdById!, entry);
    }

    const picks: Array<{ registrationId: string; originalOfficerId: string }> = [];
    for (const [officerId, entry] of byOfficer) {
      const share = Math.max(1, Math.ceil((entry.total * input.percent) / 100));
      const wanted = Math.min(entry.unsampled.length, Math.max(0, share - entry.alreadySampled));
      const pool = [...entry.unsampled];
      for (let i = 0; i < wanted; i += 1) {
        const [picked] = pool.splice(randomInt(pool.length), 1);
        picks.push({ registrationId: picked!, originalOfficerId: officerId });
      }
    }

    if (picks.length > 0) {
      await this.db.qualityCheck.createMany({
        data: picks.map((pick) => ({ ...pick, sampledById: actor.id })),
        skipDuplicates: true,
      });
    }

    const perOfficer = [...byOfficer.entries()].map(([officerId, entry]) => ({
      officerId,
      filed: entry.total,
      sampled: picks.filter((pick) => pick.originalOfficerId === officerId).length,
      inSample: entry.alreadySampled + picks.filter((pick) => pick.originalOfficerId === officerId).length,
    }));

    this.events.emit('quality.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'QUALITY_SAMPLE_DRAWN',
      actorId: actor.id,
      actorRole: actor.role,
      after: {
        from: input.from.toISOString().slice(0, 10),
        to: input.to.toISOString().slice(0, 10),
        percent: input.percent,
        sampled: picks.length,
        officers: perOfficer.length,
      },
    });

    return { sampled: picks.length, perOfficer };
  }

  async listChecks(filter: {
    status?: 'OPEN' | 'DONE';
    /** Checks this person may do: assigned to them, or unassigned — never their own records. */
    availableTo?: string;
    officerId?: string;
    limit?: number;
  }) {
    const rows = await this.db.qualityCheck.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.officerId ? { originalOfficerId: filter.officerId } : {}),
        ...(filter.availableTo
          ? {
              OR: [{ assignedToId: filter.availableTo }, { assignedToId: null }],
              NOT: { originalOfficerId: filter.availableTo },
            }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(filter.limit ?? 200, 500),
      select: {
        id: true,
        status: true,
        result: true,
        differences: true,
        notes: true,
        createdAt: true,
        checkedAt: true,
        originalOfficer: { select: { id: true, firstName: true, lastName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        checkedBy: { select: { firstName: true, lastName: true } },
        registration: {
          select: {
            id: true,
            referenceNumber: true,
            submittedAt: true,
            citizen: {
              select: {
                id: true,
                firstName: true,
                middleName: true,
                lastName: true,
                actualHouseholdMembers: true,
              },
            },
            properties: {
              where: { endedAt: null },
              select: {
                propertyType: true,
                occupancyType: true,
                propertyNumber: true,
                buildingName: true,
                building: { select: { code: true } },
                units: { where: { endedAt: null }, select: { floor: true, unitType: true } },
              },
            },
          },
        },
      },
    });

    const person = (row: { id?: string; firstName: string; lastName: string } | null) =>
      row ? { id: row.id ?? null, name: `${row.firstName} ${row.lastName}` } : null;

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      result: row.result,
      differences: row.differences,
      notes: row.notes,
      sampledAt: row.createdAt.toISOString(),
      checkedAt: row.checkedAt?.toISOString() ?? null,
      originalOfficer: person(row.originalOfficer),
      assignedTo: person(row.assignedTo),
      checkedBy: row.checkedBy ? `${row.checkedBy.firstName} ${row.checkedBy.lastName}` : null,
      citizen: {
        id: row.registration.citizen.id,
        name: fullName(row.registration.citizen),
        householdMembers: row.registration.citizen.actualHouseholdMembers,
      },
      referenceNumber: row.registration.referenceNumber,
      filedAt: row.registration.submittedAt.toISOString(),
      properties: row.registration.properties.map((card) => ({
        propertyType: card.propertyType,
        occupancyType: card.occupancyType,
        propertyNumber: card.propertyNumber,
        buildingName: card.buildingName,
        buildingCode: card.building?.code ?? null,
        units: card.units.map((unit) => `${unit.unitType ?? ''} ${unit.floor ?? ''}`.trim()),
      })),
    }));
  }

  async assign(checkId: string, input: AssignCheckInput, actor: Actor) {
    const check = await this.db.qualityCheck.findUnique({
      where: { id: checkId },
      select: { id: true, status: true, originalOfficerId: true, registration: { select: { citizenId: true } } },
    });
    if (!check) throw new NotFoundError('التحقق غير موجود');
    if (check.status === 'DONE') throw new ConflictError('تم هذا التحقق بالفعل.');

    if (input.assignedToId) {
      if (input.assignedToId === check.originalOfficerId) {
        throw new ValidationError('لا يُسند التحقق إلى الموظف الذي أنشأ السجل.');
      }
      const staff = await this.db.user.findFirst({
        where: { id: input.assignedToId, kind: 'STAFF', isActive: true },
        select: { firstName: true, lastName: true, role: true },
      });
      if (!staff) throw new ValidationError('الموظف غير موجود أو غير فعّال.');
      if (!canCheck(staff.role)) {
        throw new ValidationError('دور هذا الموظف لا يسمح بتسجيل نتيجة التحقق — أسنِده إلى موظف ميداني أو مراجِع.');
      }
    }

    await this.db.qualityCheck.update({ where: { id: checkId }, data: { assignedToId: input.assignedToId } });
    this.events.emit('quality.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'QUALITY_CHECK_ASSIGNED',
      entityId: check.registration.citizenId,
      entityType: 'User',
      actorId: actor.id,
      actorRole: actor.role,
      after: { assignedToId: input.assignedToId },
    });
    return { id: checkId, assignedToId: input.assignedToId };
  }

  async complete(checkId: string, input: CompleteCheckInput, actor: Actor) {
    const check = await this.db.qualityCheck.findUnique({
      where: { id: checkId },
      select: {
        id: true,
        status: true,
        originalOfficerId: true,
        assignedToId: true,
        registration: { select: { citizenId: true, referenceNumber: true } },
      },
    });
    if (!check) throw new NotFoundError('التحقق غير موجود');
    if (check.status === 'DONE') throw new ConflictError('تم هذا التحقق بالفعل.');
    if (check.originalOfficerId === actor.id) {
      throw new ConflictError('لا يمكنك التحقق من سجل أنشأته بنفسك.');
    }
    if (
      check.assignedToId &&
      check.assignedToId !== actor.id &&
      !(REVIEWER_ROLES as readonly string[]).includes(actor.role)
    ) {
      throw new ConflictError('هذا التحقق مُسند إلى موظف آخر.');
    }

    const now = new Date();
    await this.db.qualityCheck.update({
      where: { id: checkId },
      data: {
        status: 'DONE',
        result: input.result,
        differences: input.result === 'DIFFERS' ? [...input.differences] : [],
        notes: input.notes ?? null,
        checkedById: actor.id,
        checkedAt: now,
      },
    });

    this.announce('QUALITY_CHECK_DONE', check.registration.citizenId, actor, {
      referenceNumber: check.registration.referenceNumber,
      result: input.result,
      differences: input.result === 'DIFFERS' ? input.differences : [],
      notes: input.notes ?? null,
    });
    return { id: checkId, status: 'DONE' as const, result: input.result, checkedAt: now.toISOString() };
  }

  private announce(action: string, citizenId: string, actor: Actor, after: Record<string, unknown>) {
    this.events.emit('citizen.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      citizenId,
      action,
      after,
      actorId: actor.id,
      actorRole: actor.role,
    });
  }
}
