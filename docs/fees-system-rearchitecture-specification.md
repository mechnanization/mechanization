# Tiered Area Fees (`TIERED_AREA`): Specification and Phased Plan

> **Status:** Revised 2026-10-23 with the product decisions below, and on
> 2026-10-26 with the decisions of the review of PRs #133–#138 (D8–D14; D6
> amended by D12). Replaces the earlier draft, which re-specified rules the fee
> engine already has and contradicted decisions already taken (D28, migration 0075).
> **Last verified against the code:** `fix/fee-wizard-review` (on
> `feat/tiered-fees-cancel-and-wizard@aa35d4a`): the review's fixes and §1's
> D8–D14, 2026-10-26; the §16 render check, and production's fee tables read
> through `prod_ro`, 2026-10-27; `develop@b2c18dd`, 2026-10-23.
> **Legislative reference:** Lebanese Municipal Fees and Surcharges Law No. 60/1988.
> The bracket figures themselves are the assessment committee's (لجنة التخمين)
> and the council's; the system stores them, it does not derive them.
> **Branches:** `chore/migration-0098-0099` (SQL and `schema.prisma` only, merged
> first), then `feat/tiered-fees-matrix-engine`. Both target `develop`.

**What this adds:** a fourth fee basis, `TIERED_AREA`, where staff enter a table
of area brackets (A, B, C …) on the notice and each unit is charged the bracket
its area falls in; a pre-issuance preview; shared unit bills for units with
several registered citizens; and cancelling a notice's whole batch.

**What this does not touch:** `FLAT`, `PER_UNIT` and `PER_AREA` notices bill
exactly as they do today, including the 0075 co-owner split
(`OwnerBillingMode`) and the D28 roof factor (`levelFactors`).

---

## 1. Decisions

Taken by the product owner on 2026-10-23. Code follows these; where an older
document says otherwise, these win.

| # | Decision |
|---|---|
| **D1 Duplex and triplex** | Staff enter separate brackets per level count: a table for one-level units, one for duplex (2), one for triplex (3). A unit is matched on its recorded `unitArea` (the whole unit, every level). Under `TIERED_AREA` the D28 roof factor does **not** apply; the duplex and triplex tables replace it. A unit whose level count no bracket covers is reported unassessable, never priced by guess (the rule `levelFactors` already follows). Keeping a duplex from costing more than two separate flats is the staff's responsibility when filling the tables. |
| **D2 No change rounding, no new reversal** | Out of scope: rounding change to a banknote, and any new payment reversal. The system must match the cash box to the ليرة. Mistakes go through what exists: «إلغاء الفاتورة» (`POST fees/payments/:id/cancel`) before money is taken, correction bills, and the existing transaction reversal (`POST fees/transactions/:transactionId/reverse`, `PAYMENT_REVERSE_ROLES`), which this spec leaves unchanged. |
| **D3 Who is billed** | Each registered citizen file is رب الأسرة. There is no household scope and no head-of-household lookup: `familyScope`, `FEE_FAMILY_SCOPE` and `resolveDebtor` are dropped. |
| **D4 Bill shape** | One bill per citizen, per notice, per period, as today. Each line in `assessment.lines` records the unit's bracket. |
| **D5 Shared unit bills** | **`TIERED_AREA` only.** When the bearer rule charges two or more citizens for the same unit (co-owners, or co-tenants under an occupant-borne notice), the unit gets **one bill for the full bracket amount**, not split. It appears on every one of those citizens' profiles. Any of them may pay it, in part or in full; once paid it is PAID for all of them. While it is unpaid it blocks براءة ذمة for every one of them. Deed shares (أسهم) are not used. |
| **D6 Batch cancel** | Cancelling a notice cancels every bill nothing has been paid on, leaves bills with money on them (`paidAmount > 0`) or a claim waiting (`PENDING_REVIEW`), reports which and why, and sets the notice `isActive = false` so the recurring run does not re-issue it. **Amended 2026-10-26 by D12:** the bills of the periods the manager names, not every period; stopping is its own act. |
| **D7 Bracket scope** | Staff choose, per bracket, which unit types it applies to (any of `UnitType`) and its level count. |

### Decisions of the review (2026-10-26)

Taken by the user on the review of PRs #133–#138, on the review's
recommendations. D12 amends D6.

