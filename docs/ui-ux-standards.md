# UI/UX standards: binding for every change to `apps/frontend`

Last verified against the code: `feat/co-owner-billing` (on `develop@f10a1b7`), 2026-10-08.

This file binds every AI agent and every person who builds or reviews an
interface in this repository. [CLAUDE.md](../CLAUDE.md) (non-negotiable 9) and
[apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md) point here. Read it
**before** you write UI code and **before** you review a UI diff. A review that
does not check these rules has not reviewed the interface.

Every rule has an ID (`COL-1`, `PRIM-3` …). Cite the ID in reviews, commit
messages and code comments so findings are traceable and arguable. IDs are
never renumbered; a new rule takes a new ID. Rules live here; token values live
in [DESIGN.md](../DESIGN.md).

---

## 0. What wins when sources disagree

1. **The code's design tokens**: `apps/frontend/app/globals.css` and
   `apps/frontend/tailwind.config.ts`. Every colour there was solved against
   measured contrast targets. Never nudge one by eye; compute the contrast
   (COL-5, COL-8).
2. **The shared primitives** in `apps/frontend/components/ui/*`, as their doc
   comments describe them.
3. **This file.**
4. [DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md) at the repo root.
   `DESIGN.md` records the values of 1 and 2 as of its "Last verified" line, in
   the frontmatter-plus-sections format that design skills (impeccable) load.
   `PRODUCT.md` records who the users are and what the product does. Where
   either disagrees with 1 to 3, 1 to 3 win and the doc is the bug.

Three user decisions are binding here and are written into the rules below:
**D-i18n** (new copy in next-intl messages, TXT-1), **D-errors** (errors shown
by stable code, TXT-6) and **D-kit** (a missing primitive is hand-ported from
shadcn/ui on its Radix package, §3.2).

The rules distil three design skills installed at `~/.agents/skills/`:
`impeccable` (Operate mode, craft floor, polish, harden, clarify),
`ui-ux-pro-max` (priority rules, quick reference) and `emil-design-eng`
(component polish and motion). Use them for depth (§18). They never override
the order above.

---

## 1. Who this interface serves

This is **Operate-mode** software. People open it to finish a task, not to be
impressed.

- Clerks and collectors at a counter take cash, often with a queue, and print
  a «وصل».
- Field inspectors survey buildings on a phone, outdoors, one-handed, often on
  a weak connection.
- Accountants, auditors and the council read registers, ledgers and reports for
  hours at a time.
- The data is citizens' homes, money and legal status. A misleading screen is
  not a cosmetic bug: it bills the wrong person or hides a debt.

What follows from that:

- **UX-1. Familiar beats novel.** A category-fluent clerk must trust each
  screen immediately. A control that looks subtly different from its twin on
  another page is a defect: if "save" looks different in two places, one is
  wrong.
- **UX-2. Arabic and RTL first.** `ar` is the primary locale; English is a full
  second locale, not a fallback.
- **UX-3. Density is allowed; noise is not.** Registers may be dense. Decoration
  may not.
- **UX-4. The record must be legible as a record.** Legal and evidential facts
  (vacancy basis, who declared what and when, the name as the tenant typed it,
  the receipt number) are content. Do not drop one to "simplify" a card without
  an explicit product decision.

---

## 2. Banned patterns (the "AI slop" list)

Each of these is refused in review unless a written product decision earns it.
Most come from the impeccable craft floor and Operate guidance.

| ID | Banned | Do instead |
|---|---|---|
| BAN-1 | Raw colours in components: hex (`#e9dcc4`, `bg-[#…]`), `rgb()`, Tailwind palette classes (`text-violet-600`, `bg-amber-900/10`, `border-red-500`) | Semantic tokens (§4). A missing colour becomes a token by COL-8. The only exceptions are listed in COL-9. |
| BAN-2 | Gradient text, decorative glass/blur, glow halos | Emphasis through weight and size. |
| BAN-3 | Coloured side stripes thicker than 1px on cards, list items, callouts or alerts (`border-s-4 border-primary`) | Tint the surface (`bg-warning/10`), or use an icon plus text. |
| BAN-4 | Nested cards, and a bordered table inside a bordered card with padding | One frame. Use `CardContent className="p-0"` around a borderless `DataTable` (as `buildings/page.tsx` does). |
| BAN-5 | Eyebrow or kicker labels above a heading; section numbers (01/02/03) that carry no meaning | Let the heading carry its own weight. |
| BAN-6 | The hero-metric template (big number, small label, accent) as page structure; same-size icon+heading+text card grids as the page layout | A real layout derived from the task. |
| BAN-7 | Emoji or Unicode glyphs as icons (`‹ ›`, `✓`, a warning-sign glyph) | `lucide-react`, one stroke family. |
| BAN-8 | The "ghost card": a 1px border plus a wide soft shadow. Random radii | Declare elevation once: border **or** shadow. Radii from the token scale (LAY-3). |
| BAN-9 | `font-mono` as a costume for "technical" or for money | `font-mono` is for codes only: reference, parcel, unit and receipt numbers. Figures use `tabular-nums` in the body font. |
| BAN-10 | A modal for a task that needs neither interruption nor protected focus | Inline, a page, or progressive disclosure. A page has an address a collector can be sent to. |
| BAN-11 | Arbitrary type sizes (`text-[11px]`, `text-[8px]`) and arbitrary spacing (`p-[13px]`) | The Tailwind scale. 12px (`text-xs`) is the floor for any text a user must read. Exceptions: LAY-8. |
| BAN-12 | Inline `style={{…}}` for anything a class or token can express | Classes. Inline style only for values computed at runtime (a drag offset, a grid track count). |
| BAN-13 | Sketch-style or "illustrative" SVG standing in for content; decorative sparklines and progress rings | Real data, or nothing. Diagrams that show real geometry (the building elevation, the unit grid) are allowed, with token colours. |
| BAN-14 | `transition-all`, `ease-in` on UI, entrances from `scale(0)`, UI animation over 250 ms, animation on keyboard-initiated or high-frequency actions | §13. |
| BAN-15 | Dead code and orphaned or stacked doc comments: a comment block that documents a deleted symbol, or sits above the wrong function | Delete it, or move it to the symbol it describes. This has recurred in this repo; check every diff for it. |

---

## 3. Use the shared primitive

A page never hand-rolls what `components/ui` already does. If it seems to need
to, the primitive gets a prop instead.

