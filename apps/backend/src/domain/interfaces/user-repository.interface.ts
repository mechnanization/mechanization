import { StaffRole, User } from '../entities/user.entity';

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
  firstName: string;
  middleName?: string;
  lastName: string;
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
  residence?: 'RESIDENT' | 'NON_RESIDENT_OWNER';
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

  /** Upserts on (identityDocType, identityDocNumber) — the household-safe key. */
  upsertCitizen(input: CitizenIdentityInput, referenceNumber: string): Promise<string>;

  /** Stamps `lastLoginAt`, which the staff list surfaces as dormancy. */
  markLoggedIn(userId: string): Promise<void>;

  /** Burns a TOTP step so the same code cannot be presented twice. */
  recordTotpStep(userId: string, step: number): Promise<void>;
  /** Stores an unconfirmed secret; `confirmTotp` is what activates it. */
  saveTotpSecret(userId: string, secret: string): Promise<void>;
  /** Marks enrolment complete once the admin has proved the app works. */
  confirmTotp(userId: string): Promise<void>;
  /** Clears TOTP enrolment and secrets. */
  disableTotp(userId: string): Promise<void>;

  /** Every staff account with the history count that gates a hard delete. */
  listStaff(): Promise<StaffSummary[]>;

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

  /** Erases the row outright. Only legitimate for an account that never acted. */
  hardDeleteStaff(id: string): Promise<void>;

  /**
   * Whether this account has done anything the record still depends on: an
   * audit entry, or a registration it reviewed. Both would be orphaned by a
   * hard delete, which is why one is only offered when this is false.
   */
  countStaffHistory(id: string): Promise<number>;
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
  /** Drives whether the UI may offer a permanent delete. */
  historyCount: number;
  /** Performance & commission metrics for field inspectors */
  registeredCitizensCount?: number;
  registeredPropertiesCount?: number;
  totalEarnings?: number;
  paidBalance?: number;
  pendingBalance?: number;
  createdAt: string;
  lastLoginAt: string | null;
}