| # | Decision | Grounds |
|---|---|---|
| **D8 A period's bill stands** | The recurring run comes back every night and the register moves between nights. A unit already on a bill of the notice for the period — a citizen's own or a shared one, cancelled ones included — is billed to nobody again in that period; a change of holders counts from the next period. Each tiered line records its census `unitId` so the run can tell. Before this, a flat billed to its one owner on the 1st and given a co-owner on the 10th was billed again on the 11th as a shared bill, the owner on both. | The rule the fee engine already keeps («a period's invoice is written once»); Law 60/1988 Art. 11 counts a part-month as a full month. |
| **D9 Receipts on a shared bill** | One receipt per payment: its own «RCP-» number, the debtor who paid (`paidByCitizenId`) and what they paid — printed from «وصولات الفاتورة», payment by payment. Never the bill's total under one name, and never from a debtor's file the receipt does not name. | `docs/finance.md`: each payment has its own receipt (decree 5595/1982 Art. 16 and 98: a receipt is written when the money is taken). A co-debtor who paid has a claim on the others, and the receipt is their evidence. |
| **D10 A holder whose own bill is withheld** | A citizen who cannot be assessed — a unit with no area, a level count the table lacks, an unsurveyed building — gets no own bill and is named in the report, as before, but is still a debtor on every shared unit that can be priced: the gap is on another unit and changes nothing about this one's bracket. A unit only they hold is billed to nobody until the record is fixed. | D5: the bearer rule charged them for the unit. Not billing a correctly priced unit over a gap elsewhere would be an exemption the law does not grant (exemption is by law only). |
| **D11 Units the table does not price** | A unit whose type no bracket names, and a card with no unit type (أرض، خيمة), are outside the notice: not charged, counted on the bill (`outsideTableUnitCount`) and in the preview by type. A listed type whose level count or area no bracket covers stays unassessable (D1, T-5). | Law 60/1988's rental-value fee falls on occupied built property (Arts. 3–4); vacant land is outside it (the Ministry of Interior's 2025 roadmap recommends amending Art. 3 to bring it in). D7: staff choose which types a bracket applies to. |
| **D12 Stop and cancel are two acts** | «إيقاف الإشعار» stops a recurring notice and cancels nothing (`PATCH fees/notices/:id/active`, now on the notices page and in the trail). «إلغاء الإشعار» cancels the bills of the periods the manager names — the dialog shows each period's counts first, the latest with something to cancel ticked — and stops the notice too. | Exemption from municipal fees is by law only, and waiving municipal revenue needs the Minister of Interior's approval; cancelling a period's correct bills to end a fee would be that. Cancelling is for bills that should not have been raised. |
| **D13 A category on a category notice only** | `targetCategory` is refused on a notice to all citizens or to one (`createFeeNoticeSchema`), and dropped by `issue` for a caller that skips the schema. Notices already stored with one keep it: the municipality decides, notice by notice, whether each meant that category (retarget to «فئة عقارات») or everything (clear it), applied by the data-repair procedure. Production had none to decide on 2026-10-27: it had issued no notice yet. | The old wizard sent its default «محل تجاري» with every target, and the assessment filters every unit by it, so a per-unit notice to all citizens charged their shops alone. Only the server stops every caller; a stored notice's meaning cannot be read off the record. |
| **D14 A merged-away file pays nothing** | The payer of a shared bill is a live file: the counter's list leaves out a file merged into another (its debtor row stays when both owed the bill), and the ledger refuses one (`CITIZEN_MERGED_AWAY`, naming the file that stays). | `merged-away.ts`: nothing is written against a merged-away file; the file that stays is already a debtor. |

### Still open

| # | Question | Until decided |
|---|---|---|
| O1 | Fixed amounts for designated entities (a school, a gas station): which unit field identifies them? | Not built. No `designatedOverrides`. |
| O2 | On the citizen portal, does a shared unit bill show the **names** of the other people it is shared with, or only "shared with N others"? Names expose one citizen's holdings to another. | Show the count only. |
| O3 | May a debtor pay a shared unit bill online, or report a Whish transfer for it? Either needs the bill to remember which debtor made the claim (a new nullable column, its own migration), so the clerk's confirmation can name the payer. | **Decided 2026-10-23, for now:** paid at the municipal office only (`SHARED_BILL_PAY_AT_OFFICE`); no migration until online payment for shared bills is wanted. **2026-10-26:** stays so while online payment is paused (`docs/open-decisions.md` §21). When it reopens, the payer is recorded on the Whish checkout the signed-in debtor opens (a nullable column on `whish_checkouts`, in its own migration PR), and the success callback names it as `paidByCitizenId`. |

---

## 2. What already exists (reuse, do not rebuild)

