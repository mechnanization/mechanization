import type { Day3atiVillage } from '../../../domain/interfaces/day3ati-integration.interface';
import type { Day3atiNews, Day3atiVillages } from '../../../domain/interfaces/day3ati-news.interface';
import { NEWS_AVAILABILITY_RECHECK_MS, NewsAvailabilityService } from './news-availability.service';

describe('NewsAvailabilityService', () => {
  const village = (modules: string[]): Day3atiVillage => ({ villageId: 'v1', externalTenant: 'albazourieh', modules });

  const setup = (over: { configured?: boolean; found?: Array<Day3atiVillage | null | Error> } = {}) => {
    const found = [...(over.found ?? [village(['news'])])];
    const villageOf = jest.fn().mockImplementation(async () => {
      const next = found.length > 1 ? found.shift() : found[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    });
    const villages = { villageOf, refresh: jest.fn() } as unknown as jest.Mocked<Day3atiVillages>;
    const news = { isConfigured: over.configured ?? true } as Day3atiNews;
    return { service: new NewsAvailabilityService(news, villages), villages, villageOf };
  };

  it('is on when the village lists the news module', async () => {
    const { service } = setup({ found: [village(['events', 'news'])] });
    await expect(service.of('albazourieh')).resolves.toEqual({ enabled: true, reason: null });
  });

  it('is off, and says the integration is not set up, while the four settings are not all there', async () => {
    const { service, villageOf } = setup({ configured: false });
    await expect(service.of('albazourieh')).resolves.toEqual({ enabled: false, reason: 'NOT_CONFIGURED' });
    expect(villageOf).not.toHaveBeenCalled();
  });

  it('is off for a municipality Day3ati has no village for', async () => {
    const { service } = setup({ found: [null] });
    await expect(service.of('nowhere')).resolves.toEqual({ enabled: false, reason: 'NOT_LINKED' });
  });

  it('is off for a village without the module, and looks again once it may', async () => {
    const { service, villages, villageOf } = setup({ found: [village(['events']), village(['events', 'news'])] });

    // The first answer is cached as off; asked again after a minute it reads Day3ati afresh and finds it on.
    await expect(service.of('albazourieh', 1_000_000)).resolves.toEqual({ enabled: true, reason: null });
    expect(villages.refresh).toHaveBeenCalledTimes(1);
    expect(villageOf).toHaveBeenCalledTimes(2);
  });

  it('does not look again inside a minute, however often it is asked', async () => {
    const { service, villages } = setup({ found: [village(['events'])] });

    const first = await service.of('albazourieh', 1_000_000);
    const second = await service.of('albazourieh', 1_000_000 + NEWS_AVAILABILITY_RECHECK_MS - 1);

    expect(first).toEqual({ enabled: false, reason: 'MODULE_OFF' });
    expect(second).toEqual({ enabled: false, reason: 'MODULE_OFF' });
    expect(villages.refresh).toHaveBeenCalledTimes(1);

    await service.of('albazourieh', 1_000_000 + NEWS_AVAILABILITY_RECHECK_MS);
    expect(villages.refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps one municipality\'s recheck apart from another\'s', async () => {
    const { service, villages } = setup({ found: [village(['events'])] });
    await service.of('albazourieh', 1_000_000);
    await service.of('maarakeh', 1_000_000);
    expect(villages.refresh).toHaveBeenCalledTimes(2);
  });

  it('refuses as unavailable, naming nothing of the cause, when the villages cannot be read', async () => {
    const { service } = setup({ found: [new Error('connect ECONNREFUSED https://secret.example.test')] });
    const error = await service.of('albazourieh').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NEWS_UNAVAILABLE' });
    expect((error as Error).message).not.toContain('secret.example.test');
  });
});
