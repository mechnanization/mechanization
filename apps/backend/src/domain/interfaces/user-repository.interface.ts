import { StaffRole, User } from '../entities/user.entity';

/** What `recordTotpStep` did: accepted the code, or refused it as a replay or while locked. */
export type TotpStepOutcome =
  | { accepted: true }
  | { accepted: false; lockedUntil: Date | null };

/** How many wrong codes lock an account, and for how long (`APP_CONFIG.totp`). */
export interface TotpLockoutPolicy {
  maxFailures: number;
  lockSeconds: number;
}

/**
 * The citizen half of a filing.
 *
 * Only the name is required. Everything else is optional not because it is
 * unimportant but because a field officer may have recorded, in writing, that
 * they could not establish it — see «غير مؤكَّد» in `field-flag.schema`. What
 * decides whether an absence is acceptable is `personalDetailsSchema` at the
 * edge, which still demands every one of these of a record filed without a
 * flag against it; this interface only has to be able to *carry* the absence
 * that check has already allowed.
 *
 * `firstName` and `lastName` stay required because they are `NOT NULL` on
 * `users` and because a record nobody can search for by name is not a register
 * entry — which is also why they cannot be flagged in the first place.
 */
export interface CitizenIdentityInput {
  phone?: string;
  whatsapp?: string;
  /**
   * «لا يملك رقم هاتف» — the person owns no phone, so the absence of `phone`
   * above is an answer rather than a gap. True forces both numbers to NULL on
   * the way in; see migration 0069 and `RegistrationRepository`.
   */
  hasNoPhone?: boolean;
  /**
   * «رقم للتواصل» — a relative's number, for a citizen with none of their own.
   * Not an identity and not unique: see `User.contactPhone`.
   */
  contactPhone?: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  /**
   * اسم الأم وشهرتها — one phrase, as it is asked and as it is answered.
   *
   * Optional here for the reason every field below is: an officer may have
   * recorded in writing that they could not establish it. `personalDetailsSchema`
   * still demands it of an unflagged household file, and records filed before
   * migration 0044 simply hold nothing. Never a lookup key — siblings share it.
   */
  motherName?: string;
  gender?: string;
  nationality?: string;
  isLebanese?: boolean;
  residencyNumber?: string;
  residentStatus?: string;
  identityDocType?: string;
  identityDocNumber?: string;
  /** رقم السجل — meaningless outside the Lebanese civil registry. */
  civilRecordNumber?: string;
  totalRegisteredMembers?: number;
  actualHouseholdMembers?: number;
  maritalStatus?: string;
  bloodType?: string;
  /** نوع الملف. Absent means `RESIDENT` — a household file. */
  residence?: 'RESIDENT' | 'NON_RESIDENT_OWNER' | 'ESTATE' | 'INSTITUTION';
  /** Where a non-resident owner lives. */
  residencePlace?: string;
  localContactName?: string;
  localContactPhone?: string;
}

/**
 * A phone shared by a household resolves to several people. The citizen picks
 * which one they are *after* proving they hold the phone, so this returns the
 * minimum needed to render that choice and nothing more.
 */
export interface CitizenChoice {
  id: string;
  displayName: string;
  identityDocLastDigits: string;
}

export interface UserRepository {
  /** Case-insensitive; staff only, so a citizen row can never satisfy a login. */
  findStaffByEmail(email: string): Promise<User | null>;
  /** Either kind of user. Callers check `kind` before trusting the result. */
  findById(id: string): Promise<User | null>;
  /** Everyone reachable on one number — a household shares a phone. */
  findCitizensByPhone(phone: string): Promise<CitizenChoice[]>;

  /**
   * By رقم مرجعي, for the portal's reference-number sign-in. Returns the whole
   * user because the caller still has to match the phone on file before it
   * will issue a session.
   */
  findCitizenByReference(referenceNumber: string): Promise<User | null>;

  /** Stamps `lastLoginAt`, which the staff list surfaces as dormancy. */
  markLoggedIn(userId: string): Promise<void>;

  /**
   * Burns the TOTP step a code was generated in, so it cannot be presented
   * twice, and clears the failure count and any lockout.
   *
   * One conditional write: refused, writing nothing, when the step is at or
   * below the last one burned (a replay, `lockedUntil: null`) or the account
   * is locked at `now` (`lockedUntil` set). Two sign-ins racing with the same
   * code cannot both be accepted.
   */
  recordTotpStep(userId: string, step: number, now: Date): Promise<TotpStepOutcome>;
  /**
   * Counts a wrong code. The one that reaches `policy.maxFailures` locks the
   * account until `now + policy.lockSeconds` and starts the count again.
   */
  recordTotpFailure(
    userId: string,
    policy: TotpLockoutPolicy,
    now: Date,
  ): Promise<{ lockedUntil: Date | null }>;

