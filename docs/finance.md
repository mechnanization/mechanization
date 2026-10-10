# Finance (الخزينة والمالية) — design draft

Status: **DESIGN, with stages 1, 2 and 3 built, and of stage 4 the collector handover, the accountant’s collector panel and «جولتي» (see section 14); settling several bills at once (§3.7) built on `feat/fees-bulk-settlement`.** It records the design
agreed in discussion, 2026-10-06. Stage 5 and the rest of stage 4 are not built,
and every table, column, enum value and error code for them is a *proposal*
until its migration exists (CLAUDE.md: never invent names; grep first). The
built stages' names are real: they are in migrations `0073`, `0074`, `0078`,
`0079`, `0080`, `0081`, `0083` and `0085` and in the `treasury`, `expense`, `transfer`, `income`
and `payment-settlement` contracts of `packages/shared-schemas`.
Where the code was read, the file is cited. Where a claim could not be verified, it
is marked **[unverified]**. Where a choice was assumed and not explicitly confirmed,
it is marked **[assumed]**.

Written for: the product owner reviewing the Finance design before any code is
written.

---

## 0. How to read this file

1. Section 1 is the goal in plain words.
2. Section 2 is what already exists in the code and must be reused.
3. Sections 3 to 8 are the design: accounts, ledger, income, expenses, transfers,
   daily count.
4. Section 9 is permissions. Section 10 is data model. Section 11 is the
   delivery plan. Section 12 is tests and docs. Section 13 lists every open item
   and assumption — start your revision there.

---

## 1. Goal

Give a municipality one place that answers:

- How much money do we hold right now, in each pocket, in each currency?
- Where did money come in from, and where did it go?
- Who recorded each expense, from which wallet, and why?
- Does the physical cash in the safe match what the system says at the end of the
  day?

The money lives in **wallets** (accounts). Every movement is an **append-only
ledger entry**. A balance is always the **sum of entries**, never a stored number.

### 1.1 The four starting wallets

| # | Wallet | Currency |
|---|---|---|
| 1 | Cash safe — صندوق النقد | LBP |
| 2 | Cash safe — صندوق النقد | USD |
| 3 | Whish account — حساب Whish | LBP |
| 4 | Whish account — حساب Whish | USD |

The wallet list is **data, not code**: a table of accounts. The four above are
seeded. A bank account, a petty-cash fund or a collector's custody account is one
more row, with no code change.

### 1.2 Account types (the enum)

`CASH_SAFE`, `WHISH_ACCOUNT`, `BANK_ACCOUNT`, `COLLECTOR_CUSTODY`, `PETTY_CASH`.

All five exist in the database from the first migration (an enum value added later
needs its own migration, so they are created together). In v1 the screens show the
four seeded wallets; bank, petty cash and collector custody are used by the
mechanisms described below.

Each account holds **exactly one currency**.

---

## 2. What already exists in the code (verified by reading)

Read on 2026-10-06 on branch `feat/staff-scoping-roles-archive`.

### 2.1 The payment ledger

- Table `payment_transactions`, written by `PaymentLedgerService`
  (`apps/backend/src/application/features/fees/payment-ledger.service.ts`).
- Append-only: triggers `payment_transactions_no_update` / `_no_delete` call
  `reject_ledger_mutation()` (migration `0017_payment_ledger`).
- Corrections are **reversing rows** (negative amount, `reversalOfId`, unique so an
  entry can be reversed once).
- **Numbering changed in migration 0079.** Every book now reads
  «INV-2610-0001» — the book, the year and month it was issued in, and a counter
  that restarts at 0001 each month: invoices (new), receipts, expense vouchers
  (`PV-`) and transfers (`TR-`). The counter is a row in `document_counters`
  keyed by (kind, period) rather than a sequence, because `nextval` only climbs
  and nothing resets it monthly without racing whatever draws from it. Draw
  through `allocateDocumentNumbers` and never by hand; it must share the
  caller's transaction. Documents issued before 0079 keep their six-digit form
  and bills raised before it stay unnumbered. Every `-nnnnnn` sequence named
  further down this file describes what 0079 replaced. Full reasoning: the
  migration header and docs/database.md.
- ~~Receipt numbers `RCP-nnnnnn` come from the Postgres sequence `payment_receipt_seq`
  (gaps possible after a rollback; a number is never reused).
- `clientRequestId` (unique UUID) makes a retry return the first movement instead of
  booking the money twice (migration `0066`).
- Tender data: `tenderedLocal`, `tenderedForeign`, `tenderedForeignCurrency`,
  `exchangeRate`, `officialExchangeRate`, `changeGiven`, `adjustmentReason`
  (migrations `0064`, `0066`).
- Every movement writes a **Tier 1 audit row** inside the same transaction
  (`audit` callback is required).
- `paymentId` is **mandatory**: this table only records money against a citizen
  invoice. It cannot hold manual income, expenses, transfers or opening balances.
