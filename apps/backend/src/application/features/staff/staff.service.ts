import { citizenDisplayName } from '@mechanization/shared-schemas';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PASSWORD_HASHER,
  TOTP_SERVICE,
  USER_REPOSITORY,
} from '../../../domain/interfaces/base-repository.interface';
import {
  PasswordHasher,
  TotpService,
} from '../../../domain/interfaces/otp-repository.interface';
import {
  DeletedStaffSummary,
  StaffSummary,
  UserRepository,
} from '../../../domain/interfaces/user-repository.interface';
import { StaffRole } from '../../../domain/entities/user.entity';
import { IdentityService } from '../identity/identity.service';
import { SessionRevocationService } from '../identity/session-revocation.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { Prisma } from '../../../generated/tenant-client';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from '../treasury/expenses.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import {
  COMMISSION_RATE,
  cardsFiledOn,
  creditBillableUnits,
  payoutAllowance,
  payoutRefusal,
  type InspectorPayoutItem,
  type InspectorProfileResponse,
  type InspectorPropertyBreakdown,
  type RecordInspectorPayoutInput,
} from '@mechanization/shared-schemas';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../common/exceptions';

/**
 * Staff accounts, managed by a SUPER_ADMIN.
 *
 * Two rules here are the whole point of the feature, and neither belongs in a
 * controller:
 *
 *  1. Nothing erases a staff row. It is referenced by every audit entry they
 *     wrote and every registration they reviewed, so erasing it would strip
 *     the name off a decision the municipality may later have to answer for.
 *     A super admin's "delete" hides the account: off the list, signed out,
 *     never able to sign in — and restorable.
 *  2. An inspector still owed commission is not deleted until paid out: the
 *     card and payout link the debt is settled from leave with the account.
 */
