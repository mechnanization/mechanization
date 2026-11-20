import {
  type CreateNewsCategoryInput,
  type CreateNewsPublisherInput,
  type NewsCategoryView,
  type NewsLanguage,
  type NewsPublisherView,
  type UpdateNewsCategoryInput,
  type UpdateNewsPublisherInput,
} from '@mechanization/shared-schemas';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictError } from '../../../domain/errors/domain-error';
import { DAY3ATI_NEWS, type Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import { readAll, toCategoryView, toPublisherView } from './news-views';

/** Who is asking: their municipality, and the account Day3ati knows them by (our staff id). */
export interface NewsActor {
  tenantSlug: string;
  id: string;
  role: string;
}

const CATEGORIES = '/api/v1/news/manage/categories';
const PUBLISHERS = '/api/v1/news/manage/publishers';

/**
 * The lists a News article is filed under (categories) and published as
 * (publishers), kept on Day3ati and managed here as the signed-in user.
 *
 * Nothing is stored on our side. Each call goes to Day3ati through
 * `DAY3ATI_NEWS`, which adds the user's token, village and language and turns a
 * refusal into a coded `NEWS_*` error; what comes back is read into our own
 * views (`news-views.ts`). A change that Day3ati accepted leaves an audit row
 * (`news.changed`, Tier 2): the content is Day3ati's, but who changed what, and
 * when, is ours to answer for.
 *
 * A PUT replaces the whole record, so an edit sends every field. A category is
 * switched off, never deleted: Day3ati has no delete for either list.
 */
@Injectable()
export class NewsCatalogService {
  private readonly logger = new Logger(NewsCatalogService.name);

  constructor(
    @Inject(DAY3ATI_NEWS) private readonly news: Day3atiNews,
    private readonly events: EventEmitter2,
  ) {}

  async listCategories(who: NewsActor, language: NewsLanguage): Promise<NewsCategoryView[]> {
    const body = await this.news.request({ ...call(who, language), method: 'GET', path: CATEGORIES });
    return this.read(readAll(body, toCategoryView), 'category list');
  }

  async createCategory(
    input: CreateNewsCategoryInput,
    who: NewsActor,
    language: NewsLanguage,
  ): Promise<NewsCategoryView> {
    const body = await this.news.request({ ...call(who, language), method: 'POST', path: CATEGORIES, body: input });
    const created = this.read(toCategoryView(body), 'created category');
    this.changed(who, 'NEWS_CATEGORY_CREATED', 'NewsCategory', created.id, {
      key: created.key,
      isActive: created.isActive,
    });
    return created;
  }

  async updateCategory(
    id: string,
    input: UpdateNewsCategoryInput,
    who: NewsActor,
    language: NewsLanguage,
  ): Promise<NewsCategoryView> {
    // Day3ati requires the property on a PUT and ignores its value: the key never changes.
    const body = await this.news.request({
      ...call(who, language),
      method: 'PUT',
      path: `${CATEGORIES}/${encodeURIComponent(id)}`,
      body: { ...input, key: null },
    });
    const updated = this.read(toCategoryView(body), 'updated category');
    this.changed(who, 'NEWS_CATEGORY_UPDATED', 'NewsCategory', updated.id, {
      key: updated.key,
      isActive: updated.isActive,
    });
    return updated;
  }

  async listPublishers(who: NewsActor, language: NewsLanguage): Promise<NewsPublisherView[]> {
    const body = await this.news.request({ ...call(who, language), method: 'GET', path: PUBLISHERS });
    return this.read(readAll(body, toPublisherView), 'publisher list');
  }

  async createPublisher(
    input: CreateNewsPublisherInput,
    who: NewsActor,
    language: NewsLanguage,
  ): Promise<NewsPublisherView> {
    const body = await this.news.request({ ...call(who, language), method: 'POST', path: PUBLISHERS, body: input });
    const created = this.read(toPublisherView(body), 'created publisher');
    this.changed(who, 'NEWS_PUBLISHER_CREATED', 'NewsPublisher', created.id, {
      kind: created.kind,
      isActive: created.isActive,
    });
    return created;
  }

  async updatePublisher(
    id: string,
    input: UpdateNewsPublisherInput,
    who: NewsActor,
    language: NewsLanguage,
  ): Promise<NewsPublisherView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'PUT',
      path: `${PUBLISHERS}/${encodeURIComponent(id)}`,
      body: input,
    });
    const updated = this.read(toPublisherView(body), 'updated publisher');
    this.changed(who, 'NEWS_PUBLISHER_UPDATED', 'NewsPublisher', updated.id, {
      kind: updated.kind,
      isActive: updated.isActive,
    });
    return updated;
  }

  /** An answer that is not what the contract says is News being unavailable, never a half-read list. */
  private read<T>(value: T | null, what: string): T {
    if (value !== null) return value;
    this.logger.error(`Day3ati answered a ${what} in a form this build does not read`);
    throw new ConflictError({ code: 'NEWS_UNAVAILABLE', message: `Day3ati answered a ${what} in an unreadable form` });
  }

  private changed(
    who: NewsActor,
    action: string,
    entityType: string,
    entityId: string,
    after: Record<string, unknown>,
  ): void {
    // After Day3ati accepted it: a refused change leaves no row. Ids and switches only, never the names.
    this.events.emit('news.changed', {
      tenantSlug: who.tenantSlug,
      action,
      entityType,
      entityId,
      after,
      actorId: who.id,
      actorRole: who.role,
    });
  }
}

function call(who: NewsActor, language: NewsLanguage) {
  return { tenantSlug: who.tenantSlug, userId: who.id, language };
}
