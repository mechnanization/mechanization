import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previousPathname, recordPathname } from './nav-history';

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

describe('navigation trail', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('knows the page a form was opened from', () => {
    recordPathname('/z/ar/x/citizens');
    recordPathname('/z/ar/x/citizens/c1');
    recordPathname('/z/ar/x/citizens/c1/edit');
    expect(previousPathname()).toBe('/z/ar/x/citizens/c1');
  });

  it('keeps it across a reload of the form, which records the same page again', () => {
    recordPathname('/z/ar/x/citizens/c1');
    recordPathname('/z/ar/x/citizens/c1/edit');
    recordPathname('/z/ar/x/citizens/c1/edit');
    expect(previousPathname()).toBe('/z/ar/x/citizens/c1');
  });

  it('has nothing behind the first page of a tab', () => {
    recordPathname('/z/ar/x/citizens/c1/edit');
    expect(previousPathname()).toBeNull();
  });

  it('starts over rather than throwing on a damaged value', () => {
    sessionStorage.setItem('mechanization.nav', '{not json');
    expect(previousPathname()).toBeNull();
    recordPathname('/z/ar/x/citizens');
    expect(previousPathname()).toBeNull();
  });
});
