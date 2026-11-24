import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  DEAD-13, PAGE-03 and CACHE-02 (cleanup sprint, decisions of 2026-11-24: U-15,
  U-21, U-3). This reads the sources, so it fails when one comes back (the runner
  collects `lib/**` only and has no DOM).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx|css)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/** Files (relative to the app) under `app`, `components` and `lib` whose text matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const dir of ['app', 'components', 'lib']) {
    for (const file of sourcesUnder(join(FRONTEND, dir))) {
      if (pattern.test(readFileSync(file, 'utf8'))) found.push(relative(FRONTEND, file).replace(/\\/g, '/'));
    }
  }
  return found.sort();
}

describe('the accent system is gone (DEAD-13, U-15)', () => {
  it('its two files are deleted', () => {
    expect(existsSync(join(FRONTEND, 'lib/accents.ts'))).toBe(false);
    expect(existsSync(join(FRONTEND, 'components/accent-provider.tsx'))).toBe(false);
  });

  it('nothing names it, in code or in a stylesheet', () => {
    expect(filesMatching(/AccentProvider|useAccent|isAccent|ACCENT_INIT_SCRIPT|ACCENT_STORAGE_KEY|data-accent/)).toEqual([]);
  });

  it("the tenant layout still wraps the page in the theme and still writes the municipality's brand colour", () => {
    const layout = read('app/[tenant]/[locale]/layout.tsx');
    expect(layout).toMatch(/<ThemeProvider>\{children\}<\/ThemeProvider>/);
    expect(layout).toMatch(/--brand-primary:\$\{brandPrimary\}/);
  });
});

describe('the portal’s phone-code sign-in and «حسابي» are retired (PAGE-03, U-21)', () => {
  const PORTAL = 'app/[tenant]/[locale]/(citizen)/';

  it.each(['login', 'my-account'])('%s redirects to «ملفّي» on the server and renders nothing of its own', (route) => {
    const source = read(`${PORTAL}${route}/page.tsx`);
    expect(source).not.toMatch(/^\s*['"]use client['"]/);
    expect(source).toMatch(/redirect\(`\/\$\{tenant\}\/\$\{locale\}\/my-file`\)/);
    // no sign-in call, no session read, no markup
    expect(source).not.toMatch(/requestOtp|verifyOtp|loadSession|saveSession|useState|<[A-Za-z]/);
  });

  it('the client no longer has the two OTP calls, and no screen links the phone-code page', () => {
    const client = read('lib/api-client.ts');
    expect(client).not.toMatch(/\brequestOtp\b|\bverifyOtp\b|\bCitizenChoice\b|\bVerifyOtpResponse\b/);
    // `${locale}/login` is the phone-code page; the payments door's own sign-in is `payments/login`, which this does not match.
    const linking = filesMatching(/\$\{locale\}\/login\b/).filter((file) => file.startsWith('app/[tenant]/[locale]/(citizen)/'));
    expect(linking).toEqual([]);
  });

  it('«ملفّي» sends a citizen who is not signed in to the front door, not to a retired page', () => {
    const myFile = read(`${PORTAL}my-file/page.tsx`);
    expect(myFile).toMatch(/router\.replace\(base\)/);
    expect(myFile).not.toMatch(/\/login|\/my-account/);
  });
});

describe('request-cache.ts is kept, and says who calls it (CACHE-02, U-3)', () => {
  const source = read('lib/request-cache.ts');

  it('its header records the decision and the callers', () => {
    expect(source).toMatch(/decision U-3, 2026-11-24, CACHE-02/);
    for (const caller of ['api-client.ts', 'api/fees.ts', 'api/zones.ts', 'api/buildings.ts', 'api/citizens.ts']) {
      expect(source, caller).toContain(caller);
    }
  });

  it('every file that imports it is one the header names', () => {
    const importers = filesMatching(/from '(?:\.\.?\/|@\/lib\/)request-cache'|from '\.\/request-cache'/).filter(
      (file) => file !== 'lib/request-cache.ts',
    );
    const named = ['lib/api-client.ts', 'lib/api/fees.ts', 'lib/api/zones.ts', 'lib/api/buildings.ts', 'lib/api/citizens.ts'];
    expect(importers).toEqual([...named].sort());
  });
});
