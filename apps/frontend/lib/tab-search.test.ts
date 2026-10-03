import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTabSearches,
  readLinkSeed,
  readTabSearch,
  stashLinkSeed,
  subscribeTabSearch,
  writeTabSearch,
} from './tab-search';

/** A `Storage` good enough for these functions: Node has no `sessionStorage`. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => void data.set(name, String(value)),
    removeItem: (name) => void data.delete(name),
    clear: () => data.clear(),
  };
}

describe('tab search storage', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a term per municipality and per list', () => {
    writeTabSearch('zahle', 'citizens', 'أحمد');
    writeTabSearch('zahle', 'fees', 'BZR-2608-5HLQBM');
    writeTabSearch('albazourieh', 'citizens', 'خليل');

    expect(readTabSearch('zahle', 'citizens')).toBe('أحمد');
    expect(readTabSearch('zahle', 'fees')).toBe('BZR-2608-5HLQBM');
    expect(readTabSearch('albazourieh', 'citizens')).toBe('خليل');
    expect(readTabSearch('zahle', 'payments')).toBe('');
  });

  it('removes the entry when the term is emptied, rather than storing blanks', () => {
    writeTabSearch('zahle', 'citizens', 'أحمد');
    writeTabSearch('zahle', 'citizens', '   ');
    expect(sessionStorage.length).toBe(0);
  });

  it('caps what it stores', () => {
    writeTabSearch('zahle', 'citizens', 'x'.repeat(5000));
    expect(readTabSearch('zahle', 'citizens')).toHaveLength(200);
  });

  it('forgets one municipality’s searches on sign-out and leaves everything else', () => {
    writeTabSearch('zahle', 'citizens', 'أحمد');
    writeTabSearch('zahle', 'fees', '0312');
    writeTabSearch('zahle-north', 'citizens', 'ليلى');
    sessionStorage.setItem('mechanization.session.zahle', '{}');

    clearTabSearches('zahle');

    expect(readTabSearch('zahle', 'citizens')).toBe('');
    expect(readTabSearch('zahle', 'fees')).toBe('');
    // A tenant whose slug merely starts with the same letters is untouched.
    expect(readTabSearch('zahle-north', 'citizens')).toBe('ليلى');
    expect(sessionStorage.getItem('mechanization.session.zahle')).toBe('{}');
  });

  it('tells subscribers about same-tab writes, which fire no storage event', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTabSearch(listener);
    writeTabSearch('zahle', 'citizens', 'أحمد');
    clearTabSearches('zahle');
    unsubscribe();
    writeTabSearch('zahle', 'citizens', 'ليلى');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('degrades to "no saved search" when storage is blocked', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
      get length(): number {
        throw new Error('SecurityError');
      },
    });
    expect(() => writeTabSearch('zahle', 'citizens', 'أحمد')).not.toThrow();
    expect(readTabSearch('zahle', 'citizens')).toBe('');
    expect(() => clearTabSearches('zahle')).not.toThrow();
  });

  describe('link seeds', () => {
    const LINK = '/zahle/ar/x/citizens/new?buildingId=b1&unitId=u1&residence=RESIDENT';

    it('hands the term to the exact page the link opens', () => {
      stashLinkSeed('zahle', LINK, '  ٠٣١٢٣٤٥٦  ');
      expect(readLinkSeed('zahle', LINK)).toBe('٠٣١٢٣٤٥٦');
      // Read, not consumed: a reload of the form still has it.
      expect(readLinkSeed('zahle', LINK)).toBe('٠٣١٢٣٤٥٦');
    });

    it('is not inherited by another link, the bare form, or another municipality', () => {
      stashLinkSeed('zahle', LINK, 'أحمد');
      expect(readLinkSeed('zahle', LINK.replace('u1', 'u2'))).toBeUndefined();
      expect(readLinkSeed('zahle', LINK.replace('RESIDENT', 'NON_RESIDENT_OWNER'))).toBeUndefined();
      expect(readLinkSeed('zahle', '/zahle/ar/x/citizens/new')).toBeUndefined();
      expect(readLinkSeed('albazourieh', LINK)).toBeUndefined();
    });

    it('keeps one seed: a new click replaces the last, an empty term removes it', () => {
      stashLinkSeed('zahle', LINK, 'أحمد');
      stashLinkSeed('zahle', LINK.replace('u1', 'u2'), 'ليلى');
      expect(readLinkSeed('zahle', LINK)).toBeUndefined();
      stashLinkSeed('zahle', LINK, '');
      expect(sessionStorage.length).toBe(0);
    });

    it('is cleared with the session', () => {
      stashLinkSeed('zahle', LINK, 'أحمد');
      clearTabSearches('zahle');
      expect(readLinkSeed('zahle', LINK)).toBeUndefined();
    });
  });
});
