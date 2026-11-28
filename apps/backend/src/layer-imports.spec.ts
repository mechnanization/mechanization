import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The dependency rule, held by a test (audit ARCH-07, ARCH-08, ARCH-09).
 *
 * apps/backend/CLAUDE.md "Layers and the dependency rule": domain imports
 * nothing outside domain; application imports domain and, from infrastructure,
 * only the entry points listed below; infrastructure imports neither application
 * nor presentation. Each of those was broken at least once (APP_CONFIG under
 * presentation, the search terms under application, the cadastre readers under
 * infrastructure), and a review never caught them because the import line looks
 * like every other import line.
 *
 * Specs and `*.testing.ts` helpers are left out: a test assembles the real
 * pieces (a test client, the migrator, a repository) on purpose. So is
 * `src/scripts`, which composes the layers as `main.ts` does.
 */

const SRC = __dirname;
const LAYER = {
  domain: join(SRC, 'domain'),
  application: join(SRC, 'application'),
  infrastructure: join(SRC, 'infrastructure'),
  presentation: join(SRC, 'presentation'),
} as const;

/**
 * The infrastructure modules application code may import, by path under
 * `src/infrastructure` without the extension. The reasons live in
 * apps/backend/CLAUDE.md beside the same list; a module added here is added there.
 */
const APPLICATION_MAY_IMPORT = new Set([
  'context/tenant-context.service',
  'context/tenant-transaction',
  'context/tenant-runner',
  'prisma/tenant-schema-ref',
  'prisma/with-connection-retry',
  'prisma/prisma-errors',
  'prisma/check-violation',
  'prisma/house-card-guard',
  'cache/redis-cache.service',
  'repositories/earnings-registrations',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.testing.ts') ? [full] : [];
  });
}

/** Every relative module a file imports or re-exports, resolved to an absolute path without extension. */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [
    ...text.matchAll(/\bfrom\s+'(\.[^']*)'/g),
    ...text.matchAll(/\bimport\(\s*'(\.[^']*)'\s*\)/g),
    ...text.matchAll(/\brequire\(\s*'(\.[^']*)'\s*\)/g),
  ].map((match) => match[1]!);
  return specifiers.map((specifier) => resolve(dirname(file), specifier).replace(/\.ts$/, ''));
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);
const shown = (path: string): string => relative(SRC, path).split(sep).join('/');

/** `file → target` for every import from `layer` that `refuse` turns away. */
function offenders(layer: string, refuse: (target: string) => boolean): string[] {
  return sourceFiles(layer).flatMap((file) =>
    relativeImports(file)
      .filter(refuse)
      .map((target) => `${shown(file)} → ${shown(target)}`),
  );
}

describe('the dependency rule', () => {
  it('reads real source: each layer has files, and application reaches the infrastructure entry points', () => {
    // A guard that walked an empty or wrong directory would pass every case below.
    for (const dir of Object.values(LAYER)) expect(sourceFiles(dir).length).toBeGreaterThan(5);
    const reached = sourceFiles(LAYER.application)
      .flatMap(relativeImports)
      .filter((target) => inside(target, LAYER.infrastructure));
    expect(reached.length).toBeGreaterThan(50);
  });

  it('domain imports nothing from another layer', () => {
    expect(offenders(LAYER.domain, (target) => inside(target, SRC) && !inside(target, LAYER.domain))).toEqual([]);
  });

  it('application imports no presentation', () => {
    expect(offenders(LAYER.application, (target) => inside(target, LAYER.presentation))).toEqual([]);
  });

  it('application imports infrastructure only through the allowed entry points', () => {
    expect(
      offenders(
        LAYER.application,
        (target) =>
          inside(target, LAYER.infrastructure) && !APPLICATION_MAY_IMPORT.has(relative(LAYER.infrastructure, target).split(sep).join('/')),
      ),
    ).toEqual([]);
  });

  it('infrastructure imports neither application nor presentation', () => {
    expect(
      offenders(LAYER.infrastructure, (target) => inside(target, LAYER.application) || inside(target, LAYER.presentation)),
    ).toEqual([]);
  });

  it('every allowed entry point exists, so the list cannot outlive what it names', () => {
    const missing = [...APPLICATION_MAY_IMPORT].filter((module) => {
      try {
        return !statSync(join(LAYER.infrastructure, `${module}.ts`)).isFile();
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });
});
