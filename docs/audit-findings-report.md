# Audit Findings & Financial System Review Report

Report generated during methodical financial audit and interactive testing.
Standard format compliant with `docs/claude-review-instructions.md`.

---

# Phase 5: Financial, Treasury & Billing Pages

## 1. Scope & Verified Components
- `apps/frontend/components/admin/issue-fee-form.tsx` (Fee notice issuance wizard)
- `packages/shared-schemas/src/fee.schema.ts` (`createFeeNoticeSchema`, `FeeBasis`, `FeeBearer`, `lbpAmount`)
- `apps/backend/src/infrastructure/prisma/tenant/schema.prisma` (`FeeNotice`, `CitizenPayment`, `PaymentTransaction`, `TreasuryAccount`, `TreasuryEntry`)
- `apps/backend/src/application/features/fees/fees.service.ts` (`assessCitizen`, fee assessment logic)
- `apps/backend/src/presentation/controllers/fees.controller.ts` (`@Post('notices')`, `@Post('payments/:id/settle')`)

---

## 2. Functional & Logic Analysis
- Verified treasury activation workflow and opening balances (`treasuryGoLiveAt`).
- Analyzed fee notice issuance wizard (`/fees/new`) across its 3 steps: Details, Targeting, Review.
- Inspected the three currently supported fee calculation bases:
  1. `FLAT` (`مبلغ ثابت لكل مواطن`)
  2. `PER_UNIT` (`المبلغ × عدد الوحدات`)
  3. `PER_AREA` (`المبلغ × إجمالي المساحة (م²)`)

---

## 3. Discovered Issues & Product Enhancements

### Issue 5.1: Fee Notice Currency Hardcoded to LBP (Cannot Issue in USD)
- **File / Location:** 
  - `apps/frontend/components/admin/issue-fee-form.tsx:L251`
  - `packages/shared-schemas/src/fee.schema.ts:L353` (`amount: lbpAmount`)
  - `apps/backend/src/infrastructure/prisma/tenant/schema.prisma:L2065` (`currency String @default("LBP")`)
- **Severity:** Medium / Functional Limitation
- **Description:** The fee notice creation wizard strictly enforces `amount: lbpAmount` and labels the input as "المبلغ بالليرة اللبنانية". There is no currency selector or option to price a municipal fee in USD, even though the municipality's settings support dual currencies (`USD` / `LBP`) and citizen cash payments allow multi-currency tender.
- **Impact:** Municipalities that wish to peg fees to USD (e.g. building permits, commercial licenses, diaspora services) cannot issue USD-denominated fee notices directly.
- **Recommended Fix:** 
  1. Add optional `currency` field to `createFeeNoticeSchema` (defaulting to `baseCurrency`).
  2. Add currency toggle/select (`LBP` / `USD`) in `issue-fee-form.tsx`.
  3. Propagate notice currency to `citizen_payments.currency`.

---

### Issue 5.2: Lack of Tiered/Bracketed Area Calculation Basis (`TIERED_AREA` / شرائح المساحة)
- **File / Location:** 
  - `packages/shared-schemas/src/fee.schema.ts:L29` (`feeBasisSchema`: `FLAT`, `PER_UNIT`, `PER_AREA`)
  - `apps/backend/src/infrastructure/prisma/tenant/schema.prisma:L2056` (`FeeBasis` enum)
  - `apps/backend/src/application/features/fees/fees.service.ts:L297` (`assessCitizen`)
  - `apps/frontend/components/admin/issue-fee-form.tsx:L271`
- **Severity:** Medium / High-Value Feature Request
- **Description:** Municipal fee schedules frequently rely on progressive area brackets (شرائح المساحة) rather than a linear multiplication of rate × total area. For example:
  - Units between 20 m² and 50 m²: Flat fee of $10 (or 895,000 LBP).
  - Units between 51 m² and 100 m²: Flat fee of $15 (or 1,342,500 LBP).
  - Units between 101 m² and 200 m²: Flat fee of $25 (or 2,237,500 LBP).
  Currently, `FeeBasis` only supports linear multiplication (`PER_AREA`) or single flat fee (`FLAT`). There is no data structure or UI wizard to define tiered ranges `[minArea, maxArea, feeAmount]`.
