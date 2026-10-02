# UI/UX standards — binding for every change to `apps/frontend`

This file binds every AI agent and every person who builds or reviews an
interface in this repository. [AGENTS.md](../AGENTS.md) §9 points here. Read it
**before** you write UI code and **before** you review a UI diff. A review that
does not check these rules has not reviewed the interface.

Every rule has an ID (`COL-1`, `PRIM-3` …). Cite the ID in reviews, commit
messages and code comments so findings are traceable and arguable.

---

## 0. What wins when sources disagree

1. **The code's design tokens**: `apps/frontend/app/globals.css` and
   `apps/frontend/tailwind.config.ts`. Every colour there was solved against
   measured contrast targets. Never nudge one by eye; re-run the contrast
   validator (see §4).
2. **The shared primitives** in `apps/frontend/components/ui/*`, as their doc
   comments describe them.
3. **This file.**
4. `DESIGN.md` and `PRODUCT.md` at the repo root. Both are partly out of date:
   `DESIGN.md` names fonts (Alexandria, Readex Pro, JetBrains Mono), hex colours
   and zebra tables that the app does not use, and `PRODUCT.md` lists roles
   (`ADMIN`) that do not exist (the real `StaffRole` enum is `SUPER_ADMIN,
   AUDITOR, FIELD_INSPECTOR, COLLECTOR, ACCOUNTANT, ADMINISTRATIVE_OFFICER`).
   Where they disagree with 1–3, 1–3 win. Design skills that load `DESIGN.md`
   automatically (impeccable) must be corrected by this rule.

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
| BAN-1 | Raw colours in components: hex (`#e9dcc4`, `bg-[#…]`), `rgb()`, Tailwind palette classes (`text-violet-600`, `bg-amber-900/10`, `border-red-500`) | Semantic tokens (§4). A missing colour becomes a token in `globals.css` with light **and** dark values, validated. |
| BAN-2 | Gradient text, decorative glass/blur, glow halos | Emphasis through weight and size. |
| BAN-3 | Coloured side stripes thicker than 1px on cards, list items, callouts or alerts (`border-s-4 border-primary`) | Tint the surface (`bg-warning/10`), or use an icon plus text. |
| BAN-4 | Nested cards, and a bordered table inside a bordered card with padding | One frame. Use `CardContent className="p-0"` around a borderless `DataTable` (as `buildings/page.tsx` does). |
| BAN-5 | Eyebrow or kicker labels above a heading; section numbers (01/02/03) that carry no meaning | Let the heading carry its own weight. |
| BAN-6 | The hero-metric template (big number, small label, accent) as page structure; same-size icon+heading+text card grids as the page layout | A real layout derived from the task. |
| BAN-7 | Emoji or Unicode glyphs as icons (`‹ ›`, `✓`, `⚠`) | `lucide-react`, one stroke family. |
| BAN-8 | The "ghost card": a 1px border plus a wide soft shadow. Random radii | Declare elevation once: border **or** shadow. Radii from the token scale (§6). |
| BAN-9 | `font-mono` as a costume for "technical" or for money | `font-mono` is for codes only: reference, parcel, unit and receipt numbers. Figures use `tabular-nums` in the body font. |
| BAN-10 | A modal for a task that needs neither interruption nor protected focus | Inline, a page, or progressive disclosure. A page has an address a collector can be sent to. |
| BAN-11 | Arbitrary type sizes (`text-[11px]`, `text-[8px]`) and arbitrary spacing (`p-[13px]`) | The Tailwind scale. 12px (`text-xs`) is the floor for any text a user must read. |
| BAN-12 | Inline `style={{…}}` for anything a class or token can express | Classes. Inline style only for values computed at runtime (a drag offset, a grid track count). |
| BAN-13 | Sketch-style or "illustrative" SVG standing in for content; decorative sparklines and progress rings | Real data, or nothing. Diagrams that show real geometry (the building elevation, the unit grid) are allowed, with token colours. |
| BAN-14 | `transition-all`, `ease-in` on UI, entrances from `scale(0)`, UI animation over 300 ms, animation on keyboard-initiated or high-frequency actions | §13. |
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
| PRIM-4 | Pagination outside a table | One shared pager, with strings passed in as props, a `<nav aria-label>` landmark, and scroll-to-top on change, like DataTable's footer | A page-local pager or `‹ ›` text buttons |
| PRIM-5 | Loading, empty or failed panel | `LoadingState`, `EmptyState`, `ErrorState` from `ui/states` | `<p>جارٍ التحميل…</p>`, a dashed empty `div`, a red `<p>` |
| PRIM-6 | Placeholder shapes | `Skeleton`, `SkeletonText`, `SkeletonStat` | An inline `div animate-pulse` |
| PRIM-7 | Label/value facts | `FactRow`/`FactCell` (facts in cards and logs); `SummaryList`/`SummaryRow` (read-back of one record) | A page-local `FactRow`, `InfoCard` or `<dl>` |
| PRIM-8 | A value in a table cell | `CellTag` | `Badge` in a column |
| PRIM-9 | An annotation chip | `Badge` with a `soft-*` variant | `Badge` with colour overrides in `className` |
| PRIM-10 | LBP on screen | `<Money>`; `formatLbp` only for plain strings (toast, aria, CSV) | `toLocaleString()` plus «ل.ل» by hand |
| PRIM-11 | USD/EUR on screen | One shared formatter in `lib/currency.ts` (add it there the first time it is needed) | A page-local `formatUsd`, `$${x.toFixed(2)}`, or a third spelling |
| PRIM-12 | Dates | `formatDate` / `formatTime` / `formatDateTime` / `formatMonthList` from `lib/dates` | `toLocaleDateString('ar')`, raw month numbers joined with «، » |
| PRIM-13 | A labelled input | `Field` (label, required `*`, «(اختياري)», `caution`, error with `role="alert"`) wrapping `Input`/`Select`/`Textarea`/`DatePicker` | A bare `<label>` plus input; a native `<select>`; a native `type="date"` in new code |
| PRIM-14 | Two to four options | `SegmentedControl`; three or more filter chips: `ChipGroup` | Hand-rolled toggle buttons |
| PRIM-15 | Foldable section | `CollapsibleSection` | A `useState` toggle with a chevron |
| PRIM-16 | Confirmation of a destructive or irreversible action | `ConfirmDialog` (`requireText` when typing the subject's name is warranted); throw from `onConfirm` to show the server's refusal inline | `window.confirm`, a custom dialog |
| PRIM-17 | Any other modal | `Dialog`, always with an Arabic `closeLabel` on the Arabic locale | `Sheet` for new work: it lacks a focus trap. Fix Sheet before adding users |
| PRIM-18 | Feedback after a write | `useToast()` | `alert()`, a page-local banner that never clears |
| PRIM-19 | Icon-only control | `Button size="icon*"` + `aria-label` + `ActionTooltip` | A bare `<button>` with only an icon |
| PRIM-20 | KPI or stat row | **There is no canonical stat primitive yet.** Develop has nine local copies (`MetricCard`×3, `KpiCard`, `StatTile`, `Stat`×3, `StatusTile`). A new one goes in `components/ui`, is token-pure (no `font-mono`, no arbitrary sizes, logical dividers), and the same PR replaces at least the copies on the pages it touches | A tenth local copy |

**PRIM-21. A new primitive** goes in `components/ui/` with a doc comment that
says what it replaces and why. It takes every user-visible string as a prop
(with an Arabic default if the house primitives do that). It is adopted where
the pattern already exists, or the PR names the follow-up.

**PRIM-22. Page-local helpers that duplicate logic are refused.** When a
function such as `occupancyDot`, a role list such as `EDIT_ROLES`, or a label
map is needed by two files, it moves to `lib/` or `packages/shared-schemas`
first. Role lists must mirror the controller's `@Roles` and say so in a
comment.

---

## 4. Colour and tokens

- **COL-1. Tokens only.** `background`, `foreground`, `card`, `popover`,
  `primary`, `secondary`, `muted`, `muted-foreground`, `accent`, `destructive`,
  `warning`, `success`, `info`, `border`, `input`, `ring`, plus each
  `*-foreground`. Chart marks only from `--viz-*`. See BAN-1.
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
  `bg-X/10` tint), meaningful icons and control borders 3:1, in **both**
  themes. Dimming with `opacity-*` or `grayscale` on text needs a measured
  check.
