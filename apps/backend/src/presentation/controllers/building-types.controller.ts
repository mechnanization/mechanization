import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  BUILDING_TYPE_ADMIN_ROLES,
  BUILDING_TYPE_READ_ROLES,
  createBuildingTypeSchema,
  listBuildingTypesQuerySchema,
  updateBuildingTypeSchema,
  type CreateBuildingTypeInput,
  type ListBuildingTypesQuery,
  type UpdateBuildingTypeInput,
} from '@mechanization/shared-schemas';
import { BuildingTypesService } from '../../application/features/buildings/building-types.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * «أنواع المباني» — the municipality's building types (migration 0106).
 *
 * Read by everyone who reads or creates buildings (`BUILDING_TYPE_READ_ROLES`):
 * the building wizard and editor, the map's filter and legend, the census
 * reports, and an inspector's offline store. Added and edited by the manager
 * (`BUILDING_TYPE_ADMIN_ROLES`), Tier 1. There is no delete: a type is
 * switched off.
 */
@Controller('t/:tenantSlug/building-types')
export class BuildingTypesController {
  constructor(private readonly types: BuildingTypesService) {}

  @Roles(...BUILDING_TYPE_READ_ROLES)
  @Get()
  list(@Query(new ZodValidationPipe(listBuildingTypesQuerySchema)) query: ListBuildingTypesQuery) {
    return this.types.list({ includeInactive: query.includeInactive });
  }

  @Roles(...BUILDING_TYPE_ADMIN_ROLES)
  @Post()
  create(
    @Body(new ZodValidationPipe(createBuildingTypeSchema)) body: CreateBuildingTypeInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.types.create(body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles(...BUILDING_TYPE_ADMIN_ROLES)
  @Patch(':id')
  update(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(updateBuildingTypeSchema)) body: UpdateBuildingTypeInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.types.update(id, body, { id: user.sub, role: user.role ?? '' });
  }
}
