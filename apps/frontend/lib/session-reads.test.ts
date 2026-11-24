import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  ARCH-18 and ARCH-19 (cleanup sprint, 2026-11-24): twenty-odd pages and
  components each opened with the same effect — read the session out of
  storage, bounce to the login page if it was missing or a citizen's, then hold
  the token and the claims in two `useState`s — and a copy that forgot the
  `kind !== 'STAFF'` check was a citizen session rendering a staff page until
  the first request came back 403. `useStaffSession` is the one copy now.

  What may still call `loadSession` directly: the shell and the route guard that
  sit above every protected page, the staff login page (it asks whether to skip
  itself), and the citizen side, which has no staff session (and reads its own
  through `useCitizenSession` where it can).

  Read, not rendered (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsxUnder(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const callers = (dir: string): string[] =>
  tsxUnder(join(FRONTEND, dir))
    .filter((file) => /\bloadSession\(/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(FRONTEND, file).replace(/\\/g, '/'))
    .sort();

describe('the staff session is read through useStaffSession', () => {
  it('components: only the shell and the route guard read storage themselves', () => {
    expect(callers('components')).toEqual(['components/admin/admin-shell.tsx', 'components/admin/staff-route-guard.tsx']);
  });

  it('app: only the staff login page and the citizen pages do', () => {
    expect(callers('app')).toEqual([
      'app/[tenant]/[locale]/(citizen)/my-file/page.tsx',
      'app/[tenant]/[locale]/(citizen)/page.tsx',
      'app/[tenant]/[locale]/(citizen)/payments/page.tsx',
      'app/[tenant]/[locale]/[adminPath]/login/page.tsx',
    ]);
  });
});

describe('a page that turns a role away gives it no token meanwhile', () => {
  const read = (file: string): string => readFileSync(join(FRONTEND, file), 'utf8');
  const PROTECTED = 'app/[tenant]/[locale]/[adminPath]/(protected)/';

  it.each([
    [PROTECTED + 'settings/page.tsx', 'isAdmin'],
    [PROTECTED + 'staff/page.tsx', 'isAdmin'],
    [PROTECTED + 'fees/payments/[paymentId]/settle/page.tsx', 'maySettle'],
    ['components/admin/case-editor.tsx', 'mayWrite'],
    ['components/admin/citizen-editor.tsx', 'mayEdit'],
  ])('%s: the token is null unless %s', (file, gate) => {
    const source = read(file);
    expect(source).toMatch(new RegExp(`const token = ${gate} \\? [\\w.]+ : null;`));
    // …and the screen is left by a redirect, not by rendering the form.
    expect(source).toMatch(new RegExp(`if \\(${gate} === false\\) router\\.replace`));
  });

  it('audit: the same, through the session object the page already reads', () => {
    const source = read(PROTECTED + 'audit/page.tsx');
    expect(source).toMatch(/const session = mayRead && staff\.token && staff\.user \?/);
    expect(source).toMatch(/if \(mayRead === false\) router\.replace/);
  });
});
