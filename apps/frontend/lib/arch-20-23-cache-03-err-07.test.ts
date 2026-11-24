import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNIT_TYPE, isStructuralUnitType } from '@mechanization/shared-schemas';
import { BUILDING_UNIT_TYPES } from '@/lib/building-unit-types';
import { serviceWorkerUrl } from '@/lib/service-worker-url';

/*
  ARCH-20, ARCH-23, CACHE-03 and ERR-07 (cleanup sprint, 2026-11-24): `lib`
  stops importing components, the service worker's version follows the build,
  the owner-link caches are invalidated by tenant, and a staff page that throws
  no longer takes the shell with it. This reads the sources (the runner collects
  `lib/**` only and has no DOM), and evaluates the worker's version expression.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const ar = JSON.parse(read('messages/ar.json')) as { common: Record<string, string> };
const en = JSON.parse(read('messages/en.json')) as { common: Record<string, string> };

/** The code of a file: a comment may name what it replaced. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

/** Non-test files under `dirs` (relative to the app) whose code matches `pattern`. */
function filesMatching(pattern: RegExp, dirs = ['app', 'components', 'lib']): string[] {
  return dirs
    .flatMap((dir) => sourcesUnder(join(FRONTEND, dir)))
    .filter((file) => !/\.test\.ts$/.test(file))
    .filter((file) => pattern.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(FRONTEND, file).replace(/\\/g, '/'))
    .sort();
}