- Money is read through `Number` with a small tolerance (finding F-07 in the
  code's own comments). The new tables must use `Decimal` end to end.

### 2.2 Payment methods and statuses

- `PaymentMethod`: `CASH`, `WHISH_MONEY`, `COLLECTOR`
  (`tenant/schema.prisma`, enum near line 1866). Note the name is `WHISH_MONEY`.
- `COLLECTOR` is cash held by a person until handed in — not yet in the safe
  (the schema comment says so explicitly).
- `PaymentStatus`: `UNPAID`, `PENDING_REVIEW`, `PAID`, `OVERDUE`.

### 2.3 Roles

`StaffRole` (`tenant/schema.prisma:39`): `SUPER_ADMIN`, `AUDITOR`, `FIELD_INSPECTOR`,
`COLLECTOR`, `ACCOUNTANT`, `ADMINISTRATIVE_OFFICER`, `VIEWER`.
`packages/shared-schemas/src/cash-policy.ts:46` already defines
`FINANCE_OVERRIDE_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT']`. No new role is needed.

### 2.4 Settings

Model `SystemSettings`, table `system_settings` (`schema.prisma:1729`, `@@map` at
1843). It already holds `baseCurrency`, `secondaryCurrency`, `exchangeRate`
(Decimal(18,6), units of base currency per one unit of secondary) and
`exchangeRateUpdatedAt`. The new settings are additive columns here.
(There is **no** table called `municipality_settings`.)

### 2.5 Inspector payouts

`inspector_payouts` (model `InspectorPayout`): amount, currency (default USD),
`paidAt`, note, reference, `recordedById`. Written by `StaffService`. It has no
wallet today.

### 2.6 Rules that shape every change (from CLAUDE.md and apps/backend/CLAUDE.md)

- A migration ships **alone, additive, in its own `chore/migration-NNNN` PR**, merged
  before the code that needs it. Latest on `develop` as of the last check is
  `0070_staff_last_seen_at`; the next free number must be rechecked against every
  open branch and PR before choosing.
- Tenancy is by Postgres schema. No `tenantId` column. Data access through
  `TenantContextService`; multi-step writes through `runInTenantTransaction`.
- Every route authenticated and carries `@Roles(...)`. Bodies validated with a shared
  zod schema through `ZodValidationPipe`; ids with `ParseUUIDPipe`.
- Refusals are thrown with a stable code from `ERROR_CODES`
  (`packages/shared-schemas/src/error-codes.ts`); both locale files need the message.
- Raw SQL must be schema-qualified (`${this.S}table`); a spec enforces it.
- Migrations: idempotent SQL; catalog guards filter on `CURRENT_SCHEMA()`; no
  `DELETE FROM`, `DROP`, `TRUNCATE`.
- Never log or send to Sentry a secret, a رقم مرجعي or citizen PII. Audit rows carry
  ids and masked values, not names.
- Side effects (cache, Tier 2 audit) after commit; Tier 1 audit inside the
  transaction.
- Frontend: tokens and shared primitives only, both locales complete, RTL-first.

---

## 3. Core: accounts and the treasury ledger (Step 1)

### 3.1 Principles

1. **Append-only.** No update, no delete. Corrections are reversing entries. The
   database enforces it with triggers, as `payment_transactions` does.
2. **Balance = SUM(entries).** No stored balance column.
3. **One currency per account.** An entry's currency always equals its account's.
4. **Money type is `Decimal` end to end.** LBP is whole pounds in practice, USD has
   cents.
5. **Every entry stores the official rate at posting** (`exchangeRateAtPosting`),
   copied from `system_settings.exchangeRate` when the entry is posted. Official
   books are in LBP, and a dollar expense from last year must be valued at last
   year's rate, not today's.
6. **Every entry points to its source** (a citizen payment transaction, an income
   voucher, an expense voucher, a transfer, an opening balance, an adjustment).
7. **No negative balances.** Any outflow checks the account's balance under a row
   lock inside the transaction and is refused if it would go below zero.
8. **Locking order.** When two accounts are touched (transfer, exchange), lock them
   in ascending id order so simultaneous transfers cannot deadlock.
   - The order holds across callers, not only inside `post`. Inserting a voucher or a
     transfer checks its foreign key and takes `FOR KEY SHARE` on the wallet, so every
     caller takes the strong lock first, with `TreasuryLedgerService.lockAccounts`,
     before writing anything that references the wallet.
   - Without that, an expense and a handover on the same safe deadlocked in 17 of 25
     simultaneous rounds (PR #104 review, 2026-10-09).
9. **Idempotency.** Anything a user can double-click carries `clientRequestId`
   (the existing name).
   - A key names one act. Replayed with the same wallet, amount and clerk (and, for an
     expense or a request, the same band, payee and description: the fields its form
     renews the key on; for a salary, also the same staff account, `payeeStaffId`; for
     income, the same category, description and payer), it answers with the first
     result. Anything else is refused (`TREASURY_REQUEST_KEY_REUSED`).
   - A key whose voucher or handover has been cancelled since is refused
     (`EXPENSE_ALREADY_VOID`, `INCOME_ALREADY_VOID`, `TRANSFER_ALREADY_VOID`, each with
     the cancelled document's number), never answered as recorded.
   - Two presses carrying one key at the same moment are both answered from the
     winner's row, never with a server error.
   - The screens keep the key across every failure and every edit, and change it only
     when the server confirms the key's act exists: a success, or
     `TREASURY_REQUEST_KEY_REUSED`, `EXPENSE_ALREADY_VOID`, `INCOME_ALREADY_VOID`,
     `TRANSFER_ALREADY_VOID`, `PAYMENT_IDEMPOTENCY_KEY_REUSED`
     (`apps/frontend/lib/request-id.ts`). A refusal
     proves only that that attempt wrote nothing. Renewing on one recorded a payment
     twice after a lost answer followed by a 429; renewing on an edit did the same
     after a lost answer followed by a corrected typo.

### 3.2 Go-live: "Activate treasury"

- A single explicit action, **`SUPER_ADMIN` only**.
- The accountant physically counts each wallet; the form takes the counted opening
  balance for every active wallet.
- One transaction: posts all opening-balance entries, stamps
  `system_settings.treasuryGoLiveAt` **once**, writes the audit row.
- Cannot be run twice. A wrong opening balance is fixed afterwards by a reversing
  entry plus a corrected entry, by `SUPER_ADMIN`, with a reason.
- Before activation the finance screens show a setup state and **nothing credits any
  wallet**.
- Old payments before go-live are **not** replayed. History would be guesswork (the
  `0017` backfill already collapsed instalments into one row).

### 3.3 Auto-credit from citizen payments

Hooked **inside `PaymentLedgerService.append`**, in the same transaction as the
payment, so the payment and the wallet movement commit together or not at all. Only
payments with `occurredAt >= treasuryGoLiveAt` auto-credit.

Routing rules:

| Payment | Wallet entries |
|---|---|
| `CASH` (counter), paid in the invoice currency | `+` credit to the CASH_SAFE of that currency |
| `CASH` with a tender (notes in two currencies, change given) | `+tenderedLocal` to the safe of the invoice currency, `+tenderedForeign` to the safe of the foreign currency, `-changeGiven` from the safe of the invoice currency |
| `WHISH_MONEY`, confirmed | `+` to the WHISH_ACCOUNT of that currency |
| `WHISH_MONEY`, `PENDING_REVIEW` | **nothing.** A declaration is not money. Credit only on confirmation |
| `COLLECTOR` | `+` to that collector's `COLLECTOR_CUSTODY` account of that currency (not the safe). Created automatically, per collector and per currency, on first collection |

Important: a citizen who pays a 1,500,000 LBP bill with a $20 note and receives LBP
change moves **+$20 into the USD safe and −change from the LBP safe**. It is never
"+1.5M LBP".

Exact mechanics for tender and change (rounding, which currency the change leaves
from) are settled in the integration tests (see 12.2).

**As built (stage 1), beyond the table above:**

- The wallet entries are written by `TreasuryLedgerService.creditPayment`, called
  from `PaymentLedgerService.append` in the payment's own transaction. Every settled
  movement goes through `append`; a pending Whish declaration never reaches it,
  which is why "credit only on confirmation" holds without a special case.
- The rule is on the payment's `occurredAt`: at or after `treasuryGoLiveAt` credits,
  before it does not (agreed). **Consequence to plan for:** a collector's round dated
  before go-live but entered after it is not credited. So before activating, have
  every collector hand in their cash, so the counted opening balance includes it.
  Custody accounts never have an opening balance (they are created by a collection).
- **Who may date a payment before go-live (decided 2026-10-09).** After go-live, only
  a finance role (`FINANCE_OVERRIDE_ROLES`) may record a payment dated before it.
  Everyone else is refused (`PAYMENT_DATE_BEFORE_GO_LIVE`).
  - Why: the 30-day back-dating window open to every role that takes payments
    (`cash-policy.ts`) would otherwise let today's cash be dated last week. The bill
    is settled and a receipt printed, but no wallet or custody is credited and
    nothing flags it.
  - The decree dates a receipt on the day the money is taken (art. 16 and 98), and
    the cut-off at go-live is the opening count.
  - A finance role who dates one before go-live asserts the cash is inside that count.
    The audit row says no wallet was credited (`treasuryCredited: false`).
- **The go-live day itself is live (decided 2026-10-09, D5).** A payment dated today
  keeps its real time; one dated an earlier day sits at midday UTC of it, but never
  before the opening entry on the go-live day (`documentOccurredAt`). So by date the
  rule is the one expenses follow: a day before go-live is not live, the go-live day
  is, whatever the hour of activation. At midday, a receipt back-dated to that day was
  refused to a collector, or credited to no wallet, whenever activation came later in
  the day.
- The go-live stamp is read `FOR SHARE`, so a payment arriving while the activation
  is still committing waits for it and is credited, instead of reading NULL and
  crediting nothing. Activation commits the settings row before its transaction
  opens: on a municipality that never saved its settings there was otherwise no row
  to wait on, and the payment went ahead and credited nothing.
- No active primary account of the needed type and currency: the payment is refused
  with `TREASURY_ACCOUNT_MISSING` (money is never silently dropped). A COLLECTOR
  payment with no collector named falls back to the main safe and says so in the
  entry's note.
- Change handed back is an outflow: if the safe in that currency holds less than the
  change, the whole payment is refused with `TREASURY_INSUFFICIENT_FUNDS`, and
  nothing is written (the integration spec pins this).

### 3.4 Reversals of citizen payments

- `PaymentLedgerService.reverse` also posts the opposing wallet entries.
- **Pre-go-live payment reversed after go-live:** a wallet entry is still created,
  because cash physically leaves the drawer today. It checks the balance first. If
  the wallet does not hold enough, the reversal is **refused** until money is moved
  in (the error message must say so clearly). **[Edge-case mechanics to be settled in
  the integration tests.]**
- Reversing a post-go-live payment reverses exactly the entries it created, each
  opposing entry carrying its original's rate.
- **A collector's payment reversed after he handed the cash in (decided 2026-10-09).**
  - Opposing the custody entry would be refused, because his custody no longer holds
    the money; the safe does. The refund could then never be made.
  - So the refund leaves his custody only while it still holds all of it, and the safe
    of the same currency otherwise. It is decided for the whole payment, so a
    tender's note and its change come back through the same place.
  - This matches municipal practice. A collector may pay nothing out (decree 5595/1982
    art. 93), and refunds go through the treasury's disbursement, never out of
    collections (US municipal cash-handling policies, e.g. Barre City VT,
    Norridgewock ME, Fort Worth TX).

### 3.5 Collector custody

- One `COLLECTOR_CUSTODY` account per collector per currency, created on first
  collection, for an active staff member who can hold cash. A view-only, deactivated
  or removed staff member can't be named as the collector (`COLLECTOR_NOT_FOUND`).
- Money stays there until a **handover** (Section 7). The handover is received by
  someone other than the collector (`CUSTODY_SELF_RECEIPT`). Custody, booking and
  receipt are in different hands, which is the first rule of cash handling, and the
  one this route exists for.
- Custody is never a paying wallet. An expense from it would write a collector's
  liability down with nobody counting the notes, which is the shortage write-off §6.3
  keeps for the manager (`EXPENSE_ACCOUNT_NOT_PAYABLE`; decree art. 93).
- Custody balances are shown on the daily report as "held by collectors" but are not
  counted to close the safe.

### 3.6 Reads

- Balance per account (sum of entries).
- Statement for an account over a period: opening, entries, closing.
- Dashboard: live balance of each wallet and the month's totals of income and
  expenses **per currency**.
- **Currency toggle:** totals can be shown in one currency using the rate from
  settings, with buttons "convert to $" / "convert to LBP". The screen labels the
  rate used. Each ledger entry always keeps its own original currency, amount and
  `exchangeRateAtPosting`, so changing the rate later never rewrites history.
  Official LBP reports use each entry's own stored rate, not today's.

### 3.7 Settling several bills at once — «تسديد الفواتير المحددة» (built 2026-10-10)

From the owner's phase-4 brief (branch `feat/fees-bulk-settlement`). A cashier ticks several unpaid
bills of **one** citizen, on «الرسوم» or on the citizen's file, and settles them in one press.
Decided with the owner on 2026-10-10: notes that do not cover every selected bill are **refused**
(no part-payment of the last one), and each bill keeps its own «RCP-» receipt under a group record.

- **All or nothing.** `PaymentSettlementService.settle` runs one `runInTenantTransaction`: the retry
  key's advisory lock, every bill `FOR UPDATE` in id order (`PaymentLedgerService.lockInvoices`), the
  settings row `FOR SHARE`, the «BRC-» number, the `payment_settlements` row (0085), then each bill,
  oldest first, through `PaymentLedgerService.recordIn` — the code a single counter payment runs, with
  its receipt number, wallet entries (`creditPayment`) and Tier 1 audit row. A refusal on any bill, the
  change the safe cannot cover included (`TREASURY_INSUFFICIENT_FUNDS`), rolls back every bill.
- **One citizen.** A bill of anyone else is refused (`BULK_SETTLE_CITIZEN_MISMATCH`); a bill settled
  since it was ticked is refused by name (`BULK_SETTLE_SOME_ALREADY_PAID`, `params.invoice`).
- **The notes** (`planBulkSettlement`, shared by the dialog and the server; the server's run, under the
  locks, is the one recorded). WHISH_MONEY and COLLECTOR arrive as one sum per bill in its currency. CASH
  takes ليرة and the second currency at the **official rate only** (no override, no back-dating here —
  both stay single-bill acts):
  1. Bills in the second currency are paid with that currency's notes at face value; too few is
     `BULK_SETTLE_TENDER_SHORT`.
  2. Notes of the second currency left over go to the ليرة bills at the official rate
     (`BULK_SETTLE_RATE_NOT_SET` without one). ليرة above what the ليرة bills owe is refused
     (`BULK_SETTLE_TENDER_EXCEEDS`), as on a single bill: change comes only from a foreign note.
  3. Those foreign notes all go on **one** ledger row, the newest ليرة bill, with its change; every other
     bill is a plain sum. Splitting a note across bills cannot keep each whole to the cent ($20 for
     900,000 + 890,000 at 89,500 is $10.06 + $9.94, and the second comes out 370 ل.ل short). When the ليرة
     notes do not cover the older bills, that row's change pays them, as a clerk does it by hand. Every
     wallet still moves by what physically changed hands (+ليرة in, +dollars, −change), and the safe is
     judged on that net, so the check is "the safe plus the ليرة handed in covers the change".
  The settlement row keeps the notes as handed over and the change handed back; the rows' own change can
  be larger than the settlement's when step 3 recycles it — the net per wallet is the same.
- **Retry.** `clientRequestId` is required and lives on the settlement, not on the rows (unique per row).
  It is bound to its act (citizen, method, the set of bills): another set is `BULK_SETTLE_REQUEST_REUSED`;
  a settlement one of whose bills was reversed since is `TRANSACTION_ALREADY_REVERSED`.
- **Correcting.** A bill of a settlement is reversed on its own, through the ledger, like any receipt;
  the consolidated receipt then shows it struck through. The settlement row never changes (append-only).
- **Who.** `BULK_SETTLE_ROLES` (manager and accountant) settle; `FEE_READ_ROLES` reprint
  (`GET fees/settlements/:id`). A collector still settles the same bills one at a time.
- **The receipt** «وصل قبض بلدي مجمّع»: the BRC number, the citizen's name, father's name and phone —
  **never the رقم مرجعي** (a sign-in credential) — each bill with its INV- and RCP- numbers, parcel and
  unit, period and amount, totals per currency, the notes, the rate and the change, two signatures, and a
  QR code of the BRC number only (assumption 13.1.3). Printed A4, downloaded as PDF, sent on WhatsApp.
  **Not built:** a thermal (80 mm) layout.

---

## 4. Income — manual vouchers (Step 2)

### 4.1 What it is

Money that is not a citizen fee: Independent Municipal Fund transfers, building
permits, fines, rent, donations. Citizen fees keep auto-crediting (Section 3.3).

### 4.2 The voucher (سند قبض إيرادات)

| Field | Rule |
|---|---|
| Number | «RV-2610-0001»: the book, the month, a counter that restarts each month, drawn from `document_counters` (0079) as kind `REVENUE_VOUCHER`. Not gapless, never reused **[assumed: gaps accepted]** |
| Date | Today by default. Future dates refused. Backdating requires a reason. Not before `treasuryGoLiveAt`: that money is already in the counted opening balance (the expense rule, mirrored). Dated by `documentOccurredAt`: today keeps the clock, an earlier day sits at midday UTC, and a voucher dated the go-live day never sits before the opening entry (D5) |
| Category | From the income category list (below) |
| Description | Required |
| Amount, currency | Positive. Must equal the receiving wallet's currency (enforced by the database) |
| Receiving wallet | CASH_SAFE, WHISH_ACCOUNT or BANK_ACCOUNT. Never collector custody |
| Payer name | Free text (may be a citizen; treated as personal data) |
| External reference | Optional bank or Whish transfer number |
| Idempotency | `clientRequestId`, required. Bound to its act (wallet, amount, clerk, category, description, payer): anything else under the same key is `TREASURY_REQUEST_KEY_REUSED`, and a key whose voucher was cancelled since is `INCOME_ALREADY_VOID` (`params.voucherNumber`) |

Attachments are **not** in step 2 (see Step 3b).

### 4.3 Default income categories (seeded)

Seven, in this order (migration 0080, by `key`; the owner added the second on
2026-10-09). Each carries an Arabic and an English name; the budget codes are
NULL, as on the expense categories.

1. الصندوق البلدي المستقل (`INDEPENDENT_MUNICIPAL_FUND`)
2. عائدات الهاتف والكهرباء والمياه من الدولة (`STATE_UTILITIES_FEES`)
3. رخص بناء وإشغال وتخطيط (`BUILDING_PERMITS_PLANNING`)
4. إيجارات واستثمار أملاك البلدية (`PROPERTY_RENTAL_INVESTMENT`)
5. هبات ومساعدات غير مشروطة (`UNCONDITIONAL_GRANTS_DONATIONS`)
6. غرامات ومخالفات (`FINES_AND_PENALTIES`)
7. إيرادات متفرقة (`MISCELLANEOUS_INCOME`)

Managed by `SUPER_ADMIN` only. A category is **deactivated, never deleted or
silently renamed**; vouchers point to it by id so old receipts never change.
The manager manages them on «بنود الإيرادات» (`finance/income/categories`) and
adds one inline from the recording form (see §14, stage 2). A municipality's own
category has no `key`, an Arabic name, and an English one only if someone gives
it one.

### 4.4 Posting and voiding

- Posting writes the voucher and its wallet entry in one transaction, with a Tier 1
  audit row (voucher number and amount only — **not** the payer's name). It takes its
  locks in the order every treasury writer does: the retry key's advisory lock, the
  settings row (`FOR SHARE`), the wallet (`lockAccounts`), then the RV number and the
  insert. So income, an expense and a handover on one safe never deadlock.
- No edit, no delete: the database refuses both (the write-once trigger of 0083). Only
  the cancellation stamp (`voidedAt`, `voidedById`, `voidReason`) is written after the
  insert, once.
- **Void:** `SUPER_ADMIN` only, with a written reason. Creates a reversing entry. **[assumed]** If the wallet no longer holds the money (it was
  spent), the void is **blocked** with a clear message (`TREASURY_INSUFFICIENT_FUNDS_FOR_VOID`),
  judged behind the wallet's lock (`lockAccounts`), taken after the voucher's own row lock.

### 4.5 Screens and printing

- "تسجيل إيراد جديد" form.
- Income list: searchable and filterable (date, category, wallet, source). It shows
  manual vouchers **and** automatic citizen-fee income, clearly tagged by source and
  never entered twice. Totals per currency, with the convert toggle.
- Printable official receipt in Arabic. A reprint is stamped «نسخة».
- **[assumed]** The QR code encodes only the voucher number as plain text. No public
  verification page (a public route would be a new unauthenticated surface), and
  never a citizen's رقم مرجعي. **[Not yet checked: whether the existing citizen
  receipt print layout can be reused.]**
- Terminology (سند قبض إيرادات, رقم أمر القبض) lives in the translation files. The
  exact wording and the printed layout must be confirmed by the municipality's
  accountant.

---

## 5. Expenses (Step 3)

### 5.1 Flow — the payment order (أمر الصرف)

**Decided 2026-10-09, on the PR #104 review.** This replaces the first design, which
had no approval step. The deciding source is the municipal accounting decree,
Decree 5595 of 22 September 1982 (تحديد أصول المحاسبة في البلديات واتحادات
البلديات), read in its published text:

- Spending passes four stages: commitment, liquidation, the payment order, and
  payment (art. 21).
- The payment order is a «حوالة» that authorises paying its amount, and the head of
  the municipality issues it (art. 28).
- The cashier pays an order only after checking that it bears the competent
  authority's signature (art. 33). He must pay one properly issued (art. 85). He
  answers personally for any payment made against the law unless the head
  confirmed it in writing (art. 89).
- Salaries, routine petty expenses and urgent ones may be paid without a prior order,
  the order being issued afterwards (art. 35). Petty and urgent spending may also run
  through advances approved by the head (art. 37–42).

The first design had no approval step and leaned on "the daily count and close" as the
control that would make up for it. That count is stage 5, which isn't built. Without it,
one accountant could record and pay any expense alone, which is exactly the
single-person outflow the decree's separation is there to prevent.

```
accountant:  REQUEST ──(manager orders)──> RECORDED (paid, ordered)
                     ├─(manager rejects)──> REJECTED      (no money moved)
                     └─(author withdraws)─> WITHDRAWN     (no money moved)
accountant, art. 35: RECORDED (paid, AWAITING_ORDER) ──(manager regularises)──> RECORDED (ordered)
manager:     RECORDED (paid, ordered) — his recording is the order
any paid voucher ──(manager cancels, with a reason)──> VOID
```

- **Who signs.** In the app the manager (`SUPER_ADMIN`) records the order. The head
  of the municipality signs the paper حوالة; his account is «مشاهد فقط» (`VIEWER`),
  which writes nothing (route inventory). The order a manager records stands for the
  head's signature on the paper.
- **The accountant's two paths.**
  - The ordinary path is a request («طلب أمر صرف»). It carries category, wallet,
    payee, description and amount. Nothing leaves a wallet, and it has no date: the
    money leaves on the day of the order.
  - For what art. 35 allows, the accountant pays at once and writes why
    (`urgentReason`). The voucher then waits as «بانتظار أمر الصرف» until the manager
    regularises it, or cancels it to return the money. An accountant's recording
    without a reason is refused (`EXPENSE_ORDER_REQUIRED`).
  - **The urgent-payment ceiling** («سقف الدفع العاجل», decision D6, 2026-10-10). The
    manager sets one ceiling per currency in الإعدادات
    (`system_settings.urgentExpenseCeilingLbp` / `urgentExpenseCeilingUsd`, 0083). An
    accountant's urgent voucher above the ceiling of its wallet's currency is refused,
    writing nothing (`EXPENSE_URGENT_OVER_CEILING`, `params: { ceiling, currency }`),
    and goes to the manager as a request instead. An amount equal to the ceiling is
    under it. Unset (NULL) means no ceiling, which is where every municipality starts;
    a wallet in a currency other than LBP or USD has none. It is read from the settings
    row the payment already holds `FOR SHARE`, so a payment waits for a ceiling being
    saved and judges by the new one. It does not apply to the manager's own voucher
    (it is the order) or to a salary (art. 35 names salaries; §5.8). Only the manager
    changes it: the settings route also admits the accountant, and a change he sends
    is refused (`URGENT_EXPENSE_CEILING_FORBIDDEN`).
  - A salary paid by the accountant takes the urgent path with a reason the server
    writes (§5.8, decision D7).
- **The order.** One transaction:
  - lock the request;
  - write the voucher with its PV number (recorder: the accountant who prepared it;
    orderer: the manager);
  - debit the wallet behind its lock, never below zero;
  - record the decision on the request.

  A wallet that can't cover the amount refuses the order, and the request keeps
  waiting. The request's id is the order's retry key: the manager who gave the order
  is answered with the voucher it paid if he presses again (`replayed: true`), even
  at the same moment. Another manager is told it was decided
  (`EXPENSE_REQUEST_ALREADY_DECIDED`).
- **A decision is written once.** It is ordered (with its voucher), rejected (with a
  reason), or withdrawn (by its author or the manager). Another accountant can't
  withdraw it (`EXPENSE_REQUEST_NOT_YOURS`).
- **Fixed once paid.** Amount, currency, wallet and payee can't change once a voucher
  exists, and the database refuses it (0083). A mistake is corrected by a void and a
  new voucher.
- Thresholds on the manager's own orders, petty-cash advances (art. 37–42) and a
  supplier register stay out of v1. The urgent-payment ceiling above is the one
  amount limit, and it holds only the accountant's art. 35 path.

### 5.2 Recording (paying)

One transaction:

1. serialise the retry key, when one is sent, under a schema-scoped advisory lock
   (`<schema>:expense-request:<key>`) before it is read, so identical requests racing
   each other produce one voucher and replays (until 2026-10-09 the loser got a 500; no
   money moved twice);
2. lock the wallet, before anything that references it;
3. check the balance (never negative);
4. write the voucher and the negative wallet entry;
5. assign the payment-order number «PV-2610-0001» (migration 0079);
6. write the Tier 1 audit row.

Before step 2, nothing written yet: the payment order is checked (an accountant's voucher
needs an urgent reason), and an accountant's urgent voucher above the manager's ceiling is
refused (§5.1, `EXPENSE_URGENT_OVER_CEILING`).

The retry key is bound to its act: the same key with another wallet, amount, clerk, band,
payee or description (or, for a salary, another staff account) is refused
(`TREASURY_REQUEST_KEY_REUSED`), never answered with the first voucher; and a key whose
voucher has been cancelled since gets `EXPENSE_ALREADY_VOID`.
Insufficient funds returns a clear error code.

### 5.3 Voiding a recorded expense

`SUPER_ADMIN` only, with a written reason. It creates a reversing entry carrying the
original's rate. An urgent payment the manager won't order is refused this way.

### 5.4 Fields

Date, category, payee (free text), description, amount, currency, `invoiceNumber`
(optional text), `hasPhysicalReceipt` (checkbox «الفاتورة الورقية محفوظة في الملف»),
paying wallet (chosen when recording), recorded by, void reason.

Not now: budget line (added later together with the budget-lines table — no loose
column now), file attachments (Step 3b), supplier register (free text instead),
amount thresholds on the manager's orders. (The payment order itself is in, §5.1, and
so is the one amount limit, the ceiling on the accountant's urgent path.)

### 5.5 Default expense categories (seeded)

1. محروقات وزيوت (fuel and oils)
2. رواتب وأجور (salaries and wages)
3. صيانة وتصليح (maintenance and repairs)
4. نظافة وجمع نفايات (waste collection)
5. قرطاسية ولوازم مكتبية (office supplies)
6. كهرباء وإنارة (electricity and street lighting)
7. تعويضات المسح والجباية (inspector and collector commissions)
8. مساعدات اجتماعية وإغاثية (social and emergency relief)
9. نفقات متفرقة (miscellaneous)
10. رسوم تحويل ومصرفية (transfer and bank fees — used by transfer fees, Section 6)

Managed by `SUPER_ADMIN`; deactivated, never deleted. Salaries are only a category
here. A payroll module with a line per employee is **out of scope**; paying one
staff member from the staff page is one voucher in this category (§5.8).

**باب وبند الموازنة (added 2026-10-06).** Each category also carries an optional
`chapterCode` and `itemCode` — the chapter and article it is charged to in the
municipality's adopted budget. The idea came from a finance schema found
directly in the local development database (section 14.2); the rest of that
schema was not adopted. Both codes are **NULL on every seeded row on purpose**:
they are the municipality's own numbers, and inventing plausible-looking
official codes in a financial record is worse than leaving them empty, because
a later reader cannot tell an invented code from a real one. The municipality
fills them in; «قطع الحساب» reads them when that report is built. Both set or
both NULL (CHECK), and one category per article (partial unique index).

**The municipality adds its own bands.** `SUPER_ADMIN` creates and edits
categories (name, description, budget codes, and `active`), from the expense
dialog itself so a half-filled voucher is not lost, and nothing deletes one: a
category is deactivated, and every voucher filed under it keeps pointing at it.
Two categories may share a name — nothing in the schema stops it, so the screen
warns rather than refusing — while two on the same budget article are refused by
a unique index.

### 5.6 Inspector payouts

- Today `inspector_payouts` records an instant USD payout with no wallet.
- New behaviour: the payout **requires choosing the paying USD wallet**, and creates a
  **recorded expense voucher** in the category «تعويضات المسح والجباية» in the same
  transaction. A link from the payout to its voucher is added (additive column on
  `inspector_payouts`).
- The inspector has no finance access; the accountant who records the payout does.
- The existing payout flow must keep working for anyone not yet activated
  (before go-live no wallet is touched).

### 5.7 Step 3b — attachments

File upload of the invoice scan. Follows the upload security rules in
`docs/security.md` (type, size, storage). When enabled, an optional per-currency
amount threshold above which an attachment is required before the expense can be recorded (off by
default, set by `SUPER_ADMIN`; the example thresholds seen in discussion — $50 /
5,000,000 LBP — are **not verified rules**).

### 5.8 Salary and wage payouts — «صرف راتب / أجر» (built 2026-10-09)

Requested by the owner on 2026-10-09, together with removing the field
inspectors' commission cards («ما سجّله كل مفتش، وما يستحقه من عمولات
(1$ لكل وحدة محتسبة)») from the staff page. The inspector payout ledger itself
is untouched and still reached from the inspector's row (§5.6).

- **Where.** A «صرف راتب / أجر» action on each *active* row of «الموظفون», which
  opens a dialog: the payee (shown, not typed), the paying wallet with its
  balance and what would be left, the amount in that wallet's currency, «عن شهر
  / بيان الصرف» (required) and a paper reference (optional). An amount above the
  wallet's balance disables the button before any request; the server re-checks
  under the wallet's lock.
- **What it writes.** An ordinary expense voucher: `PV-` number, the negative
  ledger entry, the Tier 1 audit row, in one transaction, through the same code
  as §5.2. Two things are the server's, not the client's: the payee is the staff
  account's own name, and the category is the seeded «رواتب وأجور» (`SALARIES`).
  Dated today; a salary paid on another day goes through the full expense form,
  which asks why it is back-dated.
- **The link.** `expense_vouchers.payeeStaffId` (migration 0081) holds the staff
  account the voucher paid, and the audit row carries the same id. `payee` still
  holds the name as it stood that day. No screen lists a person's salaries yet;
  the column is what such a screen would read.
- **Who, and the payment order (decision D7, 2026-10-10).**
  `POST treasury/expenses/salaries/:staffId` is `TREASURY_WORK_ROLES`, like any
  expense, and goes through the payment order of §5.1. Decree 5595/1982 art. 35 names
  salaries among what may be paid before the order, so:
  - the manager's payout is the order (`orderStatus: 'ORDERED'`, no `urgentReason`);
  - an accountant's is paid at once on the urgent path. The server writes its reason,
    exactly «راتب — يُدفع قبل الحوالة (المادة 35)» (`SALARY_URGENT_REASON` in
    `packages/shared-schemas`), and the voucher waits as «بانتظار أمر الصرف»
    (`orderStatus: 'AWAITING_ORDER'`) until the manager regularises it, like any
    urgent voucher. The body carries no reason field.
  - An accountant cannot pay his own salary (`SALARY_SELF_PAYOUT`, decision D8): the
    manager records it, or it goes as a request.
  - The urgent-payment ceiling (§5.1, D6) does not apply: art. 35 names salaries.
    It applies to a salary paid through the full expense form, which is an ordinary
    voucher.
  - The retry key is also bound to the staff account (`payeeStaffId`), so a retry for
    another person who shares the name is refused (`TREASURY_REQUEST_KEY_REUSED`).

  The button is on «الموظفون», which only `SUPER_ADMIN` opens today.
- **Refused.** A citizen's id, a deleted account or an unknown id
  (`SALARY_PAYEE_NOT_FOUND`); a stopped «رواتب وأجور» (`EXPENSE_CATEGORY_INACTIVE`);
  everything §5.2 refuses. A *disabled* account can still be paid: someone who
  has left may be owed their last month.
- **Not built.** A printable «أمر صرف»: no printed layout exists for any expense
  voucher, and its wording and layout are unverified (§13.2). The success toast
  links to the expense register instead.

---

## 6. Transfers and exchange (Step 4)

### 6.1 Kinds

- **Plain transfer** (same currency): Whish USD to safe USD (cash-out), safe to bank
  deposit, safe to petty-cash fund, return of unspent petty cash.
- **Exchange** (different currencies): −X on the source, +Y on the destination, with
  the rate stored. Rate convention: local currency per one unit of the foreign one
  (the same as the payments ledger). Optional free-text **money changer name**.
- **Collector handover** (تسليم الصندوق): a transfer from the collector's custody
  account to the safe.

### 6.2 Fees

The fee is **inside the transfer**: the source wallet is debited `amount + fee`, the
destination receives `amount`, and the fee is posted automatically as an expense in
the category «رسوم تحويل ومصرفية», all in one atomic transaction.

### 6.3 Rules

- Source and destination must differ.
- The source balance is checked under lock; never negative.
- Accounts locked in ascending id order.
- Cross-currency only through an exchange, with a rate.
- Retry key. Number `TR-nnnnnn`. Tier 1 audit row.
- **Rate control:** the official rate (settings) is stored beside the rate used. A
  difference above the tolerance (setting, **default 3%**, set by `SUPER_ADMIN`)
  requires a written Arabic reason (`adjustmentReason`).
- **No blocking pre-approval** on transfers or exchanges, so counter work is never
  frozen. Instead, **large exchanges** (over a set amount, e.g. 1,000 USD, or over
  the 3% tolerance) are **flagged for post-review** by `AUDITOR` or `SUPER_ADMIN`. The flag needs a
  "reviewed by / reviewed at" action to clear it. The amount threshold is a setting.
- **Void:** `SUPER_ADMIN` only, with a reason; a reversing set of entries; blocked
  if the destination no longer holds the money.
- **Partial handover:** a collector may hand over less than their custody balance.
  The remainder stays on the custody account until resolved. Writing off a
  shortage is a separate `SUPER_ADMIN` action with a reason (**later**, not v1).
- Exchange gain/loss is **not computed in v1**. Rates are stored so a report can be
  built later.

---

## 7. Daily count and closing (Step 5)

**Until stage 5 ships (decided 2026-10-09).** The decree has the cashier keep a daily
register: the opening balance, the day's receipts and payments, and the closing
balance. A new day's register is not opened until the previous one is closed (art. 101).

Activation is not held back for stage 5. With the payment order in place (§5.1), the
expense outflow no longer rests on the count alone. In the meantime:

- A wallet's statement for a single day is that register. «اليوم» on the statement
  screen reads one day on Beirut's calendar, from its opening balance to its close.
- The accountant prints it, counts the cash against it, and signs it with a second
  person. «طباعة» on the statement prints it alone on A4 (`data-print-root`): the
  municipality, the wallet, the day, the opening and closing balances, every
  movement, the print time, and signature lines for the cashier and the accountant.
- A difference is written on the paper, never posted (§7.2).

### 7.1 The count (جرد الصندوق)

One record per wallet per day:

- **Expected balance:** the sum of entries up to the end of that municipal day
  (the business date uses `municipalToday` from shared-schemas).
- **Counted amount:** the safe's physical total, or the Whish/bank balance typed
  from the app or statement. **Total only in v1** (no note-by-note breakdown;
  maybe an on-screen calculator).
- **Difference** = counted − expected. **Any** difference (shortage عجز or surplus
  فائض) needs a written reason.
- Who counted, when.

### 7.2 A difference never changes the books automatically

The variance is recorded on the day's report. Resolving it requires an explicit
**adjustment entry by `SUPER_ADMIN`** with a mandatory reason. The adjustment is
dated on the **current open day** and refers to the closed day (a closed day takes no
new entries). A day may be closed with an unresolved difference.

### 7.3 Closing the day (إقفال اليومية)

- A day locks **only when explicitly closed**, not by a clock at midnight (closing
  often happens at 09:00 the next morning).
- Who closes: `ACCOUNTANT` or `SUPER_ADMIN`. The same person may count and close;
  there is no separate-closer rule and no setting for it.
- Days **with movements** must be counted and closed **in chronological order**.
- Days **with no activity** (no entries, balance unchanged) are closed
  **automatically**, lazily, when the next active day is closed — no scheduled job
  (scheduler ownership is a known trap in `docs/gotchas.md`).
- Once closed: **hard lock.** Any entry dated on or before a closed day is refused.
  A late entry must be dated on the current open day, with a note. This also applies
  to `PaymentLedgerService` (a backdated citizen payment or a collector round entered
  into a closed day is refused). **This changes the existing payment path** and needs
  its own tests.
- **Reopening a day:** `SUPER_ADMIN` only, with a reason, audited.

### 7.4 The daily report (تقرير الصندوق اليومي)

Per wallet: opening balance, receipts, payments, closing balance, count, difference.
A visible summary line "cash held by collectors" (custody balances) — **not**
required for closing. Printable.

### 7.5 Whish and bank

v1 compares the closing balance typed from the app against the system balance. **Line
by line statement matching is not in v1.**

---

## 8. Reporting not in v1

- «قطع الحساب» (final accounts) report: needs budget lines and an official format.
  The format must come from the municipality or the Ministry; it will not be invented
  here. Budget lines are later; the report follows.
- Gain/loss on exchange, payroll, supplier register, denomination breakdown,
  statement import, expense approval and amount-based thresholds, scheduled jobs.

---

## 9. Permissions

Two working roles. The **accountant** runs the daily work. The **manager
(`SUPER_ADMIN`)** can do every action, plus the corrective and configuration ones.
`AUDITOR` and `VIEWER` only read (the auditor can also clear a flagged exchange).

| Action | ACCOUNTANT | SUPER_ADMIN (manager) | AUDITOR | VIEWER | COLLECTOR / FIELD_INSPECTOR |
|---|---|---|---|---|---|
| View balances, lists, reports | yes | yes | yes | yes | no |
| **See his own custody and his own round** (`custody/mine`) | yes | yes | yes | no | **yes — his own only** |
| Post income voucher | yes | yes | no | no | no |
| Request a payment order («طلب أمر صرف»; moves no money) | yes | yes | no | no | no |
| Withdraw a request still waiting | **his own** | yes | no | no | no |
| Issue a payment order, reject a request, regularise an urgent payment | no | **yes** | no | no | no |
| Record (pay) an expense | **only urgent, with a reason (art. 35), up to the manager's ceiling (D6); it waits for the order** | yes — his recording is the order | no | no | no |
| Record an inspector payout (picks the wallet) | yes | yes | no | no | no |
| Pay a staff member's salary (§5.8; the button is on the `SUPER_ADMIN`-only staff page) | **yes, on the urgent path: the server writes the art. 35 reason, no ceiling; it waits for the order** (D7) | yes — his payout is the order | no | no | no |
| Transfer, exchange, collector handover (never of one's own custody) | yes | yes | no | no | no |
| Count a wallet | yes | yes | no | no | no |
| Close a day | yes | yes | no | no | no |
| Review a flagged exchange | no | yes | yes | no | no |
| Void any voucher or transfer | no | **yes** | no | no | no |
| Activate treasury (opening balances) | no | **yes** | no | no | no |
| Reopen a closed day, post an adjustment | no | **yes** | no | no | no |
| Manage categories and finance settings | no | **yes** | no | no | no |
| Set the urgent-payment ceiling (الإعدادات, D6) | no — refused (`URGENT_EXPENSE_CEILING_FORBIDDEN`) although `PATCH fees/settings` admits him for the other settings | **yes** | no | no | no |

`ACCOUNTANT` and `SUPER_ADMIN` can reuse `FINANCE_OVERRIDE_ROLES` from
`cash-policy.ts`. `@Roles` on **every** handler, and `route-inventory.spec.ts` pins every
treasury handler to its row of this table, so widening one is a decision made there.
`ADMINISTRATIVE_OFFICER` reads `custody/mine` too: the route is on every role but
«مشاهد فقط», as the next paragraph says.

**The one exception, and why it is not a hole.** `GET custody/mine` is on
`WORKING_STAFF_ROLES`, which is every role but «مشاهد فقط». It is the only
treasury route a collector may call. The table above still holds — he sees no
balance, no list and no report of the municipality's — because the route is
scoped by `user.sub` and takes no id: it can only ever answer for the person
asking. «كم بجيبتي؟» is a man's question about his own pocket, and refusing it
makes the cash no safer while leaving him unable to check the figure he will be
held to. `WORKING_STAFF_ROLES` rather than `COLLECTOR` because nothing
restricts who may be named on a payment, and in practice it is the field
inspectors who carry the cash; staff with no custody get an empty round.

---

## 10. Proposed data model (names are proposals)

| Table | Purpose | Notes |
|---|---|---|
| `treasury_accounts` | Wallets | name, type (enum), currency, active, optional owner (collector user id for custody). Four seeded rows |
| `treasury_entries` | Append-only ledger | account, signed amount `Decimal`, currency, `exchangeRateAtPosting`, source type + source id, occurredAt, actor, note, `clientRequestId`. Triggers refuse update/delete. CHECK amount <> 0 |
| `income_categories`, `income_vouchers` | Manual income | `RV-` sequence; CHECK currency = account currency (via account FK + trigger or app + constraint) |
| `expense_categories`, `expense_vouchers` | Expenses | `PV-` number (0079); status (RECORDED, VOID); wallet, recorded by, void reason; invoice fields; the payment order — `orderedAt`/`orderedById`, `urgentReason` for art. 35 (0083); `payeeStaffId` for a salary (0081, built) |
| `expense_requests` | Payment-order requests (0083) | category, wallet + currency, amount, payee, description; requested by; the decision written once (ORDERED with its voucher, REJECTED with a reason, WITHDRAWN) |
| `treasury_transfers` | Transfers, exchanges, handovers | `TR-` sequence; from/to accounts; amounts; rate, official rate, `adjustmentReason`; fee amount; money changer name; review flag + reviewed by/at |
| `treasury_counts` | Daily count per wallet | expected, counted, difference, reason, counter |
| `treasury_day_closures` | Closed days | business date, closed by/at, reopen history |
| `system_settings` (existing) | Add columns | `treasuryGoLiveAt`, rate tolerance %, large-exchange threshold |
| `inspector_payouts` (existing) | Add column | link to its expense voucher |

Rules for every migration: idempotent, schema-qualified guards, additive,
`schema.prisma` kept in step with `map:` names, a plpgsql function pins
`search_path`, every foreign key indexed. If a table holds or points at citizen
data (a payer name may be a citizen), decide whether `BackupService` `TABLE_ORDER`
must list it, and make sure `setup-claude-ro.sql` does not expose it.

---

## 11. Delivery plan

Each migration is its **own additive PR** (`chore/migration-NNNN`), merged **before**
the feature code. Numbers are rechecked against open branches at the time.

| Stage | Migration (next free ≈) | Backend | Frontend |
|---|---|---|---|
| 1 | Accounts, entries, triggers, seeded 4 wallets, account-type enum (incl. `PETTY_CASH`), `treasuryGoLiveAt` | Balances, "Activate treasury", auto-credit hook in `PaymentLedgerService`, reversal | Wallet dashboard |
| 2 | Income categories, vouchers, `RV-` sequence | Post, void, list | Income form, list, printable receipt |
| 3 | Expense categories, vouchers, `PV-` sequence, payout link | Record (pay), void, inspector payout flow | Expense screens |
| 3b | Attachment storage | Upload per security rules | Attach on voucher |
| 4 | Transfers, `TR-` sequence, review flag, settings | Transfer, exchange, handover, custody accounts | Transfer screens |
| 5 | Counts, closures, adjustments, settings | Count, close, reopen, daily report, closed-day lock | Count/close screens, report |

Each stage includes:

- shared zod contracts and error codes in `packages/shared-schemas` (rebuild `dist/`),
  with Arabic **and** English messages;
- pure rules in `*.plan.ts` with unit specs;
- the service (`runInTenantTransaction`, Tier 1 audit, events after commit), controller
  (`@Roles`, `ParseUUIDPipe`, `ZodValidationPipe`), module wiring in `providers` **and**
  `exports`, audit labels in `apps/frontend/lib/audit-labels.ts`;
- the client functions in `apps/frontend/lib/api-client.ts` and the screens, following
  `docs/ui-ux-standards.md` and its §16 pre-merge checklist.

Working method: a **separate git worktree** so existing uncommitted frontend changes
stay untouched. No commit and no push unless the owner asks.

---

## 12. Tests, safety and docs

### 12.1 Tests

- Unit specs for the pure rules: routing (cash in two currencies, change given,
  collector custody, Whish confirmed only), rate tolerance, closed-day lock, void
  rules, role permissions.
- Integration specs (gated by `TEST_DATABASE_URL`) on a **throwaway Postgres 17
  container** (Docker needed), never on `municipality_db_local`, staging or
  production. Copy the setup of `staff-hide.integration.spec.ts`.
- Concurrency tests: two simultaneous payments; two simultaneous transfers (lock
  ordering); double-click retry key.
- Append-only trigger tests; currency-match constraint; negative-balance refusal.
- Convention specs that must keep passing: raw SQL schema-qualified, migration
  guards schema-scoped, error-code ratchet, env schema, tenant isolation.

### 12.2 Settled inside the integration tests

- The exact mechanics of tender with change (rounding, which wallet change leaves).
- The pre-go-live-payment reversal edge case (3.4).
- Behaviour of a backdated citizen payment into a closed day.

### 12.3 Definition of done (from CLAUDE.md)

`pnpm typecheck` and `pnpm lint` pass; the tests of every package touched pass; a
migration is applied with `pnpm db:deploy:local` and its integration suites run on a
throwaway Postgres 17; the report says what ran, what failed and what was skipped.

### 12.4 Docs to update when it is built

`docs/database.md` (tables, append-only list), `apps/backend/CLAUDE.md` (module
wiring, error codes, audit), `docs/security.md` (endpoint checklist, gaps),
`packages/shared-schemas/CLAUDE.md`, `PRODUCT.md` (new finance capability and
roles), `docs/gotchas.md` for new traps, and this file moved into the routing table
in `CLAUDE.md`. "Last verified" lines bumped. This file is **not** yet linked from
the CLAUDE.md routing table or the AGENTS.md section map.

---

## 13. Open items and assumptions — revise here first

### 13.1 Assumed, not explicitly confirmed

1. Voucher numbers may have gaps after a rolled-back save (sequence, like `RCP-`).
2. Voiding an income voucher is **blocked** if the wallet no longer holds the money.
3. The QR code encodes only the voucher number as plain text; no public
   verification page.
4. Payer and payee are free text, kept out of logs, Sentry and audit snapshots.
5. Reversing a pre-go-live payment after go-live creates a wallet entry and is
   refused when the wallet lacks the cash (confirmed in principle; mechanics in tests).
6. Opening balances are `SUPER_ADMIN` only, entered once through "Activate treasury".
7. **[assumed]** Voids are `SUPER_ADMIN` only (the manager), not the accountant and not
   the auditor, so an accountant cannot cancel their own entries. Counting and closing
   a day are open to the accountant.
8. **[assumed]** `AUDITOR` is read-only apart from clearing a flagged exchange.

### 13.1b Settled while building stage 1

- `WHISH_MONEY` is the real enum value (not `WHISH`).
- Only settled movements reach `PaymentLedgerService.record`: the confirm path, the
  Whish callback and the counter/collector path. Pending declarations do not.
- Two simultaneous activations on a municipality whose settings row does not exist yet
  collided on the row's unique key (a raw database error). Fixed: the row is inserted
  with `ON CONFLICT DO NOTHING`, then locked. Pinned by a test.
- The backup service does not export the treasury tables and a restore aborts for a
  tenant that has moved money (same as `payment_transactions`). **Undecided**, recorded
  in `docs/database.md`.

### 13.1c Decided on the PR #104 review (2026-10-09)

Each decision was taken from the municipal accounting decree's published text and from
municipal cash-handling practice, and is pinned by
`treasury-controls.integration.spec.ts`.

| # | Question | Decision | Grounds |
|---|---|---|---|
| D1 | A collector's payment reversed after he handed the cash in: which wallet pays? | His custody while it still holds all of it; otherwise the safe of the same currency (§3.4) | Decree 5595/1982 art. 93: a collector pays nothing out. Municipal policies route refunds through the treasury's disbursement, never out of collections |
| D2 | Who may date a payment before go-live, once the treasury is live? | A finance role only, and the audit row says no wallet was credited (§3.3) | Art. 16 and 98: a receipt is written when the money is taken. The go-live cut-off is the opening count |
| D3 | May an accountant pay an expense without the head's order? | No: a request for the manager's order; art. 35 urgent payments first, regularised after (§5.1) | Art. 21, 28, 33, 35, 85, 89 |
| D4 | Must stage 5 exist before a municipality activates the treasury? | No, with D3 in place; until it ships, the one-day statement is the daily register, printed, counted and signed (§7) | Art. 101: the daily register, closed before the next opens |
| D5 | Which side of go-live is the go-live day itself? | Live, for payments, expenses and income alike. A document dated that day is placed at the opening entry or after it, never before (§3.3) | Cutover practice: every receipt taken before the opening count is entered before activation, so what is entered for that day afterwards is new cash. Art. 16 and 98: a receipt carries the day the money was taken |
| D6 | Is the accountant's urgent path (art. 35) limited? (decided by the owner, 2026-10-10) | Yes: a per-voucher ceiling per currency (LBP, USD) that the manager sets in الإعدادات. Above it, `EXPENSE_URGENT_OVER_CEILING`, and the expense goes as a request. NULL means none. Not for the manager's voucher, nor for a salary (§5.1) | Art. 35 covers salaries, routine petty expenses and genuinely urgent ones. A ceiling keeps a large purchase on the order path (art. 28, 33) without slowing what the article lets through |
| D7 | Does an accountant's salary payout need the manager's order first? (decided by the owner, 2026-10-10) | No: it is paid on the urgent path with the server's reason «راتب — يُدفع قبل الحوالة (المادة 35)», and waits for regularisation. The manager's payout is the order (§5.8) | Art. 35 names salaries among what may be paid before the order |
| D8 | May an accountant pay his own salary on the urgent path? (2026-10-10) | No (`SALARY_SELF_PAYOUT`): the manager records it, or it goes as a request for his order (§5.8) | The separation already decided for custody (`CUSTODY_SELF_RECEIPT`): money that leaves before any order must not rest on the payee's word alone |

The decree's text was read at <https://www.baladiyat.org/?page_id=6636> (the
consolidated text with its 1985–1996 amendments). It should be confirmed against the
Official Gazette edition before any screen quotes an article.

### 13.2 Not verified

- The Court of Accounts' invoice rules and attachment thresholds, and the exact
  amended wording of the decree's articles (read from a consolidated transcription,
  §13.1c). To be confirmed by the municipality's accountant or legal advisor before
  any UI or doc claims compliance.
- That the manager (`SUPER_ADMIN`) recording the payment order is how each
  municipality wants the head's signature reflected (§5.1). The head's own account is
  «مشاهد فقط», which writes nothing.
- The exact Arabic terms and printed layouts (سند قبض, حوالة دفع / أمر صرف).
- The official «قطع الحساب» format.
- Whether the existing citizen receipt print layout can be reused for vouchers.
- That the `WHISH_MONEY` settlement paths all go through `PaymentLedgerService.record`
  only on confirmation (to check when stage 1 is written).
- That the next free migration number is still `0073` (recheck open branches).

### 13.3 Deliberately left for later

Budget lines and «قطع الحساب»; amount thresholds on the manager's orders (the urgent path has
its ceiling, D6); petty-cash advances
(decree art. 37–42); file attachments (3b); supplier register; payroll; exchange
gain/loss; denomination breakdown; Whish/bank statement line matching; collector
shortage write-off; a scheduled job (none planned).

