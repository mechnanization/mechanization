import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import { StaffRole, User } from '../../domain/entities/user.entity';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  CitizenChoice,
  CitizenIdentityInput,
  StaffSummary,
  UserRepository,
} from '../../domain/interfaces/user-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /** Lower-cased and staff-scoped, matching how accounts are stored. */
  async findStaffByEmail(email: string): Promise<User | null> {
    const row = await this.db.user.findFirst({
      where: { email: email.toLowerCase(), kind: 'STAFF' },
    });
    if (!row) return null;

    return User.staff({
      id: row.id,
      tenantSlug: row.tenantSlug,
      email: row.email!,
      passwordHash: row.passwordHash!,
      role: row.role as StaffRole,
      firstName: row.firstName,
      lastName: row.lastName,
      isActive: row.isActive,
      tokenVersion: row.tokenVersion,
      lastTotpStep: row.lastTotpStep,
      totpSecret: row.totpSecret,
      totpConfirmedAt: row.totpConfirmedAt,
    });
  }

  /** Either kind — the caller decides whether that kind is acceptable. */
  async findById(id: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    if (!row) return null;

    if (row.kind === 'STAFF') {
      return User.staff({
        id: row.id,
        tenantSlug: row.tenantSlug,
        email: row.email!,
        passwordHash: row.passwordHash!,
        role: row.role as StaffRole,
        firstName: row.firstName,
        lastName: row.lastName,
        isActive: row.isActive,
        tokenVersion: row.tokenVersion,
        lastTotpStep: row.lastTotpStep,
        totpSecret: row.totpSecret,
        totpConfirmedAt: row.totpConfirmedAt,
      });
    }

    return User.citizen({
      id: row.id,
      tenantSlug: row.tenantSlug,
      phone: row.phone!,
      whatsapp: row.whatsapp,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      referenceNumber: row.referenceNumber!,
      identityDocType: row.identityDocType!,
      identityDocNumber: row.identityDocNumber!,
      isActive: row.isActive,
      tokenVersion: row.tokenVersion,
    });
  }

  /**
   * By رقم مرجعي. Citizen-scoped in the query itself, so a staff reference
   * could never satisfy the portal's login even if one collided.
   */
  async findCitizenByReference(referenceNumber: string): Promise<User | null> {
    const row = await this.db.user.findFirst({
      where: { referenceNumber, kind: 'CITIZEN' },
    });
    if (!row) return null;

    return User.citizen({
      id: row.id,
      tenantSlug: row.tenantSlug,
      phone: row.phone!,
      whatsapp: row.whatsapp,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      referenceNumber: row.referenceNumber!,
      identityDocType: row.identityDocType!,
      identityDocNumber: row.identityDocNumber!,
      isActive: row.isActive,
      tokenVersion: row.tokenVersion,
    });
  }

  /**
   * A household commonly shares one phone. Returning the minimum needed to tell
   * two family members apart — and only the last two digits of the document
   * number — keeps the disambiguation screen from becoming a way to enumerate a
   * household's ID numbers with a phone you happen to hold.
   */
  async findCitizensByPhone(phone: string): Promise<CitizenChoice[]> {
    const rows = await this.db.user.findMany({
      where: { kind: 'CITIZEN', phone, isActive: true },
      select: { id: true, firstName: true, lastName: true, identityDocNumber: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      displayName: `${row.firstName} ${row.lastName}`,
      identityDocLastDigits: (row.identityDocNumber ?? '').slice(-2).padStart(2, '•'),
    }));
  }

  /**
   * Keyed on the identity document rather than the phone: re-submitting from a
   * relative's phone must update the same person, not create a second record.
   */
  async upsertCitizen(input: CitizenIdentityInput, referenceNumber: string): Promise<string> {
    /*
      An upsert needs the key it upserts on.

      Since «غير مؤكَّد» flags exist, a citizen may be registered with no
      identity document at all — and this method has nothing to match such a
      person on. Refused loudly rather than quietly turned into an insert:
      "upsert" is a promise not to duplicate anyone, and it cannot be kept
      here. The write path that *can* handle it is
      `PrismaRegistrationRepository.submit`, which chooses between upsert and
      insert with the same question in hand.
    */
    if (!input.identityDocType || !input.identityDocNumber) {
      throw new ConflictError(
        'لا يمكن مطابقة هذا السجل بدون نوع ورقم وثيقة الإثبات',
      );
    }
    const identityDocNumber = input.identityDocNumber;

    try {
      const row = await this.db.user.upsert({
        where: {
          identityDocType_identityDocNumber: {
            identityDocType: input.identityDocType as never,
            identityDocNumber,
          },
        },
        update: {
          phone: input.phone,
          whatsapp: input.whatsapp ?? input.phone,
          firstName: input.firstName,
          middleName: input.middleName ?? null,
          lastName: input.lastName,
          gender: input.gender as never,
          nationality: input.nationality,
          isLebanese: input.isLebanese,
          residencyNumber: input.residencyNumber ?? null,
          residentStatus: input.residentStatus as never,
          civilRecordNumber: input.civilRecordNumber,
          totalRegisteredMembers: input.totalRegisteredMembers ?? input.actualHouseholdMembers,
          actualHouseholdMembers: input.actualHouseholdMembers,
          maritalStatus: input.maritalStatus as never,
        },
        create: {
          kind: 'CITIZEN',
          tenantSlug: this.tenantContext.tenantSlug,
          phone: input.phone,
          whatsapp: input.whatsapp ?? input.phone,
          firstName: input.firstName,
          middleName: input.middleName ?? null,
          lastName: input.lastName,
          gender: input.gender as never,
          nationality: input.nationality,
          isLebanese: input.isLebanese,
          residencyNumber: input.residencyNumber ?? null,
          residentStatus: input.residentStatus as never,
          identityDocType: input.identityDocType as never,
          identityDocNumber,
          civilRecordNumber: input.civilRecordNumber,
          totalRegisteredMembers: input.totalRegisteredMembers ?? input.actualHouseholdMembers,
          actualHouseholdMembers: input.actualHouseholdMembers,
          maritalStatus: input.maritalStatus as never,
          referenceNumber,
        },
        select: { id: true },
      });

      return row.id;
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Stamps `lastLoginAt` on a successful sign-in. */
  async markLoggedIn(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  /**
   * Burns a TOTP step.
   *
   * Guarded in the `where` rather than checked first: two logins racing with
   * the same code both read `lastTotpStep` as the older value, and only a
   * conditional write lets exactly one of them win. The caller treats "no row
   * updated" as a replay.
   */
  async recordTotpStep(userId: string, step: number): Promise<void> {
    const { count } = await this.db.user.updateMany({
      where: {
        id: userId,
        OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: BigInt(step) } }],
      },
      data: { lastTotpStep: BigInt(step) },
    });

    if (count === 0) {
      throw new ConflictError('تم استخدام هذا الرمز بالفعل');
    }
  }

  /** Writes an unconfirmed secret. Sessions stay blocked until confirmed. */
  async saveTotpSecret(userId: string, secret: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totpSecret: secret, totpConfirmedAt: null },
    });
  }

  /** Activates enrolment by recording when it was proved. */
  async confirmTotp(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totpConfirmedAt: new Date() },
    });
  }

  /** Clears enrolment and secrets so the second factor is no longer requested. */
  async disableTotp(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpConfirmedAt: null, lastTotpStep: null },
    });
  }

  /** Staff rows plus the audit/review counts a permanent delete depends on. */
  async listStaff(): Promise<StaffSummary[]> {
    const rows = await this.db.user.findMany({
      where: { kind: 'STAFF' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        totpConfirmedAt: true,
        // Counted in the same query rather than per row: the alternative is
        // a history lookup per staff member, and this list is rendered in
        // full on every visit to the page. Every relation `countStaffHistory`
        // checks at delete time belongs here too — undercounting here would
        // show a delete button the actual delete then refuses.
        _count: {
          select: {
            reviewedRegistrations: true,
            reviewedPayments: true,
            collectedPayments: true,
            collectedTransactions: true,
            recordedTransactions: true,
            issuedFeeNotices: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Audit entries carry `actorId` as a plain column with no relation to
    // join against, so they are counted in one grouped pass.
    const auditCounts = await this.db.auditLogEntry.groupBy({
      by: ['actorId'],
      where: { actorId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const auditByActor = new Map(
      auditCounts.map((entry) => [entry.actorId, entry._count._all]),
    );

    return rows.map((row) => ({
      id: row.id,
      email: row.email ?? '',
      fullName: `${row.firstName} ${row.lastName}`,
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.role as StaffRole,
      isActive: row.isActive,
      hasConfirmedTotp: Boolean(row.totpConfirmedAt),
      historyCount:
        row._count.reviewedRegistrations +
        row._count.reviewedPayments +
        row._count.collectedPayments +
        row._count.collectedTransactions +
        row._count.recordedTransactions +
        row._count.issuedFeeNotices +
        (auditByActor.get(row.id) ?? 0),
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    }));
    const staffIds = rows.map((r) => r.id);

    // Query registrations created by each staff member (field inspector)
    const registrations = await this.db.registration.findMany({
      where: { createdById: { in: staffIds } },
      select: {
        id: true,
        createdById: true,
        citizenId: true,
        properties: {
          select: {
            id: true,
            propertyType: true,
            units: {
              select: { id: true },
            },
          },
        },
      },
    });

    const inspectorStats = new Map<string, { citizens: Set<string>; propertyCount: number }>();
    for (const reg of registrations) {
      if (reg.createdById === null) continue;
      // Prisma's payload type keeps createdById as `string | null` here even after the
      // guard above, since it's resolved through a deferred generic index type that CFA
      // can't narrow — the runtime check is still valid, so assert it explicitly.
      const createdById = reg.createdById as string;
      const citizenId = reg.citizenId;
      const existing = inspectorStats.get(createdById);
      const stat = existing ?? { citizens: new Set<string>(), propertyCount: 0 };
      if (!existing) inspectorStats.set(createdById, stat);
      stat.citizens.add(citizenId);
      for (const p of reg.properties) {
        if (p.propertyType === 'BUILDING' && p.units.length > 0) {
          stat.propertyCount += p.units.length;
        } else {
          stat.propertyCount += 1;
        }
      }
    }

    // Query recorded payouts for each inspector
    const payouts = await this.db.inspectorPayout.findMany({
      where: { inspectorId: { in: staffIds } },
      select: {
        inspectorId: true,
        amount: true,
      },
    });

    const payoutSums = new Map<string, number>();
    for (const p of payouts) {
      payoutSums.set(p.inspectorId, (payoutSums.get(p.inspectorId) ?? 0) + Number(p.amount));
    }

    return rows.map((row) => {
      const stats = inspectorStats.get(row.id);
      const regCitizens = stats ? stats.citizens.size : 0;
      const regProperties = stats ? stats.propertyCount : 0;
      const totalEarnings = regProperties * 1.0;
      const paid = payoutSums.get(row.id) ?? 0;
      const pending = Math.max(0, totalEarnings - paid);

      return {
        id: row.id,
        email: row.email ?? '',
        fullName: `${row.firstName} ${row.lastName}`,
        firstName: row.firstName,
        lastName: row.lastName,
        role: row.role as StaffRole,
        isActive: row.isActive,
        hasConfirmedTotp: Boolean(row.totpConfirmedAt),
        historyCount:
          row._count.reviewedRegistrations +
          row._count.reviewedPayments +
          row._count.collectedPayments +
          row._count.collectedTransactions +
          row._count.recordedTransactions +
          row._count.issuedFeeNotices +
          (auditByActor.get(row.id) ?? 0),
        registeredCitizensCount: regCitizens,
        registeredPropertiesCount: regProperties,
        totalEarnings,
        paidBalance: paid,
        pendingBalance: pending,
        createdAt: row.createdAt.toISOString(),
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      };
    });
  }

  async createStaff(input: {
    tenantSlug: string;
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    role: StaffRole;
  }): Promise<string> {
    const existing = await this.db.user.findFirst({
      where: { email: input.email.toLowerCase(), kind: 'STAFF' },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('هذا البريد الإلكتروني مستخدم بالفعل');
    }

    const row = await this.db.user.create({
      data: {
        kind: 'STAFF',
        tenantSlug: input.tenantSlug,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role as never,
      },
      select: { id: true },
    });

    return row.id;
  }

  async updateStaff(
    id: string,
    patch: {
      email?: string;
      passwordHash?: string;
      firstName?: string;
      lastName?: string;
      role?: StaffRole;
    },
  ): Promise<void> {
    if (patch.email) {
      const clash = await this.db.user.findFirst({
        where: { email: patch.email.toLowerCase(), kind: 'STAFF', id: { not: id } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictError('هذا البريد الإلكتروني مستخدم بالفعل');
      }
    }

    /**
     * A role or password change revokes every session this account holds.
     *
     * Role travels in the JWT and `RolesGuard` authorises from the claim, so a
     * demoted SUPER_ADMIN would otherwise keep administering the municipality
     * until their token expired — thirty days with "تذكّرني على هذا الجهاز".
     * A password change revokes for the ordinary reason: it is what someone
     * does when they believe the old one is known.
     *
     * A rename does not bump. It changes nothing about what the session may
     * reach, and signing a colleague out because their surname was corrected
     * is the kind of friction that gets a security control removed.
     */
    const revokes = Boolean(patch.role || patch.passwordHash);

    await this.db.user.update({
      where: { id },
      data: {
        ...(patch.email ? { email: patch.email.toLowerCase() } : {}),
        ...(patch.passwordHash ? { passwordHash: patch.passwordHash } : {}),
        ...(patch.firstName ? { firstName: patch.firstName } : {}),
        ...(patch.lastName ? { lastName: patch.lastName } : {}),
        ...(patch.role ? { role: patch.role as never } : {}),
        ...(revokes ? { tokenVersion: { increment: 1 } } : {}),
      },
    });
  }

  /**
   * The soft delete and its undo. The row survives so the audit trail and any
   * registration this account reviewed keep a name attached.
   */
  async setStaffActive(id: string, isActive: boolean): Promise<void> {
    /**
     * Bumped in both directions.
     *
     * Deactivating is the obvious one — it is the dismissal case, and until
     * this column existed the dismissed account kept full access for the life
     * of its token. Reactivating bumps too: an account is usually switched off
     * because something was wrong with it, and any session still outstanding
     * from before that decision should not come back with it.
     */
    await this.db.user.update({
      where: { id },
      data: { isActive, tokenVersion: { increment: 1 } },
    });
  }

  /**
   * Erases the row. Callers must establish there is no history first — this
   * does not check, and the FK from reviewed registrations would block it.
   */
  async hardDeleteStaff(id: string): Promise<void> {
    await this.db.user.delete({ where: { id } });
  }

  /**
   * Every row anywhere in the schema that still names this account. Zero is
   * what makes it safe to erase outright.
   */
  async countStaffHistory(id: string): Promise<number> {
    const [
      reviewed,
      audited,
      recorded,
      collectedTransactions,
      reviewedPayments,
      collectedPayments,
      issuedFeeNotices,
    ] = await Promise.all([
      this.db.registration.count({ where: { reviewedById: id } }),
      this.db.auditLogEntry.count({ where: { actorId: id } }),
      // Ledger rows are history in the strongest sense the system has: money
      // this person recorded or held. The foreign keys are RESTRICT, so
      // counting them here is what turns an unerasable account into a
      // sentence about deactivating it instead of a raw constraint violation.
      this.db.paymentTransaction.count({ where: { recordedById: id } }),
      this.db.paymentTransaction.count({ where: { collectedById: id } }),
      this.db.citizenPayment.count({ where: { reviewedById: id } }),
      this.db.citizenPayment.count({ where: { collectedById: id } }),
      this.db.feeNotice.count({ where: { issuedById: id } }),
    ]);
    return (
      reviewed +
      audited +
      recorded +
      collectedTransactions +
      reviewedPayments +
      collectedPayments +
      issuedFeeNotices
    );
  }

  /** Prisma error codes stop here — no layer above this one sees them. */
  private translate(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
      if (target.includes('referenceNumber')) {
        // Astronomically unlikely (32^6 per prefix per month) but a silent
        // collision would hand one citizen another's tracking code.
        return new ConflictError('تعذّر إنشاء رقم مرجعي فريد — يرجى المحاولة مرة أخرى');
      }
      if (target.includes('email')) {
        return new ConflictError('هذا البريد الإلكتروني مسجّل مسبقاً');
      }
      return new ConflictError('هذه الوثيقة مسجّلة مسبقاً لشخص آخر');
    }
    return error;
  }
}
