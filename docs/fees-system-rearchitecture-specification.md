# Tiered Area Fees (`TIERED_AREA`): Specification and Phased Plan

> **Status:** Revised 2026-10-23 with the product decisions below. Replaces the
> earlier draft, which re-specified rules the fee engine already has and
> contradicted decisions already taken (D28, migration 0075).
> **Last verified against the code:** `develop@b2c18dd`, 2026-10-23.
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
| **D6 Batch cancel** | Cancelling a notice cancels every bill nothing has been paid on, leaves bills with money on them (`paidAmount > 0`) or a claim waiting (`PENDING_REVIEW`), reports which and why, and sets the notice `isActive = false` so the recurring run does not re-issue it. |
| **D7 Bracket scope** | Staff choose, per bracket, which unit types it applies to (any of `UnitType`) and its level count. |

### Still open

| # | Question | Until decided |
|---|---|---|
| O1 | Fixed amounts for designated entities (a school, a gas station): which unit field identifies them? | Not built. No `designatedOverrides`. |
| O2 | On the citizen portal, does a shared unit bill show the **names** of the other people it is shared with, or only "shared with N others"? Names expose one citizen's holdings to another. | Show the count only. |

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

### Phase 5: issuing

- `issue` and `runRecurringBilling` write own bills and shared bills (with
  their debtors) in one `runInTenantTransaction`; shared bills get invoice
  numbers like any other.
- Commit: `feat(fees): issue tiered notices with shared unit bills`

### Phase 6: shared bills wherever a bill is read

Every place that reads a bill's citizen, found by the compiler after 0099:

- Portal `payments/mine` and the outstanding balance: own bills plus shared
  bills where the citizen is a debtor. O2: show the number of others, not names.
- `payments/mine/:id/whish/checkout` and `payments/mine/:id/declare`: allowed for any debtor.
- Settlement at the counter and bulk settlement: record `paidByCitizenId`.
- Receipts name the paying debtor.
- براءة ذمة (`citizen-requests`): an unpaid shared bill blocks every debtor.
- Staff lists, search, summary and reports: a shared bill is counted once, never once per debtor.
- `citizen-merge`: move debtor rows; refuse or fold a duplicate pair on one bill.
- Correction bills (`bill-corrections.ts`): trace changes on the unit and on each debtor.
- Commit: `feat(fees): shared unit bills in the portal, settlement, clearance and reports`

### Phase 7: batch cancel (D6)

- `FeesService.cancelNoticeBatch(noticeId, reason, actor)`, in one transaction:
  for each bill on the notice, apply `cancelBill`'s rules; cancel what passes;
  return `{ cancelled, skipped: [{ paymentId, invoiceNumber, reason }] }`; set
  `isActive = false`; one audit row per cancelled bill.
- `POST t/:tenantSlug/fees/notices/:id/cancel`, `@Roles(...BILL_CANCEL_ROLES)`,
  `ParseUUIDPipe`, body validated by `cancelBillSchema` (same reason rule).
- Tests: a notice with paid, part-paid, `PENDING_REVIEW` and untouched bills
  cancels only the untouched ones and reports the rest (T-10); the next
  recurring run issues nothing for it.
- Commit: `feat(fees): cancel a notice's untouched bills in one step`

### Phase 8: frontend

- `components/admin/issue-fee-form.tsx`: `TIERED_AREA` as a basis; a bracket
  editor (kit primitives only, [docs/ui-ux-standards.md](ui-ux-standards.md))
  grouped by unit type and level count, with the same overlap and gap checks
  the schema runs; the preview as a required step before «إصدار».
- `components/admin/building-unit-matrix-drawer.tsx`: the unit's bracket and
  estimated fee under the active tiered notice, via `matchBracket`.
- The notice list on the fees page: «إلغاء الإشعار» for `BILL_CANCEL_ROLES`,
  showing what will be cancelled and what will be skipped. There is no notice
  detail page today.
- Portal: a shared bill labelled as shared, with the count of others (O2).
- New copy in `messages/ar.json` and `messages/en.json`; the §16 pre-merge
  checklist in ui-ux-standards.
- Commit: `feat(fees): tiered bracket editor, notice preview and batch cancel in the dashboard`

### Phase 9: verification and docs

- `pnpm --filter @mechanization/backend test`, `pnpm --filter @mechanization/frontend test`, `pnpm build:check`.
- `FLAT`, `PER_UNIT` and `PER_AREA` notices issue byte-for-byte what they did before (T-11).
- Docs: `docs/database.md`, `apps/backend/CLAUDE.md`, `docs/security.md`
  (new routes), `packages/shared-schemas/CLAUDE.md`, `docs/finance.md` (shared
  bills and the treasury), `PRODUCT.md` (a user-facing capability), a status
  note on `docs/open-decisions.md` §11, and `docs/financial-features-testing-matrix.md`.
- Commit: `test(fees): tiered area fees end to end`

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
