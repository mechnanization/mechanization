import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  UX-03 (cleanup sprint, 2026-11-24). The unit grid gave each confirmed unit one
  of ten raw palette colours (`bg-sky-500/15 text-sky-700 dark:text-sky-400 …`),
  forty classes with `dark:` twins nobody measured. They are ten tokens now,
  `--identity-1` … `--identity-10`, and "theme tokens are a measured contract":
  this recomputes the contrast from the values written in globals.css, in both
  themes, so a retuned token that stops reading fails here, not in a report.

  The method is COL-8 step 4: WCAG 2.2 relative luminance in sRGB, a tint
  alpha-composited over the surface it sits on; 4.5:1 for text against every
  surface and its own 0, 5, 10 and 15% tints, 3:1 for a boundary.
*/
const FRONTEND = join(__dirname, '..');
const css = readFileSync(join(FRONTEND, 'app', 'globals.css'), 'utf8').split('\r\n').join('\n');

type Rgb = [number, number, number];

/** The text of a theme block: from its selector to the closing brace at the same indent. */
function block(selector: string): string {
  const start = css.indexOf(`\n  ${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const end = css.indexOf('\n  }\n', start);
  return css.slice(start, end);
}

function triple(source: string, name: string): [number, number, number] {
  const match = source.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%;`));
  if (!match) throw new Error(`no --${name}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function toRgb([h, s, l]: [number, number, number]): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: Array<[string, string]> = [
  ['light', ':root'],
  ['dark', '.dark'],
];

describe.each(THEMES)('the identity colours in the %s theme', (_theme, selector) => {
  const source = block(selector);
  const background = toRgb(triple(source, 'background'));
  const surfaces: Record<string, Rgb> = {
    background,
    card: toRgb(triple(source, 'card')),
    popover: toRgb(triple(source, 'popover')),
    muted: toRgb(triple(source, 'muted')),
    page: over(toRgb(triple(source, 'muted')), background, 0.3), // `bg-muted/30` over the background
  };

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))('--identity-%i reads as text on every surface and tint', (n) => {
    const colour = toRgb(triple(source, `identity-${n}`));
    let worst = Infinity;
    for (const surface of Object.values(surfaces)) {
      for (const tint of [0, 0.05, 0.1, 0.15]) {
        worst = Math.min(worst, contrast(colour, over(colour, surface, tint)));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))('--identity-%i clears the 3:1 boundary floor as a full-strength ring', (n) => {
    const colour = toRgb(triple(source, `identity-${n}`));
    for (const surface of Object.values(surfaces)) {
      expect(contrast(colour, surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the identity colours are wired through', () => {
  const config = readFileSync(join(FRONTEND, 'tailwind.config.ts'), 'utf8');
  const grid = readFileSync(join(FRONTEND, 'components', 'admin', 'unit-grid-picker.tsx'), 'utf8');

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))('identity-%i is mapped in Tailwind and used by the unit grid', (n) => {
    expect(config).toContain(`'identity-${n}': 'hsl(var(--identity-${n}))'`);
    expect(grid).toContain(`bg: 'bg-identity-${n}/15', text: 'text-identity-${n}', ring: 'ring-identity-${n}'`);
  });

  it('the grid keeps no palette class', () => {
    expect(grid).not.toMatch(/-(sky|violet|amber|emerald|rose|cyan|fuchsia|orange|teal|indigo)-\d{2,3}/);
  });
});
