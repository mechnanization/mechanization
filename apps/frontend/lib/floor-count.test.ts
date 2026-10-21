import { describe, expect, it } from 'vitest';
import { emptyTopFloors } from './floor-count';

const at = (...floors: number[]) => floors.map((floor) => ({ floor, unitType: 'APARTMENT' }));

describe('emptyTopFloors', () => {
  it('finds the roof counted as a floor', () => {
    // Units on the ground and first floors of a block entered as three.
    expect(emptyTopFloors(at(0, 0, 1), 3)).toEqual({ empty: 1, suggested: 2 });
  });

  it('says nothing when the top row holds a unit — a «طابق فارغ» block included', () => {
    expect(emptyTopFloors([...at(0, 1), { floor: 2, unitType: 'EMPTY_FLOOR' }], 3)).toBeNull();
  });

  it('says nothing about an empty matrix, or one with only basements', () => {
    expect(emptyTopFloors([], 3)).toBeNull();
    expect(emptyTopFloors(at(-1, -2), 3)).toBeNull();
  });

  it('counts every level a home reaches — a duplex fills the row above it (0095)', () => {
    expect(emptyTopFloors([{ floor: 0, levels: 2, unitType: 'APARTMENT' }], 2)).toBeNull();
    expect(emptyTopFloors([{ floor: 0, levels: 2, unitType: 'APARTMENT' }], 3)).toEqual({ empty: 1, suggested: 2 });
  });

  it('asks about a two-storey house whose unit says one level — each storey is a roof (D28)', () => {
    expect(emptyTopFloors([{ floor: 0, levels: 2, unitType: 'INDEPENDENT_HOUSE' }], 2)).toBeNull();
    expect(emptyTopFloors([{ floor: 0, unitType: 'INDEPENDENT_HOUSE' }], 2)).toEqual({ empty: 1, suggested: 1 });
  });

  it('measures the whole gap', () => {
    expect(emptyTopFloors(at(0), 4)).toEqual({ empty: 3, suggested: 1 });
  });
});
