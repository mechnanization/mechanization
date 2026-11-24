import { describe, expect, it } from 'vitest';
import {
  MIN_DUPLICATE_REASON,
  bottomFloorFor,
  cleanPartitionNumbers,
  cleanSharedParcels,
  orphanedUnitsOf,
  pinIsAnswered,
  rankDuplicates,
  topFloorFor,
  topGapOf,
} from '@/lib/building-editor-rules';
import type { DuplicateBuildingCandidate } from '@/lib/api-client';
import type { GridUnitDraft } from '@/lib/building-draft';

/*
  GOD-21, phase 1 (cleanup sprint, 2026-11-24): the building editor's rules that
  needed no component, moved out of the 3,240-line function with their text
  unchanged, and tested here, which they were not while they sat in it.
*/
const unit = (floor: number, over: Partial<GridUnitDraft> = {}): GridUnitDraft =>
  ({ clientId: `c${floor}`, floor, startCol: 1, endCol: 1, unitType: 'APARTMENT', colorIndex: 0, levels: 1, ...over }) as GridUnitDraft;

describe('the parcel numbers that will be sent', () => {
  it('partition numbers: trimmed, blanks and repeats dropped, in the order typed', () => {
    expect(cleanPartitionNumbers([' 12 ', '', '13', '12', '  ', '14'], true)).toEqual(['12', '13', '14']);
  });

  it('partition numbers: none at all unless «مبنى مفروز» is ticked, whatever was typed', () => {
    expect(cleanPartitionNumbers(['12', '13'], false)).toEqual([]);
  });

  it('shared parcels: trimmed, blanks and repeats dropped, and never the parcel the building is filed under', () => {
    expect(cleanSharedParcels(['1042', ' 1043 ', '', '1043', '1044'], '1042')).toEqual(['1043', '1044']);
    expect(cleanSharedParcels([], '1042')).toEqual([]);
  });
});

describe('the floors the counts allow', () => {
  it('floor 0 is the ground: three floors reach floor 2, and an unreadable count is one floor', () => {
    expect(topFloorFor('3')).toBe(2);
    expect(topFloorFor('1')).toBe(0);
    expect(topFloorFor('')).toBe(0);
    expect(topFloorFor('abc')).toBe(0);
    expect(topFloorFor('0')).toBe(0);
  });

  it('basements go below zero, and none (or nonsense) is zero', () => {
    expect(bottomFloorFor('2')).toBe(-2);
    expect(bottomFloorFor('0')).toBe(-0);
    expect(bottomFloorFor('')).toBe(-0);
    expect(bottomFloorFor('-4')).toBe(-0);
  });

  it('a unit painted above the top floor or below the deepest basement is orphaned, never dropped', () => {
    const units = [unit(-3), unit(-2), unit(0), unit(2), unit(3)];
    const orphans = orphanedUnitsOf(units, topFloorFor('3'), bottomFloorFor('2'));
    expect(orphans.map((u) => u.floor)).toEqual([-3, 3]);
    expect(orphanedUnitsOf(units, 3, -3)).toEqual([]);
  });

  it('empty top floors are asked about only for a building that has floors to fill', () => {
    expect(topGapOf([unit(0)], [], '3', 'PERMITTED')).toBeNull();
    expect(topGapOf([unit(0)], [], '3', 'UNDER_CONSTRUCTION')).toBeNull();
    expect(topGapOf([unit(0)], [], '3', 'IN_USE')).not.toBeNull();
  });
});

describe('the entrance is pinned, or says why not (pinIsAnswered)', () => {
  it('a correction is never held to it', () => {
    expect(pinIsAnswered(true, null, null)).toBe(true);
  });

  it('a pin answers it', () => {
    expect(pinIsAnswered(false, [35.5, 33.8], null)).toBe(true);
  });

  it('so does a reason of at least the minimum length, trimmed; unticked, empty or short does not', () => {
    expect(pinIsAnswered(false, null, 'no signal')).toBe(true);
    expect(pinIsAnswered(false, null, ' '.repeat(10) + 'ab')).toBe(false);
    expect(pinIsAnswered(false, null, 'x'.repeat(MIN_DUPLICATE_REASON))).toBe(true);
    expect(pinIsAnswered(false, null, 'x'.repeat(MIN_DUPLICATE_REASON - 1))).toBe(false);
    expect(pinIsAnswered(false, null, '')).toBe(false);
    expect(pinIsAnswered(false, null, null)).toBe(false);
  });
});

describe('the structures already on the parcel, nearest first (rankDuplicates)', () => {
  const row = (code: string, over: Partial<DuplicateBuildingCandidate> = {}): DuplicateBuildingCandidate =>
    ({ id: code, code, latitude: null, longitude: null, distanceMetres: null, ...over }) as DuplicateBuildingCandidate;

  it('is empty when nothing is there', () => {
    expect(rankDuplicates(null, null)).toEqual([]);
    expect(rankDuplicates([], null)).toEqual([]);
  });

  it('orders by the server’s distance when there is no pin, the unmeasurable last, ties in the server’s order', () => {
    const ranked = rankDuplicates(
      [row('far', { distanceMetres: 40 }), row('unknown'), row('near', { distanceMetres: 4 }), row('tie', { distanceMetres: 40 })],
      null,
    );
    expect(ranked.map((r) => r.row.code)).toEqual(['near', 'far', 'tie', 'unknown']);
    expect(ranked.map((r) => r.distance)).toEqual([4, 40, 40, null]);
  });

  it('measures from the officer’s own pin when there is one and the row has a position', () => {
    const pin: [number, number] = [35.5, 33.8];
    const ranked = rankDuplicates(
      [
        // about 111 m north of the pin
        row('north', { latitude: 33.801, longitude: 35.5, distanceMetres: 5 }),
        // the server's figure only: no position to measure from the pin
        row('server', { distanceMetres: 30 }),
        // on the pin
        row('here', { latitude: 33.8, longitude: 35.5, distanceMetres: 999 }),
      ],
      pin,
    );
    expect(ranked.map((r) => r.row.code)).toEqual(['here', 'server', 'north']);
    expect(ranked[0].distance).toBe(0);
    expect(ranked[2].distance).toBeGreaterThan(100);
    expect(ranked[2].distance).toBeLessThan(120);
  });
});
