import { Body, Controller, Delete, HttpCode, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  NEWS_EDITOR_ROLES,
  NEWS_LANGUAGE,
  NEWS_PDF_MAX_BYTES,
  uploadNewsMediaSchema,
  type NewsLanguage,
  type UploadNewsMediaInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import type { NewsActor } from '../../application/features/news/news-changes';
import { NewsMediaService } from '../../application/features/news/news-media.service';
import { CurrentTenant, CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import { optionalOneOf } from './query-params';

/**
 * One file per request, read into memory: the size is capped here, before the
 * service sees a byte, at the largest a News file may be (a PDF); the type is
 * sniffed from the bytes there and the smaller photo limit applied. The text
 * fields (the switch, three captions, the id a file replaces) are few and short.
 */
const MEDIA_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: NEWS_PDF_MAX_BYTES, files: 1, fields: 6, fieldSize: 2_048, parts: 7 },
});

/**
 * «الأخبار»: the photos and PDFs of an article, on Day3ati.
 *
 * `NEWS_EDITOR_ROLES` only, each call made on Day3ati as the person signed in.
 * An upload is a photo (processed in the background by Day3ati, so the answer
 * may say `processing`) or a PDF; the editor reads the article again to follow
 * it. `?lang=` is the language of Day3ati's own messages.
 */
@Controller('t/:tenantSlug/news/articles/:id/media')
export class NewsMediaController {
  constructor(private readonly media: NewsMediaService) {}

  @Roles(...NEWS_EDITOR_ROLES)
  @Post()
  @UseInterceptors(MEDIA_UPLOAD)
  upload(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadNewsMediaSchema)) body: UploadNewsMediaInput,
    @Query('lang') lang?: string,
  ) {
    return this.media.upload(id, file?.buffer, body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Put(':mediaId/cover')
  setCover(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Param('mediaId', new UuidPipe()) mediaId: string,
    @Query('lang') lang?: string,
  ) {
    return this.media.setCover(id, mediaId, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Delete(':mediaId')
  @HttpCode(204)
  async remove(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Param('mediaId', new UuidPipe()) mediaId: string,
    @Query('lang') lang?: string,
  ): Promise<void> {
    await this.media.remove(id, mediaId, actor(tenantSlug, user), language(lang));
  }
}

const actor = (tenantSlug: string, user: SessionClaims): NewsActor => ({
  tenantSlug,
  id: user.sub,
  role: user.role ?? '',
});

const language = (value: string | undefined): NewsLanguage => optionalOneOf(value, NEWS_LANGUAGE) ?? 'ar';