### 13.4 Risks

- **Highest risk:** changing `PaymentLedgerService`, the money path that every
  payment uses (auto-credit hook, reversal hook, closed-day lock). Keep the change
  minimal, in the same transaction, with the existing tests kept green.
- A refusal at the counter (insufficient wallet cash on a refund; a collector round
  entered into a closed day) is correct but will surprise staff. The error messages
  and the training notes must say exactly what to do.
- Accounts with one currency each means several rows per collector. Custody accounts
  are created lazily to avoid dozens of empty ones.
- The payment order (D3) puts a manager's step in front of every ordinary expense. A
  manager away for days means the queue waits. The urgent path (art. 35) is the relief
  the decree gives, and petty-cash advances (art. 37–42) are the next step if that is
  not enough. A ceiling set too low (D6) pushes ordinary urgent spending back into
  that queue; the manager sets it, and leaving it unset means none.

---

## 14. Implementation status

### Review fixes (2026-10-09; branch `fix/pr104-review`, not committed)

What the PR #104 review found, fixed together with the decisions in §13.1c. Every item
is pinned by `treasury-controls.integration.spec.ts`, `invoice-numbering.integration.spec.ts`,
`query-params.spec.ts` or `route-inventory.spec.ts`. The full suite runs on a throwaway
Postgres 17.

