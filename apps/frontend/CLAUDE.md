# apps/frontend: agent guide

Last verified against the code: `fix/pr114-review` (PR #114 merged with `develop@5e8f5c3`, with its review fixes: citizen pickers, the building editor's held creation key and drafts, the offline queue's revised, held and refused records), 2026-10-14.

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
    (staff: «صرف راتب / أجر» per active row, `components/admin/staff/staff-salary-dialog.tsx`, TREASURY_WORK_ROLES;
      the manager's payout is the order, anyone else's is said before and after to await it, D7;
      «صرف عمولة» per inspector row, `components/admin/inspector-payout-dialog.tsx`, SUPER_ADMIN — it reads the inspector's profile)
    (settings › المالية: «سقف الدفع العاجل», one per currency, empty for none, `finance-section.tsx`;
      a save sends a ceiling only when its field changed, `ceilingChange` in lib/urgent-ceiling.ts)
    finance (الخزينة; the manager's «إضافة حساب», `components/admin/finance/add-account-dialog.tsx`) · finance/accounts/[accountId] (كشف حساب: prints through `data-print-root`;
      until stage 5 the one-day print was the daily register, now finance/daily/report;
      SUPER_ADMIN cancels a handover from its row, «إلغاء التسليم»,
      components/admin/finance/void-transfer-dialog.tsx, `mayVoidTransfer` in lib/treasury-statement.ts)
    finance/expenses (النفقات: the register is server-paged, filtered by band, wallet, status and
      from/to day, every filter, the view and the page in the URL; ?view=queue — «بانتظار أمر الصرف»:
      requests and urgent payments waiting on the manager's order,
      components/admin/finance/expense-queue.tsx, expense-dialogs.tsx)
    finance/expenses/new (تسجيل نفقة: the manager records and orders; an accountant sends a
      request, or pays urgently under art. 35 — lib/expense-order.ts decides the mode; the urgent
      path shows the wallet currency's ceiling and refuses above it with «أرسلها طلباً», except
      for the retry of a press whose answer was lost)
    finance/expenses/[voucherId]/print (أمر الصرف — A4 portrait; `?print=1` opens the print dialog once)
    finance/income (الإيرادات) · finance/income/new (تسجيل إيراد جديد)
    finance/income/[voucherId]/print (سند القبض — A4 portrait, QR of the number; `?print=1`)
    finance/income/categories (بنود الإيرادات — every reader sees the list, the manager edits it)
    finance/transfers (المناقلات والمصارفة — the register, the review queue; review on TREASURY_REVIEW_ROLES;
      drawn through `readView`, a failed re-read is a `RefreshFailedAlert`)
    finance/transfers/new (تحويل داخلي or مصارفة, `record-transfer-form.tsx`, sticky summary; the key
      is held under `transfer:new` and follows `keyIsSpent`, the form stays locked after a 2xx, a
      replay is announced as already recorded, and while the key is in doubt the shortage and the
      rate-reason checks warn instead of refusing; the page keeps the form on a failed re-read)
    finance/transfers/[transferId]/print (سند المناقلة — A4 portrait, `transfer-document.tsx`; `?print=1`;
      `readView`, as every print page)
    finance/collectors (الجباة والتحصيل — عهدة الجباة and «استلام الصندوق»; its nav row is under
     «الرسوم والجباية» since 2026-10-10, when transfers made «الخزينة» six rows)
    finance/collectors/[collectorId] (ما حصّله الجابي)
    finance/daily (جرد وإقفال اليومية — the count, the close, the manager's reopen; `?date=`;
      the close sends the counts its dialog listed, `closeRequest` in lib/daily-count.ts; a save
      clears only the boxes it carried, `draftsAfterSave`; a lost close answer re-reads that day)
    finance/daily/report (تقرير الصندوق اليومي — printed A4 landscape by its own print rules; `?date=`)
    (the four printed documents — the daily report, «أمر الصرف», «سند القبض» and «سند المناقلة»
     (`transfer-document.tsx`) — share `components/admin/finance/official-document.tsx`: the
     letterhead and crest from الإعدادات, the signature lines, `documentPrintCss`, `useAutoPrint`)
    my-round (جولتي — the collector's own pocket, phone-first, WORKING_STAFF_ROLES)

`CitizenProfilePayment.invoiceNumber` carries «INV-2610-0001» and is what
`payment-receipt.tsx` prints as the bill's reference. It is null on every bill
raised before migration 0079, and those keep printing the reference derived from
the id — `billReference` is where that choice lives.

A receipt is printed with `recorded` (a `RecordedMovement`: the RCP number, its moment and the
amounts the server returned) wherever a movement is known: the citizen payment page, the
counter settle page and «جولتي». Without it `PaymentReceipt` falls back to the bill's reference
and today's date, which is a different document from the one the citizen was handed.
    citizens/** buildings/** cases/** fees/** (incl. fees/new — إصدار رسم جديد)
    fees/settlements/[settlementId] (وصل قبض بلدي مجمّع — the consolidated receipt of a bulk settlement,
      `GET fees/settlements/:id`; opened right after «تسديد الفواتير المحددة», and a reload reprints)
    (citizens/[citizenId]/payments/[paymentId]: the counter's cash page, and below it «وصولات الفاتورة»,
      every movement on the bill, with «عكس الوصل» and its required reason for PAYMENT_REVERSE_ROLES,
      components/admin/finance/bill-receipts.tsx, reverse-receipt-dialog.tsx, `mayReverseReceipt` in lib/bill-receipts.ts;
      reached from the bill's row on the citizen file — «تسجيل دفعة نقدية» while it is owed, «وصولات الفاتورة»
      once it is paid, `billPageLink`; no reversal offered while the citizen's reported transfer waits for a
      clerk, `claimUnderReview` (the page passes the bill's status; the server's refusal is PR #120's); the
      dialog carries no retry key, answers TRANSACTION_ALREADY_REVERSED as done, and judges a press the
      server did not confirm only by a re-read that answered, `reversalFailure`, `receiptsReadAgain` — see
      Writes below; lib/bill-receipts-screens.test.ts parses both pages for the link and the mount)
    inspector/profile/** quality/**
    (inspector/profile/[staffId]/payouts: «المتبقي بعدها» per payout is earned-by-then less paid-by-then,
      `payoutHistory` in lib/inspector-payouts.ts: a payout whose voucher was cancelled listed and not counted
      as paid, a figure-only payout judged by its municipal day and its row's `createdAt`, a voucher payout at
      its moment, summed in the order the money moved (`byWhenPaid`: day, then a voucher's moment or a
      figure's `createdAt` — never `paidAt` alone, which a day's figures share); recomputed from today's
      records, which the note under the table says; «مدفوع بالزيادة» when overpaid; the figures through
      `StatStrip` and `Money`, the copy in `staff.commission.history`)
```

A bill can be part-paid, so a screen that tells someone what to pay reads the server's
`remaining` and `paidAmount`, never `amount` alone. The portal's payments page, its pay dialog
and «ملفّي» read them through `lib/citizen-payments.ts`, the per-bill rule's one home
(`billFigure`, `isPartlyPaid`, `isSettled`, and `partlyPaidFigures` for the `citizen.partlyPaid`
message, which writes «LBP» on an English page); the staff bell shows a claim's `remaining`, which
is what confirming it credits. So are the totals: the payments page, «ملفّي» and «حسابي» sum
`citizenPaymentTotals`, the payments page's rule on `develop`. A bill whose reported transfer waits
for a clerk is listed with its status and left out of what is owed. The summary's own
`outstandingTotal` counts it, and the two pages that showed it told one citizen two totals while a
transfer waited (docs/finance.md §14, review of PR #113).

«تسديد الفواتير المحددة» (docs/finance.md §3.7) is selection on two existing lists — the `/fees`
table (a checkbox column; the box beside the name on phone cards) and the citizen file's
`FeesPanel` (its state and the bar at the page root, since the section clips a sticky child) —
for `BULK_SETTLE_ROLES` only, beside each row's own «تسجيل دفعة» and «الوصل», which stay.
Pieces in `components/admin/bulk-settle/` (`bill-checkbox`, `bulk-settle-bar` — the sticky bar,
`bulk-settle-dialog`, `bulk-bills-table`, `money-list`, `bulk-payment-receipt`); the rules in
`lib/bulk-settle.ts` (which bills can be ticked, one citizen, at most 50, select-all, due per
currency, the retry-key scope, the parcel/unit wording) and the selection in
`lib/use-bulk-selection.ts` (`useBulkSelection(tenant)`). A re-read of the list drops a ticked bill paid or
sent for review since, **except** while the set is held (`selectionHeld`: a press of it is on the
wire, `beginPress`/`endPress`, or its key is in doubt): the set is the key's scope, and dropping the
bills a lost press paid emptied the set, unmounted the dialog with its bar and orphaned the key whose
retry returns the consolidated receipt (review of PR #112). The dialog sends `expectedDue`, the sums it
shows, and re-reads the list on `BULK_SETTLE_SOME_ALREADY_PAID`, `BULK_SETTLE_BILL_PENDING_REVIEW` and
`BULK_SETTLE_DUE_CHANGED`. The dialog's live «الباقي للمواطن» is `planBulkSettlement` from the
shared package, the function the server runs under lock; it refuses submit when the plan refuses the
notes or the main cash safe in the base currency plus the ليرة handed in cannot cover the change —
each a warning only while the key is in doubt (`previewGate` in `lib/bulk-settle.ts`): an official
rate moved or cleared after a lost press made the same notes «short», and refusing then blocked the
retry the server answers from the key, in words that said nothing was recorded (review of 2026-10-11).
`BULK_SETTLE_REQUEST_REUSED` names the «BRC-» the key recorded (`params.number`). The WhatsApp text is
`lib/bulk-receipt-message.ts`, which never carries a رقم مرجعي (its test feeds one in); the button is
`RECEIPT_SEND_ROLES`.

All 69 `page.tsx` files are `'use client'` and read `params` with `use(params)` (counted 2026-10-10, after PR #106 added `finance/daily` and `finance/daily/report` and PR #112 `fees/settlements/[settlementId]`).
`components/ui` is the kit (33 files, `alert.tsx` added 2026-10-06); `components/admin` holds staff screens (feature
folders `bulk-settle/`, `cases/`, `damage/`, `finance/`, `quality/`, `settings/`, `staff/`); `components/citizen` is mostly citizen-record
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
  table feel live; invalidating the key after a write is.
  - **A failed re-read keeps the page.** TanStack keeps the last data when a background
    re-read fails, and `error` comes back beside it. Show `ErrorState` only when nothing has
    loaded (`error && !data`); with data on screen, keep it and show `RefreshFailedAlert`
    (`components/admin/refresh-failed-alert.tsx`) above it, with a retry. `readView(data, error)`
    (`lib/read-view.ts`) makes that choice once; the day-closing pages, the print pages, «وصولات
    الفاتورة» (which keeps the reversal dialog open on a failed re-read) and the
    commission payout dialog's hosts (the payout history, the inspector's dashboard, the earnings
    roster; `lib/payout-hosts.test.ts` reads every host) use it. Replacing the page unmounted
    whatever was open on it: a failed treasury re-read after an in-doubt handover unmounted the
    custody panel and its key, and the retry recorded the handover twice; a failed re-read of the
    inspector's profile after an in-doubt payout unmounted the dialog with what was typed in it. A relative label («آخر ظهور»)
  needs the re-render as much as the data does, and the server's clock: the presence read
  carries `now`, and `useStaffPresence` judges «متصل الآن» against it, not the browser's clock.
- **A poll is a background request.** Anything that re-reads on a timer MUST pass
  `background: true` to `apiFetch` (it sends `x-background-request`), as `getStaffPresence`
  and the notifications bell's `getPendingPayments` do. The server skips the presence stamp
  for it; without it, an unattended open tab keeps its user «متصل الآن» all day.
- **Writes** are imperative: an `inFlight` ref and a `busy` state, `await apiFn()`, then
  `queryClient.invalidateQueries` on the key prefix (STA-3, STA-4). Model:
  `components/admin/landlord-proposal-card.tsx`.
  - A write that moves money carries a `clientRequestId` held in `lib/request-id.ts`
    (`heldKey(tenant, scope)`, `spendKey`): module state, so the key outlives every unmount of
    the form for the life of the tab. Scopes — `KeyScope`, ten of them: `building:<parcel>` (a new
    building, whose key is its id; the building editor), `bulk-settle:<ids>` (the
    selected bills' ids, sorted; `bulkKeyScope`), `commission:<staffId>` (one per inspector paid;
    `commissionScope` in `lib/commission-payout.ts`; sent before go-live too, by `payoutRequest`,
    since the payout row keeps it, `0089`), `custody:<accountId>`, `expense:pay`,
    `expense:request`, `income:new`, `salary:<staffId>` (one per person paid),
    `settle:<paymentId>` (the settle page and the citizen cash page settle the same bill and
    share it), `transfer:new`. The key belongs to one act: it is minted when a screen first asks
    for it and kept across **every** failure (any 4xx, 401, 403, 408 and
    429 included, status 0, 5xx) and every edit, because a refusal proves only that this attempt
    wrote nothing, never that an earlier one with the key did not. The server binds a key to its
    act (an expense: wallet, amount, clerk, band, payee, reason; a salary: also the staff
    account; an income voucher: wallet, amount, clerk, category, description, payer; a handover:
    custody wallet, amount, clerk; a counter payment: the bill), so an edit after a lost answer is refused with
    `TREASURY_REQUEST_KEY_REUSED` instead of recorded twice. The key is spent (`spendKey`) only
    when the server confirms its act exists: a 2xx, or one of the refusals `keyIsSpent` names —
    `ACT_RECORDED`, the one list: `TREASURY_REQUEST_KEY_REUSED`, `EXPENSE_ALREADY_VOID`,
    `INCOME_ALREADY_VOID`, `TRANSFER_ALREADY_VOID`, `TRANSACTION_ALREADY_REVERSED`,
    `PAYMENT_IDEMPOTENCY_KEY_REUSED`, `BULK_SETTLE_REQUEST_REUSED`; the commission payout dialog
    also spends on `INSPECTOR_PAYOUT_REQUEST_REUSED` (`payoutKeyAfterFailure`) — after which the
    treasury queries are re-read. The expense, income and salary forms also
    re-read them after a failure `outcomeInDoubt` names, keeping the key. A reversed earlier receipt is said as such on the settle and cash pages. No form
    renews a key in an effect on its fields. Regenerating it in a `catch` is how a dropped
    connection paid twice ([gotchas](../../docs/gotchas.md)).
  - A failure `outcomeInDoubt` names also marks the held key in doubt (`markInDoubt`;
    `heldInDoubt` reads it, `spendKey` clears it; module state like the key, so a reopened dialog
    still knows). While it is marked, a check made before the request is a warning, never a
    refusal: the salary dialog's «الرصيد لا يكفي» keeps the button live and says to press again
    unchanged, and the expense form's urgent ceiling neither refuses nor offers «أرسلها طلباً»
    until the server itself refuses the retry. The re-read balance may already carry the lost
    act, the server answers a replay before it judges the balance or the ceiling, and the old way
    out (another wallet, a request) was a new act under a new key.
  - The bulk-settle dialog holds its key under `bulk-settle:<the selected ids, sorted>`, so the same
    selection retries the same act and another selection is a new one; `BULK_SETTLE_REQUEST_REUSED`
    is among the refusals that spend a key. On a 2xx it writes the server's answer into
    `['fees-settlement', tenant, id]` and moves to the receipt page, which opens on it without a
    fetch (STA-6); the page reads the letterhead's names through `['tenant-config', tenant]`.
  - A reopened handover dialog therefore retries the same act. After a failure `outcomeInDoubt` names (status 0, 408, 429, 5xx) it re-reads
    `['treasury', tenant]`, so the reopened dialog prefills what the collector holds now.
  - «عكس الوصل» moves money and carries no key, by design: the receipt's id is the act's key.
    The server reverses a receipt once (asked under the bill's lock, with the unique index on
    `reversalOfId` behind it) and its body takes no key (`reverseTransactionSchema`), so a press
    repeated after a lost answer is refused with `TRANSACTION_ALREADY_REVERSED` and never recorded
    twice. The dialog answers that refusal as done — a warning that the receipt was already
    reversed, the dialog closed — never as a failure. A press the server did not confirm
    (`outcomeInDoubt`) is judged with the receipts read again, and only if that read answered
    after the press: after `invalidateQueries` TanStack keeps the list from before the press when
    the re-read fails or waits for a connection, so `getQueryData` alone is not a re-read
    (`receiptsReadAgain` checks `getQueryState`). Shown reversed, the press went through; not
    shown, the dialog stays open and says to press again; not read, it says so (`reversalFailure`
    in `lib/bill-receipts.ts`, one outcome per wording).
  - A 2xx with `replayed: true` answers a retry with the act an earlier attempt recorded. The
    screen says so — the document number, and that the first attempt's details stand — with a
    warning toast, never the fresh-success one (expense form, request, income form, salary
    dialog, handover, order, settle and cash pages). A counter payment's replay can carry another amount than the form shows;
    the receipt prints the server's.
  - After a 2xx the form stays locked — the in-flight ref is never released, the button stays
    off — until the page moves on or the form is reset for a new act: a page stays mounted until
    the next route is ready (`fees/new`, the expense form). The settle page reads the citizen's
    file for the receipt *after* `settlePayment` resolves, in its own `try`: a failed read shows
    «سُجّلت الدفعة — إيصال RCP-…، وتعذّر تحميل الوصل الكامل» with a retry of that read only.
  - A money write invalidates `['treasury', tenant]` as well as its own keys, because a payment
    moves a wallet. The expense form leaves the band list (`expense-categories`) out of that
    while its select is open, and `NewCategoryFields` writes a new band into the cached list
    (`setQueryData`): a reference read is never re-read by itself, and refetching it under an
    open Radix select empties the selection. The income form does the same with
    `income-categories`: `IncomeCategoryEditor` writes what it saves into both cached lists
    (`['treasury', tenant, 'income-categories']` and `[…, 'all']`) through
    `withSavedCategory` (`lib/category-cache.ts`).
- **One citizen picker.** A screen that chooses a citizen's file uses `CitizenPicker`
  (`components/admin/citizen-picker.tsx`): «تكليف مباشر», «إصدار رسم جديد», a sale's new owner
  (`BuyerPicker`), a case's people (`LinkCaseCitizenDialog`, which keeps `value` null and adds each
  pick), and the other half of a merge. It is controlled (`value: PickedCitizen | null`, `onChange`);
  the chosen file shows as a card with «تغيير». A row shows the name, the mother's name and the رقم
  مرجعي; never the document number or the phone. Never write another one: a screen with a flow of its
  own around the results uses the same search, `useCitizenSearch` («إضافة شخص إلى الوحدة» in
  `AddPersonForm`, whose «ليس بينهم؟» opens a new file). The command palette is a navigation search,
  not a picker, and keeps its own (code-quality.md).
- `useCitizenSearch` (`lib/use-citizen-search.ts`) searches the register on the server as the clerk
  types: `SEARCH_DEBOUNCE_MS` 350 ms, an `AbortController`, `limit: 8`. Files folded by «دمج ملفين» are
  never offered, archived files only where the screen asks (`includeArchived`: the census and
  ownership screens, where they are shown marked «مؤرشف» and not taken — the row says to restore the
  file first, so the person is not filed twice, and the server refuses a new filing on an archived
  file, `CITIZEN_FILE_ARCHIVED`, #115; never a fee, `FEE_CITIZEN_ARCHIVED`), and `exclude` drops the files a screen may not offer
  (the seller, the file being merged into, the people already listed). The server has no filter for
  either, so `more` says when the register holds more matches than are listed. The last term's
  matches are emptied the moment another is typed, so nothing stale is there to click. A failed search
  is told apart from «no match» (`failed`, with the API's own words in `error`) and can be retried
  (`retry`). `CitizenSearchStatus` under the field keeps one `role="status"` line mounted and draws a
  failure as a warning `Alert` with «إعادة المحاولة». Never a `listCitizens({ limit: 200 })` filtered in
  the browser: a file filed after that page cannot be found (the direct-charge dialog and «إصدار رسم
  جديد» did that until 2026-10-11).
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
  the same keys in both (2,497 leaf keys each, counted 2026-10-13 on `fix/pr113-review` with both reviews' fixes). Read it with `useTranslations`.
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
- Legacy, convert when you touch a file: inline `en ? '…' : '…'` (129 `.ts`/`.tsx` files under
  `apps/frontend` branch on the locale inline — `en ?`, `locale === 'en' ?` or `isAr ?` — 118 of
  them under `app/` and `components/`, the rest in `lib/`; 62 files declare
  `const en = locale === 'en'`; counted by grep 2026-10-13, one file fewer than `develop`'s 130
  since the payout history moved to messages), `lib/settings-i18n.ts` `settingsCopy`, and
  `labelEn` in `components/admin/nav.ts`. The 13 `messages.nav` keys are never read.
- `i18n/routing.ts` `defaultLocale` is `'en'` while `middleware.ts` `DEFAULT_LOCALE` is
  `'ar'`: [docs/gotchas.md](../../docs/gotchas.md).

## Errors (decision D-errors)

- Rule (UI TXT-6): the words for an API refusal live in `messages/{ar,en}.json` under `errors`,
  keyed by the code from `ERROR_CODES` (`packages/shared-schemas`). `ApiRequestError` builds its
  `message` through `localizeApiError` (`lib/api-errors.ts`) in the page's language, so a screen shows
  `error.message` and nothing else. The server's own text is shown only for a refusal with no code yet,
  a code this build does not know, or params that do not fit. A param that is a calendar day
  (`YYYY-MM-DD`: a closed day, a go-live day) is written through `formatDay` first, so a refusal reads
  09/10/2026 like the page around it (PRIM-12).
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
  `queueBuilding`, `syncQueue`, `retrySubmission`, `retryBuilding`, `discardBuilding`, `useOfflineQueue`, …).
- The building editor sends a creation's `clientSubmissionId` (also the building's id) from a held key,
  one per parcel (`heldKey(tenant, 'building:<parcel>')`, `lib/request-id.ts`), so the key outlives a
  remount the draft survives. The key policy is every retry key's (`keyIsSpent`): kept across every
  failure, marked in doubt after a lost answer, spent once the building is on file or handed to the
  queue. An offline save is queued under the same id, flagged `afterLostAnswer` when it is in doubt. An
  `inFlight` ref guards the save, and after one that landed the form stays locked while the page moves
  on. A `deduplicated` answer is said as such (`buildingEditor.deduplicated`).
- A queued registration is marked `inDoubt` once a send under its id may have landed unanswered (no
  answer, a 408, a 5xx; not a 429) or it was queued by an online save that fell back under its own id.
  A revision made after that carries `revisedAt` (`withRevision`), and only then. Answered `deduplicated`,
  such a record is kept, `blocked`, with the `citizenId` it reached, never dequeued: the file may hold
  the record as it stood before the revision. `OfflineQueuePanel` then offers «فتح الملف»,
  «عرض التعديلات» (the editor shows the copy and sends nothing) and «حذف», and no «إعادة المحاولة»,
  which could only replay it. These fields are optional and unindexed, so `DB_VERSION` did not change.
- A registration that names a building still queued on the device (pending, or refused before its
  shell landed) is not sent: it waits, saying which building, and goes out once that building lands
  (`namesQueuedBuilding` in `syncQueue`). A building whose shell landed and only its flats were refused
  carries `deliveredCode` and holds nobody back.
- A refused queued building is retried or discarded from `BuildingQueueNotice`; the discard
  confirmation names it, says whether it reached the register, and counts the registrations that name
  it or its flats (`registrationsOnBuilding`); `discardBuilding` blocks those, saying why. A building
  queued after a lost answer and found on file is kept as a notice (`deduplicated`). No screen edits a
  queued building's payload.
- `public/sw.js`: `VERSION` is bumped by hand; GET only, never `/api/`, never localhost;
  network-first navigations with `/offline.html`. `useServiceWorker` registers it (staff
  side) and unregisters it in development.
- Drafts: `lib/citizen-draft.ts` (localStorage), `lib/building-draft.ts` (sessionStorage). A building
  draft of an edit is written only once it differs from the building as loaded (`editDraftFingerprint`),
  stores `baseUpdatedAt`, the version its edits were made against, and is restored silently only while
  the server holds that version (`draftIsCurrent`). Otherwise the editor keeps the draft on screen,
  disables «حفظ», and asks: the latest version (read again, the draft deleted), or the draft saved over
  it (flats removed since are drawn again as new, so the save is what is on screen).
- A session that cannot write the register (`CITIZEN_RECORD_EDIT_ROLES`: «مشاهد فقط», an
  auditor, the accountant, on a device an officer queued records on) never drains:
  `syncQueue` reports `writerRequired` and leaves every record as it was, and a 403 leaves a
  record pending, because the refusal is the session's, not the record's. The queue panels
  (`OfflineQueuePanel`, `BuildingQueueNotice`, prop `canSend`) list the records for such a
  session and offer nothing that sends, edits, retries, discards or acknowledges them.

## URL and list state

`lib/use-url-state.ts` with `param.*` from `lib/url-state.ts`: `useUrlState` (schema at
module scope), `useUrlPagination`, `PAGE_SIZE_OPTIONS`. The search term lives in tab
sessionStorage through `useTabSearch`, never in the URL. Two views on one page that each
page their own table (the expense register and its queue) share `?page=` / `?limit=`, so a
view switch clears the other view's parameters in the same write. A list whose rows leave it as they
are acted on steps back to the last page with rows once its answer is in (`pageWithRows` in
`lib/url-state.ts`; «مراجعة السجلات», which pages its cards with `Pager`).

## Printing

A page prints one region of itself by marking it `data-print-root` (`app/globals.css`): on
paper everything outside it leaves the flow, the shell's one-viewport frame is released so a
long table runs over several sheets, the region prints black on white whatever the theme, and
it takes the named page `register` (A4 portrait). Print-only parts inside it use `hidden
print:block` (the statement's heading and its signature lines); controls inside it use
`print:hidden`. One print root per page. The receipt keeps its own rules
(`#receipt-print-area`, A5 landscape), and is let out of its dialog the same way — the dialog
is fixed and one screen tall, and printed as it was it repeated the receipt's top strip on every
sheet. It prints on **one** sheet: `fitReceiptToSheet` (`components/admin/payment-receipt.tsx`)
measures the receipt in hand on `beforeprint` and on «طباعة الوصل» and sets
`--receipt-print-zoom`, which the print rule applies as `zoom` with a width of the sheet divided
by it (fallback 0.68). A field that truncates on screen wraps on paper. A receipt built from a recorded movement (`RecordedMovement`) prints that movement's
`method` and no review note.

The consolidated receipt (`bulk-settle/bulk-payment-receipt.tsx`, on `fees/settlements/[settlementId]`)
is a document page like the statement: one `data-print-root`, A4 portrait, drawn in the theme's tokens
on screen and black on white on paper. Its heading is `ReceiptLetterhead`, exported from
`payment-receipt.tsx` and shared with the single receipt; it takes `currentColor`, which the single
receipt's `#receipt-print-area` sets to black. `renderReceiptPdf` (`lib/receipt-pdf.ts`) takes
`{ orientation, breakBefore }`: portrait, and a capture taller than one sheet cut between `tr` rows over
several; the default stays the single receipt's one A4 landscape sheet. Every capture is taken in the
light theme (`onclone` drops `dark` from the copy, never from the page).

## Citizen record kinds

A file is a household, «غير مقيم في البلدة», «تركة (ورثة المرحوم)» or «جهة أو وقف» (`0076`).
`ResidenceChooser` in `citizen-form.tsx` asks it in two steps («صاحب الملف»: a person, or an
estate or a body; then which), and each kind has its own first two steps
(`PersonalStep`/`ContactStep`, `OwnerPersonalStep`/`OwnerContactStep`,
`NonPersonPersonalStep`/`NonPersonContactStep`). Branch on `isOwnerRecord` / `isNonPersonRecord`
from shared-schemas, not on one value. `withResidence` joins or splits an institution's one-line
name (`namesForKind` in `lib/residence-move.ts`); it and `withSeededSearch` (which takes the kind
the form opens as) live in `lib/citizen-seed.ts`, re-exported by `citizen-form.tsx`. A card
never sends a shown owner name: `landlordNameToSend` (`lib/citizen-field-edit.ts`) strips
«ورثة المرحوم», and `landlordLink.displayName` is what the locked field shows; `PropertyCard` takes `recordKind` (an estate
offers «مالك» only); `RecordKindBadge` marks the kind beside a name. On a saved file a death
(person → estate) goes through `ResidenceChangeDialog`, like a move; switching to or from an
institution is a correction. «المستحق على عقار» is `fees/parcel`.

## Recipe: add a staff screen

Model: `app/[tenant]/[locale]/[adminPath]/(protected)/citizens/review/page.tsx` `ReviewQueuePage`.

1. **API function** in `lib/api-client.ts` beside its feature, shaped like `getReviewQueue`.
2. **Route** `app/[tenant]/[locale]/[adminPath]/(protected)/<section>/page.tsx`: `'use client'`,
   `use(params)`, `base = /<tenant>/<locale>/<adminPath>`.
3. **Roles**: a `NAV_GROUPS` row (in the group of the job it serves; at most five rows a group,
   an icon no other row uses — `lib/nav.test.ts` fails otherwise) with `roles` from the same shared set as the controller's
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
   first on a detail page; a title and no subtitle — the prop no longer exists, PRIM-1), `Card` > `CardContent className="p-0"` > borderless `DataTable`
   (`manualPagination manualFiltering sortable={false}`, `loading`, `error`, `onRetry`,
   labels from `useTableLabels`) (LAY-1, BAN-4, PRIM-3).
7. **Panels and cells**: `LoadingState`, `EmptyState`, `ErrorState`; `CellTag`, `Money`,
   `formatDate` and friends, `formatPhone` (PRIM-5 to PRIM-12). `Money` isolates the signed
   figure left to right (minus U+2212, `moneyParts` in `lib/currency.ts`) and leaves the unit in
   the page's direction; `currency` draws a dollar or euro figure the same way, `signed` adds «+»
   for a ledger movement, and `wrap` lets the unit drop under the figure — a figure in a
   `StatItem` passes it, because `StatItem` wraps and never truncates; its `hint` is a short muted
   line that qualifies the figure («آخر دفعة: …»). The treasury draws every
   figure through `TreasuryAmount`, which is `Money` with `exact`.
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
with `vitest.setup.ts` stubbing `navigator.onLine` and `window`. 48 test files, 657 cases (counted
2026-10-15, `fix/pr114-review` with PR #123 merged in). Five of them read
components rather than render them: `print-pages.test.ts` and `payout-hosts.test.ts` read every
print page and every payout-dialog host, `transfer-screens.test.ts` the transfer screens,
`commission-payout.test.ts` the payout dialog, `bulk-settle.test.ts` the bulk dialog's gate,
`bill-receipts-screens.test.ts` the bill page, the citizen file's bill rows, «وصولات الفاتورة» and
the reversal dialog, `citizen-payments.test.ts` the portal's pay dialog, «ملفّي», «حسابي» and payments page,
and `inspector-payouts.test.ts` the payout history page. `bill-receipts-screens.test.ts` parses
its pages with TypeScript's own parser to ask under which condition an element is drawn, so a
re-layout does not fail it and a new condition does.
No component, accessibility or end-to-end tests exist (no jsdom, no Testing Library); a
rendered check uses the uncommitted headless harness of UI §16.4. Untested, so add a test
when you touch them: `lib/sentry-redaction.ts`, `lib/session.ts`, `lib/csv.ts` `csvCell`.
`lib/nav.test.ts` (2026-10-09) covers `components/admin/nav.ts`: each role's landing page,
`canAccessPath`, `activeNavItem`, and the sidebar's shape — every path once, at most five rows
a group, one icon per row. A row hidden from a role under a row it can see (`/citizens/new`
under `/citizens` for «مشاهد فقط») is still reachable by address, because the longest
*visible* row matches; the page turns the role away itself. (`lib/currency.ts` gained `currency.test.ts` on 2026-10-09, with
`currencyUnit`, the one home of the «ل.ل»/«$» field unit that three finance components had
each copied.)

## Current state and known issues

- UI debt with counts and files, including the contrast failures:
  [docs/ui-ux-standards.md](../../docs/ui-ux-standards.md) §17.
- Code debt (44 `.tsx` files over 600 lines, `lib/api-client.ts` at 6,701 lines, both counted 2026-10-11, dead
  modules, the tenant config fetched three times, UTC "today"): [docs/code-quality.md](../../docs/code-quality.md).
- Traps (tailwind-merge 3 on Tailwind 3, the two default locales, missing providers on the
  citizen side, null token on first paint, `sw.js` `VERSION`, the CSP nonce, `[adminPath]` is not a control):
  [docs/gotchas.md](../../docs/gotchas.md).
- Client security gaps (offline PII in plaintext that survives sign-out):
  [docs/security.md](../../docs/security.md#known-gaps).
