import { ForbiddenError, TenantNotProvisionedError } from '../errors/domain-error';
import { PropertyType } from './property-entry.entity';
import { TenantSlug } from '../value-objects/tenant-slug.vo';

export interface TenantConfig {
  /** Property types this municipality currently accepts. Empty/absent = all. */
  enabledPropertyTypes?: PropertyType[];
  /** Document types a citizen must attach, beyond the per-property proof. */
  requiredDocuments?: string[];
  branding?: {
    logoUrl?: string;
    primaryColor?: string;
    accentColor?: string;
  };
  /** Optional per-municipality contact shown on the wizard's help footer. */
  supportPhone?: string;
}

export interface TenantProps {
  id: string;
  slug: string;
  name: string;
  nameAr: string;
  schemaName: string;
  adminPathSegment: string;
  referencePrefix: string;
  config: TenantConfig | null;
  isActive: boolean;
  provisionedAt: Date | null;
}

/**
 * A municipality. Lives in the shared `public` registry — this is the only
 * entity that is not itself inside a tenant schema.
 */
export class Tenant {
  private constructor(private readonly props: Readonly<TenantProps>) {}

  static rehydrate(props: TenantProps): Tenant {
    return new Tenant(props);
  }

  get id(): string {
    return this.props.id;
  }

  get slug(): string {
    return this.props.slug;
  }

  get name(): string {
    return this.props.name;
  }

  get nameAr(): string {
    return this.props.nameAr;
  }

  get schemaName(): string {
    return this.props.schemaName;
  }

  get adminPathSegment(): string {
    return this.props.adminPathSegment;
  }

  get referencePrefix(): string {
    return this.props.referencePrefix;
  }

  get config(): TenantConfig {
    return this.props.config ?? {};
  }

  get isActive(): boolean {
    return this.props.isActive;
  }

  /** Plain-data snapshot for callers that need to serialize this entity — a
   *  cache, most likely — and rebuild it later via `rehydrate`. */
  toProps(): TenantProps {
    return { ...this.props };
  }

  /**
   * A tenant row can exist before its Postgres schema does — provisioning is a
   * deliberate second step. Serving requests in that window would produce
   * "relation does not exist" errors from deep inside Prisma, so the boundary
   * check happens here instead.
   */
  assertServable(): void {
    if (!this.props.isActive) {
      throw new ForbiddenError({
        code: 'TENANT_NOT_ACCEPTING',
        message: 'This municipality is not currently accepting requests',
      });
    }
    if (!this.props.provisionedAt) {
      throw new TenantNotProvisionedError(this.props.slug);
    }
  }

  /**
   * Absent config means "accept everything" — a municipality that has not
   * customised its wizard should not silently reject every submission.
   */
  allowsPropertyType(type: PropertyType): boolean {
    const enabled = this.config.enabledPropertyTypes;
    if (!enabled || enabled.length === 0) return true;
    return enabled.includes(type);
  }

  /** Verifies the schema name matches what the slug would derive, so a tampered
   *  registry row cannot point a tenant at another tenant's schema. */
  assertSchemaNameConsistent(): void {
    const expected = TenantSlug.parse(this.props.slug).schemaName;
    if (expected !== this.props.schemaName) {
      throw new ForbiddenError({
        code: 'TENANT_REGISTRY_INCONSISTENT',
        message: 'Municipality registry entry is inconsistent',
      });
    }
  }
}
