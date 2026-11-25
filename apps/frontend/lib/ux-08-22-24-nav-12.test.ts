import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsCopy } from '@/lib/settings-i18n';

/*
  UX-08, UX-22, UX-24 and NAV-12 (cleanup sprint, 2026-11-24): a Tabs primitive
  in place of two hand-rolled tablists, a security screen that shows no invented
  sign-ins, a dialog title that keeps clear of its close button, and the
  quality index forwarding on the server (since NAV-03, a page of tabs). This reads the sources (the runner
  collects `lib/**` only and has no DOM).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: a comment may quote what it replaced. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}
const code = (path: string): string => withoutComments(read(path));

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

function filesMatching(pattern: RegExp, dirs = ['app', 'components', 'lib']): string[] {
  return dirs
    .flatMap((dir) => sourcesUnder(join(FRONTEND, dir)))
    .filter((file) => pattern.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(FRONTEND, file).replace(/\\/g, '/'))
    .sort();
}

const CASES_PAGE = 'app/[tenant]/[locale]/[adminPath]/(protected)/cases/page.tsx';

describe('tabs are a primitive (UX-08, CTL-9)', () => {
  it('the primitive is Radix’s, and the package says so', () => {
    expect(code('components/ui/tabs.tsx')).toMatch(/from '@radix-ui\/react-tabs'/);
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@radix-ui/react-tabs']).toBeTruthy();
  });

  it('no screen builds a tablist of its own', () => {
    expect(filesMatching(/role=["']tablist["']/, ['app', 'components'])).toEqual([]);
  });

  it('the case queues are a line-style Tabs over the one table, which is the open tab’s panel', () => {
    const tabs = code('components/admin/cases/case-queue-tabs.tsx');
    expect(tabs).toMatch(/<TabsList variant="line"/);
    expect(tabs).toMatch(/<TabsContent value=\{tab\}>\{children\}<\/TabsContent>/);
    expect(tabs).toMatch(/dir=\{en \? 'ltr' : 'rtl'\}/);
    const page = code(CASES_PAGE);
    expect(page).toMatch(/<CaseQueueTabs [^>]*>\s*<CardContent/);
    expect(page).toMatch(/<\/CardContent>\s*<\/CaseQueueTabs>/);
  });

  it('the review queue’s state filter is a pill Tabs, and its list the open tab’s panel', () => {
    const source = code('components/admin/quality/review-queue.tsx');
    expect(source).toMatch(/<TabsList variant="pill"/);
    expect(source).toMatch(/<TabsTrigger key=\{option\.key\} value=\{option\.key\}>/);
    expect(source).toMatch(/<TabsContent value=\{tab\} className="space-y-4">/);
    expect(source).toMatch(/dir=\{en \? 'ltr' : 'rtl'\}/);
    // The pager's scroll target is still the root, which `Tabs` forwards its ref to.
    expect(source).toMatch(/ref=\{listTop\}/);
  });
});

describe('the dialog’s title keeps clear of its close button (UX-24)', () => {
  it('DialogHeader reserves the end the X sits in, logically', () => {
    expect(code('components/ui/dialog.tsx')).toMatch(/'flex flex-col space-y-1\.5 text-start pe-6 sm:pe-4'/);
  });

  it('and ConfirmDialog takes it from DialogHeader', () => {
    const source = code('components/ui/confirm-dialog.tsx');
    expect(source).toMatch(/<DialogHeader>/);
    expect(source).not.toMatch(/\b(?:pr|pl|mr|ml)-\d/);
  });

  it('the X is still where the padding assumes: end-4, 16px', () => {
    const source = code('components/ui/dialog.tsx');
    expect(source).toMatch(/absolute end-4 top-4/);
    expect(source).toMatch(/<X className="h-4 w-4" \/>/);
  });
});

/*
  NAV-12 (`/quality` forwarding to `/quality/reviews` on the server) was superseded by NAV-03 on
  2026-11-25: `/quality` is the page of four tabs, and the four old addresses are the server
  redirects. Those are pinned in `lib/nav-03-04-11.test.ts`.
*/

describe('«أمان الحساب» shows no invented sign-ins (UX-22)', () => {
  it('the sample rows are gone, and with them the documentation addresses they carried', () => {
    expect(filesMatching(/SAMPLE_ROWS/)).toEqual([]);
    expect(filesMatching(/192\.0\.2\.|198\.51\.100\./)).toEqual([]);
  });

  it('so is the card that drew them', () => {
    const source = code('components/admin/settings/security-section.tsx');
    expect(source).not.toMatch(/Login History|historySample|<ScrollableTable/);
  });

  it('and the copy that was written for it, in both languages', () => {
    for (const locale of ['ar', 'en']) {
      const security = settingsCopy(locale).security as unknown as Record<string, unknown>;
      for (const key of [
        'historyHeading',
        'historyHint',
        'historySample',
        'historySampleHint',
        'colWhen',
        'colIp',
        'colDevice',
        'colLocation',
        'colResult',
        'resultSuccess',
        'resultFailed',
      ]) {
        expect(security, `${locale} ${key}`).not.toHaveProperty(key);
      }
    }
    expect(Object.keys(settingsCopy('ar').security).sort()).toEqual(Object.keys(settingsCopy('en').security).sort());
  });

  it('the backup history keeps its own «historyHeading»: it is a different section', () => {
    expect(settingsCopy('en').backup.historyHeading).toBeTruthy();
  });
});
