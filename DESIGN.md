---
name: Mechanization
description: Operate-mode municipal register, Arabic and RTL first, on warm neutrals with one blue accent and status colours that each mean one thing.
# Last verified against the code: fix/pr104-review (uncommitted review fixes), 2026-10-09. Source: apps/frontend/app/globals.css, apps/frontend/tailwind.config.ts.
colors:
  background: "hsl(40 20% 98%)"
  foreground: "hsl(0 0% 4%)"
  card: "hsl(40 20% 99%)"
  card-foreground: "hsl(0 0% 4%)"
  popover: "hsl(40 20% 100%)"
  popover-foreground: "hsl(0 0% 4%)"
  primary: "hsl(213 72% 39%)"
  primary-foreground: "hsl(0 0% 100%)"
  secondary: "hsl(42 25% 94%)"
  secondary-foreground: "hsl(0 0% 10%)"
  muted: "hsl(42 20% 93%)"
  muted-foreground: "hsl(30 3% 42%)"
  accent: "hsl(42 30% 92%)"
  accent-foreground: "hsl(0 0% 10%)"
  destructive: "hsl(0 62% 52%)"
  destructive-foreground: "hsl(0 0% 100%)"
  warning: "hsl(32 95% 34%)"
  warning-foreground: "hsl(0 0% 100%)"
  success: "hsl(142 71% 29%)"
  success-foreground: "hsl(0 0% 100%)"
  info: "hsl(199 89% 36%)"
  info-foreground: "hsl(0 0% 100%)"
  border: "hsl(45 12% 87%)"
  input: "hsl(45 12% 84%)"
  ring: "hsl(213 72% 45%)"
  illustration-concrete: "hsl(24 5% 64%)"
  illustration-shade: "hsl(30 10% 8%)"
  viz-series-1: "#2a78d6"
  viz-series-2: "#eb6834"
  viz-step-1: "#86b6ef"
  viz-step-2: "#5598e7"
  viz-step-3: "#2a78d6"
  viz-step-4: "#1c5cab"
  viz-critical: "#d03b3b"
  background-dark: "hsl(60 2% 5%)"
  foreground-dark: "hsl(0 0% 100%)"
  card-dark: "hsl(60 2% 10%)"
  card-foreground-dark: "hsl(0 0% 98%)"
  popover-dark: "hsl(60 2% 13%)"
  popover-foreground-dark: "hsl(0 0% 98%)"
  primary-dark: "hsl(213 76% 56%)"
  primary-foreground-dark: "hsl(60 2% 5%)"
  secondary-dark: "hsl(60 2% 15%)"
  secondary-foreground-dark: "hsl(0 0% 95%)"
  muted-dark: "hsl(60 2% 15%)"
  muted-foreground-dark: "hsl(48 8% 74%)"
  accent-dark: "hsl(60 2% 17%)"
  accent-foreground-dark: "hsl(0 0% 95%)"
  destructive-dark: "hsl(0 72% 62%)"
  destructive-foreground-dark: "hsl(60 2% 5%)"
  warning-dark: "hsl(32 95% 55%)"
  warning-foreground-dark: "hsl(60 2% 5%)"
  success-dark: "hsl(142 71% 40%)"
  success-foreground-dark: "hsl(60 2% 5%)"
  info-dark: "hsl(199 89% 55%)"
  info-foreground-dark: "hsl(60 2% 5%)"
  border-dark: "hsl(60 2% 18%)"
  input-dark: "hsl(60 2% 22%)"
  ring-dark: "hsl(213 76% 56%)"
  illustration-concrete-dark: "hsl(25 5% 45%)"
  illustration-shade-dark: "hsl(0 0% 0%)"
  viz-series-1-dark: "#3987e5"
  viz-series-2-dark: "#d95926"
  viz-step-1-dark: "#6da7ec"
  viz-step-2-dark: "#3987e5"
  viz-step-3-dark: "#256abf"
  viz-step-4-dark: "#184f95"
  viz-critical-dark: "#d03b3b"