| Concern | Where it lives | Under `TIERED_AREA` |
|---|---|---|
| Assessing a citizen's holdings into a bill | `assessCitizen`, [fees.service.ts](../apps/backend/src/application/features/fees/fees.service.ts) | Gets a `TIERED_AREA` branch |
| Who bears the fee (occupant or owner); a unit with no recorded status reads as owner-occupied | `FeeBearer`, `occupancy-fanout.spec.ts` | Unchanged |
| Fee exemptions («معفاة من الرسوم») | `Unit.feeExemption`, `fee-exemption.spec.ts` | Unchanged: exempt units are not charged |
| Uninhabitable units (decision §16) | `buildings/habitability.ts` | Unchanged: not charged |
| Units held under review | `assessCitizen` (`inReview`) | Unchanged |
| Unit levels | [unit-levels.ts](../packages/shared-schemas/src/unit-levels.ts) (`unitLevels`, `canSpanLevels`) | Used to pick the bracket table (D1) |
| Co-owner split (`EQUAL` / `BY_SHARES` / `RESPONSIBLE_OWNER`) | [owner-share.ts](../packages/shared-schemas/src/owner-share.ts), migration 0075 | **Not used**; D5 replaces it for tiered notices only |
| Invoice numbers `INV-YYMM-NNNN` | `document_counters`, migration 0079 | Unchanged; shared bills get numbers the same way |
| Idempotent issue | `fee_notices.clientRequestId` (0091) | Unchanged |
| Cancelling one bill | `cancelBill`, `BILL_CANCEL_ROLES` | The batch cancel applies its rules per bill |
| Cash tender and change | `toTender`, `creditOf`, `tendered-cash.spec.ts` | Unchanged (D2) |

---

## 3. Data model

### 3.1 Migrations (own PR, merged before any code that writes them)

