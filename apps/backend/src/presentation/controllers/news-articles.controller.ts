import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  NEWS_ARTICLES_PAGE_DEFAULT,
  NEWS_ARTICLES_PAGE_MAX,
  NEWS_ARTICLE_STATUS,
  NEWS_CURSOR_MAX,
  NEWS_EDITOR_ROLES,
  NEWS_LANGUAGE,
  newsPlacementSchema,
  publishNewsArticleSchema,
  saveNewsArticleSchema,
  type NewsLanguage,
  type NewsPlacementInput,
  type PublishNewsArticleInput,
  type SaveNewsArticleInput,
} from '@mechanization/shared-schemas';
import { ValidationError } from '../../domain/errors/domain-error';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { NewsArticlesService } from '../../application/features/news/news-articles.service';
import type { NewsActor } from '../../application/features/news/news-changes';
import { CurrentTenant, CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import { optionalOneOf, queryLimit } from './query-params';

/**
 * «الأخبار»: the articles themselves, on Day3ati.
 *
 * Written, edited, published, scheduled, archived, pinned and deleted by the
 * staff who manage News (`NEWS_EDITOR_ROLES`), each call made on Day3ati as the
 * person signed in, in their own municipality's village. Day3ati keeps the
 * articles and decides what a status allows; nothing is stored here. `?lang=` is
 * the language of its own messages (Arabic by default). The photos and PDFs of
 * an article have their own routes, with their own task.
 */
@Controller('t/:tenantSlug/news/articles')
export class NewsArticlesController {
  constructor(private readonly articles: NewsArticlesService) {}

  @Roles(...NEWS_EDITOR_ROLES)
  @Get()
  list(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('lang') lang?: string,
  ) {
    return this.articles.list(
      actor(tenantSlug, user),
      {
        status: optionalOneOf(status, NEWS_ARTICLE_STATUS),
        cursor: optionalCursor(cursor),
        limit: queryLimit(limit, NEWS_ARTICLES_PAGE_DEFAULT, NEWS_ARTICLES_PAGE_MAX),
      },
      language(lang),
    );
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post()
  create(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(saveNewsArticleSchema)) body: SaveNewsArticleInput,
    @Query('lang') lang?: string,
  ) {
    return this.articles.create(body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Get(':id')
  get(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Query('lang') lang?: string,
  ) {
    return this.articles.get(id, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Put(':id')
  update(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(saveNewsArticleSchema)) body: SaveNewsArticleInput,
    @Query('lang') lang?: string,
  ) {
    return this.articles.update(id, body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(publishNewsArticleSchema)) body: PublishNewsArticleInput,
    @Query('lang') lang?: string,
  ) {
    return this.articles.publish(id, body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post(':id/archive')
  @HttpCode(200)
  archive(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Query('lang') lang?: string,
  ) {
    return this.articles.archive(id, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post(':id/draft')
  @HttpCode(200)
  cancelSchedule(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Query('lang') lang?: string,
  ) {
    return this.articles.cancelSchedule(id, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Put(':id/placement')
  setPlacement(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(newsPlacementSchema)) body: NewsPlacementInput,
    @Query('lang') lang?: string,
  ) {
    return this.articles.setPlacement(id, body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Query('lang') lang?: string,
  ): Promise<void> {
    await this.articles.remove(id, actor(tenantSlug, user), language(lang));
  }
}

const actor = (tenantSlug: string, user: SessionClaims): NewsActor => ({
  tenantSlug,
  id: user.sub,
  role: user.role ?? '',
});

/** The language of Day3ati's own messages: one it speaks, Arabic when none is named. */
const language = (value: string | undefined): NewsLanguage => optionalOneOf(value, NEWS_LANGUAGE) ?? 'ar';

/**
 * A page cursor from a query string. It is Day3ati's and opaque to us, so it is
 * only bounded: not empty, at most `NEWS_CURSOR_MAX` characters, no control
 * characters. It is sent on as a query value, never put in a path.
 */
function optionalCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  // eslint-disable-next-line no-control-regex
  if (value.length > NEWS_CURSOR_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError({ code: 'INVALID_QUERY_VALUE', message: 'The page cursor is not one this list gave' });
  }
  return value;
}
