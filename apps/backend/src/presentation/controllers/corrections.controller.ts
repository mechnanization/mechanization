import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  duplexMergeSchema,
  unitCorrectionDeleteSchema,
  type DuplexMergeInput,
  type UnitCorrectionDeleteInput,
} from '@mechanization/shared-schemas';
import { UnitCorrectionService } from '../../application/features/corrections/unit-correction.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

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
  previewUnit(@Param('unitId', new UuidPipe()) unitId: string) {
    return this.units.preview(unitId);
  }

  /** Deletes the unit exactly as previewed, or changes nothing. */
  @Roles('SUPER_ADMIN')
  @Post('units/:unitId')
  deleteUnit(
    @Param('unitId', new UuidPipe()) unitId: string,
    @Body(new ZodValidationPipe(unitCorrectionDeleteSchema)) body: UnitCorrectionDeleteInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.units.apply(unitId, body, actor);
  }

  /**
   * «دمج مع الوحدة العلوية كدوبلكس» (D28): what folding the flat directly above
   * into this one would do, with the fingerprint the merge must quote.
   */
  @Roles('SUPER_ADMIN')
  @Get('units/:unitId/merge-upper')
  previewMerge(@Param('unitId', new UuidPipe()) unitId: string) {
    return this.units.previewMerge(unitId);
  }

  /** Folds the flat above into this one exactly as previewed, or changes nothing. */
  @Roles('SUPER_ADMIN')
  @Post('units/:unitId/merge-upper')
  mergeUpper(
    @Param('unitId', new UuidPipe()) unitId: string,
    @Body(new ZodValidationPipe(duplexMergeSchema)) body: DuplexMergeInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.units.applyMerge(unitId, body, actor);
  }
}
