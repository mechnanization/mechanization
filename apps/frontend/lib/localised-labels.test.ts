import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-14 and ERR-06 (cleanup sprint, 2026-11-24).

  UX-14: toasts and accessibility attributes written in Arabic alone, which an
  English page then read out in the wrong language — «إغلاق القائمة» on the
  drawer's scrim, «خريطة العقارات» on the map, the toast's own close button.
  They come from `messages` now.

  ERR-06: `ErrorState` told a dropped connection from a server fault by finding
  «تعذّر الاتصال» in the description, which only ever matched the Arabic text of
  one message and never an English page's. The caller says so (`offline`, from
  the status), and four screens that drew their failed first read as a bare red
  `Alert` use `ErrorState` with a retry.

  Read, not rendered (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');
const read = (...path: string[]): string => readFileSync(join(FRONTEND, ...path), 'utf8');

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsxUnder(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const ARABIC = /[؀-ۿ]/;

/** Lines of every app and component file, as `[file:line, text]`. */
function lines(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const dir of ['app', 'components']) {
    for (const file of tsxUnder(join(FRONTEND, dir))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => out.push([`${relative(FRONTEND, file).replace(/\\/g, '/')}:${index + 1}`, text]));
    }
  }
  return out;
}

describe('UX-14: no accessibility attribute is Arabic alone', () => {
  it('aria-label, title, alt and closeLabel are never a bare Arabic string', () => {
    const found = lines()
      .filter(([, text]) => new RegExp(`\\b(aria-label|title|alt|closeLabel)="[^"]*${ARABIC.source}`).test(text))
      .map(([where]) => where.split(':')[0]);
    // The one left is `confirm-cash-payment-dialog.tsx`, which nothing imports (DEAD-xx).
    expect([...new Set(found)]).toEqual(['components/admin/confirm-cash-payment-dialog.tsx']);
  });

  it('no toast is raised with an Arabic literal as its title', () => {
    const found = lines()
      .filter(([, text]) => !/^\s*(\*|\/\/)/.test(text)) // a doc comment may show a call
      .filter(([, text]) => new RegExp(`toast\\.(success|error|warning|info)\\(\\s*['"\`][^'"\`]*${ARABIC.source}`).test(text));
    expect(found.map(([where]) => where)).toEqual([]);
  });

  it('the theme toggle takes every word from messages.themeToggle', () => {
    const source = read('components', 'theme-toggle.tsx');
    expect(source).toMatch(/useTranslations\('themeToggle'\)/);
    expect(source).not.toMatch(/label: '[؀-ۿ]/);
  });
});

describe('ERR-06: ErrorState is told, not guessing, that the connection dropped', () => {
  it('has an offline prop and no Arabic string match', () => {
    const source = read('components', 'ui', 'states.tsx');
    expect(source).toMatch(/offline\?: boolean;/);
    expect(source).not.toContain('تعذّر الاتصال');
    expect(source).toMatch(/useTranslations\('errorState'\)/);
  });

  it('useStaffQuery says offline from the status, not from the message', () => {
    const source = read('lib', 'use-staff-query.ts');
    expect(source).toMatch(/offline: error instanceof ApiRequestError && error\.status === 0/);
  });

  it.each([
    ['components/admin/parcel-roster-dialog.tsx', 'error', /<ErrorState compact description=\{error\} offline=\{offline\} onRetry=/],
    ['components/admin/case-editor.tsx', 'loadError', /<ErrorState\s+compact\s+description=\{loadError\}\s+offline=\{loadOffline\}\s+onRetry=/],
    ['components/admin/citizen-editor.tsx', 'loadError', /<ErrorState\s+compact\s+description=\{loadError\}\s+offline=\{loadOffline\}\s+onRetry=/],
    ['components/admin/settings/users-section.tsx', 'error', /<ErrorState compact description=\{error\} offline=\{offline\} onRetry=\{\(\) => void load\(\)\}/],
  ])('%s draws its failed read as an ErrorState with a retry', (file, variable, shape) => {
    const source = read(...file.split('/'));
    expect(source).toMatch(shape);
    // The failed first read is no longer a bare red banner (another `Alert` in the file may be a save error).
    expect(source).not.toMatch(new RegExp(`<Alert variant="destructive" live="alert">\\s*\\{${variable}\\}\\s*</Alert>\\s*\\) : loading`));
    expect(source).not.toMatch(new RegExp(`<Alert variant="destructive" live="alert">\\s*\\{loadError\\}\\s*</Alert>`));
  });

  it('a retry of the case and citizen editors reads again (the attempt is in the effect’s deps)', () => {
    expect(read('components', 'admin', 'case-editor.tsx')).toMatch(/\[tenant, token, caseId, handleApiError, t, loadAttempt\]/);
    expect(read('components', 'admin', 'citizen-editor.tsx')).toMatch(/token,\s+loadAttempt,\s+citizenId,/);
  });
});
