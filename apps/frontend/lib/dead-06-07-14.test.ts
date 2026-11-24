import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  DEAD-06, DEAD-07 and DEAD-14 (cleanup sprint, 2026-11-24): three modules
  nothing imported, a dependency nothing used, and nine exports nothing read.
  This reads the sources, so it fails when one comes back (the runner collects
  `lib/**` only and has no DOM).

  Not here, on purpose: `backup-section.tsx` (kept unrendered until DEAD-10's
  decision, U-11) and the four unused client functions (DEAD-17). `useAccent`
  and `isAccent` were kept for DEAD-13's decision (U-15) and went with the whole
  accent system on 2026-11-24 (`lib/dead-13-page-03-cache-02.test.ts`).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: a comment may name a symbol it replaced. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/** Files (relative to the app) under its source folders and top-level config files whose code matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  const roots = ['app', 'components', 'lib', 'i18n', 'scripts'].map((dir) => join(FRONTEND, dir));
  const topLevel = readdirSync(FRONTEND, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name))
    .map((entry) => join(FRONTEND, entry.name));
  const files = [...roots.filter(existsSync).flatMap((root) => sourcesUnder(root)), ...topLevel];
  return files
    .filter((file) => pattern.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(FRONTEND, file).replace(/\\/g, '/'))
    .sort();
}

describe('the modules nothing imported are gone (DEAD-06)', () => {
  it.each([
    'components/admin/confirm-cash-payment-dialog.tsx',
    'components/admin/workflow.tsx',
    'lib/use-section-nav.ts',
  ])('%s', (path) => {
    expect(existsSync(join(FRONTEND, path))).toBe(false);
  });

  it('and nothing names them', () => {
    expect(filesMatching(/confirm-cash-payment-dialog|ConfirmCashPaymentDialog|admin\/workflow|Workflow(?:Rail|Section|Empty)|use-section-nav|useSectionNav/)).toEqual([]);
  });

  it('the guard on Arabic-only attributes allows no exception now', () => {
    expect(read('lib/localised-labels.test.ts')).toMatch(/expect\(\[\.\.\.new Set\(found\)\]\)\.toEqual\(\[\]\)/);
  });
});

describe('the frontend names no dependency it does not use (DEAD-07)', () => {
  it('apps/frontend/package.json has no zod', () => {
    const manifest = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).not.toHaveProperty('zod');
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('zod');
  });

  it('and no source imports it: the shared schemas bring their own, from their own folder', () => {
    expect(filesMatching(/from ['"]zod['"]|require\(['"]zod['"]\)|import\(['"]zod['"]\)/)).toEqual([]);
  });
});

describe('the exports nothing read are gone (DEAD-14)', () => {
  it.each([
    'ROLLUP_KINDS',
    'LocalOnlyNotice',
    'hasUnitFigure',
    'MIN_GRID_SIZE',
    'MAX_GRID_SIZE',
    'geometryCenter',
    'isRtlLocale',
  ])('%s', (symbol) => {
    expect(filesMatching(new RegExp(`\\b${symbol}\\b`))).toEqual([]);
  });

  it('DEFAULT_GRID_SIZE, its neighbour in the same alias block, stays: the building editor reads it', () => {
    expect(read('components/admin/unit-grid-picker.tsx')).toMatch(/export const DEFAULT_GRID_SIZE = DEFAULT_HORIZONTAL_BLOCKS;/);
    expect(read('components/admin/building-editor.tsx')).toMatch(/\bDEFAULT_GRID_SIZE\b/);
  });

  it('SHARED_SENTRY_OPTIONS stays: the audit listed it, and all three Sentry configs spread it', () => {
    for (const config of ['instrumentation-client.ts', 'sentry.edge.config.ts', 'sentry.server.config.ts']) {
      expect(read(config), config).toMatch(/\.\.\.SHARED_SENTRY_OPTIONS/);
    }
    expect(read('lib/sentry-options.ts')).toMatch(/export const SHARED_SENTRY_OPTIONS\b/);
  });
});
