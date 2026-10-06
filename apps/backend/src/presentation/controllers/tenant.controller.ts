import { Controller, Get, Param } from '@nestjs/common';
import {
  WORKING_STAFF_ROLES,
} from '@mechanization/shared-schemas';
import { TenantService } from '../../application/features/tenant/tenant.service';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';

@Controller('t/:tenantSlug/tenant')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  /**
   * Branding and wizard configuration for the public form. Unauthenticated by
   * necessity — the citizen needs it before any account exists — so it returns
   * only what a stranger may see, never the admin path or the schema name.
   */
  @Public()
  @Get('config')
  async getPublicConfig(@Param('tenantSlug') tenantSlug: string) {
    return this.tenants.getPublicConfig(tenantSlug);
  }

  @Roles(...WORKING_STAFF_ROLES)
  @Get('admin-config')
  async getAdminConfig(@Param('tenantSlug') tenantSlug: string) {
    return this.tenants.getAdminConfig(tenantSlug);
  }
}