**Payments into the treasury**

- A payment dated before go-live is a finance role's act, flagged in its audit row (D2).
- A refund after a handover leaves the safe (D1).
- The go-live stamp is read `FOR SHARE`.
- A named collector must be active staff who can hold cash.

**The payment order (D3), migration 0083 (first written as 0080)**

- `expense_requests`, the order stamp on vouchers, and the art. 35 urgent path with
  regularisation.
- Routes under `treasury/expenses/requests` and `treasury/expenses/:id/order`.
- The queue counts on the treasury overview.

**Writes and retries**

- One lock order across callers (`lockAccounts`), which ended the expense/handover
  deadlock.
- A retry key bound to its act.
- The same-key race answered as a replay instead of a 500.
- Handover legs and reversals carry their rate.

**Separation of duties**

- No one receives their own custody.
- No expense is paid out of custody.

**Documents (0083)**

- Vouchers, transfers and requests refuse a change to anything but their stamps, and
  refuse to be deleted.
- `voidedById` is indexed.

**Reads**

- The statement keeps the latest movements and reads a day as Beirut's day; a one-day
  statement is the interim register (§7).
- «جولتي» counts only what reached custody, per wallet.
- "Receipts today" buckets on Beirut's clock: `payment_transactions.occurredAt` is
  TIMESTAMPTZ, now annotated in `schema.prisma`.
