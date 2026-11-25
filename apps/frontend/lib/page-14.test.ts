import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-14 (cleanup sprint, 2026-11-25): the news pages against the page contract. Most of the contract held
  already (a title equal to its row's label, session and reads through the hooks, the table's state in the
  URL, every write behind one in-flight ref, copy in messages, no file over 600 lines), so what changed is
  small and this pins it: the articles page's primary action comes first, and a failed re-read of a list is
  said instead of silently leaving the old rows. The time input waits for decision U-8 (a time primitive) and
  is deliberately not touched. The runner collects `lib/**` only, so the pages are read as source.
*/
const FRONTEND = join(__dirname, '..');
const NEWS = 'app/[tenant]/[locale]/[adminPath]/(protected)/news';
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

describe('the articles page’s header (contract item 2)', () => {
  const page = read(`${NEWS}/articles/page.tsx`);
  // From `actions={` to the intro line under the header.
  const actions = page.slice(page.indexOf('actions={'), page.indexOf('<p className="max-w-3xl'));

  it('puts the one primary action first in reading order, then the two lists', () => {
    const create = actions.indexOf("t('new')");
    const categories = actions.indexOf("t('categoriesLink')");
    const publishers = actions.indexOf("t('publishersLink')");
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(categories);
    expect(categories).toBeLessThan(publishers);
  });

  it('has three controls, so no menu is called for, and no refresh over a TanStack read', () => {
    expect((actions.match(/<(?:Button|Link)\b/g) ?? []).length).toBe(3);
    expect(actions).not.toMatch(/RefreshCw|تحديث|Refresh/);
  });
});

describe.each([
  ['articles', 'first'],
  ['categories', 'query'],
  ['publishers', 'query'],
])('the %s list says when a re-read failed (contract item 3)', (page, read_) => {
  const source = read(`${NEWS}/${page}/page.tsx`);

  it('decides its state once, with readView', () => {
    expect(source).toMatch(new RegExp(`const view = readView\\(${read_}\\.data, ${read_}\\.error\\);`));
  });

  it('takes the page for an error only while nothing has loaded', () => {
    expect(source).toMatch(/\{view\.state === 'failed' \? \(/);
    expect(source).not.toMatch(/\.error && !\w+\.data \?/);
  });

  it('keeps the rows on a failed re-read and says so, with a retry', () => {
    expect(source).toMatch(/view\.state === 'ready' && view\.refreshFailed \? \(\s*<RefreshFailedAlert message=\{[^}]*view\.refreshFailed\} onRetry=\{\w+\.refetch\} \/>/);
  });

  it('names the failure with the API’s own words where it gave a specific code', () => {
    expect(source).toMatch(new RegExp(`${read_}\\.refusal \\?\\? view\\.`));
  });
});

describe('the lists’ lists keep a way back (NAV-05)', () => {
  it.each(['categories', 'publishers'])('%s leads back to the articles in the header', (page) => {
    expect(read(`${NEWS}/${page}/page.tsx`)).toMatch(/<HeaderBackLink fallbackHref=\{`\$\{base\}\/news\/articles`\}/);
  });
});

describe('what was left as it is, and why', () => {
  it('the time input still waits for decision U-8: the day-and-time fields keep their native time input', () => {
    expect(read('components/admin/news/day-time-fields.tsx')).toMatch(/type="time"/);
  });

  it('every news write is guarded by a ref (contract item 6)', () => {
    for (const file of ['news-category-dialog', 'news-publisher-dialog', 'article-media', 'article-editor']) {
      expect(read(`components/admin/news/${file}.tsx`), file).toMatch(/const inFlight = useRef\(false\);/);
    }
  });

  // The two lists' dialogs check at the top, validate, and set just before the request: nothing is awaited in between.
  it.each(['news-category-dialog', 'news-publisher-dialog'])('%s sets its ref before any await, and then the busy state', (file) => {
    const source = read(`components/admin/news/${file}.tsx`);
    const check = source.indexOf('if (inFlight.current) return;');
    const set = source.indexOf('inFlight.current = true;');
    expect(check).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(check);
    expect(source.slice(check, set)).not.toMatch(/\bawait\b/);
    expect(source).toMatch(/inFlight\.current = true;\s*\n\s*setBusy\(true\);/);
    expect(source).toMatch(/inFlight\.current = false;/);
  });
});
