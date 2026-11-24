import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  UNIT_TYPE_ADMIN_ROLES,
  UNIT_TYPE_READ_ROLES,
  createUnitTypeSchema,
  listUnitTypesQuerySchema,
  updateUnitTypeSchema,
  type CreateUnitTypeInput,
  type ListUnitTypesQuery,
  type UpdateUnitTypeInput,
} from '@mechanization/shared-schemas';
import { UnitTypesService } from '../../application/features/buildings/unit-types.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

/**
 * «أنواع الوحدات» — the municipality's unit types (migration 0109).
 *
 * Read by everyone who reads or edits a building's units (`UNIT_TYPE_READ_ROLES`):
 * the matrix, the building editor, the census reports, and an inspector's
 * offline store. Added and edited by the manager (`UNIT_TYPE_ADMIN_ROLES`),
 * Tier 1. There is no delete: a type is switched off. A custom type bills as
 * its base type.
 */
@Controller('t/:tenantSlug/unit-types')
export class UnitTypesController {
  constructor(private readonly types: UnitTypesService) {}

  @Roles(...UNIT_TYPE_READ_ROLES)
  @Get()
  list(@Query(new ZodValidationPipe(listUnitTypesQuerySchema)) query: ListUnitTypesQuery) {
    return this.types.list({ includeInactive: query.includeInactive });
  }

  @Roles(...UNIT_TYPE_ADMIN_ROLES)
  @Post()
  create(
    @Body(new ZodValidationPipe(createUnitTypeSchema)) body: CreateUnitTypeInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.types.create(body, actor);
  }

  @Roles(...UNIT_TYPE_ADMIN_ROLES)
  @Patch(':id')
  update(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(updateUnitTypeSchema)) body: UpdateUnitTypeInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.types.update(id, body, actor);
  }
}