- Query values are validated (non-negotiable 6).

**Invoices**

- `numberInvoices` passes one array, so a notice of more than 16,384 bills no longer
  rolls back.
- The two bill-raising transactions run on 60-second limits.

**Screens**

- Retry keys survive an unknown outcome.
- Enter in the inline category box no longer pays the voucher.
- The fee wizard stays locked once it has issued.
- «جولتي» reprints the RCP receipt.
- The statement has a date range and «اليوم».
- The payment-order screens.

**Found by the adversarial pass over these fixes (same day)**

Each item is pinned by a test that was seen to fail with its fix taken out.

- The first activation of a municipality with no settings row commits that row before
  its transaction opens, so a payment taken meanwhile waits for the stamp and is
  credited.
- Invoice numbering compares its zoneless `createdAt` in UTC; on a database set to
  Beirut it numbered nothing and every issue rolled back.
- The go-live day is live by date for payments as for expenses, and nothing dated that
  day sits before the opening entry (D5).
- A category edit clears its budget codes by sending both empty; one code alone is
  refused before it reaches the database's both-or-neither check.
- An expense or request key is also bound to its band, payee and description. A
  replayed key whose voucher or handover was cancelled since is refused rather than
  answered as recorded.
- Two clerks reversing one receipt together get one reversal and
  `TRANSACTION_ALREADY_REVERSED`, not a raw unique violation. The check moved under the
  invoice's lock. It predates PR #104, but it is on the reversal path the treasury now
  moves money through.