**0098** adds the enum value and nothing else. Postgres cannot use a new enum
value in the transaction that added it ([docs/database.md](database.md#add-an-enum-value)).

```sql
ALTER TYPE "FeeBasis" ADD VALUE IF NOT EXISTS 'TIERED_AREA';
```

**0099** adds everything else. Additive only: new columns are nullable, the
one constraint relaxed is `citizen_payments."citizenId"` NOT NULL, and the
existing per-citizen unique key is left exactly as it is.

- `fee_notices."matrixBrackets" jsonb NULL`: the bracket table (§4.1).
  CHECK: present exactly when `basis = 'TIERED_AREA'`.
- `citizen_payments."unitId" uuid NULL`, FK to `units` `ON DELETE RESTRICT`:
  set **only** on a shared unit bill.
- `citizen_payments."citizenId"` becomes nullable. CHECK:
  `("citizenId" IS NULL) = ("unitId" IS NOT NULL)`: a bill belongs to one
  citizen or to one unit, never both, never neither. CHECK: a shared bill has a
  `feeNoticeId`.
- Partial unique index on `citizen_payments ("unitId", "feeNoticeId", "periodKey")
  WHERE "unitId" IS NOT NULL`: the double-billing guard for shared bills. The
  existing `citizen_payments_citizenId_feeNoticeId_periodKey_key` keeps guarding
  per-citizen bills; shared bills have a NULL `citizenId` and never collide with it.
- New table `citizen_payment_debtors` (name to confirm at review):
  `paymentId` (FK `citizen_payments`, `ON DELETE CASCADE`), `citizenId` (FK
  `users`, `ON DELETE RESTRICT`), `role "OccupancyRole"` (OWNER, TENANT,
  FREE_OCCUPANT), primary key (`paymentId`, `citizenId`). Written once at issue:
  the people registered on the unit **when the bill was raised**, like
  `assessment`. Index on `citizenId` (the portal read).
- `payment_transactions."paidByCitizenId" uuid NULL`, FK `users`: on a shared
  bill, which debtor the money came from, for the receipt. NULL on every other
  transaction. CHECK in code, not SQL: it must be one of the bill's debtors.

The new table points at citizens: list it in `BackupService` `TABLE_ORDER`, and
confirm `setup-claude-ro.sql` does not expose it ([docs/database.md](database.md)).

Making `citizenId` nullable changes its Prisma type to `string | null`. That is
intended: every read of a bill's citizen (about 70 in fees, citizen-requests
and treasury alone) has to decide what a shared bill means there, and the
compiler lists them.

### 3.2 Prisma (add fields only; do not paste models)

```prisma
model FeeNotice {
  // … existing fields unchanged …
  /// The bracket table under TIERED_AREA (0099). Null under every other basis.
  matrixBrackets Json?
}

model CitizenPayment {
  // … existing fields unchanged, except:
  citizenId String? @db.Uuid   // was String; null exactly on a shared unit bill
  citizen   User?   @relation(fields: [citizenId], references: [id], onDelete: Cascade)
  /// The unit a shared bill is for (0099, TIERED_AREA only). Null otherwise.
  unitId    String? @db.Uuid
  unit      Unit?   @relation(fields: [unitId], references: [id], onDelete: Restrict)
  debtors   CitizenPaymentDebtor[]
  // existing @@unique([citizenId, feeNoticeId, periodKey]) stays; the partial
  // unique index for shared bills lives in the SQL only (Prisma cannot express it)
}

model CitizenPaymentDebtor {
  paymentId String        @db.Uuid
  payment   CitizenPayment @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  citizenId String        @db.Uuid
  citizen   User          @relation(fields: [citizenId], references: [id], onDelete: Restrict)
  role      OccupancyRole
  createdAt DateTime      @default(now())

  @@id([paymentId, citizenId])
  @@index([citizenId])
  @@map("citizen_payment_debtors")
}
```

Plus `paidByCitizenId` on `PaymentTransaction`, and the back-relations on `User`
and `Unit`.

---

## 4. Shared schemas

### 4.1 Brackets

```ts
// packages/shared-schemas/src/fee.schema.ts
export const FEE_BASIS = ['FLAT', 'PER_UNIT', 'PER_AREA', 'TIERED_AREA'] as const;

export const feeMatrixBracketSchema = z
  .object({
    code: z.string().trim().min(1),                    // «A», «B» …
    labelAr: z.string().trim().min(1),
    unitTypes: z.array(z.enum(UNIT_TYPE)).min(1),       // D7
    levels: unitLevelsField.default(1),                 // D1: 1, 2 (duplex), 3 (triplex) …
    minArea: z.number().nonnegative(),                  // inclusive
    maxArea: z.number().positive().nullable(),          // exclusive; null = no ceiling
    amount: /* the same money rule as a notice amount, in the notice's currency */,
  })
  .refine((b) => b.maxArea === null || b.maxArea > b.minArea, { path: ['maxArea'] })
  .refine((b) => b.levels === 1 || b.unitTypes.every(canSpanLevels), { path: ['levels'] });

export const feeMatrixSchema = z.array(feeMatrixBracketSchema).min(1).superRefine((brackets, ctx) => {
  // For every (unitType, levels) pair the brackets cover, sorted by minArea:
  //  - no two ranges overlap;
  //  - no gap: each minArea equals the previous maxArea;
  //  - only the last may be open-ended.
  // Codes are unique across the table.
});
```

Ranges include their minimum and exclude their maximum, so 100 m² sits in
exactly one of `[50, 100)` and `[100, 150)`, and a decimal area such as 100.5 m²
cannot fall into a gap. There is no currency per bracket: the notice's currency
governs. `UNIT_TYPE` and `unitLevelsField` must be the existing exports; check
`enums.ts` and `unit-levels.ts` before writing this.

### 4.2 Notice, preview, assessment

- `createFeeNoticeSchema`: `matrixBrackets: feeMatrixSchema` is required when
  `basis === 'TIERED_AREA'` and refused otherwise. Under `TIERED_AREA`, `amount`
  is 0 and ignored: the brackets carry the money (the column has no CHECK).
- `feeNoticePreviewSchema`: the same shape as `createFeeNoticeSchema` minus
  `clientRequestId`. The preview reads what the issue would read.
- `feeNoticePreviewResultSchema` (Phase 4; a zod schema, not only an interface):
  citizens billed, shared unit bills, units charged, expected revenue in the
  notice's currency, count and subtotal per bracket code, units not charged by
  reason (exempt, uninhabitable, under review, relieved by the bearer rule), and
  unassessable units by reason (no area, no bracket for this type and level
  count). Reasons reuse the codes `assessCitizen` already reports where one exists.
- `FeeAssessmentLine` gains `bracketCode` and `bracketLabel` (optional, set
  under `TIERED_AREA`).
- `FEE_BASIS` label for `TIERED_AREA` in both locales in `labels.ts`.

---

## 5. Calculation

1. `matchBracket(unit, brackets)` is a pure function in shared-schemas, so
   the unit drawer (Phase 8) shows the same answer the biller charges. It
   returns the bracket, or a miss: `NO_AREA`, or `NO_BRACKET` for a type, level
   count or area the table does not price.
2. `assessCitizen` gets a `TIERED_AREA` branch beside `PER_UNIT` and
   `PER_AREA` (`priceTieredUnits`, `tiered-area.ts`). Exemptions,
   habitability, review holds and the bearer rule run first, unchanged; the
   branch prices only the units they leave chargeable, each unit once per
   citizen. `levelFactors` is not read (D1), and neither are the 0075
   co-owner methods or a missing أسهم (D5). A miss makes the citizen
   unassessable, named in the report, as a unit with no area does under
   `PER_AREA`.
3. **Shared units (D5).** The run (`splitSharedUnitBills`) takes every unit
   two or more citizens' assessments price off their own bills and bills it
   once: `unitId` set, `citizenId` NULL, the full bracket amount, one
   `citizen_payment_debtors` row per person, in citizen-id order with the
   capacity each is charged in. A citizen can therefore have one own bill and
   several shared bills on the same notice; their own bill counts the units
   moved (`sharedBillUnitCount`), a shared bill its debtors
   (`sharedBillDebtorCount`). Two cases are not shared:
   - a card-only unit has no census id and cannot be matched across citizens,
     so it stays on each holder's own bill, as under every other basis;
   - a unit whose holders' records put it in different brackets (the census
     unit has no area and two cards measured it differently) is billed to
     nobody and reported as a conflict, rather than choosing a record.
