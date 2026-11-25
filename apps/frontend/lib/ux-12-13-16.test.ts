import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-12, UX-13 and UX-16 (cleanup sprint, 2026-11-24): the native file pickers
  (CTL-13), the hand-rolled warning banners and the warning-sign emoji (CTL-12,
  BAN-7), and the physical direction utilities left in three files (RTL-1).
  This reads the sources, so it fails when one comes back (the runner collects
  `lib/**` only and has no DOM).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: comments name the bugs they fixed, and are neither shown nor run. */
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

describe('a file is picked through FileInput (UX-12, CTL-13)', () => {
  it('no screen draws a native file input of its own', () => {
    // `backup-section.tsx` is kept unrendered (settings/page.tsx says so) and goes with DEAD-06.
    expect(filesMatching(/type=["']file["']/)).toEqual([
      'components/admin/settings/backup-section.tsx',
      'components/ui/file-input.tsx',
    ]);
  });

  it.each([
    ['components/admin/import-citizens-dialog.tsx', '.csv,text/csv'],
    ['components/admin/settings/cadastre-section.tsx', '.geojson,application/geo+json,application/json'],
    ['components/admin/settings/profile-section.tsx', 'image/png,image/jpeg,image/svg+xml'],
  ])('%s uses FileInput, with what the dialog may offer', (path, accept) => {
    const source = code(path);
    expect(source).toMatch(/<FileInput\b/);
    expect(source).toContain(`accept="${accept}"`);
    // The hand-rolled drop zone and its ref are gone.
    expect(source).not.toMatch(/useRef<HTMLInputElement>/);
    expect(source).not.toMatch(/onDragOver/);
    expect(source).not.toMatch(/fileInput\.current/);
  });

  it('the profile section has one zone for both states, and no «استبدال» button beside a logo', () => {
    const source = code('components/admin/settings/profile-section.tsx');
    expect(source).toMatch(/draft\.logoDataUri \? copy\.profile\.logoReplace : copy\.profile\.logoUpload/);
    expect(source).not.toMatch(/\.click\(\)/);
  });

  it('the cadastre zone is off while an import runs', () => {
    expect(code('components/admin/settings/cadastre-section.tsx')).toMatch(/<FileInput[\s\S]*?disabled=\{uploading\}/);
  });
});

describe('warnings are Alerts, with no emoji (UX-13, CTL-12, BAN-7)', () => {
  const FILES = [
    'components/admin/unit-correction-delete-dialog.tsx',
    'components/admin/landlord-unlink-dialog.tsx',
    'components/admin/import-citizens-dialog.tsx',
    // the building editor's Alerts moved out of `building-editor.tsx` with GOD-21 phase 2
    'components/admin/building-editor/duplicates-prompt.tsx',
    'components/admin/building-editor/editor-notices.tsx',
    'components/admin/building-editor/facility-fields.tsx',
    'components/admin/building-editor/map-section.tsx',
    'components/admin/building-editor/matrix-card.tsx',
    'components/admin/building-editor/parcel-section.tsx',
    'components/admin/building-unit-matrix-view.tsx',
    'components/admin/building-unit-matrix-drawer.tsx',
    'components/citizen/property-card.tsx',
    'app/[tenant]/[locale]/[adminPath]/(protected)/citizens/[citizenId]/payments/[paymentId]/page.tsx',
    'app/[tenant]/[locale]/[adminPath]/(protected)/staff/page.tsx',
  ];

  it('no source draws the warning-sign glyph', () => {
    expect(filesMatching(/⚠/)).toEqual([]);
  });

  it('the unit-correction dialog has no Callout of its own', () => {
    const source = code('components/admin/unit-correction-delete-dialog.tsx');
    expect(source).not.toMatch(/\bCallout\b/);
    expect(source).toMatch(/<Alert\b/);
  });

  it.each(FILES)('%s tints no box warning or info by hand', (path) => {
    const source = code(path);
    expect(source).toMatch(/components\/ui\/alert'/);
    // Two stay, and neither is a note: the building editor's «no pin» reason box is a group of controls
    // (its acknowledgement box is tinted with `bg-background/60`; the box moved to `building-editor/map-section.tsx`
    // with GOD-21 phase 2), and the staff page's tint is the icon chip at the top of its dialog.
    const tinted = source.match(/\bbg-(?:warning|info)\/(?:5|10)\b/g) ?? [];
    const onPurpose =
      path.endsWith('building-editor/map-section.tsx') ||
      path.endsWith('(protected)/staff/page.tsx');
    expect(tinted.length).toBe(onPurpose ? 1 : 0);
  });

  it('the one-time key notice is an Alert on the staff page, titled in the page\'s language', () => {
    const source = code('app/[tenant]/[locale]/[adminPath]/(protected)/staff/page.tsx');
    expect(source).toMatch(/<Alert variant="warning" title=\{locale === 'en' \? 'Notice' : 'تنبيه'\}>/);
  });

  it('a notice that has to be said at once is announced as an alert', () => {
    // The tenants still linked to an owner being removed, and the missing exchange rate on the cash page.
    expect(code('components/citizen/property-card.tsx')).toMatch(/variant="warning"\s+live="alert"/);
    expect(
      code('app/[tenant]/[locale]/[adminPath]/(protected)/citizens/[citizenId]/payments/[paymentId]/page.tsx'),
    ).toMatch(/<Alert variant="warning" live="alert">/);
  });
});

describe('the three files UX-16 names use logical or deliberate directions (RTL-1)', () => {
  it('the corrections page has no margin pair for its refresh icon', () => {
    const source = code('app/[tenant]/[locale]/[adminPath]/(protected)/fees/corrections/page.tsx');
    expect(source).not.toMatch(/\brtl:m[lr]-|\bltr:m[lr]-/);
  });

  it("the citizen form's mobile bar spans the viewport with inset-x-0", () => {
    // The bar is in `citizen-form/action-bars.tsx` since GOD-22 phase 2a; neither file may span the screen with a pair.
    for (const path of ['components/admin/citizen-form.tsx', 'components/admin/citizen-form/action-bars.tsx']) {
      expect(code(path), path).not.toMatch(/\bleft-0 right-0\b|\bright-0 left-0\b/);
    }
    expect(code('components/admin/citizen-form/action-bars.tsx')).toMatch(/fixed inset-x-0 bottom-0/);
  });

  it("the unit drawings' physical left and right are deliberate: drawn inside a dir=ltr elevation, with no margin, padding or text alignment", () => {
    const figures = read('components/admin/unit-figures.tsx');
    expect(figures).toMatch(/`left-`\/`right-` here are deliberate/);
    expect(read('components/admin/property-illustrations.tsx')).toMatch(/<div dir="ltr" className="flex h-full w-full items-center justify-center px-5">/);
    expect(withoutComments(figures)).not.toMatch(/\b-?(?:ml|mr|pl|pr)-|\btext-(?:left|right)\b|\bfloat-(?:left|right)\b/);
  });
});