| ID | Need | Use | Never |
|---|---|---|---|
| PRIM-1 | Page heading | `PageHeader` (icon, title, subtitle, actions) | A bespoke `<header>` with its own tile and sizes |
| PRIM-2 | Back navigation | `BackLink` with a real `fallbackHref` | A fixed link to the index |
| PRIM-3 | A list or register | `DataTable`. Server paging: `manualPagination manualFiltering sortable={false}`. Shape phone cards with `meta.mobile` | A hand-rolled `<table>`, pager, search or empty row |
| PRIM-4 | Pagination outside a table | `Pager` (`components/ui/pager.tsx`): strings as props, a `<nav aria-label>` landmark, the position read as one phrase, scroll-to-top through `scrollTarget`, like DataTable's footer | A page-local pager or `‹ ›` text buttons |
| PRIM-5 | Loading, empty or failed panel | `LoadingState`, `EmptyState`, `ErrorState` from `ui/states` | `<p>جارٍ التحميل…</p>`, a dashed empty `div`, a red `<p>` |
| PRIM-6 | Placeholder shapes | `Skeleton`, `SkeletonText`, `SkeletonStat` | An inline `div animate-pulse` |
| PRIM-7 | Label/value facts | `FactRow`/`FactCell` (facts in cards and logs); `SummaryList`/`SummaryRow` (read-back of one record) | A page-local `FactRow`, `InfoCard` or `<dl>` |
| PRIM-8 | A value in a table cell | `CellTag` | `Badge` in a column |
| PRIM-9 | An annotation chip | `Badge` with a `soft-*` variant | `Badge` with colour overrides in `className` |
| PRIM-10 | LBP on screen | `<Money>`; `formatLbp` only for plain strings (toast, aria, CSV) | `toLocaleString()` plus «ل.ل» by hand |
| PRIM-11 | USD/EUR on screen | `formatForeign(amount, currency)` or `formatMoney(amount, currency, locale)` from `lib/currency.ts` | A page-local USD formatter, `$${x.toFixed(2)}`, or a third spelling |
| PRIM-12 | Dates | `formatDate` / `formatTime` / `formatDateTime` / `formatMonthList` from `lib/dates` | `toLocaleDateString('ar')`, raw month numbers joined with «، » |
| PRIM-13 | A labelled input | `Field` (label, required `*`, «(اختياري)», `caution`, error with `role="alert"`) wrapping `Input`/`Select`/`Textarea`/`DatePicker` | A bare `<label>` plus input; a native `<select>`; a native `type="date"` in new code |
| PRIM-14 | Two to four options | `SegmentedControl`; three or more filter chips: `ChipGroup` | Hand-rolled toggle buttons |
| PRIM-15 | Foldable section | `CollapsibleSection` | A `useState` toggle with a chevron |
| PRIM-16 | Confirmation of a destructive or irreversible action | `ConfirmDialog` (`requireText` when typing the subject's name is warranted); throw from `onConfirm` to show the server's refusal inline | `window.confirm`, a custom dialog |
| PRIM-17 | Any other modal | `Dialog`, always with a `closeLabel` in the current locale | `Sheet` for new work: it lacks a focus trap. Fix Sheet before adding users (§17.1) |
| PRIM-18 | Feedback after a write | `useToast()` | `alert()`, a page-local banner that never clears |
| PRIM-19 | Icon-only control | `Button size="icon*"` + `aria-label` + `ActionTooltip` | A bare `<button>` with only an icon |
| PRIM-20 | KPI or stat row | `StatStrip` with `StatItem` (`components/ui/stat-strip.tsx`), up to five figures. A PR that touches a page with a local stat component replaces it | An eleventh local copy (§17.1 lists the ten) |
| PRIM-23 | DataTable strings | `useTableLabels(overrides)` (`lib/use-table-labels.ts`, reads `messages.table`) | A page-local `getTableLabels` |
| PRIM-24 | A filter control above a table | `FilterSelect`, `FilterInput` (`components/ui/filter-controls.tsx`) | A hand-styled select or search box |
| PRIM-25 | Typing a money amount | `CurrencyInput` | A local `formatLbp(value: string)` that shadows `lib/currency` |
| PRIM-26 | A menu of actions | `DropdownMenu` and its parts | A hand-rolled menu panel |
| PRIM-27 | A yes/no field; a choice drawn as a card | `Checkbox`; `ChoiceCard` (`components/ui/field.tsx`) | A native checkbox or radio (CTL-3, CTL-4) |

**PRIM-21. A new primitive** goes in `components/ui/` with a doc comment that
says what it replaces and why. It takes every user-visible string as a prop
(with an Arabic default, as the house primitives do). It is adopted where the
pattern already exists, or the PR names the follow-up. A primitive that wraps a
Radix part follows §3.2.

**PRIM-22. Page-local helpers that duplicate logic are refused.** When a
function such as `occupancyDot`, a role list such as `EDIT_ROLES`, or a label
map is needed by two files, it moves to `lib/` or `packages/shared-schemas`
first. Never add a second copy of a helper. Role lists must mirror the
controller's `@Roles` and say so in a comment.

### 3.1 Native and hand-rolled controls

Never use a native or hand-rolled control where the kit has a primitive. Where
the replacement is missing, add it by §3.2 before the second copy appears.
Counts and files: §17.1.

| ID | Banned | Use instead | Exists today | Legitimate exception |
|---|---|---|---|---|
| CTL-1 | `<input type="date">` | `DatePicker` inside `Field` | yes | none |
| CTL-2 | `<input type="time">`, `datetime-local`, `month` | a time primitive | **missing** (no shadcn or Radix part covers it; **Undecided:** build one or extend `DatePicker`) | none |
| CTL-3 | native checkbox | `Checkbox` | yes | none |
| CTL-4 | native radio | `ChoiceCard` or `SegmentedControl` | yes | the radio inside `ChoiceCard` itself |
| CTL-5 | native `<select>` | `Select`, `FilterSelect` | yes | `DatePicker`'s in-tree `JumpDropdown` listbox, which must stay inside the calendar's DOM subtree |
| CTL-6 | `<dialog>`, a `div` overlay used as a modal | `Dialog` (Radix) | yes | none; `Sheet` only after its focus trap (§17.1) |
| CTL-7 | `window.confirm`, `alert`, `prompt` | `ConfirmDialog`, `useToast` | yes | none |
| CTL-8 | `title=` as the only name or tooltip of a control | `aria-label` plus `ActionTooltip` | yes | `title` on truncated text (LAY-6); `title` that repeats an existing `aria-label` (DataTable, `Pager`) |
| CTL-9 | hand-rolled tabs (`role="tablist"` built by hand) | a `Tabs` primitive | **missing** (`@radix-ui/react-tabs` not installed) | `SegmentedControl` driving plain regions that are not tab panels (A11Y-3) |
| CTL-10 | hand-rolled switches, `aria-pressed` buttons used as an option group | a `Switch` primitive for on/off; `SegmentedControl` or `ChipGroup` for options | Switch **missing** (`@radix-ui/react-switch` not installed) | a single `aria-pressed` toggle button such as show-password |
| CTL-11 | hand-rolled popovers and comboboxes | a `Popover` primitive; `DropdownMenu` for menus | Popover **missing** (`@radix-ui/react-popover` not installed) | none |
| CTL-12 | a hand-rolled inline alert or error banner | an inline `Alert` primitive; `ErrorState` for a failed panel | Alert **missing** (shadcn's Alert has no Radix part) | none |

### 3.2 Adding a missing primitive (decision D-kit)

- **KIT-1. Port, don't install a generator.** A missing primitive is hand-ported
  from the shadcn/ui source for that component onto its matching Radix
  package. There is no shadcn components.json and no shadcn CLI, and neither is added.
  A component with no Radix part (shadcn's Alert) is ported as plain markup
  with `cva`.
- **KIT-2. Add the Radix package explicitly.** Check `apps/frontend/package.json`
  and `pnpm-lock.yaml` first. Direct dependencies today: `@radix-ui/react-checkbox`,
  `react-dialog`, `react-dropdown-menu`, `react-label`, `react-select`,
  `react-slot`, `react-tooltip`. Not present: popover, tabs, switch,
  radio-group, toggle-group, scroll-area, alert-dialog. Add one with
  `pnpm --filter @mechanization/frontend add @radix-ui/react-<name>`. Never
  state a version from memory; read the one the lockfile resolved. A package
  change also updates the docs in the [CLAUDE.md](../CLAUDE.md#keeping-the-docs-true) table.
- **KIT-3. Adapt to the house before merging.** Tokens only (shadcn's
  `bg-black/80` and palette defaults become tokens, COL-9); logical properties
  (RTL-1); the 48px `coarse:` floor (LAY-7); `focus-visible:` rings (A11Y-1);
  motion inside MOT-2 and MOT-4; no letter-spacing on Arabic (TYP-5).
- **KIT-4. Export the way `components/ui` does.** `'use client'` when it wraps
  Radix; `React.forwardRef` on each styled part with
  `X.displayName = Primitive.Part.displayName`; class names merged with `cn`;
  variants in an exported `cva` (`buttonVariants`, `badgeVariants` are the
  models); named exports in one `export { … }` block; no default export.
  `checkbox.tsx` and `tooltip.tsx` are the reference ports.
- **KIT-5. Doc comment.** The file opens with what it was ported from ("Ported
  from shadcn/ui … on `@radix-ui/react-…`"), what it replaces (name the
  hand-rolled copies), and every house deviation from the source.
- **KIT-6. Strings and adoption.** Every user-visible string, including
  `aria-label`, is a prop with an Arabic default; callers on `/en/` pass the
  English text from messages (TXT-1, TXT-2). Adopt it where the pattern exists
  (PRIM-21), add its row to the §3 or §3.1 table, and update §17 and
  [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md).

---

## 4. Colour and tokens

Token values, light and dark: [DESIGN.md](../DESIGN.md) "Colors".

- **COL-1. Tokens only.** `background`, `foreground`, `card`, `popover`,
  `primary`, `secondary`, `muted`, `accent`, `destructive`, `warning`,
  `success`, `info`, each with its `*-foreground`, plus `border`, `input`,
  `ring`, and the decorative `illustration-concrete` and `illustration-shade`.
  Chart marks only from `--viz-*` (`var(--viz-series-1)` …), which are hex and
  not mapped in Tailwind. `--primary` and `--ring` resolve through a tenant's
  `--brand-primary`. See BAN-1.
- **COL-2. Fixed meanings:**
  - `success`: paid, settled, verified, active, owner-occupied.
  - `warning`: arrears, pending, needs attention. It is **text-only**, never a
    solid fill.
  - `destructive`: overdue, refused, delete. Mostly a text colour.
  - `info`: neutral notes and explanations, "how this works".
  - `primary`: the one primary action, the current selection, links.

  One colour never carries two meanings on one screen. For example, blue cannot
  mean both "occupant" and "selected".
- **COL-3. Colour is never the only signal.** Pair every status colour with a
  word or an icon: owner versus tenant, paid versus partial, ended.
- **COL-4. Contrast floors:** text 4.5:1 (including `text-X` on its own
  `bg-X/10` tint), meaningful icons, control borders and focus indicators 3:1,
  in **both** themes, on every surface the colour sits on. Dimming with
  `opacity-*` or `grayscale` on text needs a measured check. The current tokens
  miss these floors in places: §17.3.
- **COL-5. Changing or adding a token** means computing its contrast against
  both themes with a script (COL-8), never by eye. No validator is committed;
  the method and the last measurement are in §17.3.
- **COL-6. Solid fills** use the matching `-foreground` token, never
  `text-white`, which fails in dark mode.
- **COL-7. Illustrations and diagrams.** A drawing such as a building elevation
  or a unit grid uses tokens too. Material colours (wall, glass, slab,
  basement, timber) MUST live as `--illustration-*` tokens in `globals.css`,
  light and dark, and in `tailwind.config.ts` as `illustration-*`; two exist
  today (`illustration-concrete`, `illustration-shade`), and a new material adds
  its own. Never scatter them as hex or palette classes inside the component.
  - Material fills are decorative surfaces, and no contrast ratio is asked of
    them.
  - What must read is held to 3:1 against `--card` in both themes: the
    outline that carries a shape, and every mark that carries meaning (the
    citizen's lit units, a selected unit). Those use `foreground`, `success`,
    `info` and `ring`.
  - Semantic marks inside a drawing (hazard tape, a clinic cross, a
    demolition band) use the semantic token for that meaning (`warning`,
    `success`, `destructive`), not a material.
- **COL-8. Adding a colour.** In this order:
  1. Name it by **role**, never by hue: `--overlay`, `--paper`, `--ink`, not
     `--purple`.
  2. Give it an HSL channel triple in both `:root` and `.dark` of
     `apps/frontend/app/globals.css`, in the brand hue family (the warm
     neutrals or the cedar blue) unless its role demands another hue. Add a
     `-foreground` if it can be a solid fill. sRGB values only: no `oklch()`,
     `color()` or P3.
  3. Map it in `tailwind.config.ts` `theme.extend.colors` as
     `hsl(var(--name))`.
  4. Compute WCAG 2.2 contrast with a script (sRGB relative luminance, tints
     alpha-composited over the surface): 4.5:1 for text, 3:1 for icons,
     boundaries and focus, against `--background`, the page surface
     (`bg-muted/30` over `--background`), `--card`, `--popover` and `--muted`,
     and against its own `/5`, `/10` and `/15` tints, in both themes.
  5. Write the measured ratios into the token's comment in `globals.css`, as
     `--warning` and `--info` do.
  6. Add it to COL-1 and to the frontmatter and "Colors" section of
     [DESIGN.md](../DESIGN.md).
- **COL-9. The only places a literal colour is allowed**, each kept in one
  module, never scattered:
  - Mapbox paint expressions, which cannot read CSS variables. **Undecided:**
    one map-palette module derived from the tokens (today the hex is spread
    over five map files, §17.2).
  - The printed receipt and the receipt PDF canvas, which must print black on
    white whatever the theme. They should become `--paper` and `--ink` tokens.
  - QR codes, which need fixed dark-on-light.
  - `app/global-error.tsx`, which renders outside the token tree, and the web
    manifest's `background_color` and `theme_color`.
  - A colour chosen by the user as data (a zone's colour in `zone-modal.tsx`).
  - Layout arithmetic and grid templates are not colours: `calc()`, `env()`
    and `grid-template-columns` in arbitrary classes are covered by LAY-8.

---

## 5. Typography and numbers

Font families, the loaded weights and the scale as defined: [DESIGN.md](../DESIGN.md) "Typography".

- **TYP-1. Fonts.** Body is `font-sans` (IBM Plex Sans Arabic). `font-display`
  (Noto Kufi Arabic) is for marketing-grade headings only: the staff login,
  reset-password and not-found pages. Never use it in labels, buttons or data.
- **TYP-2. Scale.** Page heading `text-xl md:text-2xl font-bold` (PageHeader).
  Card titles `text-base`/`text-lg font-semibold`. Body `text-sm`; dense rows
  `text-xs`. Nothing a user must read goes below `text-xs`.
- **TYP-3. Weights.** `font-medium` for labels, `font-semibold` for titles and
  key values, `font-bold` only for page headings and the one key figure on a
  card.
- **TYP-4. Figures.** Every number that sits in a column, a total or a running
  figure gets `tabular-nums`. Use Latin digits everywhere (`lib/dates`,
  `lib/currency`, `toLocaleString('en-US')`). Never mix Arabic-Indic and Latin
  digits on one screen: `toLocaleString('ar')` and `ar-LB` without `-u-nu-latn`
  are refused.
- **TYP-5. No `uppercase` and no letter-spacing** on Arabic text; tracking
  breaks the joins.
- **TYP-6. Inputs** are 16px on phones (`text-base sm:text-sm`, as `Input`
  does) so Safari does not zoom on focus.
- **TYP-7. A weight needs a loaded face.** Use only weights the font import in
  `globals.css` loads: Plex 400, 500, 600; Kufi 500, 700. Plex has no 700 face,
  so `font-bold` on body text renders the 600 face (§17.4). **Undecided:** add
  Plex 700 to the import, or cap body text at `font-semibold`.

---

## 6. Layout, spacing, responsive

Spacing, radius and shadow values as defined: [DESIGN.md](../DESIGN.md) "Layout", "Elevation & Depth", "Shapes".

- **LAY-1. Page root:** `w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8`, then
  `PageHeader` (or `BackLink` then the header on a detail page).
- **LAY-2. Spacing rhythm:** `gap-1.5`/`gap-2` inside a control group, `gap-3`
  between related items, `gap-4` between cards, `space-y-6` between page
  sections. Put more space above a heading than below it.
- **LAY-3. Radii:** `rounded-md` for controls and chips, `rounded-lg` for cards
  and panels, `rounded-full` for avatars and dots. New code does not introduce
  `rounded-xl`/`2xl` for cards.
- **LAY-4. Elevation:** card `shadow-sm` plus border; overlays `shadow-md`/`lg`.
  `shadow-xs` and `shadow-2xs` generate nothing on Tailwind 3.4, so do not
  write them (CODE-8 explains why they also break `cn()`).
- **LAY-5. Mobile-first.** Check at 360px, 768px, 1024px and 1440px. No
  horizontal page scroll at 360px. Grids collapse to one column below `sm`.
  Fixed-width column templates (`grid-cols-[…rem_…rem]`) need a defined phone
  layout.
- **LAY-6. Overflow.** Flex and grid children holding user text get `min-w-0`
  plus `truncate` or wrapping. Long Arabic names, a 1,250,000,000 ل.ل figure,
  and a 30-character parcel code must not break the layout. Truncated text
  exposes its full value (`title` or a tooltip).
- **LAY-7. Touch.** Interactive targets are at least 24×24px on a cursor
  (WCAG 2.5.8) and 48px on a coarse pointer, through the `coarse:` variant and
  `min-h-touch`/`min-w-touch`. Field-inspector surfaces (matrix, unit forms,
  survey) are touch-first.
- **LAY-8. Arbitrary values.** An arbitrary Tailwind value (`-[…]`) is allowed
  only for what the scale cannot express: layout arithmetic (`calc()`,
  `max(…, env(safe-area-inset-bottom))`, `100dvh`), grid templates
  (`grid-cols-[…]`, `[grid-template-columns:…]`), and the coordinates of an SVG
  drawing that shows real geometry. Never for type size, spacing, radius or
  shadow. Counts: §17.4.

---

## 7. RTL and bidi

- **RTL-1. Logical properties only:** `ms-/me-/ps-/pe-/start-/end-/border-s/-e/text-start/text-end`.
  `ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`, `text-left`, `text-right`, `rounded-l-*`, `rounded-r-*`, `divide-x` and
  `space-x` are refused, and so is the `rtl:ml-* ltr:mr-*` pair that spells
  `me-*` the long way. For a divider between items use `[&>*+*]:border-s`, not
  `divide-x rtl:divide-x-reverse`. Physical positions are allowed only for maps,
  for symmetric centring (`DialogContent`), for print, and for diagrams that
  are deliberately drawn `dir="ltr"` (the unit grid and the elevation). Comment
  why.
- **RTL-2.** Wrap values inside running text in `<bdi>`. Codes, phones and IDs
  get `dir="ltr"`.
- **RTL-3. Directional icons flip.** Use `rtl:rotate-180` for an icon drawn for
  LTR, or `ltr:rotate-180` for one drawn for RTL. Pick one convention per
  component and test both locales.

---

## 8. States and feedback

- **STA-1. Every data surface has four states:** loading, empty, error and
  content. Use the primitives (PRIM-5) or DataTable's built-ins. An empty state
  says why it is empty (first use, filtered, no permission) and what to do
  next.
- **STA-2. Every interactive control has its states:** default, hover,
  `focus-visible`, active, disabled, loading. A button that starts async work
  is disabled with a spinner until the work ends.
- **STA-3. Writes:** `try { await api(); invalidate; toast.success } catch {
  logApiError; show the message for the error's code (TXT-6); toast.error }
  finally { busy off }`. A failed **read** shows `ErrorState` with retry. A
  failed **write** keeps the user's input and shows the message next to the
  action.
- **STA-4. Money and record-creating actions guard against double submission**
  with an in-flight ref, not only a `busy` state, and where the API supports
  it, an idempotency or client-submission key. A second click must never
  record a second payment.
- **STA-5. Optimistic UI** only where a rollback is exact. Money is never
  optimistic.
- **STA-6. Success** confirms the completed outcome briefly. A receipt shows
  what the server recorded (its receipt number, its date), never a
  client-side reconstruction.

---

## 9. Forms and money entry

- **FRM-1.** Every input has a visible label through `Field`. A placeholder is
  an example, never the label. Required and optional fields are marked the
  same way everywhere.
- **FRM-2. Validation.** Validate on blur or submit, not per keystroke. The
  error goes under the field with `role="alert"`. On a failed submit, focus the
  first invalid field. Keep what the user typed.
- **FRM-3. Labels describe the outcome.** A button says what will happen («سجّل
  الدفعة»), never the gesture («موافق», «إرسال»).
- **FRM-4. Money entry:**
  - Show the currency next to the field.
  - Format thousands as the user types without moving the caret.
  - Accept Arabic-Indic digits and normalise them.
  - Show the equivalent in the bill's currency live.
  - Never let the client's arithmetic be the record: the server computes the
    credit, and the screen shows the server's result.
- **FRM-5. Official values are shown, not typed.** An exchange rate or tariff
  taken from الإعدادات is displayed with its date. Overriding it for one
  transaction is a deliberate act with a reason, shown on the receipt and
  audited server-side. A client-typed figure (a rate, a total) never becomes
  the record unchecked.
- **FRM-6. Dates** come from `DatePicker`. A date that back-dates a financial
  or legal record asks for confirmation and states the consequence. A recorded
  date takes `max` (nothing later than today); a planned one, such as a
  re-inspection day, takes `min` (nothing before today), and with no `max` its
  year list runs forward from `min`. "Today" is the municipality's calendar day
  (`municipalToday`), never `toISOString().slice(0, 10)`.

---

## 10. Destructive and irreversible actions

- **DES-1.** Name the object and the consequence in the title and the button:
  «حذف الموظف أحمد…» and «احذف الحساب», never «نعم» or «موافق».
- **DES-2.** Prefer reversible designs (hide, end, archive) and say they are
  reversible. If something can be restored, the copy must not say "for good"
  or "never". If it cannot, say so plainly.
- **DES-3.** Use `requireText` (type to confirm) only for high-impact
  operations. Match on a **unique** key (an email or code, not a display name
  two people can share). Normalise Arabic variants (أ/إ/آ→ا, ة/ه, ى/ي) and
  whitespace before comparing (`normalizeArabic` in shared-schemas).
- **DES-4.** `destructive` styling means data or access is lost. A geometry
  change that loses nothing is not destructive.
- **DES-5.** Every path to a destructive action asks the same way. If a drag
  confirms, the panel button that does the same thing confirms too.

---

## 11. Copy and language

- **TXT-1. Where copy lives (decision D-i18n).** New copy goes in next-intl
  messages, `apps/frontend/messages/ar.json` and `apps/frontend/messages/en.json`,
  with identical keys, read through `useTranslations`. Enum and status text
  always comes from `getLabels(locale)` in `packages/shared-schemas/src/labels.ts`,
  never re-typed. Legacy, converted when you touch the file: inline
  `const en = locale === 'en'` with `en ? '…' : '…'`, `lib/settings-i18n.ts`
  `settingsCopy`, and `labelEn` in `components/admin/nav.ts`. **Undecided:**
  whether "touch" means the whole file or only the components you change, for
  files above the CODE-6 limit.
- **TXT-2. No language leaks.** Every user-visible string, including `title`,
  `aria-label`, toasts, `closeLabel`, units such as «م²», and SVG labels,
  exists in both locales. A server message is not a translated string (TXT-6).
- **TXT-3. One term per concept,** matching the rest of the product and the
  law the screen implements: «إنهاء الإيجار» for a tenant and «إنهاء الإشغال»
  for a free occupant, «الوحدات المحتسبة» for billable units. Do not rename a
  shipped concept in passing.
- **TXT-4. Errors** answer three questions: what failed, why (when known), and
  how to recover. Never show an internal code as the message.
- **TXT-5. Complete, translatable sentences.** No string concatenation of
  fragments; variables stay structured.
- **TXT-6. Errors by code (decision D-errors).** The API refuses with a code
  from `ERROR_CODES`; the words live in `messages/{ar,en}.json` under
  `errors`, and `ApiRequestError.message` is already translated
  (`lib/api-errors.ts`). Show `error.message`; branch on `error.kind` or
  `error.code`, never on the text. A new code ships with both entries
  ([apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md)). A network failure
  is recognised by status 0 or the `NETWORK_ERROR` code, never by matching
  text.

---

## 12. Accessibility

- **A11Y-1.** Keep the global `:focus-visible` ring. Never remove an outline
  without an equal replacement. Use `focus-visible:`, not `focus:`.
- **A11Y-2.** Icon-only controls have an `aria-label` in the current locale.
  Decorative icons have `aria-hidden`.
- **A11Y-3. Semantics match the pattern.** Tabs are `role="tablist"`/`tab`/
  `tabpanel` with `aria-controls`/`aria-labelledby`, or are not tabs. A
  `radiogroup` does not drive `tabpanel`s. Headings form an outline: a card
  title that is a section heading is an `h2`/`h3`.
- **A11Y-4. Every drag has a single-pointer and keyboard alternative**
  (WCAG 2.5.7) that is **discoverable** where the drag is, not three clicks
  away.
- **A11Y-5.** Async status changes are announced (`role="status"`,
  `aria-live="polite"`). Toasts never steal focus.
- **A11Y-6.** Dialogs trap and restore focus, close on Escape, and have a
  visible close control.
- **A11Y-7.** Dynamic counts in badges and pagers are read as a complete
  phrase («صفحة 2 من 5»), not as loose numbers.

---

## 13. Motion

Motion in Operate software conveys state. It is never decoration (emil-design-eng
and impeccable agree). Durations and easing as the code defines them:
[DESIGN.md](../DESIGN.md) "Overlays and motion".

- **MOT-1. Should it animate at all?** Anything used tens or hundreds of times a
  day (row hover, keyboard actions, the command palette, pager clicks) gets no
  movement. Occasional surfaces (dialogs, drawers, toasts) get a standard
  entrance.
- **MOT-2. Durations:** UI motion sits at 150–250ms. Within that: press
  feedback 100–160ms; tooltips and small popovers 125–200ms; dropdowns
  150–250ms; dialogs and drawers 200–250ms. Exit faster than enter.
- **MOT-3. Easing:** `ease-out` (or a strong custom ease-out) for entrances and
  feedback, `ease-in-out` for on-screen movement. Never `ease-in` for UI.
- **MOT-4. Animate only `transform` and `opacity`** (plus `colors` for hover).
  No `width`/`height`/`top`/`left`. Use `transition-colors` or name the
  property; `transition-all` is refused.
- **MOT-5. Press feedback:** `active:scale-[0.97] motion-reduce:transform-none`
  on pressable cards and dialog buttons. Never start an entrance from
  `scale(0)`; start at 0.95 with opacity 0.
- **MOT-6. Reduced motion** is honoured globally in `globals.css`. Any new
  `transform` animation also gets `motion-reduce:`. Pulses and attention
  animations stop under reduced motion.
- **MOT-7. Interruptible.** Use CSS transitions for UI that can re-trigger
  quickly, not keyframes. Never block input while something animates.
- **MOT-8.** Gate hover-only motion with `@media (hover: hover)`; on touch,
  hover fires on tap.

---

## 14. Icons, illustrations and charts

- **ICO-1.** Icons come from `lucide-react` only. `size-4` is the default,
  `size-3.5` in dense rows and `text-xs` lines, `size-5` in card and section
  titles. One style per hierarchy level.
- **ICO-2. Illustrations that show real geometry** (the building elevation, the
  unit grid):
  - token colours only (COL-7);
  - labels in both locales;
  - selectable parts are real buttons with names and at least 24px targets,
    or the drawing is decorative (`aria-hidden`) and the list beside it is
    the control;
  - classification by shared predicates (`isStructuralUnitType`,
    `isUnoccupied`, `effectiveUnitStatus`), never by re-listing enum values in
    a `switch`.
- **ICO-3. Two drawings of the same building must agree.** A lifecycle state
  (PERMITTED, UNDER_CONSTRUCTION) is drawn the same way in the elevation, the
  grid picker and the matrix.
- **ICO-4. Charts:** `--viz-*` colours, a legend, a table or text alternative,
  locale-aware axis numbers, and empty, loading and error states. See the
  `dataviz` skill.

---

## 15. How a page is put together (code shape)

The full staff-screen recipe: [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md).

- **CODE-1. Session:** `useStaffSession(tenant, base)`, with a skeleton while
  the token is null. Do not copy the `loadSession` effect into new pages.
- **CODE-2. Reads:** `useStaffQuery` with key `[resource, tenant, …every param
  that changes the answer]`. Writes invalidate that key. Do not use imperative
  `useEffect` fetch chains in new pages.
- **CODE-3. API:** functions in `lib/api-client.ts`, shaped
  `fn(tenant, token, args, signal?)`. Request and response types come from
  `packages/shared-schemas` when a schema exists. Never re-declare a shared
  type inline.
- **CODE-4. Role gating:** the route roles in `components/admin/nav.ts` decide
  who reaches the page. A page under `/citizens/**` inherits **every** staff
  role, so a money or admin screen placed there gates itself. In-page role
  checks hide controls; the server is the enforcement, and the page's list
  says which `@Roles` it mirrors.
- **CODE-5. N+1 fetches.** A page does not fetch one resource per row (for
  example `getBuilding` per property) when one endpoint can return what the
  screen draws. Fetch only what the role may see; do not download other
  citizens' names and phones to draw a picture.
- **CODE-6. Size.** A page file over ~600 lines is split into
  `components/admin/<feature>/*` pieces with one job each.
- **CODE-7.** Doc comments sit directly on the symbol they describe and match
  what the code does (BAN-15). A comment that contradicts the code is a bug.
- **CODE-8. `cn()` does not know this Tailwind.** `lib/utils.ts` `cn` is plain
  `twMerge(clsx(…))` from tailwind-merge 3.6, which is built for Tailwind 4,
  while the app runs Tailwind 3.4.19. Observed on 2026-10-03 with the installed
  packages:
  - `min-h-9 min-h-touch` stays `min-h-9 min-h-touch`, and so do `h-10 h-touch`,
    `p-2 p-touch` and `coarse:h-12 coarse:h-touch`: the `touch` spacing is not
    recognised, both classes survive, and stylesheet order decides.
  - `shadow-sm shadow-xs` becomes `shadow-xs`: the real shadow is dropped for a
    class Tailwind 3.4 does not generate, so the element loses its shadow.
  - Colour tokens (`text-success text-sm`, `bg-illustration-concrete bg-card`)
    and `rounded-*` merge correctly.

  So: never pass `shadow-xs`/`shadow-2xs`, and never rely on `cn` to override a
  `*-touch` class; remove the class you are replacing instead. Reproduce with
  `pnpm --filter @mechanization/frontend exec node --input-type=module -e "import { twMerge } from 'tailwind-merge'; console.log(twMerge('min-h-9 min-h-touch'), twMerge('shadow-sm shadow-xs'))"`.
  The trap and its fix options: [docs/gotchas.md](gotchas.md).

---

## 16. Reviewing UI: the protocol

1. **Read the neighbours first.** Find the closest existing screen for the same
   job and compare. Drift is classified (from impeccable's polish guidance):
   - *missing token*: the system needs a reusable value;
   - *one-off implementation*: a shared primitive should replace it;
   - *conceptual mismatch*: the flow or terms differ from comparable screens;
   - *local defect*: incomplete or inconsistent.
2. **Triage in this order:**
   - **P0**: a broken task, data loss, a misleading state about money or legal
     status, an inaccessible path.
   - **P1**: missing loading, empty, error, disabled or permission states;
     copy that contradicts behaviour.
   - **P2**: flow, hierarchy, responsive or design-system drift (BAN/PRIM/COL
     violations).
   - **P3**: visual and motion polish, cleanup.
3. **Write every visual or code-level finding as a table:**

   | Before | After | Why (rule ID) |
   |---|---|---|
   | `bg-violet-500/10 text-violet-600` | `bg-primary/10 text-primary` (or a new validated token) | BAN-1, COL-1 |

4. **Verify by rendering.** Use the headless harness (temp route plus
   playwright-core plus mocked API; never staging, never real citizens). It is
   not committed and playwright-core is not in any `package.json`. Check:
   - 360px and 1440px;
   - light and dark themes;
   - `ar` and `en`;
   - long names and huge figures;
   - empty, error and loading states;
   - keyboard only.

   Clean up the harness afterwards. A screenshot you did not take is not
   evidence.
5. **Do not blame a PR for pre-existing debt.** Do require that it adds none,
   and that files it rewrites leave cleaner than they arrived.

### Pre-merge checklist (copy into the PR description for UI changes)

- [ ] No raw colours, hex or palette classes outside COL-9 (BAN-1, COL-1)
- [ ] A new colour follows COL-8, with its ratios computed in both themes
- [ ] Shared primitives used; no new local copies (PRIM-*)
- [ ] No native or hand-rolled control the kit replaces (CTL-*); a new primitive follows KIT-*
- [ ] Loading, empty, error and success states, using the primitives (STA-1)
- [ ] New copy in both message files, including aria, title, toasts and units (TXT-1, TXT-2)
- [ ] Errors shown by code, server message only as fallback (TXT-6)
- [ ] Logical properties only; checked in RTL and LTR (RTL-1)
- [ ] `tabular-nums`, Latin digits, shared formatters (TYP-4, PRIM-10–12)
- [ ] Destructive copy matches behaviour; confirmation on every path (DES-*)
- [ ] Double-submit guard on money and record writes (STA-4)
- [ ] Keyboard path for every drag; names on icon controls (A11Y-2, A11Y-4)
- [ ] Motion within MOT-*, honouring reduced motion; no `transition-all`, no `shadow-xs` (MOT-4, LAY-4)
- [ ] Rendered at 360/1440, light/dark, ar/en (§16.4)
- [ ] No orphaned comments or dead code (BAN-15)

---

## 17. Known debt on `develop` (do not copy it)

These exist today. None of them is a precedent. Counts were taken on
`develop@8742c5b` with grep and a TypeScript AST scan over `app/` and
`components/` (excluding `components/ui` unless named). When you touch a file
listed here, leave it with less of this debt, not more, and update the count.
Code-pattern debt outside the UI rules lives in
[docs/code-quality.md](code-quality.md).

### 17.1 Primitives and controls

- **Local stat and KPI components, 10** (PRIM-20): `MetricCard` in the
  buildings, citizens and fees pages; `KpiCard` (dashboard); `StatTile`
  (`citizens/[citizenId]/page.tsx`); `Stat` in
  `inspector/profile/[staffId]/payouts/page.tsx`, `inspector-earnings-roster.tsx`
  and `inspector-profile-detail.tsx`; `StatusTile` (`settings/settings-ui.tsx`);
  `StatCard` (`(citizen)/my-file`). `StatStrip` has 5 uses in 4 files.
- **Hand-rolled pagers, 3** (PRIM-4): `AuditTrailPage` (`audit/page.tsx`),
  `CorrectionBillsPage` (`fees/corrections/page.tsx`), `AuditDaily`
  (`components/admin/audit-daily.tsx`). `Pager` has 1 user.
- **Red error banners, 61 copies in 46 files**, with no `Alert` primitive
  (CTL-12): a className holding `border-destructive…`, `bg-destructive/5` or `/10` and
  `text-destructive`. Three each in `import-citizens-dialog`,
  `complete-record-dialog`, `building-unit-forms`; two each in
  `unit-correction-delete-dialog`, `merge-citizens-dialog`, `citizen-form`,
  `case-editor`, `building-editor`, `settings/profile-section` and the citizen
  `payments`, `my-file` and `my-account` pages; one in each of 34 more,
  across `components/admin`, the `(protected)` cases, citizens, citizen detail,
  dashboard, fees, settle, payments and staff pages, the staff login and
  reset-password pages, the remaining citizen pages and `components/citizen/pay-dialog.tsx`.
- **Copied `loadSession` effects, 23** (CODE-1): 16 pages under `(protected)`
  (account, audit, buildings, cases, citizens, `citizens/[citizenId]`,
  dashboard, fees, `fees/corrections`, `fees/payments/[paymentId]/settle`, map,
  the index `page.tsx`, payments, settings, staff, zones) and 7 components
  (`activity-trail`, `building-editor`, `building-unit-matrix-drawer`,
  `building-unit-matrix-view`, `case-editor`, `citizen-editor`,
  `unit-correction-delete-dialog`). Legitimate callers: `StaffRouteGuard`,
  `AdminShell`, the staff login page and the four citizen pages.
- **Double frames, 3** (BAN-4): the citizens, fees and payments pages put
  `DataTable` inside `CardContent className="p-6"`.
- **Page-local table labels, 5** (PRIM-23): `getTableLabels` in the buildings,
  citizens, fees and staff pages, and `getCaseTableLabels`
  (`components/admin/cases/case-table-labels.ts`). `useTableLabels` has 6 users.
- **Native date and time inputs, 14 in 7 files** (CTL-1, CTL-2): 13
  `type="date"` (`building-unit-forms` 8, `charge-citizen-dialog`,
  `end-ownership-dialog`, `end-tenancy-dialog`, `issue-fee-dialog`,
  `residence-change-dialog`) and 1 `type="time"` in
  `settings/backup-section.tsx`, which is not rendered.
- **Native radios, 6 in 4 files** (CTL-4): `after-tenancy-question` (2),
  `landlord-match-hint`, `landlord-proposal-card` (2), `residence-change-dialog`.
- **`title=` as a name** (CTL-8): 42 on intrinsic elements in 24 files and 27 on
  `<Button>` in 12 files (`fullscreen-map` 9, `citizen-form` 4, `zone-legend` 4,
  …). Some are truncation titles, which are allowed. **Unverified:** how many
  of the 69 are the control's only name.
- **Hand-rolled tabs, 2** (CTL-9): `components/admin/cases/case-queue-tabs.tsx`,
  `components/admin/quality/review-queue.tsx`.
- **`aria-pressed` buttons in 22 files** (CTL-10, PRIM-14). Some are single
  toggles (show password in the login page, `ThemeToggle`), others are option
  groups. **Unverified:** not triaged.
- **Hand-rolled popovers and comboboxes** (CTL-11): `bill-type-select.tsx`
  (combobox, with its own copy of `normalizeArabic`), `notifications-bell.tsx`,
  the `DatePicker` panel.
- **`Sheet` has no focus trap and no focus restore** (A11Y-6), and its two
  close controls say `aria-label="Close"` in every locale. 2 users. Fix per
  D-kit: port shadcn's Sheet onto `@radix-ui/react-dialog` (installed), keeping
  the `pressedInside` tap guard.
- **`DialogContent` defaults `closeLabel` to `'Close'`**, against the Arabic
  default of every other primitive (KIT-6). 7 of 42 `DialogContent` pass none:
  `map-export-dialog`, `parcel-roster-dialog`,
  `settings/security-section` (2), `settings/users-section`,
  `unverified-fields-dialog`, `zone-info-dialog`.
  `DialogContent`'s close button and `Badge` also use `focus:` rings instead of
  `focus-visible:` (A11Y-1).
- **`ConfirmDialog`**: `requireText` is compared raw, without `normalizeArabic`
  (DES-3); the default `confirmLabel` «تأكيد» is a gesture label (FRM-3).
- **`Toast` side stripe** (BAN-3): the toast root in
  `components/ui/toast.tsx` uses `border-s-4`, a coloured side stripe thicker
  than 1px. Replace it with a tinted surface or icon plus text.

### 17.2 Colour

- **Palette classes, 65 in 4 files** (BAN-1): `unit-grid-picker.tsx` 40 (10 of
  them `dark:` twins), `fullscreen-map.tsx` 18, `inspector-profile-detail.tsx`
  6 (purple and indigo tones), `settings/security-section.tsx` 1
  (`text-slate-700`).
- **White and black**: `payment-receipt.tsx` 42 (the print facsimile, allowed by
  COL-9 until `--paper` and `--ink` exist); `bg-white` behind the QR code and
  the logo plate in `settings/security-section.tsx` and
  `settings/profile-section.tsx`; `text-white` on a zone colour in
  `zone-info-dialog.tsx`; `border-black/20` swatch outlines in `zones/page.tsx`,
  `fullscreen-map.tsx` and `zone-legend.tsx`; a decorative `bg-white/10 blur-3xl`
  halo on the staff login page (BAN-2). Scrims in three opacities:
  `bg-black/80` (`DialogOverlay`), `bg-black/60` (`AdminShell`,
  `CommandPalette`), `bg-black/50` (`Sheet`). **Undecided:** one `--overlay`
  token and its value.
- **Hex literals, 94 in 11 files**: `fullscreen-map.tsx` 36,
  `building-map-layer.ts` 19, `zone-modal.tsx` 8 (the user-chosen zone palette),
  `zone-editor-map.tsx` 8, `parcel-pin-picker.tsx` 7, `map-export-dialog.tsx` 7
  (an inline print stylesheet), `settings/security-section.tsx` 2 (QR colours),
  `app/global-error.tsx` 2, the manifest route 2 (still the old slate
  `#f8fafc` and blue `#1d4ed8`), `lib/accents.ts` 2 (a dead swatch),
  `lib/receipt-pdf.ts` 1 (the canvas white). **`rgb()`/`hsl()` literals, 12 in
  6 files**: `fullscreen-map.tsx` 6, `payment-receipt.tsx` 2, `zone-editor-map.tsx`,
  `parcel-pin-picker.tsx`, `building-map-layer.ts`, `app/global-error.tsx`.
  `globals.css` itself holds an old slate value in the Mapbox popup shadow and a
  `#000` print border. Legitimate under COL-9: the map paint, print, QR,
  global-error, manifest and the zone palette. The map colours should move into
  one map-palette module derived from the tokens.
- **Solid warning fills** (COL-2): `Badge` has solid `warning` and `success`
  variants, and `bg-warning` is a solid fill in `citizen-form.tsx`,
  `match-light.tsx`, `quality/finding-parts.tsx` and `unit-holdings-grid.tsx`.
  **Undecided:** remove the solid warning uses, or amend COL-2.
- **The brand colour is unchecked** (COL-4): `--brand-primary` is one triple for
  both themes, and `safeHslTriple` checks its syntax, not its contrast. A dark
  brand blue would fail `text-primary` in dark mode and the near-black
  `primary-foreground` on it. **Unverified:** whether any municipality sets
  `branding.primaryColor`. **Undecided:** where to check it.

### 17.3 Contrast measured from the tokens (COL-4)

Method: WCAG 2.x relative luminance in sRGB, computed from the HSL triples and
hex values in `globals.css` by a throwaway script (not committed; COL-5). Tints
are alpha-composited over `--card`; "page" is `bg-muted/30` over
`--background`, which is what the tenant layout paints. Rendered pixels were not
measured.

| Theme | Pair | Ratio | Floor |
|---|---|---|---|
| light | `text-destructive` on `bg-destructive/5` (the banner tint) / `/10` / `/15` | 4.42 / 4.12 / 3.82 | 4.5 |
| light | `text-warning` on `/10` / `/15` (`Badge` `soft-warning`) | 4.27 / 3.99 | 4.5 |
| light | `text-success` on `/10` / `/15` | 4.38 / 4.09 | 4.5 |
| light | `text-info` on `/5` / `/10` | 4.39 / 4.11 | 4.5 |
| light | on `--muted`: destructive, warning, success, info | 4.20, 4.31, 4.44, 4.15 | 4.5 |
| light | `text-info` on the page surface | 4.46 | 4.5 |
| dark | `text-primary` on `/10` / `/15`, on `--popover`, on `--muted` | 4.23 / 3.95, 4.35, 4.08 | 4.5 |
| dark | `text-destructive` on `/10` / `/15`, on `--popover`, on `--muted` | 4.34 / 4.06, 4.44, 4.16 | 4.5 |
| light / dark | `--input` against `--card` (control boundary) | 1.39 / 1.51 | 3.0 |
| light / dark | `--border` against `--card` | 1.30 / 1.30 | 3.0 where it carries a control |
| light | `--viz-step-1`, `--viz-step-2` on `--card` | 2.07, 2.93 | 3.0 |
| dark | `--viz-step-4` on `--card`; `--viz-step-3` on `--popover` | 2.15; 2.96 | 3.0 |

Passing: every solid fill with its `-foreground` (4.78 to 6.61 light, 5.30 to
8.58 dark); `foreground` and `muted-foreground` on every surface (4.58 and up);
`--ring` everywhere against its 3:1 floor (4.08 and up; the lowest is dark on `--muted`). The `--viz-*` comment in `globals.css` says
the steps were validated at 3:1 against `#ffffff` and `#020817`; even against
those, light steps 1 and 2 (2.11, 2.99) and dark step 4 (2.47) fail.
**Undecided** (a visual change that needs approval): darken the light status
tokens, add dedicated tint surface tokens, or relax COL-4's tint clause; raise
`--input` to 3:1; re-pick the ordinal ramp against the warm surfaces.

### 17.4 Type, sizes and layout

- **Weights without a face** (TYP-7): `font-bold` 156, `font-extrabold` 2,
  `font-black` 5, against Plex loaded at 400, 500 and 600 only.
- **Letter-spacing** (TYP-5): `PageHeader`'s `h1` and `CardTitle` carry
  `tracking-tight`. In all: 35 `tracking-tight`, 16 `tracking-wide`/`wider`/`widest`,
  8 `uppercase`.
- **`text-[Npx]` below the 12px floor, 7 in 5 files** (BAN-11):
  `unit-grid-picker.tsx` (`text-[8px]`, `text-[9px]` twice),
  `building-unit-matrix-view.tsx` and `notifications-bell.tsx` (`text-[10px]`),
  `possible-duplicates.tsx` and `unit-correction-delete-dialog.tsx` (`text-[11px]`).
- **Other `-[Npx]` values, 159 in 20 files** (LAY-8), 122 of them in
  `property-illustrations.tsx`, an SVG drawing that LAY-8 allows. `-[Nrem]`: 32.
- **`shadow-xs`/`shadow-2xs`, 34 in 12 files** (LAY-4, CODE-8), including the
  primitives `field.tsx` (1) and `segmented-control.tsx` (2);
  `building-editor.tsx` has 11, `bill-type-select.tsx` 5.
- **`rounded-xl`/`2xl`/`3xl`, 139 uses** (LAY-3 applies to new cards).
  `DialogContent`, Button `xl`, `DataTable` and `Skeleton` use `rounded-xl`.
- **Physical direction utilities, about 55 in 14 files** (RTL-1): `rtl:ml-*
  ltr:mr-*` pairs instead of `me-*` in `fees/page.tsx` (7 pairs), the settle
  page (2 pairs) and `fees/corrections/page.tsx` (1 pair); `payment-receipt.tsx`
  12 (print); `fullscreen-map.tsx` 8 (map); the rest in map components, the
  building diagrams, `zones/page.tsx`, `citizen-form.tsx` (a mobile bar with
  `left-0 right-0`; use `inset-x-0`) and `DialogContent`'s symmetric centring.
- **Header actions that do not wrap** (LAY-5): at 360px on `/en/` the citizens
  page's «Import from file» and «Register new citizen» run past the screen edge
  and the second is cut off; the Arabic labels fit. Seen in the 2026-10-06
  render check; other pages with two header actions were not measured.

### 17.5 Motion

- **`transition-all`, 25 in 11 files** (MOT-4): `fullscreen-map.tsx` 9,
  `bill-type-select.tsx` 6, the primitives `segmented-control.tsx` (2),
  `field.tsx` and `data-table.tsx`, plus `zone-legend.tsx`,
  `settings/settings-ui.tsx`, `settings/profile-section.tsx`,
  `settings/cadastre-section.tsx`, `settings/backup-section.tsx` and
  `buildings/page.tsx`.
- **Dialog** exits at the same 200ms it enters, and `animate-in` runs on the CSS
  default `ease`, not an ease-out (MOT-2, MOT-3).
- **Over 250ms**: `Sheet`, `citizen-detail-drawer.tsx`,
  `import-citizens-dialog.tsx`, `map-layer-control.tsx` at 300ms; the dashboard
  and `fullscreen-map.tsx` at 500ms.

### 17.6 Copy, locale and money

- **Arabic-only toasts, 12 calls in 2 pages** (TXT-2): fees 11, zones 1.
- **Arabic-only literal attributes** (`aria-label`, `title`, `placeholder`,
  `closeLabel`), **14 in 10 files**: `admin-shell.tsx` 3,
  `import-citizens-dialog.tsx` 3, and one each in `citizens/[citizenId]/page.tsx`,
  `confirm-cash-payment-dialog.tsx`, `fullscreen-map.tsx`, `payment-receipt.tsx`,
  `settings/profile-section.tsx`, `theme-toggle.tsx`, and the primitives
  `field.tsx` and `toast.tsx`. `ThemeToggle`'s labels are Arabic only.
- **Server text shown as the message** (TXT-6): 24 catch blocks in 13 files
  render `caught.payload.message`, the server's English log text for a
  converted code, instead of `caught.message` (the `errors.<CODE>` text):
  `building-editor` 3, `landlord-proposal-card` 3, two each in `citizen-editor`,
  `end-ownership-dialog`, `end-tenancy-dialog`, `parcel-correction-dialog`,
  `unit-correction-delete-dialog`, the buildings and zones pages, one each in
  `building-unit-picker`, `landlord-unlink-dialog`, `settings/cadastre-section`
  and the landlord-links page (counted 2026-10-08; the matrix drawer's six were
  fixed then). `ErrorState` detects offline by matching «تعذّر الاتصال» in its
  description.
- **Copy mechanisms** (TXT-1): about 117 files branch inline on the locale (`en ?`,
  `locale === 'en' ?`, `isAr ?`), 62 of them through `const en = locale === 'en'`;
  `settingsCopy` serves settings and account; the 13 `messages.nav` keys are
  never read.
- **Search hints that offer «مشاهد فقط» the reference** (root rule 9): the
  register, «يتطلب مراجعة», the payments ledger and the fees screen invite a
  search by «الرقم المرجعي» for every role, but for «مشاهد فقط» the search leaves
  the reference out (`citizenSearchText`). Role-aware hints are not built
  (2026-10-06).
- **Money formatting** (PRIM-11, PRIM-25): `inspector-payout-dialog.tsx` writes
  `$${x.toFixed(2)}` 5 times; `charge-citizen-dialog.tsx` and
  `issue-fee-dialog.tsx` each define a local `formatLbp(value: string)`;
  `components/citizen/pay-dialog.tsx` builds «ل.ل» by hand in a local `lbp` (PRIM-10).
- **Double submit** (STA-4): the settle page, `fees/page.tsx` with
  `IssueFeeDialog`, and the payouts page with `InspectorPayoutDialog` guard with
  `busy` state only, with no in-flight ref.

### 17.7 Stale comments touching the UI (BAN-15)

- `globals.css`: the "Accent palettes" comment sits above no `[data-accent]`
  blocks; the `--viz-*` comment cites surfaces (`#ffffff`, `#020817`) that are
  no longer the surfaces.
- `tailwind.config.ts`: the header says it mirrors the Albazourieh theme so
  components "render identically"; `globals.css` says that parity was given up.
- `theme-toggle.tsx` says there is no `DropdownMenu` in this design system; there is.

---

## 18. Going deeper: the skills

Run these for depth, then apply them **through** this file. Where a skill's
generic advice conflicts with §0's sources of truth, the sources win.

- `impeccable`. Use `critique` and `audit` for a review, `polish` for the final
  pass, `harden` for edge cases and i18n, `clarify` for copy. Choose **Operate**
  mode for every admin surface. It loads `DESIGN.md` and `PRODUCT.md`; this
  file still wins over both.
- `ui-ux-pro-max`: `~/.agents/skills/ui-ux-pro-max/references/quick-reference.md` for the full accessibility,
  interaction, forms and navigation rules; `search.py "<query>" --domain ux`
  for one concern at a time, `--stack nextjs` or `--stack shadcn` for
  implementation.
- `emil-design-eng`: component polish and motion decisions. Its Before/After
  review table is the format required by §16.
- Related: `review-animations`, `responsive-design`, `dataviz` (charts).
