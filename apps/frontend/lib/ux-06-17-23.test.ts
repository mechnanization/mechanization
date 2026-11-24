import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_LOCALE } from '@/lib/api-errors';

/*
  UX-06, UX-17 and UX-23 (cleanup sprint, 2026-11-24): the toast's side stripe
  (BAN-3), the last `transition-all` (MOT-4) and the digits typed or formatted
  as Arabic-Indic (TYP-4). This reads the sources, so it fails when one comes
  back (the runner collects `lib/**` only and has no DOM).
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

/** The code of a file: its comments are not what a reader sees or what runs, and several name the bug they fixed. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Files (relative to the app) under `app`, `components` and `lib` whose code matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const dir of ['app', 'components', 'lib']) {
    for (const file of sourcesUnder(join(FRONTEND, dir))) {
      if (pattern.test(withoutComments(readFileSync(file, 'utf8')))) found.push(relative(FRONTEND, file).replace(/\\/g, '/'));
    }
  }
  return found.sort();
}

describe("the toast carries its tone without a side stripe (UX-06, BAN-3)", () => {
  const source = read('components/ui/toast.tsx');

  it('has no stripe thicker than 1px', () => {
    expect(source).not.toMatch(/border-[selr]-4/);
  });

  it('keeps a 1px border and tones it all round, in each of the four tones', () => {
    expect(source).toMatch(/rounded-lg border bg-card/);
    for (const [tone, token] of [
      ['success', 'success'],
      ['error', 'destructive'],
      ['warning', 'warning'],
      ['info', 'primary'],
    ] as const) {
      expect(source, tone).toMatch(new RegExp(`${tone}: \\{[^}]*accent: 'border-${token}/40'`));
    }
  });

  it("still draws the tone's icon, which is what says it to a reader who cannot tell the colours apart", () => {
    expect(source).toMatch(/<Icon className=\{cn\('mt-0\.5 size-5 shrink-0', iconColor\)\} aria-hidden \/>/);
  });
});

describe('nothing animates with transition-all (UX-17, MOT-4)', () => {
  it('no source names it', () => {
    expect(filesMatching(/\btransition-all\b/)).toEqual([]);
  });

  it("the survey bar grows with scaleX from the reading start, in either direction", () => {
    const source = read('app/[tenant]/[locale]/[adminPath]/(protected)/buildings/page.tsx');
    expect(source).toMatch(/transform: `scaleX\(\$\{percent \/ 100\}\)`/);
    expect(source).toMatch(/origin-left[^']*rtl:origin-right/);
    expect(source).toMatch(/transition-transform/);
    // The width it animated before.
    expect(source).not.toMatch(/style=\{\{ width: `\$\{percent\}%` \}\}/);
  });
});

describe('step numbers and counts are Latin digits (UX-23, TYP-4)', () => {
  it("the citizen wizard's step numbers are not typed as Arabic-Indic digits", () => {
    // The form's `sections` list is in `citizen-form.tsx`; each page's own number moved with its section (GOD-22, phase 2b).
    const form = read('components/admin/citizen-form.tsx');
    expect(form).toMatch(/step: '1'/);
    for (const [file, step] of [
      ['personal-section.tsx', '1'],
      ['contact-section.tsx', '2'],
      ['properties-section.tsx', '3'],
    ] as const) {
      expect(read(`components/admin/citizen-form/${file}`), file).toContain(`step="${step}"`);
    }
    for (const file of [
      'components/admin/citizen-form.tsx',
      'components/admin/citizen-form/personal-section.tsx',
      'components/admin/citizen-form/contact-section.tsx',
      'components/admin/citizen-form/properties-section.tsx',
    ]) {
      expect(read(file), file).not.toMatch(/\bstep[:=][^\n]*[٠-٩۰-۹]/);
    }
  });

  it("nor are the citizens import's", () => {
    const source = read('components/admin/import-citizens-dialog.tsx');
    expect(source).not.toMatch(/\bstep:\s*'[٠-٩۰-۹]'/);
  });

  it("the audit page counts with FORMAT_LOCALE, not plain 'ar'", () => {
    const source = read('app/[tenant]/[locale]/[adminPath]/(protected)/audit/page.tsx');
    expect(source).toMatch(/total\.toLocaleString\(FORMAT_LOCALE\.ar\)/);
  });

  it("no screen formats a number with the bare 'ar' or 'ar-LB' locale, which prints Arabic-Indic digits", () => {
    expect(filesMatching(/toLocale(?:String|DateString|TimeString)\(\s*['"]ar(?:-LB)?['"]/)).toEqual([]);
  });

  it("FORMAT_LOCALE's Arabic writes the count in Latin digits", () => {
    const written = (45678).toLocaleString(FORMAT_LOCALE.ar);
    expect(written).not.toMatch(/[٠-٩]/);
    expect(written).toMatch(/45.?678/);
  });
});