  /**
   * Ends every session a citizen holds, by bumping `tokenVersion`: the guard
   * refuses each token stamped with the old one. Citizens only — a staff
   * session ends with its refresh family. False when no citizen has the id.
   */
  endCitizenSessions(userId: string): Promise<boolean>;

  /**
   * Stores a secret as the account's factor, unconfirmed; `confirmTotp` is
   * what activates it. For an account being created (`StaffService`), which
   * has no factor to keep. A staff member's own enrolment goes through
   * `savePendingTotpSecret` instead.
   */
  saveTotpSecret(userId: string, secret: string): Promise<void>;
  /** Marks enrolment complete once the admin has proved the app works. */
  confirmTotp(userId: string): Promise<void>;
  /**
   * A staff member's own enrolment (0116, audit SEC-02): the new secret waits
   * beside the confirmed factor, which keeps signing in until a code from the
   * new app confirms it. Writes over an earlier pending secret. Staff only.
   */
  savePendingTotpSecret(userId: string, secret: string): Promise<void>;
  /**
   * Makes `secret` the account's confirmed factor, if it is still the one
   * waiting — the pending secret, or an unconfirmed `totpSecret` left by an
   * enrolment started before 0116 — and ends every session the account holds
   * (`tokenVersion`). False when another enrolment replaced it since, or no
   * staff account has the id: nothing is written then.
   */
  promotePendingTotp(userId: string, secret: string): Promise<boolean>;
  /**
   * Clears the second factor, a pending one included, and ends every session
   * the account holds (`tokenVersion`). Staff only.
   */
  disableTotp(userId: string): Promise<void>;

  /** Every staff account with the history count that gates a hard delete. */
  /**
   * Every staff account that has not been deleted. With `includeDeletedEarners`,
   * also the deleted ones that earned or were paid commission — the earnings
   * roster's totals are the municipality's history and must not shrink when
   * an account is hidden.
   */
  listStaff(options?: { includeDeletedEarners?: boolean }): Promise<StaffSummary[]>;

  createStaff(input: {
    tenantSlug: string;
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    role: StaffRole;
  }): Promise<string>;

  updateStaff(
    id: string,
    patch: {
      email?: string;
      passwordHash?: string;
      firstName?: string;
      lastName?: string;
      role?: StaffRole;
    },
  ): Promise<void>;

  /** Soft delete — the row stays so its audit trail keeps a name attached. */
  setStaffActive(id: string, isActive: boolean): Promise<void>;

  /**
   * «حذف موظف»: hides the account — off the staff list, never signing in —
   * and keeps the row, its details and its history. See `StaffService.remove`.
   */
  hideStaff(id: string): Promise<void>;
  /** Whether a super admin has deleted (hidden) this staff account. */
  isStaffHidden(id: string): Promise<boolean>;
  /** Brings a deleted account back onto the list — still disabled until re-enabled. */
  restoreStaff(id: string): Promise<void>;
  /** The accounts a super admin has deleted, most recent first. */
  listDeletedStaff(): Promise<DeletedStaffSummary[]>;
}

/** A deleted staff account, as the «الموظفون المحذوفون» list shows it. */
export interface DeletedStaffSummary {
  id: string;
  email: string;
  fullName: string;
  role: StaffRole;
  deletedAt: string;
}

export interface StaffSummary {
  id: string;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
  isActive: boolean;
  hasConfirmedTotp?: boolean;
  /** Performance & commission metrics for field inspectors */
  registeredCitizensCount?: number;
  registeredPropertiesCount?: number;
  totalEarnings?: number;
  paidBalance?: number;
  pendingBalance?: number;
  /**
   * Paid over and above earned. `pendingBalance` clamps at zero so the payout
   * rule can read it as "the most that may still be paid", which left an
   * overpaid inspector looking settled. Reported rather than inferred.
   */
  overpaidBalance?: number;
  createdAt: string;
  lastLoginAt: string | null;
  /**
   * «آخر ظهور» — when this account last made a request, or null if it has not
   * since migration 0070 shipped.
   *
   * Presence is derived from this and not reported as a boolean, deliberately:
   * a server that says «online» has already decided how fresh counts as
   * present, and a client holding the timestamp can show «آخر ظهور» for the
   * ones that are not. The threshold is `STAFF_ONLINE_WITHIN_SECONDS`, and the
   * rule `isStaffOnline`, both in `@mechanization/shared-schemas`.
   */
  lastSeenAt: string | null;
  /** Set only on a deleted account returned for the earnings roster. */
  deletedAt?: string | null;
}
