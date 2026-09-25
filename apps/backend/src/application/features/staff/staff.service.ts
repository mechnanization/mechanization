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
  StaffSummary,
  UserRepository,
} from '../../../domain/interfaces/user-repository.interface';
import { StaffRole } from '../../../domain/entities/user.entity';
import { IdentityService } from '../identity/identity.service';
import { SessionRevocationService } from '../identity/session-revocation.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import {
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
 *  1. Deactivation is the ordinary "delete". A staff row is referenced by
 *     every audit entry they wrote and every registration they reviewed, so
 *     erasing it would strip the name off a decision the municipality may
 *     later have to answer for.
 *  2. A permanent delete is offered only for an account with no such history —
 *     a mistyped invitation, a colleague who never signed in — where there is
 *     nothing to orphan.
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
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Every staff account, each with the history count that decides whether a
   * permanent delete may be offered.
   */
  list(): Promise<StaffSummary[]> {
    return this.users.listStaff();
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
    if (!user || user.kind !== 'STAFF') {
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
    if (!target || target.kind !== 'STAFF') {
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
    if (!target || target.kind !== 'STAFF') {
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
   * Erases the row. Refused the moment the account has done anything, which
   * is checked here rather than trusted from the client: the list endpoint
   * reports a history count so the button can be hidden, but hiding a button
   * is not what stops the request.
   */
  async remove(input: {
    tenantSlug: string;
    id: string;
    actor: { id: string; role: string };
  }): Promise<void> {
    const target = await this.users.findById(input.id);
    if (!target || target.kind !== 'STAFF') {
      throw new NotFoundError('Staff user', input.id);
    }

    if (input.id === input.actor.id) {
      throw new ForbiddenError('لا يمكنك حذف حسابك الخاص');
    }

    const history = await this.users.countStaffHistory(input.id);
    if (history > 0) {
      throw new ConflictError(
        'لا يمكن حذف هذا الحساب نهائياً لأن له سجل نشاطات — يمكنك إلغاء تفعيله بدلاً من ذلك',
      );
    }

    await this.users.hardDeleteStaff(input.id);


    this.events.emit('staff.changed', {
      action: 'STAFF_DELETED',
      tenantSlug: input.tenantSlug,
      staffId: input.id,
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
    if (!user || !user.email) {
      throw new NotFoundError('Staff user', input.staffId);
    }
    // One implementation, in IdentityService: the link is a signed token tied
    // to this account's tokenVersion, and duplicating that here would be two
    // places to get single-use and expiry right.
    return this.identity.sendStaffPasswordResetEmail(input.staffId, input.redirectTo);
  }

  /**
   * Field Inspector dashboard performance & commission earnings.
   * Calculates total registered properties ($1/property), property type breakdown,
   * paid balance from recorded payouts, and pending balance.
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
          },
        },
        properties: {
          include: {
            units: true,
          },
        },
      },
    });

    const payouts = await this.db.inspectorPayout.findMany({
      where: { inspectorId },
      orderBy: { paidAt: 'desc' },
      include: {
        recordedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
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

    let totalProperties = 0;

    const recentRegistrations = registrations.map((reg) => {
      let regPropertyCount = 0;
      const neighborhoods = new Set<string>();
      const propNums = new Set<string>();
      const propTypes = new Set<string>();

      for (const p of reg.properties) {
        if (p.neighborhood) neighborhoods.add(p.neighborhood);
        if (p.propertyNumber) propNums.add(p.propertyNumber);
        if (p.propertyType) propTypes.add(p.propertyType);

        if (p.propertyType === 'BUILDING' && p.units && p.units.length > 0) {
          regPropertyCount += p.units.length;
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
          regPropertyCount += 1;
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

      totalProperties += regPropertyCount;

      const citizenName = reg.citizen
        ? [reg.citizen.firstName, reg.citizen.middleName, reg.citizen.lastName]
            .filter(Boolean)
            .join(' ')
            .trim()
        : 'مواطن';

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
        commissionEarned: regPropertyCount * 1.0,
      };
    });

    const distinctCitizenIds = new Set(registrations.map((r) => r.citizenId));
    const totalCitizens = distinctCitizenIds.size;

    const commissionRate = 1.0;
    const totalEarnings = totalProperties * commissionRate;
    const paidBalance = payouts.reduce((sum, p) => sum + Number(p.amount), 0);
    const pendingBalance = Math.max(0, totalEarnings - paidBalance);

    const formattedPayouts: InspectorPayoutItem[] = payouts.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      currency: p.currency,
      paidAt: p.paidAt.toISOString(),
      note: p.note,
      reference: p.reference,
      recordedByName: p.recordedBy
        ? `${p.recordedBy.firstName} ${p.recordedBy.lastName}`.trim()
        : null,
      createdAt: p.createdAt.toISOString(),
    }));

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
      breakdown,
      recentRegistrations,
      payouts: formattedPayouts,
    };
  }

  /**
   * Super Admin records a commission payment made to a Field Inspector.
   *
   * Refused unless `payoutAllowance` accepts it: nothing before $100 of
   * lifetime earnings, at most $50 per week counted from the first payout, and
   * never more than is still owed. The figures are the ones the inspector's
   * dashboard shows, read through the same method, so the refusal and the
   * screen cannot disagree about what is owed.
   */
  async recordInspectorPayout(input: {
    tenantSlug: string;
    inspectorId: string;
    payload: RecordInspectorPayoutInput;
    actor: { id: string; role: string };
  }): Promise<InspectorPayoutItem> {
    // Throws NotFoundError for anything that is not a staff account.
    const profile = await this.getInspectorProfile(input.tenantSlug, input.inspectorId);

    const paidAt = input.payload.paidAt ? new Date(input.payload.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new ValidationError('تاريخ الدفع غير صالح.');
    }
    const refusal = payoutRefusal(
      payoutAllowance({
        totalEarnings: profile.totalEarnings,
        pendingBalance: profile.pendingBalance,
        payouts: profile.payouts,
        paidAt,
      }),
      input.payload.amount,
    );
    if (refusal) {
      throw new ValidationError(refusal);
    }

    const payout = await this.db.inspectorPayout.create({
      data: {
        inspectorId: input.inspectorId,
        amount: input.payload.amount,
        currency: input.payload.currency || 'USD',
        paidAt,
        note: input.payload.note ?? null,
        reference: input.payload.reference ?? null,
        recordedById: input.actor.id,
      },
      include: {
        recordedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    this.events.emit('staff.changed', {
      action: 'INSPECTOR_PAYOUT_RECORDED',
      tenantSlug: input.tenantSlug,
      staffId: input.inspectorId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      amount: input.payload.amount,
    });

    return {
      id: payout.id,
      amount: Number(payout.amount),
      currency: payout.currency,
      paidAt: payout.paidAt.toISOString(),
      note: payout.note,
      reference: payout.reference,
      recordedByName: payout.recordedBy
        ? `${payout.recordedBy.firstName} ${payout.recordedBy.lastName}`.trim()
        : null,
      createdAt: payout.createdAt.toISOString(),
    };
  }
}
