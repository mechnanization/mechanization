# Old debts — «متأخرات سنوات سابقة» (code: `arrears`)

Last verified against the code: `feat/arrears-bills-everywhere` (on `develop@90cebdc`), 2026-11-21; task 10, an old-debt bill read as one on every screen that shows a bill (§7); `feat/arrears-report` (on `develop@90cebdc`), 2026-11-21; task 11, «تقرير المتأخرات» and the batch sheet (§8); `feat/arrears-approval` (on `develop@c6e7462`), 2026-11-21; the cutoff year fixed once a batch is approved (`ARREARS_CUTOFF_LOCKED`, task 6), 2026-11-21.

> **Status, 2026-11-21:** tasks 1–4 merged to `develop` (PRs #174–#177). Task 5, the backend after the import — submit,
> return, discard, approve and the «ARR-» bills, a single line, the link of a «للمطابقة» line, the cutoff year, and «دمج
> ملفين» moving old debts — built on `feat/arrears-approval` (on `develop@c6e7462`). **Not built, with its reason:** the in-app backup (§8); and the old books'
> totals per year, which stay read only until open-decisions §23.4 is decided.
> Task 9, «شطب», built on `feat/arrears-write-off` (PR #179): [finance.md](finance.md) §3.8.
> Task 7, the export, import and submit screens, built on `feat/arrears-import-ui` (PR #181): «المتأخرات»
> (`fees/arrears`), on task 4's and task 5's routes.
>
> Task 8, approval, «للمطابقة» and the settings screens, built on `feat/arrears-approval-ui` (PR #182): `fees/arrears/review`,
> `/match` and `/settings`, on task 5's routes. The cutoff year is set there (`PUT arrears/settings/cutoff`); the books'
> totals per year are shown read-only until open-decisions §23.4 is decided.
> Task 10, old-debt bills shown properly everywhere a bill appears, built on `feat/arrears-bills-everywhere` (on
> `develop@90cebdc`): the bill's views carry `arrears` (§7), and the staff file, the cash counter, the settle page, the fees list,
> «تسديد الفواتير المحددة», the receipts and the portal («مدفوعاتي», «ملفّي», «حسابي») mark and group an «ARR-» bill.
> **Not built, with its reason:** the Al-Bazourieh image receipt has no free box for the debt's type, so it prints the bill's title
> (which carries the year, the fee and «غرامة») and the debt's own رقم العقار, not a «نوع الدين» line.
>
> Task 11, «تقرير المتأخرات» and the batch sheet, built on `feat/arrears-report` (on `develop@90cebdc`): `GET arrears/report` and
> `GET arrears/batches/:batchId/sheet` (§8), the screens `fees/arrears/report` and `fees/arrears/batches/:batchId/sheet`.
> **Not built, with its reason:** entering the old books' totals, which is open-decisions §23.4: the report reads
> `arrears_control_totals` and shows «غير مدخل» for a year with none, so «المتبقي للإدخال» appears the day a total exists, with
> no change here. A batch has no number of its own (no column holds one, and a number is a migration), so its sheet is named by
> a code, the first eight characters of its id.
>
> **Earlier status: tasks 1–4 in review, 2026-11-21, none merged.** This spec (PR #174); the migrations
> `0107`/`0108` (`chore/migration-0107-old-debts`, PR #175); the contract in shared-schemas
> (`feat/arrears-contract`, PR #176, stacked on #175); the export and the import's dry run
> (`feat/arrears-import`, PR #177, stacked on #176). Tasks 5–12 are not started. The decisions are the
> product owner's (Hashem, 2026-11-20). The work is split into twelve ClickUp tasks in the list
> «Mechanization – Old debts (البقايا)» (§10). Where a name here and the code
> disagree once the code exists, the code wins and this file is the bug.

Citizens owe the municipality money from before the system existed: fees billed in
the municipality's paper or spreadsheet books («دفاتر البلدية») and never paid. This
feature brings those debts in, one line per citizen, property, year and fee type, so
they can be collected, shown in the portal, and counted against a «براءة ذمة».

**What it is not.** It is not the treasury's `OPENING_BALANCE`
([finance.md](finance.md) §3.2). That is the cash counted in each wallet at go-live,
money the municipality *holds*. Old debts are money citizens *owe*. They never touch
a wallet until someone pays one, and then the payment goes into a wallet like any
other payment.

## 1. Why «تكليف مالي» is not enough

Today the only way to enter an old debt is a one-off charge
(`FeesService.chargeIndividual` → `raiseOneOffBill`). It falls short in five ways:

1. **No year and no fee type.** `periodKey` is `ONCE`, so no report can break the
   arrears down by year or by fee.
2. **No property line.** `ParcelDuesService` finds a parcel's open bills by the
   `propertyNumber` on `assessment.lines`; a one-off charge has none, so it never holds
   back a «براءة ذمة».
3. **A number dated this month.** It draws an `INV-YYMM-…` number, which says the bill
   was issued this month. The schema's own comment on `invoiceNumber` calls minting a
   number for something never issued under it "a fiction in front of an auditor".
4. **No duplicate guard.** Nothing stops the 2023 fee being entered twice.
5. **Archived files are refused** (`FEE_CITIZEN_ARCHIVED`), so a departed or dead
   debtor's old debt cannot be entered at all.

There is also no bulk path: thousands of lines would be typed by hand.

## 2. Decisions

### 2.1 Decided (Hashem, 2026-11-20)

1. **Name.** «متأخرات سنوات سابقة» on screen; `arrears` in code.
2. **Source.** Our own CSV template, which opens in Excel. The system exports it for a
   chosen set of N citizens at a time (by zone or by building), already filled in with
   who they are and what they hold. The accountant copies the old books into it and
   imports it back. A form takes single lines found later.
3. **One line** = citizen × رقم العقار (unit, when known) × year × fee type. A penalty
   is its own line.
4. **Attached to the citizen AND the رقم العقار**, so it holds up «براءة ذمة».
5. **Cutoff.** Old debt covers the years before `system_settings.arrearsCutoffYear`:
   2025 and earlier today, since 2026 was billed by no one (the war). From the cutoff
   on, only the system bills. The cutoff is a setting, never hard-coded; while it is
   NULL every import is refused. Whether 2026 is billed at all after the war is the
   municipality's call, not this feature's.
6. **Penalties** are carried over from the books. The system never adds one.
7. **Approval.** An ACCOUNTANT (or SUPER_ADMIN) prepares a batch as a draft that no
   citizen sees. SUPER_ADMIN approves it, and then it is locked.
8. **A person not registered yet.** The line waits in a «للمطابقة» list. Its bill is
   raised when a clerk links it to a citizen file. Rows are never matched by name
   automatically.
9. **Portal.** An old-debt bill is shown in the portal and payable like any bill
   (online payment is paused for every bill today,
   [open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)).
10. **Corrections.** «إلغاء الفاتورة» with a reason, for a mistake (the existing
    `cancelBill`). A new «شطب» write-off (`WRITTEN_OFF`) with the council decision
    number and date, for forgiveness, prescription or an amnesty; it can cover the rest
    of a part-paid bill. Both are recorded, never deleted, and reported apart.
11. **War damage.** The preview flags lines on units the census records as destroyed or
    not habitable, with the reading's date. The accountant keeps or drops each one, and
    a drop keeps its reason.
12. **Archived files** can receive old debt through an approved batch only. «تكليف مالي»
    stays refused (`FEE_CITIZEN_ARCHIVED`). Nor is an archived file chosen for a single line or for
    the link of a «للمطابقة» line (the owner, 2026-11-21): both refuse it with the same code, and the
    file is restored first.
13. **Currency.** LBP at face value. Any other currency is refused.
14. **Prescription («مرور الزمن»).** A debt older than 5 years is dropped (added
    2026-11-20). The default chosen, still to be confirmed (§2.3): the 5 years count
    from 31 December of the debt's year, so a line of year *Y* is prescribed from
    1 January of *Y* + 6. The dry run sets such a line to DROP with the reason
    «مرور الزمن» (`flags.prescribed`); no bill is ever raised for it; the accountant
    still sees it, and it is counted apart in the reconciliation panel and on the batch
    sheet. On 2026-11-21 that drops 2020 and earlier.

### 2.2 Proposed, not confirmed: Undecided

- **The approver may not be the batch's preparer** (maker ≠ checker). The error code
  `ARREARS_APPROVER_IS_PREPARER` is reserved for it; task 5 enforces it only once this is
  confirmed. With a single SUPER_ADMIN it means an ACCOUNTANT must prepare every batch.
- **The old books' total per year.** SUPER_ADMIN enters the arrears total of each year
  once, from the last «قطع الحساب», and the report shows how much has been imported
  against it. The table (`arrears_control_totals`) ships with task 2, empty, so the
  answer needs no migration either way.

### 2.3 Undecided

Tracked in [open-decisions.md §23](open-decisions.md#23-old-debts-what-the-municipality-must-answer-2026-11-21).

- **The fee-type list** for the template (§5.2 holds a provisional one).
- **When the 5 years start** (31 December of the year, or each debt's due date), and
  **whether a notice or a demand interrupts them**. The 5 years themselves could not be
  verified in Lebanese law online; the municipality's legal adviser confirms them.

## 3. Data model (task 2: `0107`, `0108`)

Every table is in the tenant schema. All additive.

### 3.1 `0107` — enum values only

Alone, because a value cannot be used in the transaction that adds it
([database.md](database.md#how-tenant-migrations-run)).

| Enum | Values |
|---|---|
| `PaymentStatus` | + `WRITTEN_OFF` («مشطوبة») |
| `ArrearsBatchStatus` (new) | `DRAFT`, `SUBMITTED`, `APPROVED`, `DISCARDED` |
| `ArrearsComponent` (new) | `PRINCIPAL` («أصل»), `PENALTY` («غرامة») |
| `ArrearsLineDecision` (new) | `KEEP`, `DROP` |

### 3.2 `0108` — tables and columns

**`arrears_batches`** — one import, from export to approval.

| Column | Notes |
|---|---|
| `status` | `ArrearsBatchStatus`, DRAFT on insert |
| `scope` | jsonb object: what the template was exported for (`{ zoneId }` or `{ buildingId }`, and the count asked) |
| `preparedById` | the accountant; RESTRICT |
| `submittedAt`, `submittedById` | set together |
| `approvedAt`, `approvedById` | set together, only on an APPROVED batch |
| `discardedAt`, `discardedById` | set together, only on a DISCARDED batch |
| `returnNote` | why SUPER_ADMIN sent it back to DRAFT |
| `controlTotal` | Decimal(14,2), ≥ 0: the accountant's hand-added total of the pages copied; required to submit |
| `sourceNote` | which books, which pages |
| `clientRequestId` | unique: the export press's retry key |

Moves: DRAFT → SUBMITTED → APPROVED; SUBMITTED → DRAFT (returned, with a note);
DRAFT or SUBMITTED → DISCARDED. APPROVED and DISCARDED are final. A trigger holds
these moves and makes an APPROVED batch written once.

**`arrears_batch_citizens`** — the set the template was exported for: (`batchId`,
`citizenId`), plus `rowKey`, a small number unique within the batch that the template
carries instead of any identifier (§5.1). «Checked against the old books» (coverage) is
counted from this table: a citizen in an approved batch was checked, whether or not
anything was owed.

**`arrears_lines`** — one debt line.

| Column | Notes |
|---|---|
| `batchId` | RESTRICT |
| `citizenId` | NULL while the line waits in «للمطابقة»; RESTRICT |
| `sourceName` | the name as written in the old books; required while `citizenId` is NULL, kept after linking |
| `rowKey` | the template row a matched line came from; NULL for an unmatched row or a single line |
| `propertyNumber` | رقم العقار as typed; required |
| `unitId`, `unitCode` | both nullable; `unitId` is SET NULL when a unit is deleted, `unitCode` stays |
| `year` | the debt's year |
| `feeType`, `feeTypeNote` | a code from `ARREARS_FEE_TYPE` (text, so a new code needs no migration); `OTHER` needs the note |
| `component` | PRINCIPAL or PENALTY |
| `amount` | Decimal(14,2), > 0 |
| `currency` | `LBP`, by CHECK (decision 13) |
| `dueDate` | date, nullable |
| `oldReference` | the old books' reference (page, receipt book) |
| `note` | |
| `decision`, `dropReason` | KEEP with no reason, or DROP with one (CHECK) |
| `flags` | jsonb object: `prescribed`, `war` (`{ level, habitable, assessedAt }`), `archived`, `unitNotHeld` |
| `linkedAt`, `linkedById` | set together when a «للمطابقة» line is linked |
| `discardedAt` | stamped on every line when its batch is discarded |

**One live line per debt.** A partial unique index over (`citizenId`, the رقم العقار with
Eastern digits folded to Latin and edge spaces trimmed, `coalesce(unitCode, '')`,
`year`, `feeType`, `component`) where `citizenId IS NOT NULL AND decision = 'KEEP' AND
discardedAt IS NULL`. A dropped line or a discarded batch therefore never blocks the
right one. The application checks first; the index has the final word
(`ARREARS_LINE_DUPLICATE`).

**The bill link lives on the bill only:** `citizen_payments.arrearsLineId`, unique,
RESTRICT. The ClickUp task named a `paymentId` on the line as well; two links in two
directions can disagree, and the line would need an UPDATE after approval. One link
keeps an approved line untouched and lets "lines approved with no bill" be a LEFT JOIN.

**Write-once.** A line of an APPROVED batch never changes, except: `citizenId` (a link
from NULL, or a «دمج ملفين» moving it), `linkedAt`/`linkedById` (once, from NULL),
`unitId` (cleared, by the SET NULL). No line of an APPROVED batch is deleted. A line of a
DISCARDED batch accepts nothing. Both new tables get the `0103` TRUNCATE guard.

**`arrears_control_totals`** — (`year` unique, `amount`, `currency` LBP, `enteredById`,
`enteredAt`). §2.2: undecided, ships empty.

**`system_settings.arrearsCutoffYear`** — Int, NULL by default. CHECK 2000–2100.

**`citizen_payments`** — `arrearsLineId` (above), and the write-off: `writtenOffAt`,
`writtenOffById`, `writeOffAmount`, `writeOffReason`, `writeOffDecisionRef`,
`writeOffDecisionDate`. CHECKs, as `0091`/`0093` hold a cancellation: the six move
together; `paymentStatus = 'WRITTEN_OFF'` exactly when `writtenOffAt` is set; the
reason and the decision number are never blank; the amount written off is greater than
0 and is exactly what was left (`paidAmount + writeOffAmount = amount`). So a receipt on
a written-off bill cannot be reversed while the write-off stands: task 9 refuses it with
a code before the database does.

## 4. The flow

```
export (N citizens) ─▶ CSV in Excel ─▶ import: dry run ─▶ import: write DRAFT lines
      │                                                          │
  DRAFT batch + its citizen set                         submit (controlTotal)
                                                                 │
                                         SUPER_ADMIN: approve ◀──┴──▶ return (note) → DRAFT
                                                │                      discard → DISCARDED
                                   one bill per KEEP line with a citizen
                                   «للمطابقة» lines wait for a link → bill
```

1. **Export («تصدير قالب»)** — task 4. The next N citizens of a zone or a building who
   are in no batch that is not DISCARDED, by رقم العقار then name; active and archived
   files, never a merged-away one. "Of a zone or a building" means holding a unit there on an
   open spell, or a current card on one on the citizen's latest registration. One row per citizen × unit they hold now (as owner or
   occupant), plus one bare row for a citizen with no unit. Writes the DRAFT batch and
   its citizen set, returns the rows, and the browser writes the CSV (`csv.ts` guards
   against formula injection). Audit `ARREARS_TEMPLATE_EXPORTED`: the batch id and the
   count, no names.
2. **Fill.** The accountant copies the books into the rows, duplicating a row for each
   year and fee. A row left with no year and no amount means «checked, nothing owed».
   Rows for people not in the set are added at the bottom with a name and no row key.
3. **Import** — task 4. One call, `dryRun: true` only checks (§6); without it, the same
   checks run and the DRAFT's lines are replaced by the file's. Nothing is visible to a
   citizen.
4. **Submit** — task 5 (UI task 7). With `controlTotal`; refused when it differs from
   the sum of every line in the batch, kept, dropped and unmatched alike
   (`ARREARS_CONTROL_TOTAL_MISMATCH`), since the books' pages hold all of them.
5. **Approve, return or discard** — task 5 (UI task 8). Approval re-runs the checks that
   can change with time (the cutoff, prescription, the duplicate check, a merge since),
   then raises one bill per KEEP line that has a citizen (§7), in one transaction, and
   locks the batch.
6. **Link** — task 5 (UI task 8). A «للمطابقة» line of an approved batch is linked to a
   citizen file and its bill raised then.
7. **Single line** — task 5. The form writes a one-line batch through the same checks
   and the same approval.

## 5. The template

### 5.1 Columns

Filled by the export: `rowKey`, full name, رقم العقار, unit code. Filled by the
accountant: year, fee type, principal, penalty, old reference, due date, note. A row
with both a principal and a penalty becomes two lines.

**Never in the file:** رقم مرجعي, phone, ID number, residency status. A citizen's id is
not in it either: `rowKey` is a small number that means something only inside its
batch. [security.md](security.md) treats an export carrying a رقم مرجعي as a credential
dump.

### 5.2 Fee types (provisional)

From Law 60/1988 and the fees this repo already describes
([municipal-tax-proposal-ar.md](municipal-tax-proposal-ar.md)), until the municipality's
accountant gives the list (§2.3): `RENTAL_VALUE` «رسم القيمة التأجيرية»,
`SEWER_SIDEWALK_MAINTENANCE` «رسم صيانة المجاري والأرصفة», `SEWER_SIDEWALK_CONSTRUCTION`
«رسم إنشاء الأرصفة والمجاري», `CLEANING` «رسم النظافة», and `OTHER` «رسم آخر», which needs a
description. The column is text, so the final list needs no migration.

## 6. The dry run's checks (task 4)

Pure rules in `apps/backend/src/application/features/arrears/arrears-import.plan.ts`
(`planArrearsImport`), each with a test that fails only for its own reason. A unit is named
by its full code, «<building code>-<unit code>», as the export writes it. A write takes
`<schema>:arrears-lines`, which every writer of live lines takes, so the duplicate check is
answered in words before the index has to.

| Check | Verdict |
|---|---|
| `rowKey` in this batch's set | otherwise the row goes to «للمطابقة», with its name; never matched by name |
| a row key's citizen merged away since the export | refused: re-export |
| unit code names a unit on that رقم العقار | otherwise refused; a unit the citizen no longer holds is a note, not a refusal (the debt may predate a sale) |
| year before `arrearsCutoffYear` | otherwise `ARREARS_YEAR_NOT_BEFORE_CUTOFF`; every row refused while it is NULL (`ARREARS_CUTOFF_NOT_SET`) |
| prescribed (decision 14) | set to DROP, reason «مرور الزمن», `flags.prescribed` |
| amount > 0, a known fee type, `OTHER` with a description | refused |
| duplicate within the file, or against a live line | `ARREARS_LINE_DUPLICATE` |
| unit (or its building) read destroyed or not habitable | flagged with level and date; the accountant keeps or drops |
| archived file | a note; allowed (decision 12) |

Totals: kept, dropped (prescribed apart), unmatched, refused, and the file's sum
beside the batch's `controlTotal`. Coverage: the citizens of the set with no line.

## 7. The bill (task 5)

One `citizen_payments` row per KEEP line with a citizen:

- `arrearsLineId` set; `feeNoticeId` NULL; `periodKey` the year («2023»).
- **Number** «ARR-YYMM-NNNN» from `document_counters` (a new book, `DOCUMENT_PREFIX.ARREARS`),
  YYMM the month it entered the system, never `INV-`. The debt's own year is on the bill.
- `title` from the fee type, the year and the component.
- `dueDate` the line's, or 31 December of its year.
- `assessment.lines` carries the رقم العقار and the unit, so `ParcelDuesService` holds the
  parcel's «براءة ذمة» back on it.
- `issuedById` the approver (or the clerk who linked it).
- Archived files are billed here and nowhere else (decision 12).

Paying it changes nothing: the counter, «تسديد الفواتير المحددة», the portal and the
receipts read it as any bill, and the money reaches a wallet as any payment does.

**How it reads (task 10).** What marks the bill is the server's `arrears` field, never its number or its title: `BillArrearsView`
(shared-schemas `arrears.schema.ts`) — the year, the fee (`feeType`, and `feeTypeNote` for «رسم آخر»), the component (`PENALTY` is
marked), the رقم العقار and the unit, and `oldReference`, the old books' page or receipt book. `oldReference` is for staff only: the
portal's own list and the consolidated receipt never carry it, and `mySummary` clears it from the profile's bills
(`citizenArrears`; `bill-arrears.integration.spec.ts` pins every read). Screens word it through `ArrearsBillMark`
(`components/arrears-bill-mark.tsx`) and the rules in `lib/arrears-bill.ts`; the portal groups the old debts under
«متأخرات سنوات سابقة», the oldest year first, the order a settlement pays them in. On the printed receipt an old debt names its own
parcel, not the citizen's first card. «إلغاء الفاتورة» and «عكس الوصل» need no change: they read the same row (the spec cancels and
reverses on «ARR-» bills), and the cancel dialog asks staff to cite the old receipt when a citizen proves they paid.

## 8. What else it touches

- **`WRITTEN_OFF` in every read** (tasks 9, 10): any read that treats "not PAID" as owed
  must leave it out, as it leaves out CANCELLED.
- **A fee notice for a year before the cutoff** is refused, so no year is billed twice
  (task 6, built on `feat/arrears-fee-guards` (on `develop@c6e7462`): the preview and the issue refuse it, the recurring run skips the
  period; [finance.md](finance.md) §3.6b). Totals that report arrears include old-debt bills (task 6, built: pinned by
  `arrears-fee-guards.integration.spec.ts`; they already did, since no total reads a bill's notice). **Not built from
  task 6:** the cutoff setting's lock once a batch is approved, which belongs with the setter on `feat/arrears-approval`.
- **«دمج ملفين»** moves `arrears_lines.citizenId` and `arrears_batch_citizens`, and its
  undo puts them back (task 5, built). A live line the kept file already holds for the same debt stays on the absorbed
  file, as a colliding bill does.
- **The in-app backup** does **not** take the new tables, and this is a change from this plan: restore empties every
  table it carries, and the old-debts tables refuse a delete by trigger, as `payment_transactions` does, so adding them
  would make every restore fail once a batch exists. It is the same open question the ledger waits on, a decision for a
  person (docs/gotchas.md, "The in-app backup cannot restore old debts"). `BackupController` is unregistered today.
- **Reports** (task 11, built): `ArrearsReportService` reads the approved batches only (a draft, a submitted or a discarded one is
  in no figure), in SQL over the lines and their bills.
  - **By year × fee type** (a penalty with its fee): `billed` (the bills raised: the kept lines that have a citizen),
    and where each pound of it stands now — `collected` (a bill's `paidAmount`, net of reversed receipts), `cancelled` (the face value
    of a bill cancelled with «إلغاء الفاتورة»), `writtenOff` (`writeOffAmount`) and `owed` (what a bill not cancelled or written off
    has left). The four add up to `billed`, in every row and in the total (`arrearsReportBalances`; the integration spec pins it).
    Kept lines with no citizen yet are `waiting` («للمطابقة»): no bill, so in none of the five.
  - **Against the old books**, per year: `imported` is every line the approved batches read — kept, dropped and unmatched alike, as the
    batch's own control total counts them, since the pages held all of them — with `prescribed` (decision 14) and the other drops
    apart, beside `controlTotal` from `arrears_control_totals` and `remainingToImport` (`controlTotal − imported`, never below
    zero; null with no total). A year with a total and nothing imported is listed.
  - **Coverage**: the citizens in an approved batch's set (checked, whether or not anything was owed) over every citizen file but one
    merged into another; archived files count, since an approved batch may reach them (decision 12).
  - **Collections**, apart because the annual «قطع الحساب» needs them apart: the net of `payment_transactions` (signed, a reversal
    is a negative row) by the calendar year of `occurredAt` in Beirut, on old-debt bills and on every other bill, per currency.
  - **The batch sheet**: for an APPROVED batch only (`ARREARS_BATCH_NOT_APPROVED`) — its code, who prepared, submitted and approved it
    and when, its totals, what it holds by year × fee × component, and the lines it dropped by رقم العقار with the reason, the
    prescribed ones marked. A4 portrait, signed by the preparer and the head of the municipality.
  - **No citizen anywhere**: sums, years and رقم العقار only; the CSV is the by-year table and goes through `csvCell`'s formula guard.

## 9. Roles

| Set (`role-sets.ts`) | Roles | For |
|---|---|---|
| `ARREARS_PREPARE_ROLES` | SUPER_ADMIN, ACCOUNTANT | export, import, submit, single line, link |
| `ARREARS_APPROVE_ROLES` | SUPER_ADMIN | approve, return, discard a submitted batch, the cutoff, control totals |
| `BILL_WRITE_OFF_ROLES` | SUPER_ADMIN | «شطب» |
| `ARREARS_REPORT_ROLES` | SUPER_ADMIN, ACCOUNTANT, AUDITOR, VIEWER | «تقرير المتأخرات» and a batch's sheet: the finance reports' readers (`TREASURY_READ_ROLES`) |

## 10. Tasks

ClickUp list «Mechanization – Old debts (البقايا)». Hashem: 1–6 and 12. Abed: 7–11.

| # | Task | Ships |
|---|---|---|
| 1 | This spec, the decisions, open-decisions §23 | docs PR |
| 2 | `0107` + `0108` (§3) | `chore/migration-0107-old-debts`, before any code |
| 3 | The contract: `arrears.schema.ts`, role sets, `ARREARS` book, error codes | shared-schemas |
| 4 | Export and the import dry run (§4.1–4.3, §6) | backend |
| 5 | Submit, approve, return, discard; the bills; single line; link; merge (built); backup (not built: §8); the cutoff year | backend |
| 6 | The cutoff on fee notices; totals that include old debts | backend |
| 7 | UI: export, import preview, submit | frontend |
| 8 | UI: approval and «للمطابقة» | frontend |
| 9 | «شطب» (backend + UI) | both |
| 10 | Old-debt bills shown properly everywhere a bill appears, portal included | both: `arrears` on the bill's views (§7), then the screens (built) |
| 11 | Old-debts report and the batch sheet | both (built: §8, `feat/arrears-report`) |
| 12 | Release, then the first real batch | ops |

## 11. What to get from the municipality

The fee-type list; a photo of one page of the old books; the arrears total per year from
the last closed accounts; and the legal adviser's answer on prescription (§2.3).