- A query day must fall in 1900–2100: `to=9999-12-31` had become a range ending in 1909.
- 0083 runs twice without error, and a decided request is closed like a cancelled
  voucher.
- «جولتي» reads the go-live stamp without locking it.
- The collector's page («من حصّل الجابي») starts at go-live too (`since`), so
  «collected − held» is what he handed in.
- An order repeated by the manager who gave it is answered with its voucher.

**Found by the frontend adversarial pass (same day)**

Each double-record was reproduced in a browser harness first, then shown to record
once after the fix.

- The screens keep a retry key across every failure and edit (§3.1 item 9). Before,
  a 429 or a corrected typo after a lost answer recorded the payment twice.
- The counter settle page locks once the payment is recorded, even when the receipt
  details then fail to load. A throttled read had unlocked it, and the second press
  took a half payment twice. A retried settlement says it was already recorded
  (`replayed`).
- A handover dialog closed and reopened keeps its key (held per wallet by the
  panel), and re-reads the figures after a doubtful failure.
- The statement prints as the daily register (§7).
- The manager can cancel a mistaken handover from its row on the statement
  («إلغاء التسليم», reason required). The money goes back onto the collector's name;
  it is refused (`TREASURY_INSUFFICIENT_FUNDS`) once the safe no longer holds it.