4. Nothing is split, so there is no rounding remainder.

---

## 6. Phases

Each phase is one commit or a small series. `pnpm typecheck` and `pnpm lint`
pass after every phase; each phase updates the docs its paths map to in
CLAUDE.md, "Keeping the docs true".

### Phase 1: migrations (PR `chore/migration-0098-0099`)

- `0098_fee_basis_tiered_area/migration.sql`, `0099_tiered_fee_matrix/migration.sql`, `schema.prisma`.
- Done when: `pnpm db:deploy:local` applies both; the integration suites pass
  on a throwaway Postgres 17; every existing `citizen_payments` row still has a
  `citizenId` and a NULL `unitId`; `docs/database.md` lists the new table and columns.
- Commit: `chore(db): tenant migrations 0098 and 0099 for tiered area fees and shared unit bills`

### Phase 2: shared schemas

- §4: `FEE_BASIS`, labels, `feeMatrixBracketSchema`, `feeMatrixSchema`,
  `bracketScales`, `feeNoticePreviewSchema`, `createFeeNoticeSchema`,
  `FeeAssessmentLine`. The preview's *result* schema moved to Phase 4, beside
  the code that computes it.
- Two guards until the later phases remove them: `assessCitizen` throws on
  `TIERED_AREA` instead of falling through to the per-unit arithmetic (Phase 3
  replaces it), and the wizard does not offer `TIERED_AREA` (Phase 8).
- Tests: overlap, gap, open-ended top bracket only last, boundary at exactly
  `maxArea`, duplicate codes, levels on a non-dwelling type refused, brackets
  sent under another basis refused.
- Done when: `pnpm --filter @mechanization/shared-schemas build` and its tests pass.
- Commit: `feat(fees): tiered area bracket schemas and the TIERED_AREA basis`

### Phase 3: calculation

- §5: `priceTieredUnits`, `tieredAssessment` and `splitSharedUnitBills` in
  `fees/tiered-area.ts`, the branch in `assessCitizen`, `matchBracket` in
  shared-schemas. Nothing is written yet: the Phase 2 guard moves from
  `assessCitizen`, which can now price a tiered notice, to `issue`, until
  Phase 5 writes the notice's table and the shared bills.
- Tests: §8, cases T-1 to T-8.
- Commit: `feat(fees): price units by area bracket and bill shared units once`

### Phase 4: preview

- `FeesService.planNotice(input, citizenIds)` is the read-and-assess half of
  `issue`: the assessment, the shared-unit split and the counts. `issue` and
  `FeesService.previewNotice(input)` both call it; the preview writes nothing
  (no notice, bill, audit row or event), so it takes no actor.
- `POST t/:tenantSlug/fees/notices/preview`, `@Roles(...FEE_ISSUE_ROLES)`,
  `ZodValidationPipe(feeNoticePreviewSchema)`, `@HttpCode(200)`; the answer is
  `feeNoticePreviewResultSchema`. A notice that targets nobody previews as
  zeros rather than refusing. `previewFeeNotice` in the frontend's api-client.
- Tests (`fee-preview.integration.spec.ts`): counts of `fee_notices`,
  `citizen_payments`, `citizen_payment_debtors` and the audit log unchanged
  after a preview; a `PER_UNIT` preview equals the issue that follows, to the
  citizen and the pound (T-9). The same check for `TIERED_AREA` lands with
  Phase 5, when it can be issued. The preview's roles are pinned to the
  issue's in `route-inventory.spec.ts`.
- Commit: `feat(fees): preview a notice's bills before issuing it`

### Phase 5: issuing, with the readers that had to change with it

Built on `feat/tiered-fees-shared-bills`. Writing a shared bill makes a bill's
`citizenId` nullable in Prisma, and every read of it had to decide what a
shared bill means in the same change, so this phase took part of Phase 6:

- `issue` and `runRecurringBilling` plan through `planNotice` and write
  through `writeBills`: own bills, then shared bills with ids given up front so
  their debtors are written only for the bills inserted (a re-run of a period
  writes nothing), then one numbering pass. The notice keeps its table
  (`matrixBrackets`); a stored table that no longer parses fails that notice's
  recurring run. `issue` answers `sharedBills` and `sharedUnitConflicts`.
- The counter: `settlePaymentSchema.paidByCitizenId`; the ledger requires it on
  a shared bill, checks it is a debtor, refuses it on an own bill
  (`SHARED_BILL_PAYER_*`), and a reversal carries it.
