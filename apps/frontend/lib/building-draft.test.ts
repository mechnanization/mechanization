import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  draftIsCurrent,
  editDraftFingerprint,
  loadBuildingDraft,
  redrawRemovedFlats,
  saveBuildingDraft,
  type BuildingDraft,
} from '@/lib/building-draft';

/** A sessionStorage for node: the module reads and writes it inside try/catch. */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
}

const DRAFT: BuildingDraft = {
  step: 1,
  parcelNumber: '1042',
  name: 'بناية النور',
  postedNumber: '',
  zoneId: '',
  isPartitioned: false,
  partitionNumbers: [],
  sharedParcels: [],
  structureType: 'RESIDENTIAL_BUILDING',
  lifecycleStatus: 'IN_USE',
  floorsCount: '3',
  basementsCount: '0',
  notes: '',
  pin: null,
  gridSize: 4,
  gridUnits: [],
  acknowledgedDuplicates: false,
};

const LOADED = '2026-10-11T08:00:00.000Z';
const COLLEAGUE_SAVED = '2026-10-11T08:20:00.000Z';

describe('draftIsCurrent', () => {
  it('restores silently only while the server holds the version the draft was made against', () => {
    expect(draftIsCurrent({ baseUpdatedAt: LOADED }, LOADED)).toBe(true);
    expect(draftIsCurrent({ baseUpdatedAt: LOADED }, COLLEAGUE_SAVED)).toBe(false);
  });

  it('does not trust a draft that never recorded its version', () => {
    // Written before `baseUpdatedAt` existed, or never based on a loaded building.
    expect(draftIsCurrent({}, LOADED)).toBe(false);
    expect(draftIsCurrent({ baseUpdatedAt: null }, LOADED)).toBe(false);
  });

  it('compares instants, as the server does, not spellings', () => {
    expect(draftIsCurrent({ baseUpdatedAt: '2026-10-11T11:00:00+03:00' }, LOADED)).toBe(true);
  });
});

describe('the stored draft keeps the version it was made against', () => {
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it('so a colleague’s save since the draft is noticed on restore', () => {
    saveBuildingDraft('town', 'building-1', { ...DRAFT, baseUpdatedAt: LOADED });

    const restored = loadBuildingDraft('town', 'building-1');
    expect(restored?.baseUpdatedAt).toBe(LOADED);
    expect(draftIsCurrent(restored!, LOADED)).toBe(true);
    expect(draftIsCurrent(restored!, COLLEAGUE_SAVED)).toBe(false);
  });
});

describe('editDraftFingerprint', () => {
  it('is the same for an edit that only moved between steps, picked a sector or answered a duplicate question', () => {
    const moved: BuildingDraft = {
      ...DRAFT,
      step: 2,
      zoneId: 'zone-1',
      acknowledgedDuplicates: true,
      duplicateReason: 'مبنى منفصل',
    };

    expect(editDraftFingerprint(moved)).toBe(editDraftFingerprint(DRAFT));
  });

  it.each([
    ['the name', { name: 'بناية الأمل' }],
    ['the notes', { notes: 'سطح مشترك' }],
    ['the floors', { floorsCount: '4' }],
    ['the pin', { pin: [35.5, 33.2] as [number, number] }],
    ['a painted flat', { gridUnits: [{ floor: 1, startCol: 0, endCol: 1, unitType: 'APARTMENT' }] as BuildingDraft['gridUnits'] }],
  ])('differs once %s changes', (_what, patch) => {
    expect(editDraftFingerprint({ ...DRAFT, ...patch })).not.toBe(editDraftFingerprint(DRAFT));
  });
});

describe('redrawRemovedFlats', () => {
  const flat = (id: string | undefined, code?: string) =>
    ({ existingId: id, unitCode: code, floor: 1, startCol: 0, endCol: 1, unitType: 'APARTMENT' }) as BuildingDraft['gridUnits'][number];

  it('draws a flat the newer version removed as a new one, so the save adds it back', () => {
    const [kept, removed, drawn] = redrawRemovedFlats(
      [flat('u-1', 'A1'), flat('u-2', 'A2'), flat(undefined)],
      new Set(['u-1']),
    );

    expect(kept).toMatchObject({ existingId: 'u-1', unitCode: 'A1' });
    expect(removed).toMatchObject({ existingId: undefined, unitCode: undefined, floor: 1 });
    expect(drawn).toMatchObject({ existingId: undefined });
  });
});
