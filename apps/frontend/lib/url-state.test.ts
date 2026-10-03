import { describe, expect, it } from 'vitest';
import { applyUrlPatch, param, readUrlState, toSearch } from './url-state';

const STATUSES = ['', 'PAID', 'UNPAID'] as const;

const SCHEMA = {
  status: param.oneOf(STATUSES, ''),
  zone: param.id(),
  parcel: param.string(),
  from: param.date(),
  flagged: param.flag(),
  page: param.page(),
  limit: param.pageSize([10, 25, 50, 100], 10),
};

const read = (query: string) => readUrlState(SCHEMA, new URLSearchParams(query));

describe('readUrlState', () => {
  it('yields every default for a bare URL', () => {
    expect(read('')).toEqual({
      status: '',
      zone: '',
      parcel: '',
      from: '',
      flagged: false,
      page: 0,
      limit: 10,
    });
  });

  it('reads well-formed values, with the page 1-based in the URL', () => {
    expect(
      read('status=PAID&zone=5f0c&parcel=1234&from=2026-09-01&flagged=1&page=3&limit=25'),
    ).toEqual({
      status: 'PAID',
      zone: '5f0c',
      parcel: '1234',
      from: '2026-09-01',
      flagged: true,
      page: 2,
      limit: 25,
    });
  });

  it('falls back to the default for anything malformed or stale', () => {
    expect(
      read('status=REFUNDED&zone=a%20b&from=2026-02-31&flagged=yes&page=0&limit=100000'),
    ).toEqual({
      status: '',
      zone: '',
      parcel: '',
      from: '',
      flagged: false,
      page: 0,
      limit: 10,
    });
    expect(read('page=-2').page).toBe(0);
    expect(read('page=two').page).toBe(0);
    expect(read('from=01/09/2026').from).toBe('');
  });

  it('accepts `true` for a flag, as hand-written links tend to use it', () => {
    expect(read('flagged=true').flagged).toBe(true);
  });

  it('ignores an over-long value rather than carrying it into a request', () => {
    expect(read(`parcel=${'9'.repeat(500)}`).parcel).toBe('');
  });
});

describe('applyUrlPatch', () => {
  const write = (query: string, patch: Parameters<typeof applyUrlPatch<typeof SCHEMA>>[2], clear?: string[]) =>
    toSearch(applyUrlPatch(query, SCHEMA, patch, clear));

  it('never writes a default, so an untouched page keeps a bare URL', () => {
    expect(write('', { status: '', flagged: false, page: 0, limit: 10 })).toBe('');
  });

  it('writes the page 1-based', () => {
    expect(write('', { page: 1 })).toBe('?page=2');
  });

  it('removes a parameter set back to its default', () => {
    expect(write('status=PAID&page=4', { status: '' })).toBe('?page=4');
  });

  it('keeps parameters the schema does not own', () => {
    expect(write('fromCaseId=abc&lat=33.5', { status: 'PAID' })).toBe(
      '?fromCaseId=abc&lat=33.5&status=PAID',
    );
  });

  it('clears named parameters in the same write — a filter change resets the page', () => {
    expect(write('page=5&limit=25', { status: 'UNPAID' }, ['page'])).toBe(
      '?limit=25&status=UNPAID',
    );
  });

  it('skips undefined keys and keys outside the schema', () => {
    expect(
      write('status=PAID', { status: undefined, other: 'x' } as unknown as Parameters<
        typeof applyUrlPatch<typeof SCHEMA>
      >[2]),
    ).toBe('?status=PAID');
  });

  it('refuses to write a value the schema would not read back', () => {
    expect(write('', { limit: 7, from: '2026-13-01' })).toBe('');
  });

  it('round-trips', () => {
    const patch = {
      status: 'UNPAID' as const,
      zone: 'z-1',
      parcel: '77',
      from: '2026-10-01',
      flagged: true,
      page: 6,
      limit: 50,
    };
    expect(read(toSearch(applyUrlPatch('', SCHEMA, patch)).slice(1))).toEqual(patch);
  });
});
