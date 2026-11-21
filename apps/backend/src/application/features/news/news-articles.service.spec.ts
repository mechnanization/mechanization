import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import { NewsArticlesService } from './news-articles.service';
import type { NewsActor } from './news-changes';

describe('NewsArticlesService', () => {
  const who: NewsActor = { tenantSlug: 'albazourieh', id: 'staff-1', role: 'SUPER_ADMIN' };
  const ID = '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d';
  const CATEGORY = '11111111-1111-4111-8111-111111111111';
  const PUBLISHER = '22222222-2222-4222-8222-222222222222';

  const article = (over: Record<string, unknown> = {}) => ({
    id: ID,
    status: 'draft',
    categoryId: CATEGORY,
    publisherId: PUBLISHER,
    authorUserId: '33333333-3333-4333-8333-333333333333',
    defaultLanguage: 'ar',
    texts: [{ language: 'ar', title: 'عنوان', summary: 'ملخص', body: 'نص' }],
    media: [],
    placeLabel: null,
    areaId: null,
    notifyResidents: false,
    publishAt: null,
    publishedAt: null,
    isPinned: false,
    featuredUntil: null,
    readingMinutes: 1,
    viewCount: 0,
    bookmarkCount: 0,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    ...over,
  });

  const input = {
    categoryId: CATEGORY,
    publisherId: PUBLISHER,
    defaultLanguage: 'ar' as const,
    texts: [{ language: 'ar' as const, title: 'عنوان', summary: null, body: 'نص' }],
    placeLabelAr: null,
    placeLabelEn: null,
    placeLabelFr: null,
    areaId: null,
    notifyResidents: false,
  };

  const setup = (answer: unknown) => {
    const news = { isConfigured: true, request: jest.fn().mockResolvedValue(answer), allPages: jest.fn() };
    const events = { emit: jest.fn() };
    const service = new NewsArticlesService(news as unknown as Day3atiNews, events as unknown as EventEmitter2);
    return { service, news, events };
  };

  const audit = (events: { emit: jest.Mock }) => events.emit.mock.calls.map(([, payload]) => payload);

  describe('list', () => {
    it('asks for the status, the cursor and the size, and reads the page', async () => {
      const item = {
        id: ID,
        status: 'published',
        title: 'عنوان',
        categoryId: CATEGORY,
        publishAt: null,
        publishedAt: '2026-11-20T10:00:00Z',
        isPinned: true,
        isFeatured: false,
        updatedAt: '2026-11-20T10:00:00Z',
      };
      const { service, news } = setup({ items: [item], nextCursor: 'abc' });

      await expect(service.list(who, { status: 'published', cursor: 'c0', limit: 20 }, 'en')).resolves.toEqual({
        items: [item],
        nextCursor: 'abc',
      });

      expect(news.request).toHaveBeenCalledWith({
        tenantSlug: 'albazourieh',
        userId: 'staff-1',
        language: 'en',
        method: 'GET',
        path: '/api/v1/news/manage/articles',
        query: { status: 'published', cursor: 'c0', limit: 20 },
      });
    });

    it('takes a missing nextCursor as the last page', async () => {
      const { service } = setup({ items: [] });
      await expect(service.list(who, { limit: 20 }, 'ar')).resolves.toEqual({ items: [], nextCursor: null });
    });

    it('is News being unavailable, not half a list, when one item is unreadable', async () => {
      const { service } = setup({ items: [{ id: 'x' }], nextCursor: null });
      await expect(service.list(who, { limit: 20 }, 'ar')).rejects.toMatchObject({ code: 'NEWS_UNAVAILABLE' });
    });
  });

  describe('reading one article', () => {
    it('leaves out the author, which is a Day3ati user and not ours, and keeps the files', async () => {
      const { service } = setup(article());
      const view = await service.get(ID, who, 'ar');
      expect(view).not.toHaveProperty('authorUserId');
      expect(view.media).toEqual([]);
      expect(view).toMatchObject({ id: ID, status: 'draft', defaultLanguage: 'ar' });
    });

    it('reads a place label and a summary that is missing', async () => {
      const { service } = setup(
        article({
          placeLabel: { ar: 'الساحة', en: null, fr: null },
          texts: [{ language: 'ar', title: 'عنوان', summary: null, body: 'نص' }],
        }),
      );
      const view = await service.get(ID, who, 'ar');
      expect(view.placeLabel).toEqual({ ar: 'الساحة', en: null, fr: null });
      expect(view.texts[0].summary).toBe('');
    });

    it.each([
      ['an unknown status', { status: 'deleted' }],
      ['no texts list', { texts: 'x' }],
      ['an unknown language', { defaultLanguage: 'de' }],
      ['an unreadable date', { updatedAt: 'yesterday-ish' }],
    ])('refuses %s', async (_name, over) => {
      const { service } = setup(article(over));
      await expect(service.get(ID, who, 'ar')).rejects.toMatchObject({ code: 'NEWS_UNAVAILABLE' });
    });
  });

  describe('writing', () => {
    it('creates a draft, sending the whole article, and records it without its text', async () => {
      const { service, news, events } = setup(article());

      await service.create(input, who, 'ar');

      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '/api/v1/news/manage/articles', body: input }),
      );
      expect(audit(events)).toEqual([
        expect.objectContaining({
          action: 'NEWS_ARTICLE_CREATED',
          entityType: 'NewsArticle',
          entityId: ID,
          after: { status: 'draft' },
        }),
      ]);
      expect(JSON.stringify(audit(events))).not.toContain('عنوان');
    });

    it('edits with a PUT of the whole article', async () => {
      const { service, news, events } = setup(article());
      await service.update(ID, input, who, 'ar');
      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'PUT', path: `/api/v1/news/manage/articles/${ID}`, body: input }),
      );
      expect(audit(events)[0]).toMatchObject({ action: 'NEWS_ARTICLE_UPDATED' });
    });
  });

  describe('moving through the statuses', () => {
    it('publishes now with an empty time, and says so in the audit row', async () => {
      const { service, news, events } = setup(article({ status: 'published', publishedAt: '2026-11-20T10:05:00Z' }));
      await service.publish(ID, { publishAt: null }, who, 'ar');
      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: `/api/v1/news/manage/articles/${ID}/publish`,
          body: { publishAt: null },
        }),
      );
      expect(audit(events)[0]).toMatchObject({ action: 'NEWS_ARTICLE_PUBLISHED', after: { status: 'published' } });
    });

    it('schedules with a time, and the status of the answer names the act', async () => {
      const when = '2026-12-01T06:00:00.000Z';
      const { service, events } = setup(article({ status: 'scheduled', publishAt: when }));
      const view = await service.publish(ID, { publishAt: when }, who, 'ar');
      expect(view.status).toBe('scheduled');
      expect(audit(events)[0]).toMatchObject({ action: 'NEWS_ARTICLE_SCHEDULED', after: { status: 'scheduled' } });
    });

    it('archives and cancels a schedule through their own routes', async () => {
      const archived = setup(article({ status: 'archived' }));
      await archived.service.archive(ID, who, 'ar');
      expect(archived.news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: `/api/v1/news/manage/articles/${ID}/archive` }),
      );
      expect(audit(archived.events)[0]).toMatchObject({ action: 'NEWS_ARTICLE_ARCHIVED' });

      const drafted = setup(article({ status: 'draft' }));
      await drafted.service.cancelSchedule(ID, who, 'ar');
      expect(drafted.news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: `/api/v1/news/manage/articles/${ID}/draft` }),
      );
      expect(audit(drafted.events)[0]).toMatchObject({ action: 'NEWS_ARTICLE_SCHEDULE_CANCELLED' });
    });

    it('pins and features, and records the switches, not the date', async () => {
      const { service, news, events } = setup(
        article({ status: 'published', isPinned: true, featuredUntil: '2026-12-05T10:00:00Z' }),
      );
      await service.setPlacement(ID, { isPinned: true, featuredUntil: '2026-12-05T10:00:00Z' }, who, 'ar');
      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'PUT', path: `/api/v1/news/manage/articles/${ID}/placement` }),
      );
      expect(audit(events)[0]).toMatchObject({
        action: 'NEWS_ARTICLE_PLACEMENT_CHANGED',
        after: { status: 'published', isPinned: true, featured: true },
      });
    });

    it('deletes, and records the id alone', async () => {
      const { service, news, events } = setup(undefined);
      await expect(service.remove(ID, who, 'ar')).resolves.toBeUndefined();
      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: `/api/v1/news/manage/articles/${ID}` }),
      );
      expect(audit(events)).toEqual([
        expect.objectContaining({ action: 'NEWS_ARTICLE_DELETED', entityType: 'NewsArticle', entityId: ID }),
      ]);
    });

    it('leaves no audit row when Day3ati refuses', async () => {
      const { service, news, events } = setup(undefined);
      news.request.mockRejectedValue(Object.assign(new Error('no'), { code: 'NEWS_ARTICLE_ALREADY_PUBLISHED' }));
      await expect(service.publish(ID, { publishAt: '2026-12-01T06:00:00Z' }, who, 'ar')).rejects.toThrow();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
