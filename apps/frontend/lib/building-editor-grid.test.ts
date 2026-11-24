import { describe, expect, it } from 'vitest';
import type { UnitWithOccupants } from '@/lib/api-client';
import { gridFromUnits, undeletableReason } from '@/components/admin/building-editor/grid-units';
import { MAX_HORIZONTAL_BLOCKS } from '@/components/admin/unit-grid-picker';
import { offlineNow } from '@/components/admin/building-editor/offline-now';

/*
  GOD-21, phase 1 (cleanup sprint, 2026-11-24): the helpers that draw a building's
  saved units back onto the wizard's grid, moved out of `building-editor.tsx`
  unchanged and tested here, which they were not while they sat in it. The rule
  that matters: a unit the grid cannot draw must never be one the save then treats
  as deleted, so what does not fit comes back as `hidden`.
*/
const unit = (patch: Partial<UnitWithOccupants>): UnitWithOccupants =>
  ({
    id: `u-${Math.random().toString(36).slice(2)}`,
    unitCode: 'A-1',
    floor: 0,
    sequence: 1,
    unitType: 'APARTMENT',
    occupants: [],
    visitCount: 0,
    levels: 1,
    startCol: null,
    endCol: null,
    unitStatus: null,
    ownerDeclaredStatus: null,
    ...patch,
  }) as UnitWithOccupants;

describe('why a unit cannot be removed (undeletableReason)', () => {
  it('names occupancy first, then field visits, and says nothing for a unit with neither', () => {
    expect(undeletableReason(unit({ unitCode: 'B-2', occupants: [{} as never] }), true)).toMatch(/B-2 has occupancy on record/);
    expect(undeletableReason(unit({ unitCode: 'B-2', visitCount: 3 }), true)).toMatch(/B-2 has field visits on record/);
    expect(undeletableReason(unit({}), true)).toBeUndefined();
  });

  it('puts occupancy ahead of a visit when a unit has both, and speaks Arabic on an Arabic page', () => {
    expect(undeletableReason(unit({ occupants: [{} as never], visitCount: 2 }), true)).toMatch(/occupancy/);
    expect(undeletableReason(unit({ occupants: [{} as never] }), false)).toMatch(/إشغال/);
    expect(undeletableReason(unit({ visitCount: 1 }), false)).toMatch(/زيارات/);
  });
});

describe('a saved building redrawn on the grid (gridFromUnits)', () => {
  it('keeps a positioned unit’s own span, its code, its levels and its status', () => {
    const { drafts, hidden, columns, floors } = gridFromUnits(
      [unit({ id: 'x1', unitCode: 'A-3', floor: 1, startCol: 2, endCol: 4, levels: 2, unitStatus: 'OCCUPIED' as never })],
      true,
    );
    expect(hidden).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ existingId: 'x1', unitCode: 'A-3', floor: 1, startCol: 2, endCol: 4, levels: 2 });
    expect(drafts[0].unitStatus).toBe('OCCUPIED');
    // a home of two levels on floor 1 reaches floor 3; the grid is never narrower than its default
    expect(floors).toBe(3);
    expect(columns).toBeGreaterThanOrEqual(4);
  });

  it('falls back to the owner’s declared status where the unit has none', () => {
    const { drafts } = gridFromUnits([unit({ unitStatus: null, ownerDeclaredStatus: 'VACANT' as never })], true);
    expect(drafts[0].unitStatus).toBe('VACANT');
  });

  it('lays out a unit with no span one column each, in sequence order, beside what is positioned', () => {
    const { drafts } = gridFromUnits(
      [
        unit({ id: 'p', startCol: 1, endCol: 2, sequence: 1 }),
        unit({ id: 'l2', sequence: 3 }),
        unit({ id: 'l1', sequence: 2 }),
      ],
      true,
    );
    const byId = Object.fromEntries(drafts.map((d) => [d.existingId, d]));
    expect([byId.p.startCol, byId.p.endCol]).toEqual([1, 2]);
    // the loose ones take the first free columns, in sequence order
    expect([byId.l1.startCol, byId.l2.startCol]).toEqual([3, 4]);
  });

  it('does not draw two units over one cell: the later one is placed beside the rest', () => {
    const { drafts } = gridFromUnits(
      [unit({ id: 'a', startCol: 1, endCol: 3, sequence: 1 }), unit({ id: 'b', startCol: 2, endCol: 4, sequence: 2 })],
      true,
    );
    const byId = Object.fromEntries(drafts.map((d) => [d.existingId, d]));
    expect([byId.a.startCol, byId.a.endCol]).toEqual([1, 3]);
    expect(byId.b.startCol).toBe(4);
    expect(byId.b.endCol).toBe(4);
  });

  it('reports what will not fit the width as hidden, so a save never treats it as deleted', () => {
    const many = Array.from({ length: MAX_HORIZONTAL_BLOCKS + 3 }, (_, i) => unit({ id: `f${i}`, sequence: i, floor: 0 }));
    const { drafts, hidden } = gridFromUnits(many, true);
    expect(drafts).toHaveLength(MAX_HORIZONTAL_BLOCKS);
    expect(hidden).toHaveLength(3);
    expect(hidden.map((u) => u.id)).toEqual(['f20', 'f21', 'f22']);
    expect(drafts.length + hidden.length).toBe(many.length);
  });

  it('counts basements as depth, and a home’s upper levels as the floors above its own', () => {
    const { basements, floors } = gridFromUnits(
      [unit({ floor: -2, startCol: 1, endCol: 1 }), unit({ floor: 0, startCol: 2, endCol: 2, levels: 3 })],
      true,
    );
    expect(basements).toBe(2);
    expect(floors).toBe(3);
  });

  it('keeps a home’s upper levels free on the floors above: a unit there goes beside, not on top', () => {
    const { drafts } = gridFromUnits(
      [
        unit({ id: 'home', floor: 0, startCol: 1, endCol: 2, levels: 2, sequence: 1 }),
        unit({ id: 'above', floor: 1, startCol: 1, endCol: 2, sequence: 1 }),
      ],
      true,
    );
    const above = drafts.find((d) => d.existingId === 'above')!;
    expect(above.startCol).toBe(3);
  });

  it('gives each drawn unit its own client id and a colour index in order', () => {
    const { drafts } = gridFromUnits([unit({ sequence: 1 }), unit({ sequence: 2 })], true);
    expect(new Set(drafts.map((d) => d.clientId)).size).toBe(2);
    expect(drafts.map((d) => d.colorIndex)).toEqual([0, 1]);
  });

  it('is empty for an empty building, at the default size', () => {
    const result = gridFromUnits([], true);
    expect(result.drafts).toEqual([]);
    expect(result.hidden).toEqual([]);
    expect(result.floors).toBe(1);
    expect(result.basements).toBe(0);
  });
});

describe('whether the browser says it is offline (offlineNow)', () => {
  it('is true only when navigator.onLine is exactly false, and not when it is unknown', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
      expect(offlineNow()).toBe(true);
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
      expect(offlineNow()).toBe(false);
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
      expect(offlineNow()).toBe(false);
    } finally {
      if (real) Object.defineProperty(globalThis, 'navigator', real);
    }
  });
});
