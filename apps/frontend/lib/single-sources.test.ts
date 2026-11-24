import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLocale, isLocale, locales } from '../i18n/routing';

/*
  DRY-13, DRY-14 and DRY-15 (cleanup sprint, 2026-11-24): three values each
  read in several places with a fallback of its own — the API's address and the
  Mapbox token, the tenant's public config, the default language. One source
  each now; this fails when a copy comes back.

  Read, not rendered (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/** Files (relative) under the app whose source matches `pattern`. */
function filesMatching(pattern: RegExp, dirs = ['app', 'components', 'lib', 'i18n']): string[] {
  const found: string[] = [];
  const roots = [...dirs.map((dir) => join(FRONTEND, dir)), join(FRONTEND, 'middleware.ts')];
  for (const root of roots) {
    const files = root.endsWith('.ts') ? [root] : sourcesUnder(root);
    for (const file of files) {
      if (pattern.test(readFileSync(file, 'utf8'))) found.push(relative(FRONTEND, file).replace(/\\/g, '/'));
    }
  }
  return found.sort();
}

describe('the NEXT_PUBLIC_* values are read in one module (DRY-13)', () => {
  it('the API address', () => {
    expect(filesMatching(/process\.env\.NEXT_PUBLIC_API_URL/)).toEqual(['lib/public-config.ts']);
  });

  it('the Mapbox token', () => {
    expect(filesMatching(/process\.env\.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN/)).toEqual(['lib/public-config.ts']);
  });

  it('the local fallback address is spelled once', () => {
    expect(filesMatching(/localhost:4000\/api\/v1/)).toEqual(['lib/public-config.ts']);
  });
});

describe('the tenant config is fetched through one server helper (DRY-14)', () => {
  it('no layout or route defines its own getTenant', () => {
    expect(filesMatching(/function (getTenant|getTenantName|municipalityName)\b/, ['app'])).toEqual([]);
  });

  it('the one fetch of tenant/config is the helper’s, cached for the request', () => {
    expect(filesMatching(/\/tenant\/config/, ['app', 'components', 'i18n'])).toEqual([]);
    const helper = readFileSync(join(FRONTEND, 'lib', 'tenant-config.server.ts'), 'utf8');
    expect(helper).toMatch(/export const fetchTenantConfig = cache\(/);
    expect(helper).toMatch(/\/tenant\/config/);
  });
});

describe('the default language is one constant (DRY-15)', () => {
  it('is Arabic, the language a visitor with no cookie and no Accept-Language is sent to', () => {
    expect(defaultLocale).toBe('ar');
    expect(locales).toContain(defaultLocale);
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('the middleware takes it from i18n/routing', () => {
    expect(filesMatching(/\bDEFAULT_LOCALE\b/)).toEqual([]);
    const middleware = readFileSync(join(FRONTEND, 'middleware.ts'), 'utf8');
    expect(middleware).toMatch(/from '\.\/i18n\/routing'/);
    expect(middleware).toMatch(/targetLocale: Locale = defaultLocale/);
    expect(middleware).not.toMatch(/const LOCALES\b/);
  });

  it('the tenant layout turns an unrecognised locale into the default, in its own direction', () => {
    const layout = readFileSync(join(FRONTEND, 'app', '[tenant]', '[locale]', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/const locale = isLocale\(requested\) \? requested : defaultLocale;/);
  });
});

describe('the middleware sends a visitor with no language to the default (DRY-15, behaviour)', () => {
  const redirectOf = async (headers: Record<string, string> = {}, path = '/acme/dashboard-x') => {
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('../middleware');
    const response = middleware(new NextRequest(`http://localhost${path}`, { headers }));
    return response.headers.get('location');
  };

  it('lands on /ar with no cookie and no Accept-Language', async () => {
    expect(await redirectOf()).toBe('http://localhost/acme/ar/dashboard-x');
  });

  it('follows a cookie, then Accept-Language, over the default', async () => {
    expect(await redirectOf({ cookie: 'NEXT_LOCALE=en' })).toBe('http://localhost/acme/en/dashboard-x');
    expect(await redirectOf({ 'accept-language': 'en-GB,en;q=0.9' })).toBe('http://localhost/acme/en/dashboard-x');
    expect(await redirectOf({ cookie: 'NEXT_LOCALE=fr', 'accept-language': 'fr-FR' })).toBe(
      'http://localhost/acme/ar/dashboard-x',
    );
  });

  it('leaves a path that already has a locale alone', async () => {
    expect(await redirectOf({}, '/acme/en/dashboard-x')).toBeNull();
  });
});
