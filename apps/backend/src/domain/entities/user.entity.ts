import { citizenDisplayName } from '@mechanization/shared-schemas';
import { AggregateRoot } from './aggregate-root.base';
import { ForbiddenError, ValidationError } from '../errors/domain-error';

export type UserKind = 'STAFF' | 'CITIZEN';
export type StaffRole =
  | 'SUPER_ADMIN'
  | 'AUDITOR'
  | 'FIELD_INSPECTOR'
  | 'COLLECTOR'
  | 'ACCOUNTANT'
  | 'ADMINISTRATIVE_OFFICER'
  | 'VIEWER';

export interface StaffProps {
  id: string;
  tenantSlug: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
  firstName: string;
  lastName: string;
  isActive: boolean;
  tokenVersion?: number;
  lastTotpStep?: bigint | null;
  totpSecret?: string | null;
  totpConfirmedAt?: Date | null;
}

export interface CitizenProps {
  id: string;
  tenantSlug: string;
  phone: string;
  whatsapp?: string | null;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  referenceNumber: string;
  identityDocType: string;
  identityDocNumber: string;
  isActive: boolean;
  tokenVersion?: number;
  /** نوع الملف — an estate is named «ورثة المرحوم …» (0076). Absent reads as a household. */
  residence?: string | null;
}

/**
 * One user concept for both staff and citizens.
 *
 * v1 kept two tables, two token formats and two guards, which meant every
 * "does this token's tenant match the URL's tenant" check existed twice — and a
 * check that exists twice is a check that eventually exists once.
 */
export class User extends AggregateRoot {
  private constructor(
    readonly id: string,
    readonly kind: UserKind,
    readonly tenantSlug: string,
    private readonly attrs: Record<string, unknown>,
  ) {
    super();
  }

  static staff(props: StaffProps): User {
    if (!props.email.includes('@')) {
      throw new ValidationError('A staff account requires a valid email');
    }
    return new User(props.id, 'STAFF', props.tenantSlug, { ...props });
  }

  static citizen(props: CitizenProps): User {
    return new User(props.id, 'CITIZEN', props.tenantSlug, { ...props });
  }

  get isActive(): boolean {
    return this.attrs.isActive === true;
  }

  get role(): StaffRole | undefined {
    return this.attrs.role as StaffRole | undefined;
  }

  get email(): string | undefined {
    return this.attrs.email as string | undefined;
  }

  get phone(): string | undefined {
    return this.attrs.phone as string | undefined;
  }

  get passwordHash(): string | undefined {
    return this.attrs.passwordHash as string | undefined;
  }

  /** Stamped into every token this account is issued. See the schema note. */
  get tokenVersion(): number {
    return (this.attrs.tokenVersion as number | undefined) ?? 0;
  }

  /**
   * The TOTP step this account last authenticated with, or `null`.
   *
   * Compared against the step a submitted code falls in, which is what makes a
   * code single-use: within `otplib`'s one-step window the same digits verify
   * for about ninety seconds, so "it verified" is not on its own enough.
   */
  get lastTotpStep(): number | null {
    const raw = this.attrs.lastTotpStep as bigint | number | null | undefined;
    return raw === null || raw === undefined ? null : Number(raw);
  }

  get totpSecret(): string | undefined {
    return (this.attrs.totpSecret as string | null | undefined) ?? undefined;
  }

  /** As every screen names the file — «ورثة المرحوم …» for an estate (0076). */
  get fullName(): string {
    return citizenDisplayName({
      firstName: (this.attrs.firstName as string | null) ?? null,
      middleName: (this.attrs.middleName as string | null) ?? null,
      lastName: (this.attrs.lastName as string | null) ?? null,
      residence: (this.attrs.residence as string | null) ?? null,
    });
  }

  /**
   * SUPER_ADMIN holds the keys to every citizen's national ID number, residency
   * status and documents in this municipality. The v1 spec called 2FA
   * "optional to consider"; at that blast radius it is a requirement, enforced
   * here so no login path can skip it.
   */
  get requiresTotp(): boolean {
    return this.kind === 'STAFF' && this.role === 'SUPER_ADMIN';
  }

  get hasConfirmedTotp(): boolean {
    return Boolean(this.attrs.totpSecret && this.attrs.totpConfirmedAt);
  }

  /**
   * Called before a session is issued. Refuses a deactivated account.
   */
  assertMayStartSession(): void {
    if (!this.isActive) {
      throw new ForbiddenError('This account has been deactivated');
    }
  }

  recordLogin(context: { ip?: string; userAgent?: string }): void {
    this.record('user.logged-in', {
      userId: this.id,
      kind: this.kind,
      role: this.role,
      email: this.email,
      tenantSlug: this.tenantSlug,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
}
