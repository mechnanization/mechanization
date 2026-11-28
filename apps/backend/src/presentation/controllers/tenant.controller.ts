import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  WORKING_STAFF_ROLES,
} from '@mechanization/shared-schemas';
import { TenantService } from '../../application/features/tenant/tenant.service';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { CurrentTenant } from '../decorators/current-user.decorator';
import { DEFAULT_THROTTLE } from '../http/throttlers';

@Controller('t/:tenantSlug/tenant')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  /**
   * Branding and wizard configuration for the public form. Unauthenticated by
   * necessity — the citizen needs it before any account exists — so it returns
   * only what a stranger may see, never the admin path or the schema name.
   * The default bar (SEC-07): read once per page load and cached, so a reader
   * never comes near it.
   */
  @Public()
  @Throttle(DEFAULT_THROTTLE)
  @Get('config')
  async getPublicConfig(@CurrentTenant('slug') tenantSlug: string) {
    return this.tenants.getPublicConfig(tenantSlug);
  }

  @Roles(...WORKING_STAFF_ROLES)
  @Get('admin-config')
  async getAdminConfig(@CurrentTenant('slug') tenantSlug: string) {
    return this.tenants.getAdminConfig(tenantSlug);
  }
}