describe('lib imports nothing from components (ARCH-20)', () => {
  it('no lib module does', () => {
    // `lib/nav.test.ts` is a test of `components/admin/nav.ts`, which is why it is not a module.
    expect(filesMatching(/from ['"](?:@\/components|(?:\.\.?\/)+components)/, ['lib'])).toEqual([]);
  });

  it.each([
    ['components/admin/citizen-form.tsx', /export type \{ CitizenFormValues \} from '@\/lib\/citizen-form-values'/],
    ['components/citizen/property-card.tsx', /export type \{ CardRemovalAnswer, PropertyDraft, UnitDraft \} from '@\/lib\/citizen-form-values'/],
    ['components/admin/unit-grid-picker.tsx', /export type \{ GridUnitDraft \} from '@\/lib\/building-draft'/],
    ['components/admin/payment-receipt.tsx', /export type \{ RecordedMovement, RecordedTender \} from '@\/lib\/recorded-movement'/],
    ['components/citizen/unit-fields.tsx', /export \{ BUILDING_UNIT_TYPES \} from '@\/lib\/building-unit-types'/],
    ['components/ui/pager.tsx', /export type \{ PagerLabels \} from '@\/lib\/ui-labels'/],
    ['components/ui/data-table.tsx', /export type \{ DataTableLabels \} from '@\/lib\/ui-labels'/],
  ])('%s still exports what it exported, so no importer changed', (path, reexport) => {
    expect(read(path)).toMatch(reexport);
  });

  it('the moved types are declared once, in lib', () => {
    for (const [name, home] of [
      ['CitizenFormValues', 'lib/citizen-form-values.ts'],
      ['PropertyDraft', 'lib/citizen-form-values.ts'],
      ['NamesBefore', 'lib/citizen-form-values.ts'],
      ['GridUnitDraft', 'lib/building-draft.ts'],
      ['RecordedMovement', 'lib/recorded-movement.ts'],
      ['PagerLabels', 'lib/ui-labels.ts'],
      ['DataTableLabels', 'lib/ui-labels.ts'],
    ] as const) {
      expect(filesMatching(new RegExp(`export interface ${name}\\b`)), name).toEqual([home]);
    }
  });

  it('BUILDING_UNIT_TYPES is what a building can contain: no independent house, no structural type', () => {
    expect(BUILDING_UNIT_TYPES).not.toContain('INDEPENDENT_HOUSE');
    expect(BUILDING_UNIT_TYPES.some((type) => isStructuralUnitType(type))).toBe(false);
    expect(BUILDING_UNIT_TYPES.length).toBeGreaterThan(0);
    expect(BUILDING_UNIT_TYPES.every((type) => (UNIT_TYPE as readonly string[]).includes(type))).toBe(true);
  });
});

describe("the service worker's version is the build's commit (ARCH-23)", () => {
  /** What `VERSION` comes to in `public/sw.js` when the page registered it at `href`. */
  function versionAt(href: string): string {
    const statement = read('public/sw.js').match(/const VERSION =[\s\S]*?;\r?\n/);
    if (!statement) throw new Error('no VERSION statement in sw.js');
    return new Function('self', `${statement[0]}\nreturn VERSION;`)({ location: { href } }) as string;
  }

  it('is no longer a constant someone bumps', () => {
    expect(read('public/sw.js')).not.toMatch(/const VERSION = '/);
  });

  it('is the `v` of its own address', () => {
    expect(versionAt('https://example.test/sw.js?v=3f9a1c2b7d10')).toBe('3f9a1c2b7d10');
  });

  it('is «unversioned» with no `v`, an empty one, or nothing a cache name can hold', () => {
    expect(versionAt('https://example.test/sw.js')).toBe('unversioned');
    expect(versionAt('https://example.test/sw.js?v=')).toBe('unversioned');
    expect(versionAt('https://example.test/sw.js?v=%2F%20%3F')).toBe('unversioned');
  });

  it('keeps only characters a cache name can hold, and no more than 40', () => {
    expect(versionAt('https://example.test/sw.js?v=ab%2Fcd%20ef')).toBe('abcdef');
    expect(versionAt(`https://example.test/sw.js?v=${'a'.repeat(100)}`)).toHaveLength(40);
  });

  it('names its caches after it, and activate deletes the other versions', () => {
    const source = read('public/sw.js');
    expect(source).toMatch(/`mechanization-shell-\$\{VERSION\}`/);
    expect(source).toMatch(/name\.startsWith\('mechanization-'\) && !CURRENT\.includes\(name\)/);
  });

  it('the page registers the address that carries the commit', () => {
    expect(serviceWorkerUrl('3f9a1c2b7d10aabbccddeeff00112233445566778')).toBe('/sw.js?v=3f9a1c2b7d10');
    expect(serviceWorkerUrl(undefined)).toBe('/sw.js');
    expect(serviceWorkerUrl('   ')).toBe('/sw.js');
    const hook = read('lib/use-service-worker.ts');
    expect(hook).toMatch(/serviceWorker\.register\(serviceWorkerUrl\(COMMIT_SHA\)/);
    expect(hook).not.toMatch(/register\('\/sw\.js'/);
  });

  it('the commit is read from the environment in two places only: here, and where Sentry tags its release', () => {
    expect(filesMatching(/process\.env\.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA/)).toEqual(['lib/public-config.ts', 'lib/sentry-options.ts']);
  });
});

describe('the owner-link caches are invalidated by tenant (CACHE-03)', () => {
  it('no call names the queue or its summary without the tenant', () => {
    expect(filesMatching(/queryKey: \['landlord-links(?:-summary)?'\]/)).toEqual([]);
  });

  it.each([
    'app/[tenant]/[locale]/[adminPath]/(protected)/citizens/landlord-links/page.tsx',
    'app/[tenant]/[locale]/[adminPath]/(protected)/citizens/landlord-links/[propertyEntryId]/page.tsx',
    'components/admin/cases/use-case-linking.ts',
  ])('%s invalidates both by [name, tenant]', (path) => {
    const source = read(path);
    expect(source).toContain("queryKey: ['landlord-links', tenant]");
    expect(source).toContain("queryKey: ['landlord-links-summary', tenant]");
  });
});

describe('a staff page that throws keeps the shell (ERR-07)', () => {
  const dir = 'app/[tenant]/[locale]/[adminPath]/(protected)';

  it('has a boundary beside the protected layout, which is what it has to sit beside', () => {
    expect(existsSync(join(FRONTEND, dir, 'layout.tsx'))).toBe(true);
    expect(existsSync(join(FRONTEND, dir, 'error.tsx'))).toBe(true);
  });

  it('retries, reports, and offers a way home', () => {
    const source = code(`${dir}/error.tsx`);
    expect(source).toMatch(/^'use client';/);
    expect(source).toMatch(/onClick=\{reset\}/);
    expect(source).toMatch(/Sentry\.captureException\(error\)/);
    expect(source).toMatch(/href=\{`\/\$\{tenant\}\/\$\{locale\}\/\$\{adminPath\}`\}/);
  });

  it('says it in the page’s language, with words both message files hold', () => {
    const source = code(`${dir}/error.tsx`);
    expect(source).toMatch(/useTranslations\('common'\)/);
    for (const key of ['error', 'errorBody', 'errorReference', 'retry', 'errorHome']) {
      expect(source, key).toContain(`t('${key}')`);
      expect(ar.common[key], `ar ${key}`).toBeTruthy();
      expect(en.common[key], `en ${key}`).toBeTruthy();
    }
  });

  function code(path: string): string {
    return withoutComments(read(path));
  }
});
