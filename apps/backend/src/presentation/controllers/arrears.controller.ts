import { createHash } from 'node:crypto';
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ARREARS_APPROVE_ROLES,
  ARREARS_PREPARE_ROLES,
  ARREARS_REPORT_ROLES,
  approveArrearsBatchSchema,
  arrearsCutoffSchema,
  arrearsSingleLineSchema,
  discardArrearsBatchSchema,
  exportArrearsTemplateSchema,
  importArrearsSchema,
  linkArrearsLineSchema,
  returnArrearsBatchSchema,
  submitArrearsBatchSchema,
  type ArrearsCutoffInput,
  type ArrearsSingleLineInput,
  type DiscardArrearsBatchInput,
  type ExportArrearsTemplateInput,
  type ImportArrearsInput,
  type LinkArrearsLineInput,
  type ReturnArrearsBatchInput,
  type SubmitArrearsBatchInput,
} from '@mechanization/shared-schemas';
import { ArrearsBatchService } from '../../application/features/arrears/arrears-batch.service';
import { ArrearsReportService } from '../../application/features/arrears/arrears-report.service';
import { ArrearsService } from '../../application/features/arrears/arrears.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { APP_CONFIG } from '../../application/common/app.config';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
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
 * export and the import's dry run and write (task 4), and a batch's life after
 * it (task 5): submit, return, discard, approve, a single line, the link of a
 * «للمطابقة» line, and the cutoff year. The accountant and the manager prepare
 * (`ARREARS_PREPARE_ROLES`); the manager alone approves, returns, reads the
 * review and sets the cutoff (`ARREARS_APPROVE_ROLES`). Nothing here reaches
 * the portal until a batch is approved and its bills are raised.
 */
@Controller('t/:tenantSlug/arrears')
export class ArrearsController {
  constructor(
    private readonly arrears: ArrearsService,
    private readonly batches: ArrearsBatchService,
    private readonly reports: ArrearsReportService,
  ) {}

  /**
   * «تصدير قالب»: a DRAFT batch for the next `count` citizens of a zone or a
   * building, and the template's rows. Names, رقم العقار and unit codes only.
   */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Throttle(ARREARS_BULK_THROTTLE)
  @Post('batches/export')
  exportTemplate(
    @Body(new ZodValidationPipe(exportArrearsTemplateSchema)) body: ExportArrearsTemplateInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.arrears.exportTemplate(body, actor);
  }

  /** The filled template: checked (`dryRun`), or written into the DRAFT batch. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Throttle(ARREARS_BULK_THROTTLE)
  @Post('batches/:batchId/import')
  importLines(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(importArrearsSchema)) body: ImportArrearsInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.arrears.importLines(batchId, body, actor);
  }

  /** The batches, newest first. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Get('batches')
  listBatches() {
    return this.batches.list();
  }

  /**
   * «تقرير المتأخرات» (task 11): by year and fee type, what was approved, collected, cancelled, written
   * off and is still owed, against the old books' totals, with the old debts' collections apart from the
   * rest. Sums only, no citizen: the finance reports' readers (`ARREARS_REPORT_ROLES`).
   */
  @Roles(...ARREARS_REPORT_ROLES)
  @Get('report')
  report() {
    return this.reports.report();
  }

  /** The page the head of the municipality signs for an approved batch (task 11). */
  @Roles(...ARREARS_REPORT_ROLES)
  @Get('batches/:batchId/sheet')
  sheet(@Param('batchId', new UuidPipe()) batchId: string) {
    return this.reports.sheet(batchId);
  }

  /** A submitted batch as the manager reviews it. */
  @Roles(...ARREARS_APPROVE_ROLES)
  @Get('batches/:batchId/review')
  review(@Param('batchId', new UuidPipe()) batchId: string) {
    return this.batches.review(batchId);
  }

  /** «إرسال للاعتماد»: a draft with the total of the pages copied. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Post('batches/:batchId/submit')
  submit(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(submitArrearsBatchSchema)) body: SubmitArrearsBatchInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.submit(batchId, body, actor);
  }

  /** Approval raises the bills and locks the batch. */
  @Roles(...ARREARS_APPROVE_ROLES)
  @Post('batches/:batchId/approve')
  approve(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(approveArrearsBatchSchema)) _body: Record<string, never>,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.approve(batchId, actor);
  }

  /** Back to the preparer as a draft, with what to fix. */
  @Roles(...ARREARS_APPROVE_ROLES)
  @Post('batches/:batchId/return')
  returnBatch(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(returnArrearsBatchSchema)) body: ReturnArrearsBatchInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.returnBatch(batchId, body, actor);
  }

  /** A draft by its preparer or the manager; a submitted batch by the manager alone (the service asks). */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Post('batches/:batchId/discard')
  discard(
    @Param('batchId', new UuidPipe()) batchId: string,
    @Body(new ZodValidationPipe(discardArrearsBatchSchema)) body: DiscardArrearsBatchInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.discard(batchId, body, actor);
  }

  /** One line found later: a one-line batch through the same checks and the same approval. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Post('lines')
  addLine(
    @Body(new ZodValidationPipe(arrearsSingleLineSchema)) body: ArrearsSingleLineInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.addSingleLine(body, actor);
  }

  /** The lines of approved batches whose person is not on the register yet. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Get('lines/unmatched')
  unmatched() {
    return this.batches.unmatched();
  }

  /** Links a «للمطابقة» line to a file; its bill is raised then. */
  @Roles(...ARREARS_PREPARE_ROLES)
  @Post('lines/:lineId/link')
  link(
    @Param('lineId', new UuidPipe()) lineId: string,
    @Body(new ZodValidationPipe(linkArrearsLineSchema)) body: LinkArrearsLineInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.link(lineId, body, actor);
  }

  /** The cutoff year, and the old books' totals as the table holds them. */
  @Roles(...ARREARS_APPROVE_ROLES)
  @Get('settings')
  settings() {
    return this.batches.settings();
  }

  /** Sets the year before which a debt is old (decision 5). */
  @Roles(...ARREARS_APPROVE_ROLES)
  @Put('settings/cutoff')
  setCutoff(
    @Body(new ZodValidationPipe(arrearsCutoffSchema)) body: ArrearsCutoffInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.batches.setCutoff(body, actor);
  }
}
