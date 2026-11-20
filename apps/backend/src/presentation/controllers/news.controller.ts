import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  NEWS_EDITOR_ROLES,
  NEWS_LANGUAGE,
  createNewsCategorySchema,
  createNewsPublisherSchema,
  updateNewsCategorySchema,
  updateNewsPublisherSchema,
  type CreateNewsCategoryInput,
  type CreateNewsPublisherInput,
  type NewsLanguage,
  type UpdateNewsCategoryInput,
  type UpdateNewsPublisherInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { NewsAvailabilityService } from '../../application/features/news/news-availability.service';
import { NewsCatalogService, type NewsActor } from '../../application/features/news/news-catalog.service';
import { CurrentTenant, CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import { optionalOneOf } from './query-params';

/**
 * «الأخبار» on Day3ati: the categories an article is filed under and the
 * publishers it is published as.
 *
 * Only the staff who manage News (`NEWS_EDITOR_ROLES`) call these, and each
 * call is made on Day3ati as the person who is signed in: their own account
 * there, in their own municipality's village. Nothing is stored here and no
 * route takes a village or a tenant from the client. `?lang=` is the language
 * Day3ati writes its own messages in (Arabic by default).
 */
@Controller('t/:tenantSlug/news')
export class NewsController {
  constructor(
    private readonly catalog: NewsCatalogService,
    private readonly availability: NewsAvailabilityService,
  ) {}

  /** Whether News is on for this municipality (its Day3ati village lists the module): what hides the screens. */
  @Roles(...NEWS_EDITOR_ROLES)
  @Get('availability')
  isAvailable(@CurrentTenant('slug') tenantSlug: string) {
    return this.availability.of(tenantSlug);
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Get('categories')
  listCategories(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.listCategories(actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post('categories')
  createCategory(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(createNewsCategorySchema)) body: CreateNewsCategoryInput,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.createCategory(body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Put('categories/:id')
  updateCategory(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(updateNewsCategorySchema)) body: UpdateNewsCategoryInput,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.updateCategory(id, body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Get('publishers')
  listPublishers(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.listPublishers(actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Post('publishers')
  createPublisher(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(createNewsPublisherSchema)) body: CreateNewsPublisherInput,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.createPublisher(body, actor(tenantSlug, user), language(lang));
  }

  @Roles(...NEWS_EDITOR_ROLES)
  @Put('publishers/:id')
  updatePublisher(
    @CurrentTenant('slug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(updateNewsPublisherSchema)) body: UpdateNewsPublisherInput,
    @Query('lang') lang?: string,
  ) {
    return this.catalog.updatePublisher(id, body, actor(tenantSlug, user), language(lang));
  }
}

const actor = (tenantSlug: string, user: SessionClaims): NewsActor => ({
  tenantSlug,
  id: user.sub,
  role: user.role ?? '',
});

/** The language of Day3ati's own messages: one it speaks, Arabic when none is named. */
const language = (value: string | undefined): NewsLanguage => optionalOneOf(value, NEWS_LANGUAGE) ?? 'ar';