- Staff readers: the payments list and the verification queue (`billHolder`,
  `sharedUnit`), the audit view (the unit, linked to its building), the
  collector's two views (the paying debtor, the shared unit's sector and
  door), the parcel report's per-person standing (a debtor's shared bills
  included).
- «المستحق على عقار» left-joins the citizen, so an unpaid shared bill on a
  parcel blocks its براءة ذمة (the clearance reads parcel dues).
- `citizen-merge` moves the absorbed person's debtor rows, leaves a row on a
  bill both already owe, and the undo moves them back (`sharedBillDebts`).
- Backup: `citizenPaymentDebtor` in `TABLE_ORDER`, snapshot version 5.
- Frontend: the screens that read a bill's citizen name a shared bill by its
  unit and count (`common.sharedUnitBill`), and offer no receipt reprint or
  bulk settlement for one.
- Tests: `shared-unit-bills.integration.spec.ts` (issue as previewed, T-8 and
  T-9; the parcel's dues; the counter's three refusals and the paid bill with
  its payer; the recurring run once a period), and a merge-and-undo test in
  `citizen-merge.integration.spec.ts`.
- Commit: `feat(fees): issue tiered notices with shared unit bills`

### Phase 6: shared bills where a person reads their own

Built on `feat/tiered-fees-debtor-views`. What a person owes is their own bills
and the shared bills they are a debtor on (`billsOwedBy`, and its SQL twin in
the register):

- Portal `payments/mine`, the portal summary and the staff citizen file
  (`getCitizenProfile`): a debtor's shared bills, with `sharedUnit` — the unit
  and the number of others, never names (O2). The portal explains a shared bill
  and offers no payment action for it.
- `payments/mine/:id/declare` and `…/whish/checkout`: **refused** for a debtor's
  shared bill (`SHARED_BILL_PAY_AT_OFFICE`), not allowed as first planned. A
  claim is confirmed later by a clerk, the ledger takes money on a shared bill
  only with its payer named, and the bill keeps no claimant: a claim could
  never be confirmed. See O3. A citizen who is not a debtor is answered
  `PAYMENT_NOT_FOUND`, as for any bill not theirs.
- The register: each person's figures include their shared bills; the money
  totals sum distinct bills, so a shared bill counts once.
- The payments list filtered by citizen and the edit review's open bills: their
  shared bills too.
- Bulk settlement: a debtor's shared bills, the citizen settling named payer.
- Receipts: reprinted from the payer's file (`lastPaidByCitizenId` on the ledger
  row; the citizen file lists the shared bill).
- `describeAssessment`: each unit's bracket under `TIERED_AREA`, a shared bill
  shared between N, an own bill's units moved to shared bills — never «× 0».
- **Not done: correction bills.** They leave `TIERED_AREA` out
  (`correction-bills.service.ts`). Today's figure of a tiered bill depends on
  who else is charged for each unit, so it has to be recomputed across the run
  as `splitSharedUnitBills` does; one citizen at a time an own bill would be
  listed for shared units it never carried. Phase 6b.
- Tests: four more in `shared-unit-bills.integration.spec.ts` (every read of
  what a person owes and the register's once-only total; the claim refusal;
  bulk settlement with the payer); `describeAssessment` in
  `fee-assessment.test.ts`.
- Commit: `feat(fees): shared unit bills in the portal and a citizen's own reads`

### Phase 7: batch cancel (D6)

Built on `feat/tiered-fees-cancel-and-wizard`.

- `FeesService.cancelNoticeBatch(noticeId, reason, actor)`, in one transaction:
  every bill of the notice locked, `billCancelRefusal` (the rule `cancelBill`
  now applies too) on each; what passes cancelled in one `updateMany`, with a
  `FEE_BILL_CANCELLED` row per bill and any waiting municipal request cancelled
  with its bill; what fails left as it is and returned as
  `{ paymentId, invoiceNumber, reason }`; the notice `isActive = false` and a
  `FEE_NOTICE_CANCELLED` row on it. Answers
  `{ noticeId, cancelled, skipped, deactivated }`; a second press cancels
  nothing more.
