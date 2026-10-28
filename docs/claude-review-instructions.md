# Comprehensive Code & Feature Review Instructions for Claude Code

This file contains the complete, phased task specification for **Claude Code** to conduct an exhaustive, methodical audit of the entire codebase.

---

## 📋 Task Overview for Claude Code

You are instructed to conduct a deep, page-by-page and feature-by-feature review of the entire monorepo (`mechnanization/mechanization`):
* **Packages:** `packages/shared-schemas`
* **Backend:** `apps/backend` (Domain, Application, Infrastructure, Presentation)
* **Frontend:** `apps/frontend` (Citizen portal, Admin dashboard, Components, Libs)
* **Database:** `apps/backend/src/infrastructure/prisma` (Registry and Tenant schemas, Migrations 0001 to 0092)

Your goal is to inspect every feature, screen, controller, service, schema, and migration to identify **functional bugs, logic errors, architectural conflicts, permission leaks, and edge cases**.

---

## 🛑 Non-Negotiable Rules to Obey During Review

Before reviewing, you must strictly adhere to the repository's binding rules:
1. **Read `CLAUDE.md` first.** (Repo map, commands, non-negotiables).
2. **Tenancy is by Postgres schema (`tenant_<slug>`), never by column.** Ensure no code assumes a `tenantId` column or allows cross-tenant leakage.
3. **`users` holds BOTH staff and citizens** (`kind: 'STAFF' | 'CITIZEN'`). A query must never assume `users` contains only staff or only citizens.
4. **UI Standards are binding** ([`docs/ui-ux-standards.md`](docs/ui-ux-standards.md)):
   - Banned list (BAN-1 to BAN-15): No raw hex colors, no nested bordered cards, no gradient text, no arbitrary pixel type sizes.
   - Required primitives (PRIM-1 to PRIM-12): `PageHeader` (no subtitles), `DataTable`, `Money`, `SummaryList`, `CellTag`.
   - Arabic & RTL first: Number digits isolated LTR with unit placed in reading order (`<Money>`).
5. **Database rules** ([`docs/database.md`](docs/database.md)):
   - Schema modifications are hand-written SQL tenant migrations.
   - Tables with write-once triggers must not be rewritten.

---

## 🔍 Phased & Page-by-Page Audit Plan

Divide your audit systematically into the following 7 phases, dedicating thorough scrutiny to each page and component:

### Phase 1: Database Architecture, Migrations & Tenancy
* **Scope:**
  - `apps/backend/src/infrastructure/prisma/registry/schema.prisma`
  - `apps/backend/src/infrastructure/prisma/tenant/schema.prisma`
  - Tenant migrations from `0001_init` through `0092_citizen_requests`
* **Checks:**
  - Verify all table relationships, foreign keys, cascading deletes, and unique indexes.
  - Verify that write-once triggers (`reject_closed_day_entry`, `reject_day_closure_rewrite`, `reject_transfer_review_rewrite`, `reject_inspector_payout_rewrite`) are correctly schema-scoped.
  - Check `DocumentCounter` locking mechanisms and race conditions.
  - Check `BackupService.TABLE_ORDER`: verify whether newly introduced tables are registered for backup/restore.

---

### Phase 2: Authentication, Security & Tenant Context
* **Scope:**
  - `apps/backend/src/application/features/identity/`
  - `apps/backend/src/presentation/guards/`
  - `apps/backend/src/presentation/middlewares/`
* **Checks:**
  - `TenantMiddleware` & `TenantContextService.run`: verify tenant resolution and context cleanup.
  - Guard execution order: `ThrottlerGuard` → `JwtAuthGuard` → `RolesGuard`.
  - Citizen reference authentication (`openByReference`): session lifecycle, reference entropy, and credential protection.
  - Staff authentication: password hashing, refresh token rotation, TOTP verification, and session revocation.
  - Role-based access control: verify that every endpoint has explicit role permissions declared.

---

### Phase 3: Citizen Portal Pages
* **Pages to Inspect:**
  1. `/(citizen)` (Landing / Reference Number input): formatting masks, uppercase auto-format, raw reference conversion, session bypass.
  2. `/(citizen)/login`: Phone and SMS route (verify disabled/paused state).
  3. `/(citizen)/my-account`: Profile facts, read-only guarantees.
  4. `/(citizen)/my-file`:
     - Personal details card (wrapping, initials avatar, Arabic names).
     - Registered properties and unit list.
     - Unpaid vs settled bills list, review notes, and Whish checkout triggers.
     - «طلباتي» (My Requests) section: status badges, fee notices, and pickup indicators.
  5. `/(citizen)/my-file/requests/new`:
     - Request application wizard: type selection, property selection, legal capacity guards (e.g. tenants blocked from clearance without power of attorney).
     - Client-side image compression (`image-compression.ts`), WebP conversion, presigned S3 upload flow.
  6. `/(citizen)/my-file/requests/[requestId]`: Detail inspection, fee settlement status, pickup readiness.
  7. `/(citizen)/payments`: Online vs counter payment routing; state of `ONLINE_PAYMENT_OPEN`.

---

