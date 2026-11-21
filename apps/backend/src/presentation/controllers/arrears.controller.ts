import { createHash } from 'node:crypto';
import { Body, Controller, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ARREARS_PREPARE_ROLES,
  exportArrearsTemplateSchema,
  importArrearsSchema,
  type ExportArrearsTemplateInput,
  type ImportArrearsInput,
} from '@mechanization/shared-schemas';
import { ArrearsService } from '../../application/features/arrears/arrears.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { APP_CONFIG } from '../config/app.config';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

/**
 * Old debts' bulk routes, export and import, counted per session
 * (`APP_CONFIG.throttle.arrearsBulk`): behind nginx every clerk shares one IP.
 */
const ARREARS_BULK_THROTTLE = {
  default: {
    limit: APP_CONFIG.throttle.arrearsBulk.limit,
    ttl: APP_CONFIG.throttle.arrearsBulk.ttlSeconds * 1000,
    getTracker: (request: Record<string, unknown>) => {
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const authorization = headers.authorization;
      const key = typeof authorization === 'string' ? authorization : `ip:${String(request.ip)}`;
      return `arrears-bulk:${createHash('sha256').update(key).digest('hex')}`;
    },
  },
};

/**
 * Old debts, «متأخرات سنوات سابقة» (docs/old-debts-plan.md): the template's
 * export and the import's dry run and write (task 4). The accountant and the
 * manager (`ARREARS_PREPARE_ROLES`); nothing here reaches the portal, and a
 * DRAFT batch is seen by no citizen. Submitting, approving and the bills are
 * task 5.
 */
@Controller('t/:tenantSlug/arrears')
export class ArrearsController {
  constructor(private readonly arrears: ArrearsService) {}

  /**
   * «تصدير قالب»: a DRAFT batch for the next `count` citizens of a zone or a
   * building, and the template's rows. Names, رقم العقار and unit codes only.
   */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Throttle(ARREARS_BULK_THROTTLE)
  @Post('batches/export')
  exportTemplate(
    @Body(new ZodValidationPipe(exportArrearsTemplateSchema)) body: ExportArrearsTemplateInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.arrears.exportTemplate(body, { id: user.sub, role: user.role ?? '' });
  }

  /** The filled template: checked (`dryRun`), or written into the DRAFT batch. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Throttle(ARREARS_BULK_THROTTLE)
  @Post('batches/:batchId/import')
  importLines(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(importArrearsSchema)) body: ImportArrearsInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.arrears.importLines(batchId, body, { id: user.sub, role: user.role ?? '' });
  }
}
