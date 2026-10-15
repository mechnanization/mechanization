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
import { isUniqueViolationOn } from '../treasury/retry-key';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import {
  COMMISSION_RATE,
  cardsFiledOn,
  creditBillableUnits,
  municipalToday,
  payoutAllowance,
  payoutRefusal,
  TREASURY_ADMIN_ROLES,
  type InspectorPayoutItem,
  type InspectorProfileResponse,
  type InspectorPropertyBreakdown,
  type RecordInspectorPayoutInput,
  type RecordInspectorPayoutResult,
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

    /*
      Newest first, and a tie on `paidAt` broken by the row written last. Every
      payout recorded before go-live on one day carries that day's noon stamp
      (`payoutRequest`), so `paidAt` alone left their order, and the list's
      «آخر دفعة», to whatever Postgres's plan returned (review of PR #113). The
      payout history does not rely on this order: it sorts by when the money
      moved (`payoutHistory` in apps/frontend/lib/inspector-payouts.ts).
    */
    const payouts = await this.db.inspectorPayout.findMany({
      where: { inspectorId },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
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
      back into the wallet (0086). It stays in the history, marked, and leaves
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
   * there is no ledger yet for the money to leave, and `paidAt` may date it,
   * never after today. Once live the money must leave a wallet, or the day's
   * count comes up short by every commission paid (docs/finance.md §5.6): the
   * payout is paid now, from a dollar wallet the client names, as a «PV-»
   * voucher in «تعويضات المسح والجباية» written by
   * `ExpensesService.recordCommission`, and the payout row points at it.
   * Voucher, ledger entry, payout and both audit rows commit together or not
   * at all. Each path refuses the other's fields rather than quietly dropping
   * them.
   *
   * ## Whose it is (decision D9, the owner, 2026-10-10)
   *
   * A commission is paid like a salary (§5.8): decree 5595/1982 art. 35 names
   * salaries and wages among what may be paid before the order. Once live the
   * manager's payout is the order, and an accountant's is paid at once on the
   * urgent path with `COMMISSION_URGENT_REASON`, written by the server, and
   * waits for the manager's regularisation; the urgent ceiling does not hold
   * it back (`recordCommission`). Two refusals, both before any figure is read:
   *
   * - nobody but the manager pays himself (`COMMISSION_SELF_PAYOUT`): money
   *   that leaves before any order must not rest on the payee's word alone,
   *   the rule D8 set for a salary;
   * - before go-live the figure-only payout — no wallet and no voucher, so no
   *   order to wait for and nothing to regularise — stays the manager's
   *   (`INSPECTOR_PAYOUT_BEFORE_LIVE_MANAGER_ONLY`).
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
   * answers with it (`replayPayout`) — rather than reading a balance the first
   * already spent and refusing a payment that in fact went through. On both
   * paths: the key is kept on the payout row itself (0089), and once live on
   * its voucher too. Before 0089 a payout recorded before go-live kept no key,
   * so a press whose answer was lost, pressed again, recorded the figure twice
   * (review of 2026-10-11).
   *
   * ## The balance is judged last
   *
   * An accountant may not read an inspector's figures (`INSPECTOR_PROFILE_ROLES`).
   * So once live the allowance is checked after every other refusal, inside the
   * transaction that rolls the voucher back with it: no other refusal — a
   * missing, stopped or short wallet — can tell him whether an amount is within
   * what is owed, and the refusal itself names no figure to him
   * (`payoutRefusal`'s `showOwed`).
   */
  async recordInspectorPayout(request: {
    tenantSlug: string;
    inspectorId: string;
    payload: RecordInspectorPayoutInput;
    actor: { id: string; role: string };
  }): Promise<RecordInspectorPayoutResult> {
    /*
      One spelling of the inspector's id for everything below. The path's
      `ParseUUIDPipe` accepts an upper-cased UUID and passes it on as typed,
      and Postgres reads either spelling as the same row — but the self-payout
      check and the advisory lock key compare strings. «3F2A…» was another
      inspector to both: a second payout took another lock and spent the same
      balance again, and an accountant paid himself (review of 2026-10-11).
      Lower case is the form the database returns every id in.
    */
    const input = {
      ...request,
      inspectorId: request.inspectorId.toLowerCase(),
      actor: { ...request.actor, id: request.actor.id.toLowerCase() },
    };
    const ordersPayments = (TREASURY_ADMIN_ROLES as readonly string[]).includes(input.actor.role);
    if (!ordersPayments && input.inspectorId === input.actor.id) {
      throw new ForbiddenError({
        code: 'COMMISSION_SELF_PAYOUT',
        message: 'Staff cannot pay their own commission; the manager records it.',
      });
    }
    // Who may read the figure: `StaffController.getInspectorProfile`'s rule, the manager or the inspector himself.
    const showOwed = input.actor.role === 'SUPER_ADMIN' || input.actor.id === input.inspectorId;

    try {
      return await this.recordInspectorPayoutInTransaction(input, ordersPayments, showOwed);
    } catch (error) {
      /*
        Two presses carrying one key that met on a unique index rather than on
        the inspector's lock: the same key sent for two inspectors takes two
        locks, and both get past the lookup. The loser's transaction is gone.
        Answer it from the row the key wrote, read afresh, as if it had arrived
        a second later — never as a server error (`retry-key.ts`). A key that
        wrote some other form's voucher has no payout to answer with.
      */
      const key = input.payload.clientRequestId;
      if (key && isUniqueViolationOn(error, 'clientRequestId')) {
        const earlier = await payoutByKey(this.db as Prisma.TransactionClient, key);
        if (earlier) return replayPayout(earlier, input);
        throw new ConflictError({
          code: 'INSPECTOR_PAYOUT_REQUEST_REUSED',
          message: 'This request id already wrote another expense voucher.',
        });
      }
      throw error;
    }
  }

  /** The one transaction behind `recordInspectorPayout`, with the inspector's id already in its one spelling. */
  private async recordInspectorPayoutInTransaction(
    input: {
      tenantSlug: string;
      inspectorId: string;
      payload: RecordInspectorPayoutInput;
      actor: { id: string; role: string };
    },
    ordersPayments: boolean,
    showOwed: boolean,
  ): Promise<RecordInspectorPayoutResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const { payload } = input;

      /** What the inspector is owed, read under his lock. Refuses an id that is no staff account, or a deleted one. */
      const payeeProfile = async (): Promise<InspectorProfileResponse> => {
        // Throws NotFoundError for anything that is not a staff account.
        const profile = await this.getInspectorProfile(input.tenantSlug, input.inspectorId);
        // A deleted account was settled before it went (see `remove`); paying it now has no basis.
        if (await this.users.isStaffHidden(input.inspectorId)) {
          throw new ConflictError('هذا الحساب محذوف — استعده أولاً إن كان له مستحقات');
        }
        return profile;
      };
      /** Never more than is owed, with the figure only for a caller who may read it. */
      const refuseOverOwed = (profile: InspectorProfileResponse): void => {
        const allowance = payoutAllowance({ pendingBalance: profile.pendingBalance });
        const refusal = payoutRefusal(allowance, payload.amount, { showOwed });
        if (refusal) {
          throw new ValidationError(refusal);
        }
      };

      const lockKey = `${this.tenantContext.schemaName}:inspector-payout:${input.inspectorId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      // A retried press, on either path: answered with the payout its key wrote (`payoutByKey`).
      if (payload.clientRequestId) {
        const earlier = await payoutByKey(tx, payload.clientRequestId);
        if (earlier) return replayPayout(earlier, input);
      }

      // The settings row FOR SHARE before any wallet is named (`TreasuryLedgerService.lockAccounts`).
      const { goLiveAt } = await this.ledger.config(tx);
      if (!goLiveAt) {
        if (!ordersPayments) {
          throw new ForbiddenError({
            code: 'INSPECTOR_PAYOUT_BEFORE_LIVE_MANAGER_ONLY',
            message: 'Before the treasury is live a commission payout is recorded by the manager.',
          });
        }
        refuseOverOwed(await payeeProfile());
        return this.recordPayoutWithoutTreasury(tx, input);
      }

      if (!payload.accountId) {
        throw new ValidationError({
          code: 'INSPECTOR_PAYOUT_WALLET_REQUIRED',
          message: 'The treasury is live, so a payout must name the wallet it is paid from.',
        });
      }
      /*
        Paid now, as the voucher is. No other road pays a commission dated
        another day: the expense form refuses «تعويضات المسح والجباية»
        (`EXPENSE_CATEGORY_RESERVED`), since a voucher there with no payout row
        would leave the inspector owed what he was paid. Whether a commission
        may be back-dated once live is Undecided (docs/open-decisions.md §18).
      */
      if (payload.paidAt) {
        throw new ValidationError({
          code: 'INSPECTOR_PAYOUT_DATE_NOT_ALLOWED',
          message: 'With the treasury live a payout is dated today.',
        });
      }

      const profile = await payeeProfile();

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

      /*
        Last, so nothing else refused can say whether the amount is within what
        is owed (see above); the voucher and its ledger entry roll back with
        this refusal. `profile` was read under the inspector's lock and before
        this payout, so it is what was owed when the press arrived.
      */
      refuseOverOwed(profile);

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
          // On the payout as on its voucher, so one lookup answers a retry on either path (0089).
          clientRequestId: payload.clientRequestId ?? null,
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
          // Whether the order came with it, or it was paid on the urgent path and waits for one (D9).
          ordered: voucher.orderStatus === 'ORDERED',
        },
      });

      return { ...payoutItem(payout), replayed: false };
    });
  }

  /**
   * The payout as it was before the treasury: a row and its audit row, no
   * wallet and no voucher. Kept for a municipality that has not gone live,
   * where there is no ledger for the money to leave. The manager's alone, as
   * it always was (`recordInspectorPayout`).
   */
  private async recordPayoutWithoutTreasury(
    tx: Prisma.TransactionClient,
    input: {
      tenantSlug: string;
      inspectorId: string;
      payload: RecordInspectorPayoutInput;
      actor: { id: string; role: string };
    },
  ): Promise<RecordInspectorPayoutResult> {
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
    /*
      A payout is dated the day the cash was handed over, which has happened.
      Compared as the municipality's calendar days, as every treasury date is.
    */
    if (municipalToday(paidAt) > municipalToday()) {
      throw new ValidationError({
        code: 'INSPECTOR_PAYOUT_DATE_IN_FUTURE',
        message: 'A payout cannot be dated after today.',
      });
    }

    const payout = await tx.inspectorPayout.create({
      data: {
        inspectorId: input.inspectorId,
        amount: payload.amount,
        currency: payload.currency || 'USD',
        paidAt,
        // Trimmed as the live path stores them, so a retry's statement compares alike (`replayPayout`).
        note: payload.note?.trim() || null,
        reference: payload.reference?.trim() || null,
        recordedById: input.actor.id,
        /*
          The press's retry key (0089). There is no voucher to keep it before
          go-live, and without it a payout whose answer was lost, pressed
          again, was recorded twice: the inspector read as owed less than he
          was, with nothing to void (review of 2026-10-11).
        */
        clientRequestId: payload.clientRequestId ?? null,
      },
      include: PAYOUT_INCLUDE,
    });

    /*
      Tier 1, in the transaction, with the figures: the same row the live path
      writes, less the voucher. It used to be the `staff.changed` event, whose
      listener keeps only an email, a role and a list of changed fields — so
      the amount a payout lowered the inspector's balance by was in no audit
      row at all. Ids and figures only; the inspector is the entity.
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
        currency: payout.currency,
        paidAt: payout.paidAt.toISOString(),
      },
    });

    return { ...payoutItem(payout), replayed: false };
  }
}

/** A payout with what its history row shows: who recorded it, and the voucher that paid it. */
const PAYOUT_INCLUDE = {
  recordedBy: { select: { firstName: true, lastName: true } },
  expenseVoucher: {
    // `accountId` is not shown; `replayPayout` compares it.
    select: { id: true, voucherNumber: true, voidedAt: true, accountId: true, account: { select: { name: true } } },
  },
} satisfies Prisma.InspectorPayoutInclude;

type PayoutRow = Prisma.InspectorPayoutGetPayload<{ include: typeof PAYOUT_INCLUDE }>;

/**
 * The payout a retry key wrote, if any: on the payout row since 0089, on both
 * paths, and on its voucher once the treasury is live — the only place a live
 * payout written before 0089 keeps it.
 */
function payoutByKey(tx: Prisma.TransactionClient, clientRequestId: string): Promise<PayoutRow | null> {
  return tx.inspectorPayout.findFirst({
    where: { OR: [{ clientRequestId }, { expenseVoucher: { clientRequestId } }] },
    include: PAYOUT_INCLUDE,
  });
}

/**
 * The answer to a press whose `clientRequestId` already paid a commission.
 *
 * A key names one act, as an expense voucher's does (`ExpensesService.replayVoucher`):
 * this officer paying this inspector this amount, for this statement — and,
 * when a voucher paid it, out of this wallet. Replayed with all of them it
 * answers with the first payout, marked `replayed`. Anything else is a new act
 * under an old key and is refused (`TREASURY_REQUEST_KEY_REUSED`), rather than
 * answered with a payout the officer did not ask for. The paper reference and
 * the date are not compared: a retry is the same payment, and the payout keeps
 * what it was first recorded with.
 *
 * A payout recorded before go-live left no wallet, so none is compared: if the
 * treasury went live between the lost press and its retry, the dialog now names
 * a wallet, and the answer is still the figure the first press recorded — the
 * inspector was paid once, before the books opened.
 *
 * A payout whose voucher was cancelled since is not answered as made
 * (`EXPENSE_ALREADY_VOID`): the officer would read «صُرفت» and hand over cash
 * the register shows as returned, which the inspector is owed again.
 */
function replayPayout(
  earlier: PayoutRow,
  input: { inspectorId: string; payload: RecordInspectorPayoutInput; actor: { id: string } },
): RecordInspectorPayoutResult {
  const { payload } = input;
  if (earlier.inspectorId !== input.inspectorId) {
    throw new ConflictError({
      code: 'INSPECTOR_PAYOUT_REQUEST_REUSED',
      message: 'This request id already paid another inspector.',
    });
  }
  const voucher = earlier.expenseVoucher;
  if (
    !earlier.amount.equals(new Prisma.Decimal(payload.amount)) ||
    (voucher !== null && voucher.accountId !== payload.accountId) ||
    earlier.recordedById !== input.actor.id ||
    earlier.note !== (payload.note?.trim() || null)
  ) {
    throw new ConflictError({
      code: 'TREASURY_REQUEST_KEY_REUSED',
      message: 'This request id was already used for a different payout.',
    });
  }
  if (voucher?.voidedAt) {
    throw new ConflictError({
      code: 'EXPENSE_ALREADY_VOID',
      message: `This request was paid as ${voucher.voucherNumber}, and that voucher has since been cancelled.`,
      params: { voucherNumber: voucher.voucherNumber },
    });
  }
  return { ...payoutItem(earlier), replayed: true };
}

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