- **Impact:** Municipalities cannot reflect official municipal council tariff decisions (قرارات المجلس البلدي) that use bracketed area bands, forcing clerks to manually calculate and adjust bills.
- **Recommended Fix:**
  1. Add `TIERED_AREA` to `FeeBasis` enum.
  2. Support a JSON bracket structure on `FeeNotice`:
     ```ts
     brackets: Array<{ minM2: number; maxM2: number; amount: number }>;
     ```
  3. Extend `assessCitizen` in `fees.service.ts` to look up each unit's surveyed area against the bracket table.
  4. Add an intuitive interactive bracket builder (Add Range: From - To - Amount) in `issue-fee-form.tsx` when `TIERED_AREA` is selected.

---

### Issue 5.3: Missing Residence Sub-filter in "جميع المواطنين" Targeting (المقيمين / غير المقيمين / الجميع)
- **File / Location:** 
  - `packages/shared-schemas/src/fee.schema.ts:L347` (`createFeeNoticeSchema`)
  - `apps/backend/src/application/features/fees/fees.service.ts` (`issue` citizen query)
  - `apps/frontend/components/admin/issue-fee-form.tsx:L320`
- **Severity:** High / Key Municipal Domain UX Gap
- **Description:** When selecting "جميع المواطنين" (`ALL_CITIZENS`) in the Targeting step, the wizard assumes 100% of citizens indiscriminately. However, in municipal reality, citizens registered on civil records are split between those living in town and those living outside/abroad. There is no sub-selector to filter by residence status.
- **Impact:** Municipalities cannot levy resident-specific services (e.g. household waste management, generator services, local neighborhood security) without wrongfully charging expatriates and non-residents who do not reside within municipal bounds.
- **Recommended Fix & UI Specification:**
  1. In `issue-fee-form.tsx`, when the user selects **«جميع المواطنين»**, an animated sub-selector (radio group or segmented control) must expand below it asking:
     - **المقيمون فقط في البلدة** (`RESIDENT`) — (e.g., household waste and daily municipal services).
     - **غير المقيمين فقط** (`NON_RESIDENT_OWNER`) — (e.g., diaspora or absent property fees).
     - **الجميع (مقيمين وغير مقيمين)** (`ALL`) — (general town-wide assessments).
  2. In `createFeeNoticeSchema`, add:
     ```ts
     citizenResidenceTarget: z.enum(['ALL', 'RESIDENT', 'NON_RESIDENT']).default('ALL'),
     ```
  3. In `fees.service.ts`, filter the citizen query based on `users.residence` when `ALL_CITIZENS` is selected.

---

### Issue 5.4: Inability to Batch-Cancel / Withdraw an Erroneous Fee Notice
- **File / Location:** 
  - `apps/backend/src/presentation/controllers/fees.controller.ts` (`FeesController`)
  - `apps/backend/src/application/features/fees/fees.service.ts` (`cancelBill` vs missing `cancelNotice`)
- **Severity:** High / Operational Risk
- **Description:** If a clerk makes a typo and issues a fee notice to 1,500 citizens (e.g. typing 10,000,000 instead of 1,000,000 LBP), there is currently no endpoint or UI action to "Cancel Notice & Withdraw Unpaid Bills" in batch. The system only provides `setNoticeActive(false)` (which merely halts future recurring runs), leaving all 1,500 generated bills active and outstanding unless a manager cancels them manually one by one.
- **Impact:** Massive operational overhead and potential municipal scandal if residents check their files and find exorbitant or erroneous debts that the municipality cannot wipe in bulk.
- **Recommended Fix:** 
  1. Add `POST /fees/notices/:id/cancel` endpoint on `SUPER_ADMIN` role with required reason.
  2. In `FeesService.cancelNotice`: In one transaction, verify that none of the notice's bills have recorded payments (or only cancel unpaid bills), set `paymentStatus = 'CANCELLED'` across all bills of that notice, mark the notice inactive, and write a Tier 1 audit row.
  3. Add «إلغاء وسحب جدول التكليف» button on the notice detail view in the admin portal.

---