- The expense register is paged on the server, with from/to day filters, and keeps
  its filters in the URL.
- Activation and the expense form offer only active wallets; an accountant is not
  offered «استلام الصندوق» on his own custody.

**Found by the final review workflow (same day; each finding re-checked by a skeptic)**

- A failed background re-read no longer unmounts a write form, and the retry keys
  live outside the form (per tenant and act), so a key cannot be lost and the money
  recorded twice. Both double-records were reproduced first.
- A handover key is not replayed once the custody wallet has moved since the earlier
  transfer: a later handover of the same amount is a new count, refused as a spent key
  (`TREASURY_REQUEST_KEY_REUSED`) so the screen renews it.
- A counter retry whose receipt has since been reversed is refused
  (`TRANSACTION_ALREADY_REVERSED`), not answered as recorded.
- The statement reads its page and its sums in one repeatable-read snapshot, so a
  movement committed during the read cannot shift every running balance.
- The collector page sums «collected» from his custody's ledger entries, so
  «collected − held» stays what he handed in after a refund paid from the safe.
- «طباعة الوصل» prints the whole receipt; the statement cannot be printed while
  another range loads.

### Extended 2026-10-10 (merge of `fix/expense-retry-key-race`; branch `fix/pr104-review`, not committed)

The controls above, carried to the income vouchers and the salary payout that the merge
brought in, and the two decisions the owner took that day (D6, D7). Each item is pinned in
`treasury-controls.integration.spec.ts` by a test that was seen to fail with its fix taken
out.

- **Income vouchers** (§4): the retry key is bound to its act and a cancelled voucher's key
  is `INCOME_ALREADY_VOID`; a unique violation on the key is answered as a replay
  (`retry-key.ts`); the lock order is the advisory lock, `config` (`FOR SHARE`),
  `lockAccounts`, then the RV number; the go-live day is dated by `documentOccurredAt`
  with the go-live stamp (D5); a void takes the wallet's lock through `lockAccounts`; and
  0083's write-once trigger covers `income_vouchers`.
- **Salaries** (§5.8, D7): the manager's payout is ordered; the accountant's is urgent with
  the server's art. 35 reason and awaits regularisation; the key is bound to
  `payeeStaffId`.
- **The urgent-payment ceiling** (§5.1, D6): two columns on `system_settings` (0083, each
  NULL or > 0), read with the go-live stamp, enforced in
  `ExpensesService.recordInTransaction`, set through `PATCH fees/settings` by the manager
  only (`URGENT_EXPENSE_CEILING_FORBIDDEN`), and stripped from the settings a citizen reads.
- `route-inventory.spec.ts` pins every `IncomeController` handler's role list.

### Stage 1 — core ledger (built; branch `chore/migration-0073`, not committed)

Built and tested:

- Migration `0073_treasury_ledger`: enums `TreasuryAccountType` and
  `TreasuryEntrySource` (all values from the start), tables `treasury_accounts` and
  `treasury_entries` (append-only triggers, (accountId, currency) foreign key, one
  reversal per entry, one primary account per type and currency, one custody account per
  collector and currency), `system_settings.treasuryGoLiveAt`, the four seeded wallets.
- `schema.prisma` models; shared contracts (`treasury.schema.ts`), six error codes
  with Arabic and English messages, labels for account types and entry sources.
- Backend: `treasury.plan.ts` (pure routing rules), `TreasuryLedgerService`,
  `TreasuryService` (overview, statement, activation), `TreasuryController`
  (`GET /treasury`, `GET /treasury/accounts/:id/statement`, `POST /treasury/activate`),
  and the hook inside `PaymentLedgerService` (credit and reversal).
- Tests: 18 unit tests (routing) and 37 integration tests on a throwaway Postgres 17
  (schema rules, activation including the race, payments, reversals, funds, statement).
- Docs: database, security, gotchas, backend, shared-schemas, PRODUCT, CLAUDE routing.
- Frontend: the `finance` page (balance cards, statement dialog, the activation dialog with a
  confirm step, the «محتجز لدى الجباة» line, and the currency toggle that only adds a converted
  total and is disabled when no rate is set), the nav row, the audit label, 68 message keys in
  both locales, and two pure helpers with tests. Typecheck, lint (0 errors) and 201 frontend
  tests pass. **Not rendered**: no check at 360/1440px, light/dark or Arabic/English yet.

Not in stage 1 (by design): creating extra accounts through the API, the exchange-rate
snapshot being used by any report, income, expenses, transfers, counts and closing.

### Stage 3 — expenses (built; same branch, not committed)

Built and tested, exactly as §5 describes, with **no approval step**:

- Migration `0074_expense_vouchers`: `expense_categories` (with the optional
  budget codes above) and `expense_vouchers`, the `PV-` sequence, and the ten
  agreed categories seeded by `key`. The voucher's (accountId, currency) foreign
  key makes a ليرة voucher on a dollar safe impossible at the database.
- Backend: `expenses.plan.ts` (the three date rules), `ExpensesService`,
  `ExpensesController` (`t/:tenantSlug/treasury/expenses`), wired into both modules.
  Recording writes the voucher, posts the negative ledger entry and writes the
  Tier 1 audit row in one transaction; cancelling stamps the voucher and posts an
  opposing entry. The currency comes from the wallet, never the request.
- A rule §5 did not state, added because the arithmetic demands it: **an expense
  may not be dated before `treasuryGoLiveAt`**. That money is already subtracted
  from the counted opening balance, so recording it would take it out twice. The
  go-live day itself is allowed, and a voucher dated it is never placed before the
  opening entry (D5, as for payments, §3.3).
- Tests: 12 unit (dates) and 23 integration on a throwaway Postgres 17 — the
  voucher and the money committing together, a refused outflow leaving no
  voucher, two simultaneous vouchers against one wallet, the retry key, the void
  returning the money, and two simultaneous cancellations.
- Frontend: the `finance/expenses` register (filters, per-currency totals over
  the whole filtered set, cancelled vouchers shown struck through rather than
  hidden), the record dialog and the cancel dialog, its own nav row, and a link
  from the treasury page. Recording lives on its own page, `finance/expenses/new`,
  not in a dialog (BAN-10): it is a nine-field form worked through with an invoice
  in hand, and a route gives it an address, a working back button, and no overlay
  to lose a half-filled voucher to. A sticky summary beside it shows the wallet
  balance, the amount and what is left, and turns red before the submit when the
  wallet cannot cover it.
