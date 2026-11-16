import { describe, expect, it, vi } from 'vitest';
import type { BuildingTypeView } from '@mechanization/shared-schemas';
import { ApiRequestError } from './api-client';
import { buildingTypeLabel, readWithOfflineCopy, typesToOffer } from './building-types';

const type = (row: Partial<BuildingTypeView> & Pick<BuildingTypeView, 'id' | 'nameAr'>): BuildingTypeView => ({
  nameEn: null,
  structureType: 'RESIDENTIAL_BUILDING',
  defaultUnitType: 'APARTMENT',
  isSystem: false,
  isActive: true,
  sortOrder: 100,
  buildingCount: 0,
  ...row,
});

const residential = type({ id: 'sys-1', nameAr: 'مبنى سكني', nameEn: 'Residential Building', isSystem: true, sortOrder: 10 });
const school = type({ id: 'c-1', nameAr: 'مدرسة', structureType: 'PUBLIC_INSTITUTION', defaultUnitType: 'OFFICE', sortOrder: 5 });
const closed = type({ id: 'c-2', nameAr: 'مستوصف قديم', structureType: 'PUBLIC_INSTITUTION', isActive: false });

const offline = () => new ApiRequestError(0, { code: 'NETWORK_ERROR', message: 'تعذّر الاتصال' });

describe('the building types kept on the device (0106)', () => {
  it('saves every answer for the next time there is no network', async () => {
    const cache = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    expect(await readWithOfflineCopy(async () => [residential, school], cache)).toEqual([residential, school]);
    expect(cache.save).toHaveBeenCalledWith([residential, school]);
  });

  it('answers the kept list when the server cannot be reached', async () => {
    const cache = { load: vi.fn().mockResolvedValue([residential]), save: vi.fn() };
    expect(await readWithOfflineCopy(() => Promise.reject(offline()), cache)).toEqual([residential]);
  });

  it('says the network failed when nothing was ever kept, and passes any refusal of the server through', async () => {
    const empty = { load: vi.fn().mockResolvedValue(null), save: vi.fn() };
    await expect(readWithOfflineCopy(() => Promise.reject(offline()), empty)).rejects.toBeInstanceOf(ApiRequestError);
    const kept = { load: vi.fn().mockResolvedValue([residential]), save: vi.fn() };
    const refused = new ApiRequestError(403, { code: 'FORBIDDEN', message: 'ممنوع' });
    await expect(readWithOfflineCopy(() => Promise.reject(refused), kept)).rejects.toBe(refused);
    expect(kept.load).not.toHaveBeenCalled();
  });

  it('never fails a read because the device would not keep it', async () => {
    const full = { load: vi.fn(), save: vi.fn().mockRejectedValue(new Error('quota')) };
    expect(await readWithOfflineCopy(async () => [school], full)).toEqual([school]);
  });
});

describe('the types a building is offered', () => {
  it('lists system types first, and keeps a switched-off type only on the building that has it', () => {
    expect(typesToOffer([school, closed, residential]).map((row) => row.id)).toEqual(['sys-1', 'c-1']);
    expect(typesToOffer([school, closed, residential], 'c-2').map((row) => row.id)).toEqual(['sys-1', 'c-1', 'c-2']);
  });

  it('names a building not typed yet by its structure’s system type, in the page’s language', () => {
    expect(buildingTypeLabel([residential, school], { buildingTypeId: null, structureType: 'RESIDENTIAL_BUILDING' }, 'en', '—')).toBe(
      'Residential Building',
    );
    expect(buildingTypeLabel([residential, school], { buildingTypeId: 'c-1', structureType: 'PUBLIC_INSTITUTION' }, 'en', '—')).toBe('مدرسة');
  });
});
