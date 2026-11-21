/**
 * Day3ati's `/api/v1/integration` calls: the ones the system itself makes with
 * its client token, not on a user's behalf. Today that is the staff accounts
 * Day3ati keeps for the users who manage a municipality's News.
 *
 * Application code asks this port and never sees the token or the URL.
 */
export const DAY3ATI_INTEGRATION = Symbol('DAY3ATI_INTEGRATION');

/** The one role Day3ati accepts for a staff account today. */
export type Day3atiStaffRole = 'news_editor';

/** Languages Day3ati speaks. Arabic is the required one. */
export type Day3atiLanguage = 'ar' | 'en' | 'fr';

export interface Day3atiStaffAccount {
  displayName: string;
  role: Day3atiStaffRole;
  language: Day3atiLanguage;
}

/**
 * One village in Day3ati: where a municipality's News lives
 * (`GET /api/v1/integration/villages`). `externalTenant` is our own tenant
 * slug, the `{tenant}` of the staff paths; `slug` and `name` are Day3ati's.
 */
export interface Day3atiVillage {
  villageId: string;
  externalTenant: string;
  /** The keys of the modules switched on for the village (`news`, …), as Day3ati names them. */
  modules: readonly string[];
}

export interface Day3atiIntegration {
  /** False when the four `DAY3ATI_*` settings are not all set: nothing is sent. */
  readonly isConfigured: boolean;

  /**
   * Creates or updates one user's staff account in a village
   * (`PUT …/tenants/{tenant}/staff/{userId}`). Safe to repeat.
   */
  upsertStaff(tenantSlug: string, userId: string, account: Day3atiStaffAccount): Promise<void>;

  /** Every village this client may use, with the municipality each one belongs to. */
  listVillages(): Promise<Day3atiVillage[]>;

  /**
   * Removes one user from a village (`DELETE …/tenants/{tenant}/staff/{userId}`).
   * A user Day3ati does not know is already removed, so that is not an error.
   */
  removeStaff(tenantSlug: string, userId: string): Promise<void>;
}

/**
 * Why a Day3ati integration call failed.
 *
 * `code` is the partner's own stable code when it answered
 * (`integration.role_not_allowed`, `integration.tenant_not_mapped`, …) and one
 * of ours when it did not: `day3ati.not_configured`, `day3ati.unavailable`,
 * `day3ati.invalid_subject`, `day3ati.http_<status>`. Token failures keep their
 * own `Day3atiAuthError` code, carried over here. `message` is English, for
 * logs, and never holds a name, a token or the secret.
 */
export class Day3atiApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status Day3ati answered with, when it did. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Day3atiApiError';
  }

  /** The municipality has no village on Day3ati: nothing sent for it can succeed. */
  get isTenantNotMapped(): boolean {
    return this.code === 'integration.tenant_not_mapped';
  }

  /** Worth asking again a moment later: Day3ati did not answer, or failed on its side. */
  get isTransient(): boolean {
    return this.code === 'day3ati.unavailable' || (this.status !== undefined && this.status >= 500);
  }
}
