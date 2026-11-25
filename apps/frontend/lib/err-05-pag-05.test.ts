import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import ar from '../messages/ar.json';
import { blockText } from './api-errors';

/*
  ERR-05 and PAG-05 (cleanup sprint, 2026-11-25), on what ERR-04 and PAG-04
  (Hashem, PR #239) put on the wire: every preview block carries
  `refusal: { code, params }`, and `GET fees/notices` pages with `limit` and
  `offset`. The runner collects `lib/**` only and has no DOM here, so the screens
  are read as source, as the other cleanup tests do.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: its comments name the bug they fixed and are not what runs. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const ARABIC = /[؀-ۿ]/;

describe('blockText (ERR-05)', () => {
  const vacant = {
    refusal: { code: 'LANDLORD_LINK_UNIT_VACANT', params: { hasUnit: 'no', unitCode: '' } },
    message: 'نص الخادم بالعربية',
  };

  it('words a block from its refusal in the language asked, whatever the server said', () => {
    expect(blockText(vacant, 'ar')).toMatch(/^الوحدة مؤكَّد شغورها/);
    const english = blockText(vacant, 'en');
    expect(english).not.toMatch(ARABIC);
    expect(english).not.toBe(vacant.message);
  });

  it('reads the page language when no locale is given', () => {
    // No document in the node runner: `currentLocale()` is Arabic.
    expect(blockText(vacant)).toBe(blockText(vacant, 'ar'));
  });

  it('shows the server sentence only for a code this build does not know', () => {
    const unknown = { refusal: { code: 'A_CODE_FROM_A_NEWER_API', params: {} }, message: 'the older words' };
    expect(blockText(unknown, 'en')).toBe('the older words');
  });
});

describe('the screens word a block from its refusal (ERR-05)', () => {
  const SCREENS = [
    'components/admin/landlord-proposal-card.tsx',
    'components/admin/merge-citizens-dialog.tsx',
    'components/admin/citizen-merges.tsx',
    'components/admin/citizen-editor.tsx',
    'components/admin/unit-correction-delete-dialog.tsx',
  ];

  it.each(SCREENS)('%s draws a block through blockText and never block.message', (path) => {
    const code = withoutComments(read(path));
    expect(code).toMatch(/\bblockText\(/);
    expect(code).not.toMatch(/\bblocks?\.message\b/);
    expect(code).not.toMatch(/\bblocker\.message\b/);
  });

  it('keeps no hand-written copy of the unit correction blockers beside the refusals', () => {
    expect(read('components/admin/unit-correction-delete-dialog.tsx')).not.toMatch(/function blockerText/);
  });
});

const apiFetch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ items: [], total: 0 })));
vi.mock('./api/core', () => ({ apiFetch }));

describe('getFeeNotices (PAG-05)', () => {
  beforeEach(() => apiFetch.mockClear());

  it('asks for the page it is given', async () => {
    const { getFeeNotices } = await import('./api/fees');
    await getFeeNotices('t1', 'tok', { limit: 25, offset: 50 });
    expect(apiFetch.mock.calls[0]?.[1]).toBe('/fees/notices?limit=25&offset=50');
  });

  it('asks for the most one request may when no page is given (the backup export)', async () => {
    const { getFeeNotices } = await import('./api/fees');
    await getFeeNotices('t1', 'tok');
    expect(apiFetch.mock.calls[0]?.[1]).toBe('/fees/notices?limit=200&offset=0');
  });
});

describe('«إشعارات الرسوم» pages on the server (PAG-05)', () => {
  const page = withoutComments(read('app/[tenant]/[locale]/[adminPath]/(protected)/fees/notices/page.tsx'));

  it('is a manually paged DataTable whose page is in the URL', () => {
    expect(page).toMatch(/\bmanualPagination\b/);
    expect(page).toMatch(/useUrlPagination\(/);
    expect(page).not.toMatch(/paginated=\{false\}/);
  });

  it('reads the page it shows, and keeps the last one while the next is read', () => {
    expect(page).toMatch(/queryKey: \['fee-notices', tenant, pagination\.pageIndex, pagination\.pageSize\]/);
    expect(page).toMatch(/offset: pagination\.pageIndex \* pagination\.pageSize/);
    expect(page).toMatch(/keepPrevious: true/);
  });

  it('no longer says it shows only the latest notices', () => {
    expect(page).not.toMatch(/'truncated'/);
    expect((en.fees.notices as Record<string, unknown>).truncated).toBeUndefined();
    expect((ar.fees.notices as Record<string, unknown>).truncated).toBeUndefined();
  });
});