@Injectable()
export class StaffService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOTP_SERVICE) private readonly totp: TotpService,
    private readonly tenantContext: TenantContextService,
    private readonly revocation: SessionRevocationService,
    private readonly identity: IdentityService,
    private readonly events: EventEmitter2,
    private readonly expenses: ExpensesService,
    private readonly ledger: TreasuryLedgerService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /** The accounts a super admin has deleted — the list a restore is made from. */
  listDeleted(): Promise<DeletedStaffSummary[]> {
    return this.users.listDeletedStaff();
  }

  /**
   * Brings a deleted account back onto the staff list. Still disabled: the
   * person signs in again only once someone re-enables them, a decision of its
   * own. While deleted, the account keeps its email reserved — a new account
   * cannot take it, so the restore path stays open.
   */
  async restore(input: { tenantSlug: string; id: string; actor: { id: string; role: string } }): Promise<void> {
    const target = await this.users.findById(input.id);
    if (!target || target.kind !== 'STAFF' || !(await this.users.isStaffHidden(input.id))) {
      throw new NotFoundError('Deleted staff user', input.id);
    }
    await this.users.restoreStaff(input.id);
    this.events.emit('staff.changed', {
      action: 'STAFF_RESTORED',
      tenantSlug: input.tenantSlug,
      staffId: input.id,
      role: target.role ?? undefined,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /** Every staff account that has not been deleted, deactivated ones included. */
  list(options: { includeDeletedEarners?: boolean } = {}): Promise<StaffSummary[]> {
    return this.users.listStaff(options);
  }

  async create(input: {
    tenantSlug: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: StaffRole;
    actor: { id: string; role: string };
  }): Promise<{ id: string; totp?: { secret: string; keyUri: string } }> {
    const passwordHash = await this.hasher.hash(input.password);
    const id = await this.users.createStaff({
      tenantSlug: input.tenantSlug,
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
    });

    /**
     * A SUPER_ADMIN is enrolled at creation, not at first sign-in.
     *
     * `IdentityService` refuses a session to that role until enrolment is
     * complete, so an account created without a secret could never sign in —
     * and could not reach the enrolment endpoint either, which is itself behind
     * a session. Issuing the secret here is what keeps that from being a
     * deadlock: the inviting administrator receives it once, in this response,
     * and hands it over with the password.
     *
     * Confirmed immediately rather than after the invitee proves a code,
     * because the person who would prove it cannot sign in to do so. That is a
     * real trade — the secret exists before anyone has scanned it — and the
     * reason `pnpm staff:create --reset-totp` exists: a secret that never
     * reached its owner is reissued rather than leaving the account stranded.
     */
    const totp = input.role === 'SUPER_ADMIN' ? await this.enrolTotp(id) : undefined;


    this.events.emit('staff.changed', {
      action: 'STAFF_CREATED',
      tenantSlug: input.tenantSlug,
      staffId: id,
      email: input.email,
      role: input.role,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return { id, ...(totp ? { totp } : {}) };
  }

  /**
   * Issues and confirms a second factor for one staff account, returning what
   * the authenticator app needs. Shared by `create` and the `staff:create
   * --reset-totp` CLI, so both produce an account in the same state.
   */
  async enrolTotp(staffId: string): Promise<{ secret: string; keyUri: string }> {
    const user = await this.users.findById(staffId);
    // A deleted account gets no new second factor: restore it first, deliberately.
    if (!user || user.kind !== 'STAFF' || (await this.users.isStaffHidden(staffId))) {
      throw new NotFoundError('Staff user', staffId);
    }

    const secret = this.totp.generateSecret();
    await this.users.saveTotpSecret(staffId, secret);
    await this.users.confirmTotp(staffId);

    return {
      secret,
      keyUri: this.totp.keyUri(secret, user.email ?? staffId, `Baladiya ${user.tenantSlug}`),
    };
  }

  async update(input: {
    tenantSlug: string;
    id: string;
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    role?: StaffRole;
    actor: { id: string; role: string };
  }): Promise<void> {
    const target = await this.users.findById(input.id);
    if (!target || target.kind !== 'STAFF' || (await this.users.isStaffHidden(input.id))) {
      throw new NotFoundError('Staff user', input.id);
    }

    // Demoting yourself out of SUPER_ADMIN can leave a municipality with no
    // one able to manage accounts at all — including no one able to undo it.
    if (input.id === input.actor.id && input.role && input.role !== 'SUPER_ADMIN') {
      throw new ForbiddenError('لا يمكنك تغيير صلاحيتك الخاصة');
    }

    await this.users.updateStaff(input.id, {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      ...(input.password ? { passwordHash: await this.hasher.hash(input.password) } : {}),
    });

    // A role or password change bumps `tokenVersion` in the repository; drop
    // the cached copy so the sessions it just revoked stop working now.
    if (input.role || input.password) {
      await this.revocation.forget(input.id);
    }


    this.events.emit('staff.changed', {
      action: 'STAFF_UPDATED',
      tenantSlug: input.tenantSlug,
      staffId: input.id,
      // Never the new password, hashed or otherwise — the audit trail records
      // that a credential changed, not what it changed to.
      changed: Object.keys({
        ...(input.email ? { email: true } : {}),
        ...(input.firstName ? { firstName: true } : {}),
        ...(input.lastName ? { lastName: true } : {}),
        ...(input.role ? { role: true } : {}),
        ...(input.password ? { password: true } : {}),
      }),
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /** The ordinary delete: the account stops working, the record stays whole. */
  async setActive(input: {
    tenantSlug: string;
    id: string;
    isActive: boolean;
    actor: { id: string; role: string };
  }): Promise<void> {
    const target = await this.users.findById(input.id);
    if (!target || target.kind !== 'STAFF' || (await this.users.isStaffHidden(input.id))) {
      throw new NotFoundError('Staff user', input.id);
    }

    // Locking yourself out is not a decision worth honouring at 2am.
    if (input.id === input.actor.id && !input.isActive) {
      throw new ForbiddenError('لا يمكنك إلغاء تفعيل حسابك الخاص');
    }

    await this.users.setStaffActive(input.id, input.isActive);
    // The repository has bumped `tokenVersion`; this drops the cached copy so
    // the revocation takes effect now rather than at the end of its TTL.
    await this.revocation.forget(input.id);


    this.events.emit('staff.changed', {
      action: input.isActive ? 'STAFF_REACTIVATED' : 'STAFF_DEACTIVATED',
      tenantSlug: input.tenantSlug,
      staffId: input.id,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /**
   * «حذف موظف», for a super admin: hides the account, never removes it.
   *
   * A staff member's id is on what they did — registrations reviewed, payments
   * recorded (held by a RESTRICT key), receipts issued, the audit trail — so the
   * row stays, with its name and details, and those records keep reading back
   * to the person. The account leaves the staff list and can never sign in
   * again (`hideStaff`), and any open session ends now. Nobody deletes their
   * own account.
   */
  async remove(input: {
    tenantSlug: string;
    id: string;
    actor: { id: string; role: string };
  }): Promise<void> {
    const target = await this.users.findById(input.id);
    if (!target || target.kind !== 'STAFF' || (await this.users.isStaffHidden(input.id))) {
      throw new NotFoundError('Staff user', input.id);
    }

    if (input.id === input.actor.id) {
      throw new ForbiddenError('لا يمكنك حذف حسابك الخاص');
    }

    /*
      Nobody still owed commission is deleted, whatever their role: earnings
      accrue to anyone who filed records (the roster lists every such account,
      not only inspectors), and a role change must not open a way around this.
      The deleted leave the payout screens' actions, so the debt is settled
      first, then the account goes.
    */
    const { pendingBalance } = await this.getInspectorProfile(input.tenantSlug, input.id);
    if (pendingBalance > 0) {
      throw new ConflictError(
        `لا يمكن حذف هذا الحساب: له عمولات مستحقة بقيمة ${pendingBalance.toFixed(2)} $ لم تُدفع بعد. سدّدها من «الأرباح والدفعات» ثم احذفه`,
      );
    }

    await this.users.hideStaff(input.id);
    // As on deactivation: the cached session goes now, not at its TTL.
    await this.revocation.forget(input.id);

    this.events.emit('staff.changed', {
      action: 'STAFF_DELETED',
      tenantSlug: input.tenantSlug,
      staffId: input.id,
      role: target.role ?? undefined,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /**
   * Change own password. Verifies current password first.
   */
  async changePassword(input: {
    tenantSlug: string;
    staffId: string;
    currentPassword: string;
    newPassword: string;
    actor: { id: string; role: string };
  }): Promise<void> {
    const target = await this.users.findById(input.staffId);
    if (!target || target.kind !== 'STAFF' || !target.passwordHash) {
      throw new NotFoundError('Staff user', input.staffId);
    }

    const match = await this.hasher.verify(input.currentPassword, target.passwordHash);
    if (!match) {
      throw new UnauthorizedError('كلمة المرور الحالية غير صحيحة');
    }

    const passwordHash = await this.hasher.hash(input.newPassword);
    await this.users.updateStaff(input.staffId, { passwordHash });

    await this.revocation.forget(input.staffId);

    this.events.emit('staff.changed', {
      action: 'STAFF_PASSWORD_CHANGED',
      tenantSlug: input.tenantSlug,
      staffId: input.staffId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /**
   * Change own email. Verifies current password first and ensures new email is not taken.
   */
  async changeEmail(input: {
    tenantSlug: string;
    staffId: string;
    newEmail: string;
    currentPassword: string;
    actor: { id: string; role: string };
  }): Promise<{ email: string }> {
    const target = await this.users.findById(input.staffId);
    if (!target || target.kind !== 'STAFF' || !target.passwordHash) {
      throw new NotFoundError('Staff user', input.staffId);
    }

    const match = await this.hasher.verify(input.currentPassword, target.passwordHash);
    if (!match) {
      throw new UnauthorizedError('كلمة المرور الحالية غير صحيحة');
    }

    const nextEmail = input.newEmail.trim().toLowerCase();
    if (nextEmail === target.email?.toLowerCase()) {
      return { email: nextEmail };
    }

    const existing = await this.users.findStaffByEmail(nextEmail);
    if (existing) {
      throw new ConflictError('البريد الإلكتروني مستخدم بالفعل من قبل موظف آخر');
    }

    await this.users.updateStaff(input.staffId, { email: nextEmail });

    this.events.emit('staff.changed', {
      action: 'STAFF_EMAIL_CHANGED',
      tenantSlug: input.tenantSlug,
      staffId: input.staffId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return { email: nextEmail };
  }

  async sendPasswordResetEmail(input: {
    staffId: string;
    redirectTo?: string;
  }): Promise<{ message: string }> {
    const user = await this.users.findById(input.staffId);
    if (!user || !user.email || user.kind !== 'STAFF' || (await this.users.isStaffHidden(input.staffId))) {
      throw new NotFoundError('Staff user', input.staffId);
    }
    // One implementation, in IdentityService: the link is a signed token tied
    // to this account's tokenVersion, and duplicating that here would be two
    // places to get single-use and expiry right.
    return this.identity.sendStaffPasswordResetEmail(input.staffId, input.redirectTo);
  }

  /**
   * Field Inspector dashboard performance & commission earnings.
   *
   * Earnings are $1 per distinct unit filed — `creditBillableUnits` owns that
   * rule, and the roster in `listStaff` calls the same function, because this
   * figure and the roster's used to be two copies of one loop.
   *
   * The breakdown below is a different question and keeps its own arithmetic:
   * it describes every property type this inspector surveyed, land and tents
   * included, and the card that renders it says so. Work that earns nothing is
   * still work, and hiding it would make the page a worse record of what the
   * officer actually did.
   */
  async getInspectorProfile(tenantSlug: string, inspectorId: string): Promise<InspectorProfileResponse> {
    const inspector = await this.db.user.findFirst({
      where: { id: inspectorId, kind: 'STAFF' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (!inspector) {
      throw new NotFoundError('Staff user', inspectorId);
    }

    const registrations = await this.db.registration.findMany({
      where: { createdById: inspectorId },
      orderBy: { submittedAt: 'desc' },
      include: {
        citizen: {
          select: {
            id: true,
            firstName: true,
            middleName: true,
            lastName: true,
            residence: true,
          },
        },
        properties: {
          include: {
            units: true,
          },
        },
        // Cards filed here that a merge has since moved onto another
        // registration. Still this officer's work — see `cardsFiledOn`.
        movedCards: {
          include: {
            units: true,
          },
        },
      },
    });

    const payouts = await this.db.inspectorPayout.findMany({
      where: { inspectorId },
      orderBy: { paidAt: 'desc' },
      include: PAYOUT_INCLUDE,
    });

    const breakdown: InspectorPropertyBreakdown = {
      houses: 0,
      apartments: 0,
      buildings: 0,
      lands: 0,
      tents: 0,
      commercial: 0,
      other: 0,
      totalUnits: 0,
    };

    /*
      Oldest first, which is not the order this list is rendered in.

      Deduplication has to credit *somebody* for a flat that carries two
      records, and crediting whoever filed first is the only choice that does
      not move an inspector's total when an unrelated record is added months
      later. `registrations` arrives newest-first for display, so the credit
      pass walks its own copy and the map carries the answer back.
    */
    const seenUnits = new Set<string>();
    const creditedByRegistration = new Map<string, number>();
    for (const reg of [...registrations].sort(
      (a, b) => a.submittedAt.getTime() - b.submittedAt.getTime(),
    )) {
      creditedByRegistration.set(reg.id, creditBillableUnits(cardsFiledOn(reg), seenUnits));
    }
    const totalProperties = seenUnits.size;

    const recentRegistrations = registrations.map((reg) => {
      // What this record added to the total — zero when every flat on it was
      // already credited to an earlier record, which is the honest figure to
      // show beside it.
      const regPropertyCount = creditedByRegistration.get(reg.id) ?? 0;
      const neighborhoods = new Set<string>();
      const propNums = new Set<string>();
      const propTypes = new Set<string>();

      for (const p of cardsFiledOn(reg)) {
        if (p.neighborhood) neighborhoods.add(p.neighborhood);
        if (p.propertyNumber) propNums.add(p.propertyNumber);
        if (p.propertyType) propTypes.add(p.propertyType);

        if (p.propertyType === 'BUILDING' && p.units && p.units.length > 0) {
          breakdown.buildings++;
          for (const u of p.units) {
            if (u.unitType) propTypes.add(u.unitType);
            if (u.unitType === 'APARTMENT') {
              breakdown.apartments++;
            } else if (u.unitType === 'INDEPENDENT_HOUSE') {
              breakdown.houses++;
            } else if (u.unitType && ['SHOP', 'OFFICE', 'CLINIC', 'WAREHOUSE'].includes(u.unitType)) {
              breakdown.commercial++;
            } else {
              breakdown.other++;
            }
            breakdown.totalUnits++;
          }
        } else {
          if (p.propertyType === 'HOUSE' || p.unitType === 'INDEPENDENT_HOUSE') {
            breakdown.houses++;
          } else if (p.unitType === 'APARTMENT') {
            breakdown.apartments++;
          } else if (p.propertyType === 'BUILDING') {
            breakdown.buildings++;
          } else if (p.propertyType === 'LAND') {
            breakdown.lands++;
          } else if (p.propertyType === 'TENT') {
            breakdown.tents++;
          } else if (['SHOP', 'OFFICE', 'CLINIC', 'WAREHOUSE'].includes(p.unitType ?? '')) {
            breakdown.commercial++;
          } else {
            breakdown.other++;
          }
        }
      }

      // «ورثة المرحوم …» for an estate (0076).
      const citizenName = reg.citizen ? citizenDisplayName(reg.citizen) || 'مواطن' : 'مواطن';

      return {
        registrationId: reg.id,
        citizenId: reg.citizenId,
        citizenName: citizenName || 'مواطن',
        referenceNumber: reg.referenceNumber,
        submittedAt: reg.submittedAt.toISOString(),
        status: reg.status,
        propertyCount: regPropertyCount,
        neighborhoods: Array.from(neighborhoods),
        propertyNumbers: Array.from(propNums),
        propertyTypes: Array.from(propTypes),
        commissionEarned: regPropertyCount * COMMISSION_RATE,
      };
    });

    const distinctCitizenIds = new Set(registrations.map((r) => r.citizenId));
    const totalCitizens = distinctCitizenIds.size;

    const commissionRate = COMMISSION_RATE;
    const totalEarnings = totalProperties * commissionRate;
    /*
      A payout whose voucher was cancelled is not money paid: the void put it
      back into the wallet (0083). It stays in the history, marked, and leaves
      the sum — the same filter `UserRepository.listStaff` puts in its query,
      so the roster and this page agree on what is owed.
    */
    const paidBalance = payouts
      .filter((p) => !p.expenseVoucher?.voidedAt)
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const pendingBalance = Math.max(0, totalEarnings - paidBalance);
    /*
      The other side of that clamp, which used to be nowhere.

      `pendingBalance` must not go negative — the payout rule reads it as "the
      most that may still be paid" — but an inspector paid more than he earned
      then read as settled, which is the one balance nobody would want hidden.
      It arises without anyone erring: a record corrected away after its payout
      lowers the total underneath money already handed over.
    */
    const overpaidBalance = Math.max(0, paidBalance - totalEarnings);

    const formattedPayouts: InspectorPayoutItem[] = payouts.map(payoutItem);

    return {
      inspector: {
        id: inspector.id,
        name: `${inspector.firstName} ${inspector.lastName}`.trim(),
        email: inspector.email,
        role: inspector.role as any,
        isActive: inspector.isActive,
        createdAt: inspector.createdAt.toISOString(),
        lastLoginAt: inspector.lastLoginAt ? inspector.lastLoginAt.toISOString() : null,
      },
      totalCitizens,
      totalProperties,
      commissionRate,
      totalEarnings,
      paidBalance,
      pendingBalance,
      overpaidBalance,
      breakdown,
      recentRegistrations,
      payouts: formattedPayouts,
    };
  }

  /**
   * «صرف عمولة» — a commission payment to a field inspector.
   *
   * Refused unless `payoutAllowance` accepts it: never more than is still
   * owed. The figures are the ones the inspector's dashboard shows, read
   * through the same method, so the refusal and the screen cannot disagree
   * about what is owed.
   *
   * ## Two paths, chosen by the treasury, never by the client
   *
   * Before go-live a payout is a figure and nothing else, as it always was —
   * there is no ledger yet for the money to leave, and `paidAt` may date it.
   * Once live the money must leave a wallet, or the day's count comes up short
   * by every commission paid (docs/finance.md §5.6): the payout is paid now,
   * from a dollar wallet the client names, as a «PV-» voucher in «تعويضات
   * المسح والجباية» written by `ExpensesService.recordCommission`, and the
   * payout row points at it. Voucher, ledger entry, payout and both audit rows
   * commit together or not at all. Each path refuses the other's fields rather
   * than quietly dropping them.
   *
   * ## Why the inspector is locked
   *
   * «what is owed» is read and then paid. Two payouts to one inspector at once
   * would both read the same balance and both pass, and he would be paid twice
   * what he earned. A transaction-scoped advisory lock on his id makes the
   * second wait for the first to commit, and then read what is left. The key
   * names the schema, so two municipalities never wait on each other.
   *
   * The same lock is what makes a retried press safe: the second request for a
   * `clientRequestId` waits here, then finds the payout the first wrote and
   * returns it — rather than reading a balance the first already spent and
   * refusing a payment that in fact went through.
   */
  async recordInspectorPayout(input: {
    tenantSlug: string;
    inspectorId: string;
    payload: RecordInspectorPayoutInput;
    actor: { id: string; role: string };
  }): Promise<InspectorPayoutItem> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const { payload } = input;

      const lockKey = `${this.tenantContext.schemaName}:inspector-payout:${input.inspectorId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      if (payload.clientRequestId) {
        const earlier = await tx.inspectorPayout.findFirst({
          where: { expenseVoucher: { clientRequestId: payload.clientRequestId } },
          include: PAYOUT_INCLUDE,
        });
        if (earlier) {
          if (earlier.inspectorId !== input.inspectorId) {
            throw new ConflictError({
              code: 'INSPECTOR_PAYOUT_REQUEST_REUSED',
              message: 'This request id already paid another inspector.',
            });
          }
          return payoutItem(earlier);
        }
      }

      // Throws NotFoundError for anything that is not a staff account.
      const profile = await this.getInspectorProfile(input.tenantSlug, input.inspectorId);
      // A deleted account was settled before it went (see `remove`); paying it now has no basis.
      if (await this.users.isStaffHidden(input.inspectorId)) {
        throw new ConflictError('هذا الحساب محذوف — استعده أولاً إن كان له مستحقات');
      }

      const refusal = payoutRefusal(
        payoutAllowance({ pendingBalance: profile.pendingBalance }),
        payload.amount,
      );
      if (refusal) {
        throw new ValidationError(refusal);
      }

      const { goLiveAt } = await this.ledger.config(tx);
      if (!goLiveAt) {
        return this.recordPayoutWithoutTreasury(tx, input);
      }

      if (!payload.accountId) {
        throw new ValidationError({
          code: 'INSPECTOR_PAYOUT_WALLET_REQUIRED',
          message: 'The treasury is live, so a payout must name the wallet it is paid from.',
        });
      }
      // Paid now, as the voucher is; a commission paid on another day is an expense-form job.
      if (payload.paidAt) {
        throw new ValidationError({
          code: 'INSPECTOR_PAYOUT_DATE_NOT_ALLOWED',
          message: 'With the treasury live a payout is dated today.',
        });
      }
      /*
        Earnings are counted in dollars, so a payout that left a ليرة wallet
        would be summed as dollars against them. An unknown or stopped wallet
        is left to `recordVoucher`, which refuses it with its own code.
      */
      const wallet = await tx.treasuryAccount.findFirst({
        where: { id: payload.accountId, active: true },
        select: { currency: true },
      });
      if (wallet && wallet.currency !== 'USD') {
        throw new ValidationError({
          code: 'INSPECTOR_PAYOUT_WALLET_NOT_USD',
          message: 'Commissions are paid from a US dollar wallet.',
          params: { currency: wallet.currency },
        });
      }

      const voucher = await this.expenses.recordCommission(
        { id: profile.inspector.id, name: profile.inspector.name },
        {
          accountId: payload.accountId,
          amount: payload.amount,
          description: payload.note,
          invoiceNumber: payload.reference,
          clientRequestId: payload.clientRequestId,
        },
        input.actor,
      );
      /*
        The payout replay above found nothing for this key, so a voucher that
        answers as a replay was written by some other form under the same key.
        Linking a payout to it would book that money as commission.
      */
      if (voucher.replayed) {
        throw new ConflictError({
          code: 'INSPECTOR_PAYOUT_REQUEST_REUSED',
          message: 'This request id already wrote another expense voucher.',
        });
      }

      const { occurredAt } = await tx.expenseVoucher.findUniqueOrThrow({
        where: { id: voucher.id },
        select: { occurredAt: true },
      });

      const payout = await tx.inspectorPayout.create({
        data: {
          inspectorId: input.inspectorId,
          amount: new Prisma.Decimal(payload.amount),
          currency: voucher.currency,
          paidAt: occurredAt,
          note: payload.note?.trim() || null,
          reference: payload.reference?.trim() || null,
          recordedById: input.actor.id,
          expenseVoucherId: voucher.id,
        },
        include: PAYOUT_INCLUDE,
      });

      /*
        Tier 1, in the transaction, beside the voucher's own EXPENSE_RECORDED
        row: that one says money left a wallet, this one says whom it paid.
        Ids and figures only; the inspector is the entity.
      */
      await this.audit.recordInTransaction({
        actorId: input.actor.id,
        actorType: 'STAFF',
        actorRole: input.actor.role as never,
        action: 'INSPECTOR_PAYOUT_RECORDED',
        entityType: 'User',
        entityId: input.inspectorId,
        after: {
          payoutId: payout.id,
          amount: payload.amount,
          currency: voucher.currency,
          voucherId: voucher.id,
          voucherNumber: voucher.voucherNumber,
          accountId: payload.accountId,
        },
      });

      return payoutItem(payout);
    });
  }

  /**
   * The payout as it was before the treasury: a row and its audit event, no
   * wallet and no voucher. Kept for a municipality that has not gone live,
   * where there is no ledger for the money to leave.
   */
  private async recordPayoutWithoutTreasury(
    tx: Prisma.TransactionClient,
    input: {
      tenantSlug: string;
      inspectorId: string;
      payload: RecordInspectorPayoutInput;
      actor: { id: string; role: string };
    },
  ): Promise<InspectorPayoutItem> {
    const { payload } = input;
    if (payload.accountId) {
      throw new ConflictError({
        code: 'TREASURY_NOT_ACTIVE',
        message: 'The treasury is not active, so no wallet can pay this payout yet.',
      });
    }

    const paidAt = payload.paidAt ? new Date(payload.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new ValidationError('تاريخ الدفع غير صالح.');
    }

    const payout = await tx.inspectorPayout.create({
      data: {
        inspectorId: input.inspectorId,
        amount: payload.amount,
        currency: payload.currency || 'USD',
        paidAt,
        note: payload.note ?? null,
        reference: payload.reference ?? null,
        recordedById: input.actor.id,
      },
      include: PAYOUT_INCLUDE,
    });

    // Its audit row is written once the transaction commits (`runInTenantTransaction`).
    this.events.emit('staff.changed', {
      action: 'INSPECTOR_PAYOUT_RECORDED',
      tenantSlug: input.tenantSlug,
      staffId: input.inspectorId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      amount: payload.amount,
    });

    return payoutItem(payout);
  }
}

/** A payout with what its history row shows: who recorded it, and the voucher that paid it. */
const PAYOUT_INCLUDE = {
  recordedBy: { select: { firstName: true, lastName: true } },
  expenseVoucher: {
    select: { id: true, voucherNumber: true, voidedAt: true, account: { select: { name: true } } },
  },
} satisfies Prisma.InspectorPayoutInclude;

type PayoutRow = Prisma.InspectorPayoutGetPayload<{ include: typeof PAYOUT_INCLUDE }>;

function payoutItem(p: PayoutRow): InspectorPayoutItem {
  return {
    id: p.id,
    amount: Number(p.amount),
    currency: p.currency,
    paidAt: p.paidAt.toISOString(),
    note: p.note,
    reference: p.reference,
    recordedByName: p.recordedBy ? `${p.recordedBy.firstName} ${p.recordedBy.lastName}`.trim() : null,
    createdAt: p.createdAt.toISOString(),
    voucher: p.expenseVoucher
      ? {
          id: p.expenseVoucher.id,
          voucherNumber: p.expenseVoucher.voucherNumber,
          accountName: p.expenseVoucher.account.name,
          voided: p.expenseVoucher.voidedAt !== null,
        }
      : null,
  };
}
