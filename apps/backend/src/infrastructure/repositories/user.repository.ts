import { citizenDisplayName } from '@mechanization/shared-schemas';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import { StaffRole, User } from '../../domain/entities/user.entity';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  CitizenChoice,
  DeletedStaffSummary,
  StaffSummary,
  UserRepository,
} from '../../domain/interfaces/user-repository.interface';
import { cardsCreditedTo, COMMISSION_RATE, creditBillableUnits } from '@mechanization/shared-schemas';
import { TenantContextService } from '../context/tenant-context.service';
import { creditedRegistrationsWhere, EARNINGS_CARD_SELECT } from './earnings-registrations';

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
      residence: row.residence,
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
      residence: row.residence,
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
      select: { id: true, firstName: true, lastName: true, residence: true, identityDocNumber: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      // «ورثة المرحوم …» for an estate (0076): the heirs choosing which file is theirs.
      displayName: citizenDisplayName(row, { middleName: false }),
      identityDocLastDigits: (row.identityDocNumber ?? '').slice(-2).padStart(2, '•'),
    }));
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

  /** The staff accounts that have not been deleted — see the interface for the roster's option. */
  async listStaff(options: { includeDeletedEarners?: boolean } = {}): Promise<StaffSummary[]> {
    const rows = await this.db.user.findMany({
      // A deleted account is gone from the list; its row and history stay.
      where: options.includeDeletedEarners ? { kind: 'STAFF' } : { kind: 'STAFF', deletedAt: null },
      select: {
        deletedAt: true,
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        lastSeenAt: true,
        totpConfirmedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const staffIds = rows.map((r) => r.id);

    // The work each staff member is credited for: the registrations they made,
    // and those holding a line they filed on somebody else's file (0096). See
    // `creditedRegistrationsWhere`, which the inspector's page loads through too.
    //
    // Oldest first, the order `creditBillableUnits` is documented to be fed in.
    const registrations = await this.db.registration.findMany({
      where: creditedRegistrationsWhere(staffIds),
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true,
        createdById: true,
        citizenId: true,
        properties: { select: EARNINGS_CARD_SELECT },
        // Cards filed here that a merge has since moved onto another
        // registration — still credited here. See `cardsFiledOn`.
        movedCards: { select: EARNINGS_CARD_SELECT },
      },
    });

    const listed = new Set(staffIds);
    const inspectorStats = new Map<string, { citizens: Set<string>; units: Set<string> }>();
    const statFor = (officerId: string) => {
      let stat = inspectorStats.get(officerId);
      if (!stat) {
        stat = { citizens: new Set<string>(), units: new Set<string>() };
        inspectorStats.set(officerId, stat);
      }
      return stat;
    };
    for (const reg of registrations) {
      // Citizens are the ones this officer registered, not every file he added a line to.
      if (reg.createdById !== null && listed.has(reg.createdById)) {
        statFor(reg.createdById).citizens.add(reg.citizenId);
      }
      // Everyone this registration can pay: its officer, and whoever filed a line on it.
      const officers = new Set<string>(reg.createdById ? [reg.createdById] : []);
      for (const card of [...reg.properties, ...reg.movedCards]) {
        for (const line of card.units) if (line.filedById) officers.add(line.filedById);
      }
      for (const officerId of officers) {
        if (!listed.has(officerId)) continue;
        // One dollar per distinct unit. The set spans this officer's whole
        // history rather than one registration, so the owner's file and the
        // tenant's file for one flat are counted once between them.
        creditBillableUnits(cardsCreditedTo(officerId, reg), statFor(officerId).units);
      }
    }

    // Query recorded payouts for each inspector. One whose voucher was
    // cancelled put the money back in the wallet and is not paid (0086) — the
    // same rule `StaffService.getInspectorProfile` applies, so both agree.
    const payouts = await this.db.inspectorPayout.findMany({
      where: {
        inspectorId: { in: staffIds },
        OR: [{ expenseVoucherId: null }, { expenseVoucher: { voidedAt: null } }],
      },
      select: {
        inspectorId: true,
        amount: true,
      },
    });

    const payoutSums = new Map<string, number>();
    for (const p of payouts) {
      payoutSums.set(p.inspectorId, (payoutSums.get(p.inspectorId) ?? 0) + Number(p.amount));
    }

    const summaries = rows.map((row) => {
      const stats = inspectorStats.get(row.id);
      const regCitizens = stats ? stats.citizens.size : 0;
      const regProperties = stats ? stats.units.size : 0;
      const totalEarnings = regProperties * COMMISSION_RATE;
      const paid = payoutSums.get(row.id) ?? 0;
      const pending = Math.max(0, totalEarnings - paid);
      // See StaffSummary.overpaidBalance: the half of the clamp that used to
      // be invisible, so the roster can show money owed back.
      const overpaid = Math.max(0, paid - totalEarnings);

      return {
        id: row.id,
        email: row.email ?? '',
        fullName: `${row.firstName} ${row.lastName}`,
        firstName: row.firstName,
        lastName: row.lastName,
        role: row.role as StaffRole,
        isActive: row.isActive,
        hasConfirmedTotp: Boolean(row.totpConfirmedAt),
        registeredCitizensCount: regCitizens,
        registeredPropertiesCount: regProperties,
        totalEarnings,
        paidBalance: paid,
        pendingBalance: pending,
        overpaidBalance: overpaid,
        createdAt: row.createdAt.toISOString(),
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        deletedAt: row.deletedAt?.toISOString() ?? null,
      };
    });
    // A deleted account stays on the roster only for what it earned or was paid.
    return summaries.filter(
      (summary) => !summary.deletedAt || summary.totalEarnings > 0 || summary.paidBalance > 0,
    );
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

  /** Back on the staff list, still disabled: re-enabling is its own, separate decision. */
  async restoreStaff(id: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { deletedAt: null } });
  }

  async listDeletedStaff(): Promise<DeletedStaffSummary[]> {
    const rows = await this.db.user.findMany({
      where: { kind: 'STAFF', deletedAt: { not: null } },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, deletedAt: true },
      orderBy: { deletedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      email: row.email ?? '',
      fullName: `${row.firstName} ${row.lastName}`,
      role: row.role as StaffRole,
      deletedAt: row.deletedAt!.toISOString(),
    }));
  }

  async isStaffHidden(id: string): Promise<boolean> {
    const row = await this.db.user.findUnique({ where: { id }, select: { deletedAt: true } });
    return Boolean(row?.deletedAt);
  }

  /**
   * «حذف موظف»: the account is hidden, not removed.
   *
   * The row has to stay — payments it recorded hold a RESTRICT foreign key to
   * it, and the audit trail, the registrations it reviewed and the receipts it
   * issued all name it, under its own name. So this marks it deleted, which
   * takes it off the staff list, and deactivates it in the same write.
   * `tokenVersion` is bumped so a session still open on it dies now.
   */
  async hideStaff(id: string): Promise<void> {
    await this.db.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, tokenVersion: { increment: 1 } },
    });
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