### Phase 4: Admin Back-Office Registry & Operations
* **Pages to Inspect:**
  1. `[adminPath]/dashboard`: KPI cards, census statistics, collection summary.
  2. `[adminPath]/citizens`: Directory, `DataTable` server pagination, search normalization, `mergeCitizens` workflow, relative phone distinction (`hasNoPhone` vs `contactPhone`).
  3. `[adminPath]/buildings`:
     - Building directory, census tracking, unit grid matrix view (`building-unit-matrix-view.tsx`, `building-unit-matrix-drawer.tsx`).
     - Occupancy types (`OWNER`, `TENANT`, `FREE_OCCUPANT`).
     - Partitioning & shares (`Building.isSubdivided`, `shares` restrictions).
     - Damage assessment & reinspection queue.
  4. `[adminPath]/cases`: Doorstep visits, locked gates, unresolved links, scheduling revisits.
  5. `[adminPath]/map` & `zones`: Spatial centroid resolution vs entrance pins, cadastre layer loading.
  6. `[adminPath]/quality`: Data quality dismissals, duplicate review queue.
  7. `[adminPath]/staff`: Staff roster, TOTP resets, presence heartbeat (`lastSeenAt`), salary & commission payouts.

---

### Phase 5: Financial, Treasury & Billing Pages
* **Pages to Inspect:**
  1. `[adminPath]/fees`:
     - Fee assessment, billing runs, overdue filters, recurring billing.
     - Counter payments (`counter-payment`), bulk settlement (`bulkSettle`, BRC- consolidated receipts).
     - Parcel dues (`fees/parcel` - pre-clearance checks).
     - Corrections (`fees/corrections`).
  2. `[adminPath]/finance/movements`:
     - Dual recording composer (`RecordIncomeForm` / `RecordExpenseForm`), wallet select.
     - Urgent disbursement ceilings under Lebanese municipal law Art. 35 (`urgent-ceiling.ts`).
  3. `[adminPath]/finance/transactions`:
     - Unified financial ledger, filter bar (period, direction, wallet, category), voucher side sheet (`voucher-sheet.tsx`).
  4. `[adminPath]/finance/transfers`:
     - Internal transfers, currency exchange with tolerance percentage, collector custody handover & voiding.
  5. `[adminPath]/finance/daily`:
     - Daily count, day closure (`DayClosureService`), closed-day lock, daily report printing (`finance/daily/report`).
  6. `[adminPath]/finance/accounts/[accountId]`: Account statement printing (`data-print-root`).

---

### Phase 6: Municipal Requests & Certificates Management
* **Pages to Inspect:**
  1. `[adminPath]/requests`:
     - Request review queue (`DataTable`), status filters (`AWAITING_PAYMENT`, `IN_REVIEW`, `READY_FOR_PICKUP`, `COMPLETED`, `REJECTED`).
     - Request inspection sheet (`request-sheet.tsx`): applicant identity, property link, parcel dues check, S3 attachments preview.
  2. `[adminPath]/requests/new`:
     - Counter request composer (`counter-request-form.tsx`) for in-person citizens.
  3. `[adminPath]/requests/types`:
     - Service pricing & enablement matrix.
  4. `[adminPath]/requests/[requestId]/print`:
     - Official printed certificate layout (`official-document.tsx` letterhead, crest, signatures, QR verification code).
  5. `s3-request-file-storage.service.ts`:
     - S3 presigned URL generation, mime-sniffing, error handling, local development behavior (`FILE_UPLOAD_FAILED`).

---

### Phase 7: Cross-Cutting Standards, UX Compliance & Open Decisions
* **Checks:**
  - **UI/UX Compliance:** Check for violations of BAN-1 to BAN-15 and PRIM-1 to PRIM-12 across all components.
  - **Localization (i18n):** Verify that all translation keys used in frontend components exist in both `apps/frontend/messages/ar.json` and `en.json`.
  - **Error Codes:** Ensure all domain errors thrown by services are declared in `packages/shared-schemas/src/error-codes.ts` and mapped in translation files.
  - **Open Decisions:** Inspect how pending items (Whish live contract, SMS provider D9, local S3 dev setup) are handled.

---

## 📝 Required Deliverable / Final Report Format

Upon completing the review, compile your findings into a single, well-structured markdown file:
`docs/audit-findings-report.md`

Use the following format for each phase:
```markdown
# Phase [X]: [Phase Name]

## 1. Scope & Verified Components
- [List files and components audited in this phase]

## 2. Functional & Logic Analysis
- [Describe the findings, workflow evaluation, and data flow]

## 3. Discovered Issues & Edge Cases
### Issue [X.1]: [Short Title]
- **File / Location:** `path/to/file.ts:L123`
- **Severity:** [Critical | High | Medium | Low | Technical Debt]
- **Description:** [Exact description of the bug, edge case, or conflict]
- **Impact:** [What happens to the user, data, or system]
- **Recommended Fix:** [Clear, actionable code or architecture solution]

## 4. UI/UX Standards & Compliance Status
- [Notes on token usage, RTL, primitives, and accessibility]
```

At the end of the report, provide a **Summary Action Plan** prioritizing the most critical fixes needed.
