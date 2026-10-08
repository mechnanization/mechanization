# apps/frontend: agent guide

Last verified against the code: `feat/unit-fee-exemptions` (on `develop@f10a1b7`), 2026-10-08.

Next.js 15 app router, React 18, next-intl 4, TanStack Query 5, Tailwind 3.4 with
tailwind-merge 3, Radix and lucide-react. One app serves the staff dashboard and the
citizen portal, Arabic and RTL first. Hub: [CLAUDE.md](../../CLAUDE.md). Binding UI rules
with IDs ("UI §n" below): [docs/ui-ux-standards.md](../../docs/ui-ux-standards.md). Token values:
[DESIGN.md](../../DESIGN.md). Client security: [docs/security.md](../../docs/security.md#client-hardening).

## Structure

```text
app/layout.tsx                          RootLayout: metadata, viewport (viewportFit cover)
app/not-found.tsx, app/global-error.tsx render outside every provider (global-error bilingual by hand, not-found Arabic only)
app/[tenant]/[locale]/layout.tsx        TenantLayout (server, force-dynamic) + error.tsx
  (citizen)/                            portal: / login my-account my-file payments payments/login
  [adminPath]/login, reset-password     outside the protected layout
  [adminPath]/(protected)/layout.tsx    ProtectedAdminLayout + manifest.webmanifest/route.ts
    page.tsx (AdminIndexPage, role landing) · [...unknown] (AdminNotFound)
    dashboard account audit map zones settings staff payments
    citizens/** buildings/** cases/** fees/** inspector/profile/** quality/**
```

All 49 `page.tsx` files are `'use client'` and read `params` with `use(params)`.
`components/ui` is the kit (32 files); `components/admin` holds staff screens (feature
folders `cases/`, `damage/`, `quality/`, `settings/`, `staff/`); `components/citizen` is mostly citizen-record
form pieces used by staff screens, and only `pay-dialog` serves the portal. `lib` holds the
API client, session, hooks, formatters and offline queue; `public/sw.js` is the service worker.

## Composition roots and provider order

- `middleware.ts`: per-request CSP nonce sent on as `x-nonce`; locale redirect from the
  `NEXT_LOCALE` cookie, then Accept-Language, then `DEFAULT_LOCALE`; `/monitoring` exempt.
- `TenantLayout`: tenant config fetch (unknown tenant gives `notFound()`), `<html lang dir>`,
  `--brand-primary` through `safeHslTriple`, then `NextIntlClientProvider` > `ThemeProvider`
  > `AccentProvider`.
- `ProtectedAdminLayout`: `QueryProvider` > `TooltipProvider` > `ToastProvider` >
  `AdminShell` (registers the service worker) > `StaffRouteGuard`. `(citizen)/layout.tsx`
  mounts none of the three: `useToast` throws there, `useStaffQuery` and `ActionTooltip` fail.

## Dependency direction

`app` → `components/admin`, `components/citizen` → `components/ui` → `lib` →
`@mechanization/shared-schemas`. MUST NOT import against the arrow.

| Layer | May import | Must not import |
|---|---|---|
| `app/**` | everything below | another route's `page.tsx` |
| `components/admin`, `components/citizen` | `components/ui`, `lib`, shared-schemas, each other | `app/**` |
| `components/ui` | pure `lib` helpers (`cn`, `lib/currency.ts`, `lib/scroll-to-top.ts`), Radix, lucide, sibling primitives | feature components, `lib/api-client.ts` |
| `lib` | shared-schemas, other `lib` modules | `components/**`: a shared type moves to `lib` or shared-schemas |

Deviations ([docs/code-quality.md](../../docs/code-quality.md)): `lib/citizen-field-controls.ts`
imports the value `BUILDING_UNIT_TYPES` from `components/citizen/unit-fields`; four `lib`
modules (`citizen-draft`, `building-draft`, `residence-move`, `use-table-labels`) import
component types.

## Data fetching

- `lib/api-client.ts` `apiFetch(tenant, path, init)` calls `/t/<tenant><path>` with the
  Bearer token, rethrows `AbortError`, maps a network failure to `ApiRequestError` (status
  0, code `NETWORK_ERROR`), and on a 401 exchanges the token once (`exchangeStaffToken`,
  one flight per tenant) and replays. Endpoint functions MUST be shaped
  `fn(tenant, token, args?, signal?)` (model `getReviewQueue`), with shared-schemas types (CODE-3).
- **Reads** MUST use `useStaffQuery` (`lib/use-staff-query.ts`) with key
  `[resource, tenant, ...every param that changes the answer]`. It waits for the token,
  clears the session on a 401, and returns `{data, loading, fetching, error, refetch}`.
  `keepPrevious` for server-paged tables, `reference` for lookup lists, `refreshMs`
  for the few reads whose answer goes stale with nothing on the page to invalidate it
  (today only the staff presence read, `lib/use-staff-presence.ts`, at 60 s — the same
  minute the server's presence stamp is written on; the heavy `/staff` roster is read once).
  TanStack pauses the interval while the tab is hidden. It is not a way to make an ordinary
  table feel live; invalidating the key after a write is. A relative label («آخر ظهور»)
  needs the re-render as much as the data does, and the server's clock: the presence read
  carries `now`, and `useStaffPresence` judges «متصل الآن» against it, not the browser's clock.
- **A poll is a background request.** Anything that re-reads on a timer MUST pass
  `background: true` to `apiFetch` (it sends `x-background-request`), as `getStaffPresence`
  and the notifications bell's `getPendingPayments` do. The server skips the presence stamp
  for it; without it, an unattended open tab keeps its user «متصل الآن» all day.
- **Writes** are imperative: an `inFlight` ref and a `busy` state, `await apiFn()`, then
  `queryClient.invalidateQueries` on the key prefix (STA-3, STA-4). Model:
  `components/admin/landlord-proposal-card.tsx`.
- `lib/request-cache.ts` (`cachedRequest`, `invalidateRequests`) is a second, memory-only
  cache inside api-client (tenant config, zones, census, fee summary, settings). Legacy for
  new reads. **Undecided:** retire it for `reference: true` reads, or keep it for non-React callers.
- Deviations: 16 `(protected)` pages and 7 components (besides `AdminShell` and
  `StaffRouteGuard`) still call `loadSession` directly, most of them to fetch in effects (UI §17.1).
  The landlord-links screens invalidate `['landlord-links']`, with no tenant, so the prefix
  over-invalidates.

## Session

- `lib/session.ts`: key `mechanization.session.<tenant>`. `saveSession` uses sessionStorage,
  localStorage only for "remember me"; `updateSession` keeps the store it found (use it on
  refresh); `clearSession` clears both stores and the tab searches.
- Staff renewal is `apiFetch`'s job, never a screen's. A 401 on a staff call runs
  `exchangeStaffToken`: storage first, then, holding the `mechanization.refresh.<tenant>` Web Lock,
  a renewal another tab announced on the `mechanization.session` `BroadcastChannel`, and only then
  `POST /auth/staff/refresh` with `credentials: 'include'`. The tab that renews announces it inside
  the lock, so three tabs waking together make one exchange. Sign-in and sign-out (`loginStaff`,
  `logoutStaff`) take the same lock. A renewal that cannot be reached is
  `SESSION_REFRESH_UNAVAILABLE` (status 0, a connection problem), never a sign-out. Rules:
  [docs/security.md](../../docs/security.md#tokens-passwords-and-totp).
- Staff pages MUST use `useStaffSession(tenant, base)` (`{token, user}`, null until its
  effect runs; redirects unless `kind === 'STAFF'`) and show a skeleton while the token is
  null (CODE-1). `StaffRouteGuard` checks `canAccessPath`, which opens a path with no
  `NAV_GROUPS` row to every role (CODE-4). Citizen pages call `loadSession` directly.
- Drafts and the offline queue survive sign-out: [docs/security.md](../../docs/security.md#known-gaps).

## Copy and i18n (decision D-i18n)

- New copy MUST go in next-intl messages, `messages/ar.json` and `messages/en.json`, with
  the same keys in both (928 each today). Read it with `useTranslations`.
  `lib/messages-parity.test.ts` checks that both files hold the same keys, the same ICU
  placeholders and the same rich-text tags, and that no Arabic message outside `errors`
  writes a count as `#`: inside a plural branch write `{count}`, because `#` is formatted
  with the page's locale and plain `ar` prints Arabic-Indic digits on some engines.
- A plain module that needs copy (no React context: a formatter, a table-cell helper) builds
  a translator over its own slice of the message files with `createTranslator` and
  `FORMAT_LOCALE` (`ar-u-nu-latn`, Latin digits) from `lib/api-errors.ts`, as `api-errors.ts`,
  `fee-assessment.ts`, `owner-billing.ts` and `audit-describe.ts` do. Plain labels with no placeholders are a lookup
  (`audit-labels.ts` reads `auditActions` and `auditEntities`).
- Enum and status labels MUST come from `getLabels(locale)` (shared-schemas).
- Legacy, convert when you touch a file: inline `en ? '…' : '…'` (about 117 files; 62 declare
  `const en = locale === 'en'`), `lib/settings-i18n.ts` `settingsCopy`, and `labelEn` in
  `components/admin/nav.ts`. The 13 `messages.nav` keys are never read.
- `i18n/routing.ts` `defaultLocale` is `'en'` while `middleware.ts` `DEFAULT_LOCALE` is
  `'ar'`: [docs/gotchas.md](../../docs/gotchas.md).

## Errors (decision D-errors)

- Rule (UI TXT-6): the words for an API refusal live in `messages/{ar,en}.json` under `errors`,
  keyed by the code from `ERROR_CODES` (`packages/shared-schemas`). `ApiRequestError` builds its
  `message` through `localizeApiError` (`lib/api-errors.ts`) in the page's language, so a screen shows
  `error.message` and nothing else. The server's own text is shown only for a refusal with no code yet,
  a code this build does not know, or params that do not fit.
- Branch on `error.kind` (`CONFLICT`, `VALIDATION_FAILED`, …) for the class and `error.code` for one
  case, never on the message. Offline is `status === 0`, never a string match. The older
  `details.code` / `details.reason` values (`STALE_PREVIEW`, `FIGURE_CHANGED`, `NOT_OPEN`, …) are still
  sent, and `merge-citizens-dialog.tsx` and the `fees/corrections` page read them.
- Adding a code: [apps/backend/CLAUDE.md](../backend/CLAUDE.md#error-codes). Its `errors.<CODE>` entry
  is ICU (`{amount, number}`, plural, select); `lib/api-errors.test.ts` checks both files have it with
  the same placeholders.
- Today: refusals the API has not converted (see the backend guide) still show its Arabic text on
  `/en/`. `ErrorState` detects offline by searching its description for «تعذّر الاتصال».
  `duplicateBuildingsOf`, `duplicateUnitsOf`, `staleEditOf`, `duplicateReviewOf` and
  `unitCorrectionRefusal` narrow on `kind` and details; copy that shape.

## Offline

- `lib/offline-db.ts`: IndexedDB `mechanization.offline` (`DB_VERSION = 2`), stores
  `citizenSubmissions` and `buildingSubmissions`, keyed by `id`, a `clientSubmissionId` from
  `newSubmissionId` (`lib/offline-sync.ts`) that the server's unique index deduplicates. `lib/offline-sync.ts` runs one engine per tenant (`queueSubmission`,
  `queueBuilding`, `syncQueue`, `retrySubmission`, `useOfflineQueue`, …).
- `public/sw.js`: `VERSION` is bumped by hand; GET only, never `/api/`, never localhost;
  network-first navigations with `/offline.html`. `useServiceWorker` registers it (staff
  side) and unregisters it in development.
- Drafts: `lib/citizen-draft.ts` (localStorage), `lib/building-draft.ts` (sessionStorage).
- A session that cannot write the register (`CITIZEN_RECORD_EDIT_ROLES`: «مشاهد فقط», an
  auditor, the accountant, on a device an officer queued records on) never drains:
  `syncQueue` reports `writerRequired` and leaves every record as it was, and a 403 leaves a
  record pending, because the refusal is the session's, not the record's. The queue panels
  (`OfflineQueuePanel`, `BuildingQueueNotice`, prop `canSend`) list the records for such a
  session and offer nothing that sends, edits, retries, discards or acknowledges them.

## URL and list state

`lib/use-url-state.ts` with `param.*` from `lib/url-state.ts`: `useUrlState` (schema at
module scope), `useUrlPagination`, `PAGE_SIZE_OPTIONS`. The search term lives in tab
sessionStorage through `useTabSearch`, never in the URL.

## Recipe: add a staff screen

Model: `app/[tenant]/[locale]/[adminPath]/(protected)/citizens/review/page.tsx` `ReviewQueuePage`.

1. **API function** in `lib/api-client.ts` beside its feature, shaped like `getReviewQueue`.
2. **Route** `app/[tenant]/[locale]/[adminPath]/(protected)/<section>/page.tsx`: `'use client'`,
   `use(params)`, `base = /<tenant>/<locale>/<adminPath>`.
3. **Roles**: a `NAV_GROUPS` row with `roles` from the same shared set as the controller's
   `@Roles` (`role-sets.ts` in shared-schemas); gate controls with an allow-list in
   `lib/staff-roles.ts` and `hasRole`. Never a deny-list: the next read-only role, or an
   undefined role on first paint, would get the write controls. A write page that a role
   can reach by its address sends a role that cannot write back to the read page, as
   `case-editor`, `building-editor` and the settle page do, and a component that offers an
   action takes the permission as a required prop (`canSend`, `canAnswer`, `canOpen`)
   rather than a default that fails open.
4. **Messages**: a namespace in both message files, including `aria-label`, `title`,
   toasts, units and error texts (TXT-2).
5. **Read**: `useStaffSession`, then `useStaffQuery`; list state from `useUrlPagination`,
   `useTabSearch`, `useUrlState`.
6. **Layout**: root `w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8`, `PageHeader` (`BackLink`
   first on a detail page), `Card` > `CardContent className="p-0"` > borderless `DataTable`
   (`manualPagination manualFiltering sortable={false}`, `loading`, `error`, `onRetry`,
   labels from `useTableLabels`) (LAY-1, BAN-4, PRIM-3).
7. **Panels and cells**: `LoadingState`, `EmptyState`, `ErrorState`; `CellTag`, `Money`,
   `formatDate` and friends, `formatPhone` (PRIM-5 to PRIM-12).
8. **Writes**: in-flight ref, `invalidateQueries`, `useToast`; destructive actions through
   `ConfirmDialog`; `closeLabel` on every `DialogContent` (STA-3, STA-4, PRIM-16).
9. **Split** into `components/admin/<feature>/*` past about 600 lines (CODE-6, model `cases/`).
10. **Test** pure logic as `lib/<name>.ts` plus `lib/<name>.test.ts`; run the UI §16 pre-merge checklist.

## Environment variables

Names only. Nothing validates them; there is no frontend env schema. `NEXT_PUBLIC_*` values
are inlined at build time. The local `.env.local` block is in
[docs/database-environments.md](../../docs/database-environments.md).

| Name | Read in |
|---|---|
| `NEXT_PUBLIC_API_URL` | 10 files, each with its own fallback (`'http://localhost:4000/api/v1'`, except `'http://localhost:3001'` in `fullscreen-map.tsx` and `zone-editor-map.tsx`): `lib/api-client.ts`, `middleware.ts`, three layouts, the manifest route, dashboard, three map components (debt: [docs/code-quality.md](../../docs/code-quality.md)) |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | `fullscreen-map.tsx`, `parcel-pin-picker.tsx`, `zone-editor-map.tsx` |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_VERCEL_ENV`, `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | `lib/sentry-options.ts` |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `CI`, `VERCEL`, `NEXT_DIST_DIR` | `next.config.mjs`, build time |

## Commands

| Purpose | Command |
|---|---|
| Dev server, port 3000 (root `pnpm dev` checks the env first) | `pnpm --filter @mechanization/frontend dev` |
| Typecheck | `pnpm --filter @mechanization/frontend typecheck` |
| Lint, as CI runs it (whether `next lint` reads the flat config is **Unverified**) | `pnpm lint` |
| Unit tests, watch mode | `pnpm --filter @mechanization/frontend test`, `pnpm --filter @mechanization/frontend test:watch` |
| Production build that leaves the dev server's `.next` alone | `pnpm build:check` |
| First, after a shared-schemas change (the app reads its `dist/`) | `pnpm --filter @mechanization/shared-schemas build` |

## Tests

Vitest (`apps/frontend/vitest.config.mts`): `environment: 'node'`, only `lib/**/*.test.ts`,
with `vitest.setup.ts` stubbing `navigator.onLine` and `window`. 18 files, 253 cases.
No component, accessibility or end-to-end tests exist (no jsdom, no Testing Library); a
rendered check uses the uncommitted headless harness of UI §16.4. Untested, so add a test
when you touch them: `lib/sentry-redaction.ts`, `lib/session.ts`, `lib/csv.ts` `csvCell`,
`lib/currency.ts`, `canAccessPath`.

## Current state and known issues

- UI debt with counts and files, including the contrast failures:
  [docs/ui-ux-standards.md](../../docs/ui-ux-standards.md) §17.
- Code debt (40 `.tsx` files over 600 lines, `lib/api-client.ts` at 5,782 lines, dead
  modules, the tenant config fetched three times, UTC "today"): [docs/code-quality.md](../../docs/code-quality.md).
- Traps (tailwind-merge 3 on Tailwind 3, the two default locales, missing providers on the
  citizen side, null token on first paint, `sw.js` `VERSION`, the CSP nonce, `[adminPath]` is not a control):
  [docs/gotchas.md](../../docs/gotchas.md).
- Client security gaps (offline PII in plaintext that survives sign-out):
  [docs/security.md](../../docs/security.md#known-gaps).
