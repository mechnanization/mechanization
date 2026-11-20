import type { Day3atiIntegration, Day3atiVillage } from '../../domain/interfaces/day3ati-integration.interface';
import {
  DAY3ATI_VILLAGES_MISS_REFRESH_MS,
  DAY3ATI_VILLAGES_TTL_MS,
  Day3atiVillageDirectory,
} from './day3ati-village-directory';

describe('Day3atiVillageDirectory', () => {
  const village = (externalTenant: string, villageId = `v-${externalTenant}`): Day3atiVillage => ({
    villageId,
    externalTenant,
    modules: ['news'],
  });

  let now: number;
  let list: jest.Mock<Promise<Day3atiVillage[]>, []>;
  let directory: Day3atiVillageDirectory;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    list = jest.fn().mockResolvedValue([village('albazourieh'), village('maarakeh')]);
    directory = new Day3atiVillageDirectory({ listVillages: list } as unknown as Day3atiIntegration);
  });
  afterEach(() => jest.restoreAllMocks());

  it('finds each municipality by its tenant slug, reading the list once', async () => {
    await expect(directory.villageOf('albazourieh')).resolves.toMatchObject({ villageId: 'v-albazourieh' });
    await expect(directory.villageOf('maarakeh')).resolves.toMatchObject({ villageId: 'v-maarakeh' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('shares one read between callers that arrive together', async () => {
    await Promise.all([directory.villageOf('albazourieh'), directory.villageOf('maarakeh'), directory.villageOf('albazourieh')]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reads again after a day', async () => {
    await directory.villageOf('albazourieh');
    now += DAY3ATI_VILLAGES_TTL_MS + 1;
    await directory.villageOf('albazourieh');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reads again when told to', async () => {
    await directory.villageOf('albazourieh');
    directory.refresh();
    await directory.villageOf('albazourieh');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('gives null for a municipality with no village, and does not ask again inside a minute', async () => {
    await expect(directory.villageOf('nowhere')).resolves.toBeNull();
    await expect(directory.villageOf('nowhere')).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('finds a village created since, once a minute has passed', async () => {
    await expect(directory.villageOf('newtown')).resolves.toBeNull();

    list.mockResolvedValue([village('albazourieh'), village('newtown')]);
    now += DAY3ATI_VILLAGES_MISS_REFRESH_MS;

    await expect(directory.villageOf('newtown')).resolves.toMatchObject({ villageId: 'v-newtown' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('keeps the first village of a municipality when Day3ati lists two', async () => {
    list.mockResolvedValue([village('albazourieh', 'first'), village('albazourieh', 'second')]);
    await expect(directory.villageOf('albazourieh')).resolves.toMatchObject({ villageId: 'first' });
  });

  it('does not keep a failed read, nor serve an old list in its place', async () => {
    await directory.villageOf('albazourieh');
    now += DAY3ATI_VILLAGES_TTL_MS + 1;
    list.mockRejectedValueOnce(new Error('down'));

    await expect(directory.villageOf('albazourieh')).rejects.toThrow('down');
    await expect(directory.villageOf('albazourieh')).resolves.toMatchObject({ villageId: 'v-albazourieh' });
  });
});
