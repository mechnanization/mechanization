import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { unitCorrectionDeleteSchema, type UnitCorrectionDeleteInput } from '@mechanization/shared-schemas';
import { UnitCorrectionService } from '../../application/features/corrections/unit-correction.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * «حذف تصحيحي» — corrections the ordinary routes refuse on purpose.
 *
 * SUPER_ADMIN only, on both routes, the preview included: what a correction
 * would erase is itself a list of people and where they live, and nobody who
 * cannot perform the correction needs to read it.
 *
 * Its own controller rather than more routes on `BuildingsController`, so the
 * one place that bypasses the census's delete guards is easy to find and to
 * review, and its role cannot drift to `WRITE_ROLES` with the routes around it.
 */
@Controller('t/:tenantSlug/corrections')
export class CorrectionsController {
  constructor(private readonly units: UnitCorrectionService) {}

  /** What deleting this unit would remove, close and change, with the fingerprint the delete must quote. */
  @Roles('SUPER_ADMIN')
  @Get('units/:unitId')
  previewUnit(@Param('unitId', new ParseUUIDPipe()) unitId: string) {
    return this.units.preview(unitId);
  }

  /** Deletes the unit exactly as previewed, or changes nothing. */
  @Roles('SUPER_ADMIN')
  @Post('units/:unitId')
  deleteUnit(
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Body(new ZodValidationPipe(unitCorrectionDeleteSchema)) body: UnitCorrectionDeleteInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.units.apply(unitId, body, { id: user.sub, role: user.role ?? '' });
  }
}