- **COL-5. Changing or adding a token** means re-running the contrast
  validator against both themes. It is not committed; rebuild it from the
  targets documented in the comments of `globals.css` and in the
  theme-token note. Never pick a value by eye.
- **COL-6. Solid fills** use the matching `-foreground` token, never
  `text-white`, which fails in dark mode.
- **COL-7. Illustrations and diagrams.** A drawing such as a building elevation
  or a unit grid uses tokens too. Material colours (wall, glass, slab,
  basement, timber) live as `--illustration-*` tokens in `globals.css`, light
  and dark, and in `tailwind.config.ts` as `illustration-*`. Never scatter them
  as hex or palette classes inside the component.
  - Material fills are decorative surfaces, and no contrast ratio is asked of
    them.
  - What must read is held to 3:1 against `--card` in both themes: the
    outline that carries a shape, and every mark that carries meaning (the
    citizen's lit units, a selected unit). Those use `foreground`, `success`,
    `info` and `ring`, which are already validated.
  - Semantic marks inside a drawing (hazard tape, a clinic cross, a
    demolition band) use the semantic token for that meaning (`warning`,
    `success`, `destructive`), not a material.

---

## 5. Typography and numbers

- **TYP-1. Fonts.** Body is `font-sans` (IBM Plex Sans Arabic). `font-display`
  (Noto Kufi Arabic) is for marketing-grade headings only (login, not-found).
  Never use it in labels, buttons or data.
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

---

## 6. Layout, spacing, responsive

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
  write them.
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

---

## 7. RTL and bidi

- **RTL-1. Logical properties only:** `ms-/me-/ps-/pe-/start-/end-/border-s/-e/text-start/text-end`.
  `ml/mr/pl/pr/left/right/text-left/right/rounded-l/r`, `divide-x` and
  `space-x` are refused. For a divider between items use
  `[&>*+*]:border-s`, not `divide-x rtl:divide-x-reverse`. Physical positions
  are allowed only for maps and for diagrams that are deliberately drawn
  `dir="ltr"` (the unit grid and the elevation). Comment why.
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
  logApiError; show ApiRequestError.message; toast.error } finally { busy off }`.
  A failed **read** shows `ErrorState` with retry. A failed **write** keeps the
  user's input and shows the server's message next to the action.
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
  audited server-side.
- **FRM-6. Dates** come from `DatePicker`. A date that back-dates a financial
  or legal record asks for confirmation and states the consequence.

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
  whitespace before comparing.
- **DES-4.** `destructive` styling means data or access is lost. A geometry
  change that loses nothing is not destructive.
- **DES-5.** Every path to a destructive action asks the same way. If a drag
  confirms, the panel button that does the same thing confirms too.

---

## 11. Copy and language

- **TXT-1. House convention:** admin copy is written inline and bilingual
  (`const en = locale === 'en'` then `en ? '…' : '…'`). Surfaces that already
  use `next-intl` (login, dashboard, payments, error pages) keep using it.
  Enum and status text always comes from `getLabels(locale)` in
  `packages/shared-schemas/src/labels.ts`, never re-typed.
- **TXT-2. No language leaks.** Every user-visible string, including `title`,
  `aria-label`, toasts, `closeLabel`, units such as «م²», and SVG labels,
  exists in both locales. Server error messages are Arabic and are shown as
  received.
- **TXT-3. One term per concept,** matching the rest of the product and the
  law the screen implements: «إنهاء الإيجار» for a tenant and «إنهاء الإشغال»
  for a free occupant, «الوحدات المحتسبة» for billable units. Do not rename a
  shipped concept in passing.
- **TXT-4. Errors** answer three questions: what failed, why (when known), and
  how to recover. Never show an internal code as the message.
- **TXT-5. Complete, translatable sentences.** No string concatenation of
  fragments; variables stay structured.

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
and impeccable agree).

- **MOT-1. Should it animate at all?** Anything used tens or hundreds of times a
  day (row hover, keyboard actions, the command palette, pager clicks) gets no
  movement. Occasional surfaces (dialogs, drawers, toasts) get a standard
  entrance.
- **MOT-2. Durations:** press feedback 100–160ms; tooltips and small popovers
  125–200ms; dropdowns 150–250ms; dialogs and drawers 200–300ms. Exit faster
  than enter.
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
   playwright-core plus mocked API; never staging, never real citizens).
   Check:
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

- [ ] No raw colours, hex or palette classes (BAN-1, COL-1)
- [ ] Shared primitives used; no new local copies (PRIM-*)
- [ ] Loading, empty, error and success states, using the primitives (STA-1)
- [ ] Both locales complete, including aria, title, toasts and units (TXT-2)
- [ ] Logical properties only; checked in RTL and LTR (RTL-1)
- [ ] `tabular-nums`, Latin digits, shared formatters (TYP-4, PRIM-10–12)
- [ ] Destructive copy matches behaviour; confirmation on every path (DES-*)
- [ ] Double-submit guard on money and record writes (STA-4)
- [ ] Keyboard path for every drag; names on icon controls (A11Y-2, A11Y-4)
- [ ] Motion within MOT-*, honouring reduced motion
- [ ] Rendered at 360/1440, light/dark, ar/en (§16.4)
- [ ] No orphaned comments or dead code (BAN-15)

---

## 17. Known debt on `develop` (do not copy it)

These exist today. None of them is a precedent.

- Nine local stat and KPI components (PRIM-20).
- Three hand-rolled pagers.
- 56 copies of the red error banner with no shared `Alert`.
- 27 pages with a copied `loadSession` effect.
- Double frames: a DataTable inside a `CardContent p-6`.
- `getTableLabels` copied in five pages although `messages.table` exists.
- About 28 raw palette classes in 5 files (`fullscreen-map`, `unit-grid-picker`,
  `inspector-profile-detail`, `staff/page`, `security-section`).
- 15 native date inputs.
- `Sheet` without a focus trap.
- `shadow-xs`/`shadow-2xs` no-ops.
- Mixed USD spellings.
- Arabic-only toasts on `/en/`.
- `DESIGN.md` describes a different visual system.

When you touch a file listed here, leave it with less of this debt, not more.

---

## 18. Going deeper: the skills

Run these for depth, then apply them **through** this file. Where a skill's
generic advice conflicts with §0's sources of truth, the sources win.

- `impeccable`. Use `critique` and `audit` for a review, `polish` for the final
  pass, `harden` for edge cases and i18n, `clarify` for copy. Choose **Operate**
  mode for every admin surface.
- `ui-ux-pro-max`: `references/quick-reference.md` for the full accessibility,
  interaction, forms and navigation rules; `search.py "<query>" --domain ux`
  for one concern at a time, `--stack nextjs` or `--stack shadcn` for
  implementation.
- `emil-design-eng`: component polish and motion decisions. Its Before/After
  review table is the format required by §16.
- Related: `review-animations`, `responsive-design`, `dataviz` (charts).