- `POST t/:tenantSlug/fees/notices/:id/cancel`, `@Roles(...BILL_CANCEL_ROLES)`
  (pinned to the single cancel's), `ParseUUIDPipe`, body validated by
  `cancelBillSchema` (same reason rule), 200. `cancelFeeNotice` in the
  frontend's api-client; the button is Phase 8.
- Tests (`notice-batch-cancel.integration.spec.ts`): a notice with paid,
  part-paid, `PENDING_REVIEW` and untouched bills cancels only the untouched
  one and reports the rest (T-10); the notice stops and the next recurring run
  issues nothing for it; a second press and an unknown notice.
- Commit: `feat(fees): cancel a notice's untouched bills in one step`

### Phase 8: frontend

Built on `feat/tiered-fees-cancel-and-wizard`, in three commits:

- **The wizard** (`components/admin/issue-fee-form.tsx`): `TIERED_AREA` as a
  basis, the bracket editor (`components/admin/fees/tiered-matrix-editor.tsx`:
  kit primitives only, checked by `feeMatrixSchema` through `matrixIssues`), and
  «معاينة قبل الإصدار» (`components/admin/fees/notice-preview.tsx`) as a
  required step before «إصدار», for every basis. One notice payload for the
  preview and the issue (`lib/fee-notice-draft.ts`, `noticePayload`), which
  also stopped the wizard sending its default category with every target (a
  per-unit notice to all citizens had charged their shops alone).
- **The counter** («تسجيل دفعة»): a shared bill's payer chosen from its debtors
  (`sharedDebtors` on `GET fees/payments/:id`), required, sent as
  `paidByCitizenId`.
- **«إشعارات الرسوم»** (`/fees/notices`): there was no notice list, so it was
  added, with «إلغاء الإشعار» for `BILL_CANCEL_ROLES` behind a `ConfirmDialog`
  that says what is cancelled, what is left and that it cannot be undone; the
  bills left are listed after.
- Portal: a shared bill labelled as shared, with the count of others (O2) —
  done in Phase 6.
- New copy in both message files. `PRODUCT.md` updated.
- **Not done:** the unit drawer's estimate (`building-unit-matrix-drawer.tsx`,
  the unit's bracket under each active tiered notice via `matchBracket`): the
  drawer is a census screen whose roles do not read the fees, and the notices
  it would read carry no table yet (`GET fees/notices` does not return
  `matrixBrackets`). And the §16 pre-merge checklist's rendering (360/1440,
  light/dark, ar/en) was not run: no browser harness was set up.
- Commits: `feat(fees): tiered bracket editor and the notice preview in the
  issue wizard`, `feat(fees): choose the payer of a shared unit bill at the
  counter`, `feat(fees): the fee notices page and «إلغاء الإشعار»`.

### Phase 9: verification and docs

- `pnpm --filter @mechanization/backend test`, `pnpm --filter @mechanization/frontend test`, `pnpm build:check`.
- `FLAT`, `PER_UNIT` and `PER_AREA` notices issue byte-for-byte what they did before (T-11).
- Docs: `docs/database.md`, `apps/backend/CLAUDE.md`, `docs/security.md`
  (new routes), `packages/shared-schemas/CLAUDE.md`, `docs/finance.md` (shared
  bills and the treasury), `PRODUCT.md` (a user-facing capability), a status
  note on `docs/open-decisions.md` §11, and `docs/financial-features-testing-matrix.md`.
- Commit: `test(fees): tiered area fees end to end`

### Phase 10: the review's fixes (2026-10-26)

Built on `fix/fee-wizard-review` (PR #138), on top of the stack. The review of
PRs #133–#138 found three defects that block the release and five decisions,
recorded as D8–D14 above.

- **D8, the recurring run.** `writeBills`'s transaction locks the notice's row
  (`FOR UPDATE`), re-reads `isActive`, and for `TIERED_AREA` reads the units the
  period already billed (`unitsBilledInPeriod`: shared bills' `unitId`, own
  bills' line `unitId`) and splits again without them (`splitSharedUnitBills`'
  `alreadyBilled`). Each tiered line carries its `unitId`. A bill says what left
  it: `billedElsewhereUnitCount`, `sharedConflictUnitCount`.
- **D9, receipts.** `GET fees/payments/:id/transactions` names each payment's
  payer on a shared bill (`paidByCitizenId`, `paidByName`); «وصولات الفاتورة»
  prints that payment's receipt from the payer's file (`receiptOfEntry`). The
  citizen file and the fees and payments lists no longer reprint a shared bill's
  total; they link to «وصولات الفاتورة». The bill's cash page, opened from a
  debtor's file, names that debtor as the payer (it was refused with
  `SHARED_BILL_PAYER_REQUIRED` before).
- **D10, D11, pricing.** `priceTieredUnits` prices every unit it can and
  returns the units outside the table and why the own bill is withheld;
  `assessTargets` hands the withheld with their priced units to the split
  (`withheld`). The preview counts the units outside the table by type.
- **D12, the notices page.** «إيقاف الإشعار» / «استئناف الإشعار»
  (`FEE_ADMIN_ROLES`, audited `FEE_NOTICE_STOPPED` / `FEE_NOTICE_RESUMED`);
  «إلغاء الإشعار» takes `periodKeys` (`cancelNoticeSchema`) and shows each
  period first (`GET fees/notices/:id/periods`, `BILL_CANCEL_ROLES`). The cancel
  locks the notice's row first, as the run does, and writes its audit rows in one
  statement (`AuditService.recordManyInTransaction`).
