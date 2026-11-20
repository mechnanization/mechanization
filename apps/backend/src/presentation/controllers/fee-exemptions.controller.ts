import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  FEE_EXEMPTION_READ_ROLES,
  feeExemptionListQuerySchema,
  feeExemptionUnitLookupSchema,
  type FeeExemptionListQuery,
  type FeeExemptionUnitLookup,
} from '@mechanization/shared-schemas';
import { FeeExemptionService } from '../../application/features/buildings/fee-exemption.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * «قائمة الإعفاء من الرسوم» — the whitelist of units exempt from fees, a
 * unit's exemption history, and the units one person holds (migration 0104;
 * the user's decisions of 2026-11-16).
 *
 * Read-only, and staff only: every answer names the people on the units, so
 * the audience is `FEE_EXEMPTION_READ_ROLES` (the manager, the administrative
 * officer, the accountant and the auditor; never the collector, the field
 * inspector or «مشاهد فقط») and never the portal. Granting and lifting stay
 * `PUT buildings/units/:unitId/fee-exemption`, the manager's alone.
 *
 * Static paths are declared before the ones with an id.
 */
@Controller('t/:tenantSlug/fee-exemptions')
export class FeeExemptionsController {
  constructor(private readonly exemptions: FeeExemptionService) {}

  /** The whitelist: standing or lifted periods, searched and paged on the server. */
  @Roles(...FEE_EXEMPTION_READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(feeExemptionListQuerySchema)) query: FeeExemptionListQuery,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.exemptions.list(query, { role: user.role ?? '' });
  }

  /** One unit by its full reference, «<building code>-<unit code>». */
  @Roles(...FEE_EXEMPTION_READ_ROLES)
  @Get('units')
  unitByReference(@Query(new ZodValidationPipe(feeExemptionUnitLookupSchema)) query: FeeExemptionUnitLookup) {
    return this.exemptions.unitByReference(query.reference);
  }

  /** One unit: who holds it, its standing exemption and every period. */
  @Roles(...FEE_EXEMPTION_READ_ROLES)
  @Get('units/:unitId')
  unit(@Param('unitId', new UuidPipe()) unitId: string) {
    return this.exemptions.unitView(unitId);
  }

  /** Every unit one person holds now, structural floors left out, each with its exemption. */
  @Roles(...FEE_EXEMPTION_READ_ROLES)
  @Get('citizens/:citizenId/units')
  citizenUnits(@Param('citizenId', new UuidPipe()) citizenId: string) {
    return this.exemptions.citizenUnits(citizenId);
  }
}
