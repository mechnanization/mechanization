import { Body, Controller, Delete, Get, Header, Param, Post, Put } from '@nestjs/common';
import {
  type CreateZoneInput,
  type UpdateZoneInput,
  createZoneSchema,
  updateZoneSchema,
} from '@mechanization/shared-schemas';
import { ZonesService } from '../../application/features/zones/zones.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * Sits under `t/:tenantSlug` like every other tenant-scoped controller — that
 * prefix is what `TenantMiddleware` binds to, so a zone route outside it would
 * run with no tenant-scoped Prisma client at all.
 */
@Controller('t/:tenantSlug/zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  /**
   * Every sector with its parcel count. Reading sectors is part of reading
   * the map, so every staff role may.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'VIEWER')
  @Get()
  async list() {
    return { zones: await this.zones.list() };
  }

  /**
   * The zone overlay both maps draw. Served from the API rather than as a static
   * asset like the cadastre layers: zone membership changes whenever an admin
   * saves the editor, where the cadastre changes only on a manual re-import.
   *
   * Not cached at the HTTP layer for the same reason — an admin who saves a
   * sector expects to see it on the map immediately, and the expensive part
   * (dissolving member parcels) is already memoised per zone in the service.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'VIEWER')
  @Get('geojson')
  @Header('Cache-Control', 'no-store')
  async geojson(@Param('tenantSlug') tenantSlug: string) {
    return this.zones.buildGeoJson(tenantSlug);
  }

  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'VIEWER')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.zones.get(id);
  }

  /**
   * SUPER_ADMIN and ADMINISTRATIVE_OFFICER for the writes below: sectors
   * decide which inspector is accountable for which parcels and how coverage
   * is reported, so redrawing them is an administrative act rather than
   * day-to-day case work — which is the clerical role's remit, not the
   * inspector's. Deletion stays SUPER_ADMIN only: it is the one write that
   * cannot be corrected by drawing the boundary again.
   */
  @Roles('SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER')
  @Post()
  async create(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(createZoneSchema)) body: CreateZoneInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.zones.create(tenantSlug, body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles('SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER')
  @Put(':id')
  async update(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateZoneSchema)) body: UpdateZoneInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.zones.update(tenantSlug, id, body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  async remove(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    await this.zones.remove(tenantSlug, id, { id: user.sub, role: user.role ?? '' });
    return { deleted: true };
  }
}
