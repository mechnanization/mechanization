import type { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictError, ValidationError } from '../../../domain/errors/domain-error';
import type { Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import { NewsCatalogService, type NewsActor } from './news-catalog.service';

describe('NewsCatalogService', () => {
  const who: NewsActor = { tenantSlug: 'albazourieh', id: 'staff-1', role: 'ADMINISTRATIVE_OFFICER' };
  const ID = '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d';

  const category = {
    id: ID,
    key: 'water-power',
    name: { ar: 'مياه وكهرباء', en: null, fr: null },
    icon: null,
    sortOrder: 1,
    isActive: true,
  };
  const publisher = { id: ID, name: { ar: 'البلدية', en: null, fr: null }, kind: 'municipality', isActive: true };

  const setup = (answer: unknown) => {
    const news = { isConfigured: true, request: jest.fn().mockResolvedValue(answer), allPages: jest.fn() };
    const events = { emit: jest.fn() };
    const service = new NewsCatalogService(news as unknown as Day3atiNews, events as unknown as EventEmitter2);
    return { service, news, events };
  };

  describe('categories', () => {
    it('lists them as the signed-in user, in their language', async () => {
      const { service, news } = setup([category]);

      await expect(service.listCategories(who, 'en')).resolves.toEqual([category]);

      expect(news.request).toHaveBeenCalledWith({
        tenantSlug: 'albazourieh',
        userId: 'staff-1',
        language: 'en',
        method: 'GET',
        path: '/api/v1/news/manage/categories',
      });
    });

    it('creates one, sends what the form holds, and leaves an audit event with no name in it', async () => {
      const { service, news, events } = setup(category);
      const input = { key: 'water-power', nameAr: 'مياه وكهرباء', nameEn: null, nameFr: null, icon: null, sortOrder: 1 };

      await expect(service.createCategory(input, who, 'ar')).resolves.toEqual(category);

      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '/api/v1/news/manage/categories', body: input }),
      );
      expect(events.emit).toHaveBeenCalledWith('news.changed', {
        tenantSlug: 'albazourieh',
        action: 'NEWS_CATEGORY_CREATED',
        entityType: 'NewsCategory',
        entityId: ID,
        after: { key: 'water-power', isActive: true },
        actorId: 'staff-1',
        actorRole: 'ADMINISTRATIVE_OFFICER',
      });
      expect(JSON.stringify(events.emit.mock.calls)).not.toContain('مياه');
    });

    it('edits one with a PUT of the whole record and a null key, which Day3ati ignores', async () => {
      const { service, news, events } = setup({ ...category, isActive: false });
      const input = { nameAr: 'مياه وكهرباء', nameEn: null, nameFr: null, icon: null, sortOrder: 1, isActive: false };

      await service.updateCategory(ID, input, who, 'ar');

      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PUT',
          path: `/api/v1/news/manage/categories/${ID}`,
          body: { ...input, key: null },
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'news.changed',
        expect.objectContaining({ action: 'NEWS_CATEGORY_UPDATED', after: { key: 'water-power', isActive: false } }),
      );
    });

    it('leaves no audit row when Day3ati refuses', async () => {
      const { service, news, events } = setup(undefined);
      news.request.mockRejectedValue(new ValidationError({ code: 'NEWS_INVALID_INPUT', message: 'no' }));

      await expect(
        service.createCategory(
          { key: 'x', nameAr: 'س', nameEn: null, nameFr: null, icon: null, sortOrder: 0 },
          who,
          'ar',
        ),
      ).rejects.toMatchObject({ code: 'NEWS_INVALID_INPUT' });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('is News being unavailable, not a half list, when an answer is not what the contract says', async () => {
      const { service } = setup([category, { id: 'x' }]);
      const error = await service.listCategories(who, 'ar').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ code: 'NEWS_UNAVAILABLE' });
    });

    it('does not report a change it could not read back', async () => {
      const { service, events } = setup({ unexpected: true });
      await expect(
        service.createCategory(
          { key: 'x', nameAr: 'س', nameEn: null, nameFr: null, icon: null, sortOrder: 0 },
          who,
          'ar',
        ),
      ).rejects.toMatchObject({ code: 'NEWS_UNAVAILABLE' });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('publishers', () => {
    it('lists them', async () => {
      const { service, news } = setup([publisher]);
      await expect(service.listPublishers(who, 'ar')).resolves.toEqual([publisher]);
      expect(news.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/v1/news/manage/publishers' }));
    });

    it('creates one and records its kind, never its name', async () => {
      const { service, news, events } = setup(publisher);
      const input = { nameAr: 'البلدية', nameEn: null, nameFr: null, kind: 'municipality' as const };

      await service.createPublisher(input, who, 'ar');

      expect(news.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: input }));
      expect(events.emit).toHaveBeenCalledWith(
        'news.changed',
        expect.objectContaining({
          action: 'NEWS_PUBLISHER_CREATED',
          entityType: 'NewsPublisher',
          after: { kind: 'municipality', isActive: true },
        }),
      );
    });

    it('edits one with a PUT of the whole record', async () => {
      const { service, news, events } = setup({ ...publisher, isActive: false });
      const input = { nameAr: 'البلدية', nameEn: null, nameFr: null, kind: 'municipality' as const, isActive: false };

      await service.updatePublisher(ID, input, who, 'fr');

      expect(news.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'PUT', path: `/api/v1/news/manage/publishers/${ID}`, body: input, language: 'fr' }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'news.changed',
        expect.objectContaining({ action: 'NEWS_PUBLISHER_UPDATED', after: { kind: 'municipality', isActive: false } }),
      );
    });
  });
});