typography:
  display:
    fontFamily: "Noto Kufi Arabic, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.375
  page-heading:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
  card-title:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  dense:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  label:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  unit: "4px"
  control-gap: "8px"
  related-gap: "12px"
  card-gap: "16px"
  card-padding: "16px"
  section-gap: "24px"
  page-inline: "16px"
  page-inline-sm: "24px"
  page-inline-lg: "32px"
  touch: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-coarse:
    height: "{spacing.touch}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "40px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    height: "40px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "40px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card-padding}"
  dialog:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
    padding: "24px" # 16px below sm (p-4 sm:p-6)
  tooltip:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
---

# Design System: Mechanization

Last verified against the code: `fix/pr104-review` (with the PR #104 review fixes uncommitted), 2026-10-09.

This file records the visual system **as the code defines it**. The values come from
`apps/frontend/app/globals.css`, `apps/frontend/tailwind.config.ts` and the primitives in
`apps/frontend/components/ui`. Where this file and the code disagree, the code is the fact
and this file is the bug. Rules, with IDs, live in
[docs/ui-ux-standards.md](docs/ui-ux-standards.md); this file holds values. Change a value
in the code first, then here, in the same change ([CLAUDE.md](CLAUDE.md#keeping-the-docs-true)).
Light values carry the plain key in the frontmatter; dark values carry a `-dark` suffix.

## Overview

**Creative North Star: "The Modern Civic Ledger"** (the name the previous version of this
file gave the system; kept).

A register that clerks, collectors, inspectors and auditors read for hours and act on
quickly. Surfaces are calm and warm: a cream page in light mode and a warm near-black in
dark mode, each surface layer a step lighter than the one beneath it, so a card reads as an
object rather than an outline. One blue accent marks the primary action, the current
selection and links. Four status colours (success, warning, info, destructive) each carry
one meaning and appear mostly as text. Density is allowed; decoration is not.

The interface is Arabic and right-to-left first, with English as a full second locale.
Codes, phones and figures sit in left-to-right runs inside Arabic text.

**Key Characteristics:**
- Warm neutrals, not slate: hues 30 to 45 in light, hue 60 at 2% saturation in dark.
- One accent, overridable per municipality.
- Status colour is a text colour first; tints sit behind it at 5 to 15% alpha.
- Flat surfaces: a 1px border plus at most a small shadow.
- 48px touch floor on coarse pointers, dense on a mouse.

## Colors

Colour tokens are HSL channel triples on `:root` and `.dark`, mapped in
`tailwind.config.ts` as `hsl(var(--name))`, so Tailwind composes alpha (`bg-primary/90`).
`next-themes` (`ThemeProvider`, `attribute="class"`, default `system`, storage key
`mechanization.theme`) puts the `dark` class on `<html>`. The `--viz-*` chart colours are
finished hex values and are not mapped in Tailwind.

### Primary
- **Cedar Blue** (`primary`, `primary-dark`): the one primary action, the selection,
  links, active nav rows, the page-header icon tile. `ring` and `ring-dark` are the focus
  colour. In dark mode the primary is lighter and its foreground flips to near-black.
- **Municipal brand override**: `--primary` and `--ring` resolve through
  `var(--brand-primary, …)`. `TenantLayout` writes `--brand-primary` from the tenant
  config's `branding.primaryColor` after `safeHslTriple` checks its syntax. It is one
  triple for both themes, and nothing checks its contrast (UI §17).
- The accent picker is dead code: `ACCENTS` in `lib/accents.ts` has one entry and
  globals.css has no `[data-accent]` blocks.

### Neutral
- **Page, card, popover** (`background`, `card`, `popover`): three layers, each a hair
  lighter than the one below. The tenant layout paints `<body>` with `bg-muted/30` over
  `--background`, so the page a card sits on is slightly darker than `background`.
- **Ink** (`foreground`, `muted-foreground`): text and secondary text.
- **Quiet fills** (`secondary`, `muted`, `accent`): secondary buttons, table headers,
  hover rows.
- **Lines** (`border`, `input`): dividers and control borders. Every element gets
  `border-border` by default.

### Status
Meanings are binding in COL-2; summary:
- **Success** (`success`): paid, settled, verified, active.
- **Warning** (`warning`): arrears, pending, needs attention. Light lightness is 34% so
  the text clears 4.5:1 on the cream page.
- **Info** (`info`): neutral notes and "how this works".
- **Destructive** (`destructive`): overdue, refused, delete. Mostly a text colour.
- Each has a `-foreground` for a solid fill: white in light mode, near-black in dark mode.
  COL-2 allows no solid `warning` fill; the solid uses that exist are debt (UI §17.2).

### Illustration
- **Concrete** and **Shade** (`illustration-concrete`, `illustration-shade`): decorative
  material fills for the building drawings (`property-illustrations.tsx`,
  `unit-grid-picker.tsx`). No contrast ratio is asked of them (COL-7).

### Charts
- **Series pair** (`viz-series-1`, `viz-series-2`): blue and orange, categorical
  (collected against overdue on the dashboard).
- **Ordinal ramp** (`viz-step-1` to `viz-step-4`): one blue hue, lightest first, for the
  review pipeline stages; dark steps are selected separately, not inverted. Only
  `viz-step-1` and `viz-step-4` are read today (the dashboard).
- **Critical** (`viz-critical`): reserved for the refused outcome, outside the ramp, always
  with an icon and a label. No component reads it today.
- Charts are hand-drawn SVG in `components/admin/charts.tsx` (`ChartCard`, `ColumnChart`,
  `GroupedColumnChart`); there is no chart library. Measured failures of the ramp: UI §17.

## Typography

**Display Font:** Noto Kufi Arabic (weights 500 and 700 loaded), fallback system-ui, sans-serif.
**Body Font:** IBM Plex Sans Arabic (weights 400, 500 and 600 loaded), fallback system-ui, sans-serif.
**Mono:** the Tailwind default mono stack (`font-mono`), for codes only.

Both families load through one Google Fonts `@import` at the top of `globals.css`
(`display=swap`); the CSP allows `fonts.googleapis.com` for styles, and `font-src` is
`fonts.gstatic.com` plus `data:`. `--font-body` backs `font-sans`, and `--font-display` backs `font-display`.

### Hierarchy
- **Display** (700; 1.875rem rising to 2.25rem from `sm` on the staff login, leading
  1.375; 1.5rem on reset-password and the not-found pages): those headings and nowhere else.
- **Page heading** (700, 1.25rem rising to 1.5rem from `md`, leading 1.25): `PageHeader`.
- **Card title** (600, leading 1): `CardTitle`; the caller sets `text-base` or `text-lg`.
- **Body** (400, 0.875rem, 1.25rem line): running text and most controls.
- **Dense** (400, 0.75rem, 1rem line): table rows, chips, meta lines. The floor for text a
  user must read.
- **Label** (500, 1rem on phones and 0.875rem from `sm`, leading 1): `Label`, table heads.
  Inputs use the same 1rem-to-0.875rem step so Safari does not zoom on focus.
- Figures in columns and totals use `tabular-nums` in the body font.

Font sizes, line heights and weights are the Tailwind 3.4 defaults; none is customised.
Plex has no 700 face loaded, so `font-bold` (156 uses), `font-extrabold` (2) and
`font-black` (5) on body text resolve to the 600 face (TYP-7). `PageHeader`'s `h1`,
`CardTitle` and the display headings carry `tracking-tight`, a TYP-5 deviation; do not
copy it.

## Layout

- **Grid**: the Tailwind 3.4 default spacing scale (4px unit). Breakpoints are the defaults
  (`sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px); `container` is centred
  with 1rem padding and caps at 1280px.
- **Page**: `w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8` (16, 24, 32px inline), then
  `PageHeader`. The citizen portal uses `container max-w-3xl py-8`.
- **Rhythm**: 6 to 8px inside a control group, 12px between related items, 16px between
  cards, 24px between page sections (LAY-2). Card padding is 16px (`p-4`, `pt-0` under
  the header).
- **Touch**: `touch` is 3rem (`h-touch`, `min-h-touch`, `min-w-touch`). The custom
  `coarse:` variant (`@media (pointer: coarse)`) lifts Button, Input, Select and Checkbox
  hit areas to 48px on a finger and leaves desktop dense.
- **Safe areas**: `viewportFit: 'cover'` in `app/layout.tsx`, so `env(safe-area-inset-*)`
  works in the mobile action bars.

## Elevation & Depth

Flat by default, with depth from lighter surface layers (most visible in dark mode) plus
Tailwind's default shadows. The shadow scale is not customised.

### Shadow Vocabulary
- **Resting** (`shadow-sm`, Tailwind `0 1px 2px 0 rgb(0 0 0 / 0.05)`): `Card` (with its
  border), `Input`, `Select` trigger, `Textarea`.
- **Floating** (`shadow-md`): `TooltipContent`, `SelectContent`.
- **Overlay** (`shadow-lg`): `DialogContent`, `DropdownMenuContent`, toasts, the
  `DatePicker` panel. `Sheet` uses `shadow-xl`.
- `shadow-xs` and `shadow-2xs` do not exist in Tailwind 3.4 and render nothing (LAY-4).
- **Scrims**: `bg-black/80` (`DialogOverlay`), `bg-black/60` (`AdminShell` mobile nav,
  `CommandPalette`), `bg-black/50` (`Sheet`). Three opacities and no token.

## Shapes

- **Radius** (`--radius: 0.5rem`): `rounded-lg` 8px for cards, panels and the page-header
  icon tile; `rounded-md` 6px for controls, badges and chips; `rounded-sm` 4px for the
  checkbox and small marks; `rounded-full` for avatars and dots. `rounded-xl` (12px) and
  `rounded-2xl` (16px) are Tailwind defaults not tied to `--radius`; `DialogContent` and
  Button `xl` use `rounded-xl`.
- **Borders**: 1px in `border` everywhere; control borders in `input`.
- **Focus**: a global `:focus-visible` outline, 2px solid `ring`, offset 2px. Primitives
  add `focus-visible:ring-2 ring-ring ring-offset-2`.

## Components

### Buttons
- **Variants** (`buttonVariants`): `default` (primary fill), `destructive`, `outline`
  (background with `input` border), `secondary`, `ghost`, `link`.
- **Sizes**: `default` 40px, `sm` 36px, `lg` 56px, `xl` 80px (the citizen wizard's primary
  action), `icon` 40px, `icon-sm` 32px. Every size except `lg` and `xl` is 48px on a
  coarse pointer. `type` defaults to `button`.
- **Hover**: the fill at 90% (`hover:bg-primary/90`) or the `accent` surface; colour
  transitions only.

### Chips and tags
- **Badge** (`badgeVariants`): solid `default`, `secondary`, `destructive`, `success`,
  `warning`, `outline`, and soft tints `soft-default`, `soft-success`, `soft-destructive`,
  `soft-info` (10% tints), `soft-warning` (15% tint) and `soft-muted` (the opaque `muted`
  surface). 12px medium, `rounded-md`.
- **CellTag**: the value in a table cell, a text tone only: `neutral`, `muted`,
  `success`, `warning`, `destructive`, `primary`.

### Cards and figures
- **Card**: `rounded-lg border bg-card shadow-sm`; header and content `p-4`.
- **StatStrip** and **StatItem**: up to five figures in equal columns divided by 1px
  border gaps, two columns below `sm`. A value wraps and is never truncated.

### Money
- **Money** draws a sum as its signed figure, isolated left to right, then its unit in the
  page's direction: «ل.ل 1,500,000» on an Arabic page, "1,500,000 LBP" on an English one.
  A negative carries U+2212, as wide as «+», on the left of its digits. One line by default;
  `wrap` lets the unit drop under the figure (the treasury's wallet strip at 360px). Dollars
  and euros take the same shape (`currency`), with the symbol after the figure.

### Inputs and fields
- **Input**, **Select** trigger: 40px (48px coarse), `rounded-md`, `border-input`,
  `bg-background`, ring on `focus-visible`; invalid swaps the border to `destructive`.
- **Field**: label, required mark, «(اختياري)», caution text and an error line with
  `role="alert"`.

### Tables
- **DataTable**: sticky header on `bg-muted/95` with backdrop blur, 12px cell padding
  (`p-3`), row hover on `muted/50`; no zebra striping. Phone layouts come from column
  `meta.mobile`.

### Overlays and motion
Durations and easing are Tailwind and tailwindcss-animate defaults unless a class says
otherwise: `transition-*` runs 150ms on `cubic-bezier(0.4, 0, 0.2, 1)`; `animate-in` and
`animate-out` run 150ms on the CSS default `ease`.
- **Dialog**: 200ms in and out, fade plus zoom from 95%.
- **DropdownMenu**, **Tooltip**: 150ms, fade plus zoom from 95%. **Select**: 150ms fade
  only. Tooltips open after 200ms (`TooltipProvider delayDuration={200}`) and are drawn in
  inverted colours (`foreground` fill, `background` text).
- **Toast**: 200ms slide from the bottom plus fade, polite live region.
- **Sheet**: 300ms slide from the inline end.
- **CollapsibleSection**: 200ms `ease-out`.
- **Reduced motion**: globals.css cuts every animation and transition to 0.01ms; only
  `.animate-spin` keeps turning, slowed to 2s.
- **Theme switch**: `disableTransitionOnChange`, so no colour transition on toggle.

### Print
- **Receipt** (`#receipt-print-area`): A5 landscape, 10mm margins, a 2px black border, lifted
  out of its dialog.
- **A page's document** (`data-print-root`, today the treasury statement): the named page
  `register`, A4 portrait with 12mm margins (A5 landscape where named pages are not supported).
  Black text on white whatever the theme, no shadows or surfaces, tokens' borders kept; table
  cells may wrap and padding tightens to 4×6px at 12px type, the heading row repeats on each
  sheet and no row splits across two. Print-only parts — the sheet heading, the signature lines
  drawn as a 1px rule in the text colour — are `hidden print:block`.

### Icons
- `lucide-react` only, one stroke family. `size-4` by default, `size-3.5` in dense rows,
  `size-5` in card and section titles and in the page-header tile.

## Do's and Don'ts

Each line points at the rule that binds it in [docs/ui-ux-standards.md](docs/ui-ux-standards.md).

### Do:
- **Do** use semantic tokens only, and add a missing colour by the procedure in COL-8.
- **Do** use the shared primitive, or port a missing one by KIT-1 to KIT-6.
- **Do** keep text at 4.5:1 and control boundaries and focus at 3:1 in both themes (COL-4).
- **Do** use `tabular-nums` and Latin digits for figures (TYP-4).
- **Do** use logical properties (RTL-1) and the 48px coarse floor (LAY-7).
- **Do** animate only `transform` and `opacity`, within MOT-2, honouring reduced motion (MOT-6).

### Don't:
- **Don't** write hex, `rgb()` or Tailwind palette classes in a component (BAN-1, COL-9 lists the exceptions).
- **Don't** use a native or hand-rolled control the kit replaces (CTL-1 to CTL-12).
- **Don't** use arbitrary sizes, `shadow-xs` or `transition-all` (BAN-11, LAY-8, LAY-4, MOT-4).
- **Don't** use `font-display` outside the login, reset-password and not-found headings (TYP-1), or letter-spacing on Arabic (TYP-5).
- **Don't** use `font-mono` for money or as decoration (BAN-9).
- **Don't** add gradient text, glass or glow (BAN-2), or a coloured side stripe (BAN-3).
