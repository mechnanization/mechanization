import {
  type NewsArticlePage,
  type NewsArticleStatus,
  type NewsArticleView,
  type NewsLanguage,
  type NewsPlacementInput,
  type PublishNewsArticleInput,
  type SaveNewsArticleInput,
} from '@mechanization/shared-schemas';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictError } from '../../../domain/errors/domain-error';
import { DAY3ATI_NEWS, type Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import { emitNewsChanged, type NewsActor } from './news-changes';
import { toArticlePage, toArticleView } from './news-views';

const ARTICLES = '/api/v1/news/manage/articles';

/** What a list asks for: a status, the cursor of the page, and how many. */
export interface NewsArticleListQuery {
  status?: NewsArticleStatus;
  cursor?: string;
  limit: number;
}

/**
 * News articles on Day3ati, written and moved through their statuses as the
 * signed-in user. Nothing is stored here: each call goes to Day3ati through
 * `DAY3ATI_NEWS`, which adds the user's token, village and language and turns a
 * refusal into a coded `NEWS_*` error, and what comes back is read into our own
 * views (`news-views.ts`).
 *
 * - The status is Day3ati's: publishing, scheduling, archiving and cancelling a
 *   schedule are its operations, and it refuses the ones a status does not
 *   allow (scheduling a published article is `NEWS_ARTICLE_ALREADY_PUBLISHED`).
 *   This service does not second-guess it.
 * - An edit sends the whole article, because Day3ati's `PUT` replaces it: a
 *   language left out is removed.
 * - Each change Day3ati accepted leaves an audit row (`news.changed`): the
 *   article's id and status, never its text.
 */
@Injectable()
export class NewsArticlesService {
  private readonly logger = new Logger(NewsArticlesService.name);

  constructor(
    @Inject(DAY3ATI_NEWS) private readonly news: Day3atiNews,
    private readonly events: EventEmitter2,
  ) {}

  async list(who: NewsActor, query: NewsArticleListQuery, language: NewsLanguage): Promise<NewsArticlePage> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'GET',
      path: ARTICLES,
      query: { status: query.status, cursor: query.cursor, limit: query.limit },
    });
    return this.read(toArticlePage(body), 'article list');
  }

  async get(id: string, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({ ...call(who, language), method: 'GET', path: `${ARTICLES}/${encodeURIComponent(id)}` });
    return this.read(toArticleView(body), 'article');
  }

  async create(input: SaveNewsArticleInput, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({ ...call(who, language), method: 'POST', path: ARTICLES, body: input });
    const created = this.read(toArticleView(body), 'created article');
    this.changed(who, 'NEWS_ARTICLE_CREATED', created);
    return created;
  }

  async update(id: string, input: SaveNewsArticleInput, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'PUT',
      path: `${ARTICLES}/${encodeURIComponent(id)}`,
      body: input,
    });
    const updated = this.read(toArticleView(body), 'updated article');
    this.changed(who, 'NEWS_ARTICLE_UPDATED', updated);
    return updated;
  }

  /** Publishes now (`publishAt` null), or schedules it (an instant). The answer's status says which. */
  async publish(id: string, input: PublishNewsArticleInput, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'POST',
      path: `${ARTICLES}/${encodeURIComponent(id)}/publish`,
      body: input,
    });
    const published = this.read(toArticleView(body), 'published article');
    this.changed(who, published.status === 'scheduled' ? 'NEWS_ARTICLE_SCHEDULED' : 'NEWS_ARTICLE_PUBLISHED', published);
    return published;
  }

  /** Out of the feed; it can be published again. */
  async archive(id: string, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'POST',
      path: `${ARTICLES}/${encodeURIComponent(id)}/archive`,
    });
    const archived = this.read(toArticleView(body), 'archived article');
    this.changed(who, 'NEWS_ARTICLE_ARCHIVED', archived);
    return archived;
  }

  /** Cancels a schedule: the article goes back to a draft. */
  async cancelSchedule(id: string, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'POST',
      path: `${ARTICLES}/${encodeURIComponent(id)}/draft`,
    });
    const draft = this.read(toArticleView(body), 'article back to draft');
    this.changed(who, 'NEWS_ARTICLE_SCHEDULE_CANCELLED', draft);
    return draft;
  }

  async remove(id: string, who: NewsActor, language: NewsLanguage): Promise<void> {
    await this.news.request({
      ...call(who, language),
      method: 'DELETE',
      path: `${ARTICLES}/${encodeURIComponent(id)}`,
    });
    emitNewsChanged(this.events, who, { action: 'NEWS_ARTICLE_DELETED', entityType: 'NewsArticle', entityId: id });
  }

  /** Pinned on top of the feed, and/or featured in the carousel until a time. */
  async setPlacement(id: string, input: NewsPlacementInput, who: NewsActor, language: NewsLanguage): Promise<NewsArticleView> {
    const body = await this.news.request({
      ...call(who, language),
      method: 'PUT',
      path: `${ARTICLES}/${encodeURIComponent(id)}/placement`,
      body: input,
    });
    const placed = this.read(toArticleView(body), 'article placement');
    emitNewsChanged(this.events, who, {
      action: 'NEWS_ARTICLE_PLACEMENT_CHANGED',
      entityType: 'NewsArticle',
      entityId: placed.id,
      after: { status: placed.status, isPinned: placed.isPinned, featured: placed.featuredUntil !== null },
    });
    return placed;
  }

  /** An answer that is not what the contract says is News being unavailable, never a half-read article. */
  private read<T>(value: T | null, what: string): T {
    if (value !== null) return value;
    this.logger.error(`Day3ati answered a ${what} in a form this build does not read`);
    throw new ConflictError({ code: 'NEWS_UNAVAILABLE', message: `Day3ati answered a ${what} in an unreadable form` });
  }

  private changed(who: NewsActor, action: string, article: NewsArticleView): void {
    emitNewsChanged(this.events, who, {
      action,
      entityType: 'NewsArticle',
      entityId: article.id,
      after: { status: article.status },
    });
  }
}

function call(who: NewsActor, language: NewsLanguage) {
  return { tenantSlug: who.tenantSlug, userId: who.id, language };
}
