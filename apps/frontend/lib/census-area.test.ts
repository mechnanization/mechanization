import { describe, expect, it } from 'vitest';
import { mirrorCensusAreas } from './census-area';

const census = { shop: { unitArea: '20' }, flat: { unitArea: null } };

describe('mirrorCensusAreas', () => {
  it('fills a linked line stored with no area — the field it shows is locked', () => {
    // B-1-1626-A 0003: the owner line had no area, the unit had 20.
    expect(mirrorCensusAreas([{ unitId: 'shop', unitArea: undefined }], census)).toEqual([
      { unitId: 'shop', unitArea: '20' },
    ]);
  });

  it('replaces an area the unit was corrected away from', () => {
    expect(mirrorCensusAreas([{ unitId: 'shop', unitArea: '175' }], census)).toEqual([
      { unitId: 'shop', unitArea: '20' },
    ]);
  });

  it('converges: null once every line agrees, however the number is written', () => {
    expect(mirrorCensusAreas([{ unitId: 'shop', unitArea: '20.00' }], census)).toBeNull();
  });

  it('leaves a line alone where the unit has no area, or the line names no unit', () => {
    const lines = [
      { unitId: 'flat', unitArea: '75' },
      { unitArea: '40' },
      { unitId: 'unknown', unitArea: undefined },
    ];
    expect(mirrorCensusAreas(lines, census)).toBeNull();
  });
});