- **D13** in `refineFeeNotice` and `issue`; **D14** in `getPaymentById` and
  `recordIn`.
- **The register's figures** (`CitizensService.list`): «what a person owes»
  read through the two indexes (`p.id IN (own UNION ALL debtor rows)`), and the
  headline totals from a `searched` set joined by `UNION`, instead of an `OR`
  around a correlated `EXISTS`.
- **Release order.** `chore/migration-0098-0099` (#133) reaches `main` alone.
  #134–#138 then ship as **one** release: each step alone has a known defect
  (#135 alone fails the corrections page, #135–#136 issue shared bills the counter
  cannot take money on). The first tiered notice is issued once that release has
  run without trouble: 0099's header says a rollback past it is safe only while
  no shared bill exists. On 2026-10-27 production's last tenant migration was
  0097 and it had issued no notice and no bill, so 0098/0099 meet empty fee tables.
- **Rendered** (§16, 2026-10-27), against fabricated data: the notices page, its
  cancel and stop dialogs, the periods' loading, error and empty states, and a
  shared bill's receipts, in Arabic and English at 360 and 1440px, light and
  dark, and the cancel by keyboard alone. It caught the phone card's two buttons
  drawn over each other (`!w-auto`, UI §17.4) and an Arabic title reordering an
  English sentence (now isolated, RTL-2).
- **Not done:** correction bills for `TIERED_AREA` (Phase 6b, a debt in
  `docs/code-quality.md`).
- Tests: T-14 to T-19 below, in `tiered-area.spec.ts`, `fee-matrix.spec.ts`,
  `notice-batch-cancel.integration.spec.ts`, `shared-unit-bills.integration.spec.ts`,
  `route-inventory.spec.ts`, `bill-receipts.test.ts` and `fee-assessment.test.ts`.

---

## 7. Not in this spec

- Change rounding to a banknote; a new payment reversal (D2).
- Designated-entity fixed amounts (O1).
- Household scope (D3).
- Any change to how `FLAT`, `PER_UNIT` or `PER_AREA` bill, including the 0075 co-owner split.

---

## 8. Test matrix

| # | Scenario | Expected |
|---|---|---|
| T-1 | Brackets `[0,100)` and `[90,150)` for the same unit type and level count | Refused: overlap |
| T-2 | Brackets `[0,100)` and `[101,150)` | Refused: gap |
| T-3 | A one-level flat of exactly 100 m² against `[0,100)` and `[100,150)` | Charged the `[100,150)` bracket |
| T-4 | A duplex of 220 m² with a duplex table | Charged the duplex table's bracket for 220 m²; `levelFactors` not applied |
| T-5 | A triplex when the notice has no triplex brackets | Unassessable («no bracket for this type and level count»); no bill line |
| T-6 | Occupant-borne notice on a unit recorded VACANT | Not charged (bearer rule, unchanged) |
| T-7 | A unit with no recorded status | Read as owner-occupied and charged (unchanged) |
| T-8 | A flat with three registered co-owners, bracket 30,000,000 LBP | One shared bill of 30,000,000 LBP, three debtor rows; shows on all three profiles; one pays it, it is PAID on all three |
| T-9 | Preview then issue the same notice | Preview writes nothing; its totals equal the issued totals |
| T-10 | Batch cancel with paid, part-paid, PENDING_REVIEW and untouched bills | Only the untouched are cancelled; the rest reported; notice inactive |
| T-11 | Existing `FLAT`, `PER_UNIT`, `PER_AREA` notices | Bill exactly as before |
| T-12 | A co-owner with an unpaid shared bill requests براءة ذمة | Refused until the shared bill is paid |
| T-13 | Exempt and uninhabitable units under `TIERED_AREA` | Not charged; counted in the preview by reason |
| T-14 | «إلغاء الإشعار» on a monthly notice for the latest period only | That period's untouched bills cancelled; the earlier period stays owed; the periods are named in the notice's audit row (D12) |
| T-15 | A flat billed to its one owner this month; a co-owner recorded mid-month; the run again | No second bill for the flat this month; next month one shared bill owed by both (D8) |
| T-16 | Three brothers own a shop; the youngest also owns a flat with no area | No own bill for him, named in the report; the shop's shared bill has all three as debtors (D10) |
| T-17 | A residential table issued to all citizens; a citizen holds a flat, a garage and a plot | The flat is billed; the garage and the plot counted outside the table, not refused (D11) |
| T-18 | A shared bill paid in two parts by two brothers, reprinted | Each receipt names its own payer and amount, the balance after it (D9) |
| T-19 | A shared bill's payer is a file merged into another | Not offered at the counter; refused by the ledger with `CITIZEN_MERGED_AWAY` (D14) |