- Verified by rendering: an expense was recorded end to end through the UI
  (`PV-000001`, 250,000 ل.ل), and the ليرة safe went from 7,200,000 to 6,950,000
  with one ledger entry and one audit row.

**Not in stage 3**, as agreed: attachments (step 3b), budget lines as their own
table, approval thresholds, a supplier register, and the inspector-payout link
of §5.6 — `inspector_payouts` still records a payout with no wallet, and wiring
it to a voucher is the next piece of this stage.

**Added to stage 3 on 2026-10-09: the salary payout (§5.8).** Migration
`0081_expense_voucher_payee_staff` (`payeeStaffId`, its foreign key and index),
`ExpensesService.recordSalary` and `POST expenses/salaries/:staffId`, the
`SALARY_PAYEE_NOT_FOUND` code, and the «صرف راتب / أجر» dialog on the staff page,
which lost the inspectors' commission cards in the same change. Nine
integration tests on a throwaway Postgres 17 (the voucher and its link, the
audit row by id, the retry, the overdraw, a citizen's id, a deleted and a
disabled account, a stopped category, the foreign key). Verified in a browser
against the local seeded database: two payments of 250,000 ل.ل
(`PV-2610-0002`, `PV-2610-0003`) took the ليرة safe from 6,525,000 to
6,025,000, each with one ledger entry and one audit row, and an amount above
the balance disabled the button and wrote nothing. Rendered at 360 and 1440px,
Arabic and English, light and dark.

### Stage 4 — the collector handover (built; same branch, not committed)

The one piece of §6 the flow could not do without: a collector's cash reached his
custody wallet and had no way out. Built:

- Migration `0078_treasury_transfers` (not 0075 — `chore/migration-0075-0077`
  had taken it): one `treasury_transfers` table for every move between wallets,
  the `TR-` sequence, and a CHECK that a same-currency move carries no rate while
  a cross-currency one must. The columns an exchange needs are there and
  nullable; only the same-currency path is wired.
- Backend: `TransfersService` and `TransfersController`. `custody` answers «كم
  بعهدة كل جابٍ»; `receiveCustody` writes both ledger legs, the transfer document
  and the Tier 1 audit row in one transaction; `void` puts the money back on the
  collector. More than he holds is refused with the figure named
  (`CUSTODY_EXCEEDS_HELD`), and again by the ledger's never-negative post.
- Frontend: the treasury page's read-only «محتجز لدى الجباة» line became a panel
  listing each collector with «استلام الصندوق», and a dialog that shows what he
  holds and what would remain as the amount is typed.
- **«من حصّل الجابي»** (`finance/collectors/[collectorId]`), reached from a second
  button on that panel: every receipt he wrote at a door, with the citizen who
  paid — named in full with his father's name, because two «غسان جواد» in one
  village is ordinary — his phone, the sector he lives in, what the bill was
  for, the receipt number and the amount. Enough to ring him and enough to find
  him, which is what the screen is for. Custody is one
  number; a round is thirty doors, and this is the list the accountant reads
  while the notes are on the desk. Offered whether or not he is still carrying
  anything — a collector who has settled is exactly the one whose round someone
  asks about afterwards. **Collected and held are two different figures** and the
  page says so in as many words: a handover moves an amount, not a set of
  receipts, so nothing can honestly be marked "handed over" receipt by receipt,
  and the difference between the two numbers is simply what he has brought in.
  Reversed payments stay on the list beside their opposing rows, struck through,
  because hiding the pair would make the totals stop adding up for whoever is
  counting. No رقم مرجعي anywhere — see the note in docs/security.md.
- **The accountant's panel now carries the day**: each collector's receipts and
  takings for today (Beirut, `municipalToday`), and a status badge —
  «يجمع اليوم» / «لم يخرج اليوم» / «سلّم كل شيء». The status is **derived from
  his receipts, never stored**: nothing in the system records whether a man is
  out on a round, and «لم يخرج اليوم» with cash still on him is a different
  answer from «سلّم كل شيء», so they are different badges rather than one vague
  tone.
- **«جولتي»** (`/my-round`, `GET custody/mine`) — the collector's own screen,
  built for a phone on a doorstep: what is in his pocket, then the doors it came
  from as cards rather than a table, each with the citizen, his unit reference,
  the receipt number and the time, and a button that opens the existing
  `PaymentReceipt` to print, download or send it over WhatsApp. Nothing new was
  built for the receipt itself.

  The list is **everything since his last handover**, not "today": his pocket
  does not empty at midnight, and a man who collected yesterday and has not
  handed in would otherwise see a full pocket above an empty list. After a
  *partial* handover even that set cannot account for all he holds — a handover
  moves an amount, not a set of receipts — so the remainder is named
  («محمول من جولة سابقة») rather than left as an unexplained gap between two
  numbers. Cancelled payments and their opposing rows are left out here, unlike
  the accountant's reconciliation list: this screen is the money in his pocket,
  and a cancelled payment is not in it.
- Tests: 16 integration tests walking the whole flow — collected at a door, held
  in custody with the safe untouched, partial handover, full handover, double
  press, two simultaneous handovers, cancellation, and an audit row that does not
  name the collector.
- Verified in the browser against the seeded database: `TR-000001` moved
  500,000 ل.ل of a collector's 1,500,000 into the safe; he kept 1,000,000.

**A rule worth stating plainly**, because it is what makes custody worth having:
nothing here touches an invoice. The citizen's debt was settled at his door. If
the handover never happened the register would still be right, and the collector
would simply still owe the municipality the cash — which is exactly what his
custody balance says.

**Not in stage 4 yet**: a Whish cash-out, a bank deposit, petty cash, currency
exchange with its rate tolerance and post-review flag, and transfer fees. They
share the table and the service.

### Stage 2 — income vouchers (built 2026-10-09; same branch, not committed)

Built as §4 describes, with the differences listed after:

- Migration `0080_income_vouchers`: `income_categories` (Arabic and English
  names, optional budget codes, deactivated never deleted) and
  `income_vouchers`, with the seven categories of §4.3 seeded by `key`. The
  (accountId, currency) foreign key makes a ليرة voucher in a dollar safe
  impossible at the database; `clientRequestId` is NOT NULL. The amount is
  `DECIMAL(14,2)`, the ledger's own precision. No sequence: the number comes
  from `document_counters`, kind `REVENUE_VOUCHER`, prefix `RV`.
- Backend: `income.plan.ts` (the date rules — `planExpenseDate`'s, delegated and
  renamed, not copied — and the Beirut-midnight bounds of a register period),
  `IncomeService`, `IncomeController` (`t/:tenantSlug/treasury/income`), wired
  into both modules. Recording writes the voucher, posts the positive
  `INCOME_VOUCHER` entry and the Tier 1 audit row (number and amount, never the
  payer) in one transaction. The receiving wallet must be a cash safe, Whish or
  a bank account (`canReceiveIncome`); custody and petty cash are refused with
  `INCOME_ACCOUNT_NOT_RECEIVING`.
- The retry key is serialised with a schema-scoped advisory lock before it is
  read, so two identical requests racing each other produce one voucher and
  one replay — not a unique violation surfacing as a 500, which a read alone
  cannot prevent. Pinned by a test. Since 2026-10-10 it is also bound to its
  act (see "Extended 2026-10-10" above).
- Voiding, manager only, locks the voucher and then the wallet, and refuses
  with `TREASURY_INSUFFICIENT_FUNDS_FOR_VOID` (figures named) when the wallet
  has spent the money since (§4.4, assumption 13.1.2). The voucher is left
  untouched.
- Categories, the manager's alone: `POST` and `PATCH` on `income/categories`
  add one, rename it, give it an English name or its budget codes, and stop or
  restart it. Never a delete. Two on one budget article are refused by the
  partial unique index (`INCOME_CATEGORY_CODE_TAKEN`). An edit replaces the
  names and codes as the form holds them, but keeps `active` unless it is sent,
  as the expense edit does since the PR #104 review (a PATCH changes only the
  fields it sends). Both acts are Tier 1 audited with the state
  before and after.
- Tests: 12 unit (dates, Beirut midnights across both clock changes, periods)
  and 38 integration on a throwaway Postgres 17.
- Frontend: the `finance/income` register (search on the server, period,
  category, currency and status filters, per-currency totals over the whole
  filtered set, cancelled vouchers struck through with their reason), the
  cancel dialog, its own nav row «الإيرادات», and the recording page
  `finance/income/new` with the sticky summary of the expense page — balance
  now, amount, balance after. «بنود الإيرادات» (`finance/income/categories`)
  lists every category, stopped ones included, for every finance reader, and
  gives the manager add, edit, stop and restart; the recording form offers the
  manager «بند جديد» inline, so a missing category does not cost the voucher.
  The register's category filter lists stopped categories too, since their
  vouchers are still in it.

**Not in stage 2 yet**, against §4.5: the register lists manual vouchers only,
not citizen-fee income beside them; there is no printable «سند قبض» (nor its
QR code); the totals have no convert toggle. Not rendered in a browser (no check at 360/1440px, light/dark,
Arabic/English) and not exercised over HTTP.

### Stage 5

Not started.

---

## 15. The schema found in the local database (2026-10-06)

While applying `0074`, the migration failed: `expense_categories` already existed
in the local development database with a different shape. Six tables were there —
`cash_boxes`, `cash_transfers`, `expense_categories`, `expenses`,
`income_categories`, `incomes` — plus three enum types. **No migration in any
branch creates them and no code in the repository references them**; they had
been created straight against the database, outside the migration system.

Their design differed from this one in one way that decides the matter: a
`cash_boxes` row carried a stored `openingBalance` and there was **no ledger**, so
a balance would have to be recomputed across four tables, with nothing
append-only and no record of a movement. Citizen payments were not connected to
them at all.

Decided by the user on 2026-10-06: keep the treasury ledger, take the
`chapterCode`/`itemCode` budget-coding idea (§5.5), and drop the six tables from
the local database. They held scratch rows ("test", "test1", two cash boxes, one
income). Staging and production never had them, so nothing there was touched and
no migration removes them.

**Where they came from is unknown.** If another tool or session is building
finance in parallel, that work and this will collide again.
