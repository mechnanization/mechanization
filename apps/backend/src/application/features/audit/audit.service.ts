import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import { AUDIT_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import {
  AuditQuery,
  AuditRepository,
  AuditRow,
} from '../../../domain/interfaces/audit-repository.interface';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';

/**
 * The audit trail subscribes to domain events rather than being called by the
 * features it records.
 *
 * This is the one piece of CQRS-era machinery v2 kept, because it earns its
 * keep: `RegistrationService` does not know audit logging exists, so adding a
 * new recorded action never means editing the feature that triggers it — and
 * forgetting to log is a missing subscriber, not a missing line inside a method.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    private readonly tenantContext: TenantContextService,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent('registration.submitted')
  async onRegistrationSubmitted(payload: {
    registrationId: string;
    citizenId: string;
    referenceNumber: string;
    propertyCount: number;
  }): Promise<void> {
    await this.record({
      actorId: payload.citizenId,
      actorType: 'CITIZEN',
      action: 'REGISTRATION_SUBMITTED',
      entityType: 'Registration',
      entityId: payload.registrationId,
      after: {
        referenceNumber: payload.referenceNumber,
        propertyCount: payload.propertyCount,
      },
    });
  }

  /*
   * `registration.status-changed` (STATUS_CHANGE) and
   * `registration.resubmitted` were recorded here. Both described the
   * adjudication of a طلب — a reviewer moving a claim through the pipeline,
   * and a citizen answering a rejection with corrected values — and neither
   * event is emitted any more.
   *
   * Existing rows carrying those actions stay in the trail. It is append-only
   * by database trigger, and a decision that really was taken in 2026 does not
   * stop having been taken because the workflow was retired.
   */

  /**
   * Every change to a staff account, under one subscriber.
   *
   * One event carrying its own `action` rather than five event names matched
   * by a wildcard: `EventEmitterModule.forRoot` here does not enable
   * wildcards, so `staff.*` would register a listener that never fires — and
   * an audit subscriber that silently records nothing is worse than none.
   *
   * Nothing about the credential itself is recorded: `changed` names which
   * fields moved, never their values.
   */
  @OnEvent('staff.changed')
  async onStaffChanged(payload: {
    staffId: string;
    action: string;
    email?: string;
    role?: string;
    changed?: string[];
    actorId: string;
    actorRole: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: payload.action,
      entityType: 'User',
      entityId: payload.staffId,
      after: {
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.role ? { role: payload.role } : {}),
        ...(payload.changed ? { changed: payload.changed } : {}),
      },
    });
  }

  /** Sector writes — who redrew which sector, and how its membership moved. */
  @OnEvent('zone.changed')
  async onZoneChanged(payload: {
    zoneId: string;
    action: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actorId: string;
    actorRole: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: payload.action,
      entityType: 'Zone',
      entityId: payload.zoneId,
      before: payload.before,
      after: payload.after,
    });
  }

  /** حالات writes — a field visit logged, edited, resolved or removed. */
  @OnEvent('case.changed')
  async onCaseChanged(payload: {
    caseId: string;
    action: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actorId: string;
    actorRole: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: payload.action,
      entityType: 'Case',
      entityId: payload.caseId,
      before: payload.before,
      after: payload.after,
    });
  }

  /**
   * Census writes — a building, a unit, an occupancy begun or ended, a visit.
   *
   * `BuildingsService` and `CensusSyncService` have emitted `building.changed`
   * for every one of these since Phase 2, and their comments said the audit row
   * was what a resident disputing a bill could read. Nothing subscribed except
   * the dashboard cache, so none of it was ever written: when «إنهاء الإشغال»
   * was pressed by mistake in the field there was no row saying who pressed it,
   * on which flat, or when. This is that row.
   */
  @OnEvent('building.changed')
  async onBuildingChanged(payload: {
    action: string;
    buildingId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actorId: string;
    actorRole: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: payload.action,
      entityType: 'Building',
      entityId: payload.buildingId,
      before: payload.before,
      after: payload.after,
    });
  }

  @OnEvent('user.logged-in')
  async onLogin(payload: {
    userId: string;
    kind: string;
    role?: string;
    email?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.userId,
      actorType: payload.kind === 'STAFF' ? 'STAFF' : 'CITIZEN',
      actorRole: (payload.role ?? null) as never,
      actorEmail: payload.email,
      action: 'LOGIN',
      entityType: 'User',
      entityId: payload.userId,
      ipAddress: payload.ip,
      userAgent: payload.userAgent,
    });
  }

  @OnEvent('document.viewed')
  async onDocumentViewed(payload: {
    documentId: string;
    documentType: string;
    actorId: string;
    actorRole: string;
    actorEmail?: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      actorEmail: payload.actorEmail,
      action: 'DOCUMENT_VIEW',
      entityType: 'Document',
      entityId: payload.documentId,
      after: { documentType: payload.documentType },
    });
  }

  @OnEvent('cadastre.imported')
  async onCadastreImported(payload: {
    actorId: string;
    actorRole: string;
    parcelsImported: number;
    parcelsSkipped: number;
    linesImported: number;
  }): Promise<void> {
    // Rebuilding the parcel registry a citizen's submission validates against
    // is exactly the kind of system-wide change an audit trail exists to
    // record, not just per-registration edits.
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: 'CADASTRE_IMPORT',
      entityType: 'Parcel',
      after: {
        parcelsImported: payload.parcelsImported,
        parcelsSkipped: payload.parcelsSkipped,
        linesImported: payload.linesImported,
      },
    });
  }

  @OnEvent('citizen.changed')
  async onCitizenChanged(payload: {
    citizenId: string;
    action: string;
    changed?: string[];
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actorId?: string;
    actorRole?: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId ?? payload.citizenId,
      actorType: payload.actorRole ? 'STAFF' : 'CITIZEN',
      actorRole: (payload.actorRole ?? null) as never,
      action: payload.action,
      entityType: 'User',
      entityId: payload.citizenId,
      before: payload.before,
      after: {
        ...(payload.after ?? {}),
        ...(payload.changed ? { changed: payload.changed } : {}),
      },
    });
  }

  @OnEvent('fee.issued')
  async onFeeIssued(payload: {
    noticeId: string;
    title: string;
    amount: number;
    targetType: string;
    issuedCount: number;
    actorId?: string | null;
    actorRole?: string | null;
    recurring?: boolean;
    periodKey?: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId ?? 'SYSTEM',
      actorType: payload.actorId ? 'STAFF' : 'SYSTEM',
      actorRole: (payload.actorRole ?? null) as never,
      action: payload.recurring ? 'FEE_RECURRING_ISSUED' : 'FEE_ISSUED',
      entityType: 'FeeNotice',
      entityId: payload.noticeId,
      after: {
        title: payload.title,
        amount: payload.amount,
        targetType: payload.targetType,
        issuedCount: payload.issuedCount,
        periodKey: payload.periodKey,
      },
    });
  }

  @OnEvent('payment.reviewed')
  async onPaymentReviewed(payload: {
    paymentId: string;
    citizenId: string;
    confirmed: boolean;
    actorId: string | null;
    actorRole: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId ?? 'WHISH',
      actorType: payload.actorRole === 'WHISH' ? 'SYSTEM' : 'STAFF',
      actorRole: (payload.actorRole ?? null) as never,
      action: payload.confirmed ? 'PAYMENT_CONFIRMED' : 'PAYMENT_REJECTED',
      entityType: 'Payment',
      entityId: payload.paymentId,
      after: {
        citizenId: payload.citizenId,
        confirmed: payload.confirmed,
      },
    });
  }

  @OnEvent('payment.declared')
  async onPaymentDeclared(payload: {
    paymentId: string;
    citizenId: string;
    method: string;
  }): Promise<void> {
    await this.record({
      actorId: payload.citizenId,
      actorType: 'CITIZEN',
      action: 'PAYMENT_DECLARED',
      entityType: 'Payment',
      entityId: payload.paymentId,
      after: {
        method: payload.method,
      },
    });
  }

  @OnEvent('settings.changed')
  async onSettingsChanged(payload: {
    actorId: string;
    actorRole: string;
    changed: string[];
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: 'SETTINGS_UPDATED',
      entityType: 'SystemSettings',
      after: {
        changed: payload.changed,
      },
    });
  }

  /**
   * A municipality's register replaced wholesale.
   *
   * `BackupService` has always emitted this and nothing has ever subscribed to
   * it, so the single most destructive action in the system — every citizen,
   * property and payment row deleted and rewritten from a file — left no trace
   * at all. The trail survives a restore by construction (it is excluded from
   * the snapshot and from the tables restore empties), which is what makes this
   * entry meaningful: it is written *into* the log that outlives the operation
   * it describes.
   */
  @OnEvent('backup.restored')
  async onRegisterRestored(payload: {
    actorId: string;
    actorRole: string;
    snapshotCreatedAt: string;
    written: Record<string, number>;
  }): Promise<void> {
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      action: 'REGISTER_RESTORED',
      entityType: 'Tenant',
      after: {
        // Which snapshot, and what landed — enough to reconcile the register
        // against the file afterwards without having kept the file.
        snapshotCreatedAt: payload.snapshotCreatedAt,
        written: payload.written,
      },
    });
  }

  @OnEvent('report.exported')
  async onExport(payload: {
    actorId: string;
    actorRole: string;
    actorEmail?: string;
    rowCount: number;
    filter: Record<string, unknown>;
  }): Promise<void> {
    // Bulk export is the highest-consequence action in the system: one click
    // turns a controlled dashboard into a spreadsheet on someone's laptop.
    await this.record({
      actorId: payload.actorId,
      actorType: 'STAFF',
      actorRole: payload.actorRole as never,
      actorEmail: payload.actorEmail,
      action: 'CSV_EXPORT',
      entityType: 'Registration',
      after: { rowCount: payload.rowCount, filter: payload.filter },
    });
  }

  /**
   * Its own cache namespace, separate from the dashboard's, and TTL-only
   * rather than event-invalidated: the trail is appended to on almost every
   * action here (including every login), so clearing it on write would
   * invalidate about as often as it's read. A short TTL is enough to absorb
   * repeated reads of the same page — reopening it, paginating back — without
   * the log ever needing to look perfectly live.
   */
  async query(query: AuditQuery): Promise<{ items: AuditRow[]; total: number }> {
    const key = this.cacheKey(query);
    const cached = await this.cache.get<{ items: AuditRow[]; total: number }>(key);
    if (cached) return cached;

    const result = await this.audit.query(query);
    const ttl = this.config.get<number>('AUDIT_CACHE_TTL_SECONDS') ?? 20;
    await this.cache.set(key, result, ttl);
    return result;
  }

  private cacheKey(query: AuditQuery): string {
    const parts = [
      query.actorId ?? 'ALL',
      query.entityType ?? 'ALL',
      query.entityId ?? 'ALL',
      query.from ? query.from.toISOString() : 'ALL',
      query.to ? query.to.toISOString() : 'ALL',
      query.limit,
      query.offset,
    ];
    return `audit:${this.tenantContext.tenantSlug}:query:${parts.join(':')}`;
  }

  /**
   * A failed audit write must not fail the action that triggered it — a citizen
   * losing their submission because a log row would not insert is the wrong
   * trade. It is logged loudly instead; a gap in the trail is an operational
   * alarm, not a user-facing error.
   */
  private async record(entry: Parameters<typeof AuditLogEntry.create>[0]): Promise<void> {
    /*
      Emitted from inside a transaction: written once it commits, and not at all
      if it rolls back. Written straight away through the transaction client, a
      row for an event near the end of the work reached the database after the
      commit and was refused — see `runInTenantTransaction`.
    */
    const transaction = this.tenantContext.peek()?.transaction;
    if (transaction) {
      transaction.afterCommit.push(() => this.write(entry));
      return;
    }
    await this.write(entry);
  }

  private async write(entry: Parameters<typeof AuditLogEntry.create>[0]): Promise<void> {
    try {
      await this.audit.append(AuditLogEntry.create(entry));
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED for ${entry.action} on ${entry.entityType}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