### Issue 5.5: Heirs & Estates Overbilling Hazard under `FLAT` Basis
- **File / Location:** 
  - `apps/backend/src/application/features/fees/fees.service.ts:L318` (`assessCitizen`)
- **Severity:** Medium / Logic Disparity
- **Description:** Under `FLAT` basis, the calculation completely ignores holdings, co-ownership shares, and estate distribution (`bearer` is ignored). If a deceased parent leaves one house to 5 registered heirs, each heir receives a full flat bill (e.g. 1,000,000 LBP each = 5,000,000 LBP total for one household), whereas under `PER_UNIT`, the fee is divided proportionally according to their inheritance shares (`BY_SHARES`).
- **Impact:** Multi-generation households and co-heirs are billed multiple times for what is intended to be a single household fee.
- **Recommended Fix:** Add an optional toggle for `FLAT` fees: «توزيع الرسم على الورثة والشركاء» so that if a household/property has multiple registered co-owners, the flat fee is apportioned rather than multiplied.

---

### Issue 5.6: Lack of Automated Overdue Penalties / Late Fees (غرامات التأخير)
- **File / Location:** 
  - `apps/backend/src/application/features/fees/fees.service.ts:L858`
  - `apps/backend/src/infrastructure/prisma/tenant/schema.prisma:L2137`
- **Severity:** Medium / Feature Gap
- **Description:** While `PaymentStatus.OVERDUE` exists, the code explicitly notes that "OVERDUE is derived on read rather than written by a nightly job". More importantly, Lebanese municipal tax laws prescribe statutory late penalties (e.g., 2% per month of delay after the statutory grace period). The system currently has zero logic to compute or bill late interest/penalties.
- **Impact:** Municipalities lose legal statutory late penalty revenue, and citizens have zero financial incentive to pay bills before `dueDate`.
- **Recommended Fix:** Support optional `latePenaltyPercentPerMonth` in `FeeNotice`, and dynamically compute accumulated penalty on bills past their `dueDate`.

---

### Issue 5.7: Absence of Social Hardship & Welfare Exemptions (إعفاءات الحالات الاجتماعية)
- **File / Location:** 
  - `apps/backend/src/infrastructure/prisma/tenant/schema.prisma:L143` (`units_fee_exemption_fields`)
- **Severity:** Medium / Municipal Policy Requirement
- **Description:** Exemption logic currently exists only on the `units` table (`PLACE_OF_WORSHIP`, `PUBLIC_FACILITY`, `OTHER`). There is no mechanism to exempt or discount specific vulnerable citizen categories (e.g., families of martyrs, severely disabled citizens, retirees/pensioners below minimum wage, or hardship cases approved by municipal council resolution).
- **Impact:** Vulnerable families receive standard bills and must either be manually corrected or accumulate artificial debt.
- **Recommended Fix:** Add `feeExemptionStatus` to citizen profiles (`users`) with proof document attachment, and automatically exempt or discount their bills during the assessment run.

---

### Issue 5.8: Cash Change Banknote Rounding Discrepancy (أزمة كسور العملة الورقية)
- **File / Location:** 
  - `apps/frontend/components/admin/payment-receipt.tsx:L247`
  - `packages/shared-schemas/src/cash-policy.ts`
- **Severity:** Low / Practical Cashier Friction
- **Description:** When a citizen tenders foreign currency (e.g. $50 USD at rate 89,500 LBP) against an odd fee amount, the exact calculated change often yields amounts like `2,685,370 LBP` or `830 LBP`. In Lebanon, the smallest physical banknote in cash circulation is 20,000 LBP or 50,000 LBP. The cashier cannot physically hand back 370 LBP.
- **Impact:** Cashier drawers inevitably accumulate small unrecorded cash surpluses or deficits because the system expects mathematical perfection down to the single pound while physical banknotes do not exist.
- **Recommended Fix:** Introduce a configurable "Banknote Rounding Rule" (e.g. round change down to nearest 10,000 or 50,000 LBP and credit the difference as a minor fee adjustment or tip).

---

## 4. UI/UX Standards & Compliance Status
- `issue-fee-form.tsx` adheres cleanly to RTL layout and number formatting (`formatLbp`).
- Input labels and stepper navigation comply with primitive guidelines.


