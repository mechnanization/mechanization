# apps/frontend: agent guide

Last verified against the code: `fix/cleanup-sec-10-dead-18-dry-01` (on `develop@5bf5856`): the `pnpm lint:unused` row (DEAD-18), 2026-11-24; `fix/cleanup-arch-01-sec-05-sec-02` (on `chore/migration-0116`, `develop@5bf5856a`): «أمان الحساب»'s 2FA re-authentication and sign-out after a second-factor change, `signInAfterSecondFactorChange`, the `TOTP_CODE_REQUIRED` / `TOTP_ENROLMENT_*` messages (audit SEC-02), 2026-11-24; `feat/arrears-bills-everywhere` (on `develop@90cebdc`): old debts task 10 — an «ARR-» bill marked and grouped wherever a bill appears: `components/arrears-bill-mark.tsx` (`ArrearsBillMark`, `useArrearsPropertyText`) and `lib/arrears-bill.ts` on the citizen file, the cash counter (and the cancel dialog's hint to cite the old receipt), the settle page, the fees list, «تسديد الفواتير المحددة» and its receipt, the printed receipt (the debt's own رقم العقار and a «نوع الدين» line), and the portal's «مدفوعاتي», «ملفّي» and «حسابي», the `arrearsBill` messages, 4,204 leaf keys each, 2026-11-21; `feat/unit-types` (on `chore/migration-0111`): the default unit types' own drawings in the building elevation — `components/admin/unit-figures.tsx` (27 fronts, `Record<UnitFigure, …>`), `BuildingElevation`'s `figures` and `UnitFace`'s `figure` in `property-illustrations.tsx`, `figuresByType` in `lib/unit-types.ts`, passed by the matrix view and the drawer, checked on screenshots from headless Edge, 2026-11-21; `feat/unit-types` (on `chore/migration-0109`): «أنواع الوحدات» — the second tab of `buildings/types` (`?tab=units`, `components/admin/unit-types/`), `lib/unit-types.ts` (`useUnitTypes`, the picker helpers), the unit-type pickers in the building editor's grid, the matrix view and the drawer, `UNIT_TYPE_ADMIN_ROLES`, the `unitTypes` messages, the key and test counts, 2026-11-21; `feat/arrears-report` (on `develop@90cebdc`): old debts task 11 — «تقرير المتأخرات» (`fees/arrears/report`) and a batch's sheet (`fees/arrears/batches/[batchId]/sheet`, `components/admin/arrears/arrears-batch-sheet.tsx`), `getArrearsReport` and `getArrearsBatchSheet` in `lib/arrears-api.ts`, `lib/arrears-report.ts` (`arrearsReportCsv`, `coveragePercent`), `ARREARS_REPORT_ROLES` in `lib/staff-roles.ts`, the `arrears.report` and `arrears.sheet` messages and `errors.ARREARS_BATCH_NOT_APPROVED`, 4,287 leaf keys each, 2026-11-21; `feat/arrears-approval-ui` (review, 2026-11-21): «إعدادات المتأخرات» shows the books' totals read-only (open-decisions §23.4, no route takes them), and `lib/arrears-api.ts` takes `ArrearsBatchReview`, `ArrearsBatchTotalRow`, `ArrearsUnmatchedLine` and `ArrearsSettingsView` from the shared contract instead of its own copies, `arrears.issue.PRESCRIBED_SINCE_IMPORT`, the key count, 2026-11-21; `feat/arrears-approval-ui` (on `feat/arrears-import-ui@af7b2a4`): old debts task 8 — «اعتماد المتأخرات» (`fees/arrears/review`, `components/admin/arrears/batch-review.tsx`), «أسطر للمطابقة» (`fees/arrears/match`) and «إعدادات المتأخرات» (`fees/arrears/settings`), their calls and the two views the contract lacks proposed in `lib/arrears-api.ts`, `ArrearsVerdicts`' `readOnly`, the `arrears.review` / `match` / `settings` messages, the key count, 2026-11-21; `feat/arrears-import-ui` (on `develop@c6e7462`): «المتأخرات» (`fees/arrears`, old debts task 7: `components/admin/arrears/` — the export dialog, the import panel with its verdicts and the reconcile panel, the single-line dialog — `lib/arrears.ts`, `lib/arrears-api.ts` with task 5's three routes still proposed, `buildArrearsTemplate` / `parseArrearsCsv` in `lib/csv.ts`, the `arrears:export` and `arrears:line` key scopes, the `arrears` messages, the link from the fees page), the key and test counts, 2026-11-21; `feat/arrears-write-off` (follow-up, 2026-11-21): a municipal request's fee may be written off, and the request goes on to review (`settleRequestOfWrittenOffBill`, `reconcile`, `REQUEST_FEE_WRITTEN_OFF`, the owner's decision of 2026-11-21); the write-off dialog names the request and the toast says where it went, `BILL_WRITE_OFF_REQUEST_FEE` removed, 3,952 leaf keys each; `feat/arrears-write-off` (on `develop@67a1ffe`): «شطب» on the bill's counter page (`components/admin/fees/write-off-bill-dialog.tsx`, `writeOffBill` and `writeOff` on the bill types in `lib/api-client.ts`, `BILL_WRITE_OFF_ROLES`), a written-off bill owing nothing on every screen that reads a bill's status (`billOwesNothing`), the `counterPayment.writeOff` messages, the key count, 2026-11-21; `feat/arrears-fee-guards` (on `develop@c6e7462`): `errors.FEE_PERIOD_BEFORE_ARREARS_CUTOFF` in both message files (the wizard shows it from the preview and the issue), 3,924 leaf keys each, 2026-11-21; `feat/arrears-approval` (follow-up, 2026-11-21, old debts task 6): the cutoff year is fixed once a batch is approved (`ARREARS_CUTOFF_LOCKED`); `errors.ARREARS_CUTOFF_LOCKED` in both message files; `feat/arrears-approval` (on `develop@c6e7462`): the nine old-debts approval error codes and eight audit labels in the message files (`errors.ARREARS_*`, `auditActions`, `auditEntities.ArrearsLine`), 3,941 leaf keys each, 2026-11-21; `feat/day3ati-news-media` (follow-up, 2026-11-21): `useStaffQuery`'s `refusal` — the API's own translated words for a refusal with a specific code — shown on every News screen instead of the table's one generic line (`ErrorState`, `refusalOf`), the key and test counts; `feat/day3ati-news-media` (on `feat/day3ati-news-articles@bfb9250`), 2026-11-21: the article's photos and PDFs (`components/admin/news/article-media.tsx`, `uploadNewsMedia`, `lib/news-media.ts`, the CSP's `img-src` for `NEXT_PUBLIC_DAY3ATI_MEDIA_ORIGIN` in `middleware.ts`, `lib/https-origin.ts`), the News rows hidden for a municipality whose village lacks the module (`useNewsAvailability`, `visibleGroups`'s `newsEnabled`), the test and key counts; `feat/day3ati-news-articles` (on `feat/day3ati-news-categories@cef40da`), 2026-11-20: «الأخبار» articles (`news/articles`, `news/articles/new`, `news/articles/[articleId]`, `components/admin/news/article-*.tsx` and `day-time-fields.tsx`, `lib/news-article-form.ts`, the article functions in `lib/api-client.ts`, the `news.articles` messages, a third nav row, the test and key counts); `feat/day3ati-news-categories` (on `feat/day3ati-news-client@a84d0ef`), 2026-11-20: «الأخبار» (`news/categories`, `news/publishers`, `components/admin/news/`, `lib/news.ts`, `NEWS_EDITOR_ROLES` in `lib/staff-roles.ts`, a «الأخبار» nav group of two rows, the `news` messages, the test and key counts); `fix/responsible-owner-billing` (on `develop@e9e79ff`): a «مالك مسؤول» re-checked at billing time — `checkResponsibleOwners`, `FeesService.ownerClaims`, the `RESPONSIBLE_NOT_BILLED` fallback and its quality finding (F13, task B13), 2026-11-16; `fix/citizen-sessions` (on `develop@e9e79ff`): a citizen's sign-out ended on the server (`POST auth/citizen/logout`, `endCitizenSessions`, `signOutCitizen`) and the staff reset token in the link's fragment (`password-reset-link`, `parseResetLink`, the Supabase parsing removed), task S14, both gap rows removed, 2026-11-16; `fix/landlord-agreement-roles` (on `develop@e9e79ff`): owner answers carried by a citizen save applied only for `LANDLORD_LINK_ANSWER_ROLES`, and `LandlordMatchHint`'s required `canAnswer` (task S17), the gap row removed, 2026-11-16; `fix/counter-payment-checks` (on `develop@e9e79ff`): a single counter payment (findings F18 and F19, task B11) — the retry key required and bound to the payer and the day, `expected` and `PAYMENT_FIGURES_CHANGED`, large change needing a reason (`PAYMENT_LARGE_CHANGE_REASON_REQUIRED`, `largeExchangeThreshold` in `ledger.config`), `counterCredit`, 2026-11-15; `fix/duplicate-notice-guard` (on `develop@e9e79ff`): the duplicate notice guard (finding F11, task B8) — `feeNoticeDuplicateSchema`, the preview's `duplicates`, `acknowledgedDuplicates` and `FEE_NOTICE_DUPLICATE`, `duplicateNotices` and the issue lock, the wizard's confirmation in «قبل الإصدار», 2026-11-15; `fix/charge-retry-key` (on `chore/migration-0102@72f0974`): «تكليف مالي»'s retry key (0102, task B11) — `chargeCitizenSchema.clientRequestId`, `replayCharge`, `FEE_CHARGE_REQUEST_REUSED`, the `charge:new` key scope, and the security gap row removed, 2026-11-15; `fix/2fa-replay-guard` (on `chore/migration-0101@7466f6d`): the TOTP replay guard burns the code's own step (`matchStep`, security audit N-1), one step either side, wrong codes counted per account with a lockout (`APP_CONFIG.totp`, `TOTP_CODE_INVALID` / `TOTP_CODE_REUSED` / `TOTP_LOCKED`, `TOTP_LOCKED_OUT`), 2026-11-15; `feat/building-types` (on `feat/unit-fee-whitelist`), 2026-11-16: «أنواع المباني» (`buildings/types`, `components/admin/building-types/`, `lib/building-types.ts`, the editor's type picker and the grid's first unit type, the ledger's type filter and column, the map's type filter and legend, the dashboard's buildings by type), the offline store at `DB_VERSION = 3` with `referenceData`, the key and test counts; `feat/unit-fee-whitelist` (on `chore/migration-0106`), 2026-11-16: «قائمة الإعفاء من الرسوم» (`fees/exemptions`, `components/admin/fee-exemptions/`, the drawer panel's last day and lift reason, `FEE_EXEMPTION_READ_ROLES`/`FEE_EXEMPTION_GRANT_ROLES` in `lib/staff-roles.ts`, the file's and the portal's last day); `fix/review-follow-ups` (on `develop@e8bb71f`): the portal's settings read, `getCitizenPortalSettings` (`CitizenPortalSettings`, the three `CITIZEN_SETTINGS_FIELDS`), outside `request-cache.ts`, and `PayDialog` typed by it, 2026-11-20; `fix/responsible-owner-billing` (on `develop@e9e79ff`): a «مالك مسؤول» re-checked at billing time — `checkResponsibleOwners`, `FeesService.ownerClaims`, the `RESPONSIBLE_NOT_BILLED` fallback and its quality finding (F13, task B13), 2026-11-16; `fix/citizen-sessions` (on `develop@e9e79ff`): a citizen's sign-out ended on the server (`POST auth/citizen/logout`, `endCitizenSessions`, `signOutCitizen`) and the staff reset token in the link's fragment (`password-reset-link`, `parseResetLink`, the Supabase parsing removed), task S14, both gap rows removed, 2026-11-16; `fix/landlord-agreement-roles` (on `develop@e9e79ff`): owner answers carried by a citizen save applied only for `LANDLORD_LINK_ANSWER_ROLES`, and `LandlordMatchHint`'s required `canAnswer` (task S17), the gap row removed, 2026-11-16; `fix/counter-payment-checks` (on `develop@e9e79ff`): a single counter payment (findings F18 and F19, task B11) — the retry key required and bound to the payer and the day, `expected` and `PAYMENT_FIGURES_CHANGED`, large change needing a reason (`PAYMENT_LARGE_CHANGE_REASON_REQUIRED`, `largeExchangeThreshold` in `ledger.config`), `counterCredit`, 2026-11-15; `fix/duplicate-notice-guard` (on `develop@e9e79ff`): the duplicate notice guard (finding F11, task B8) — `feeNoticeDuplicateSchema`, the preview's `duplicates`, `acknowledgedDuplicates` and `FEE_NOTICE_DUPLICATE`, `duplicateNotices` and the issue lock, the wizard's confirmation in «قبل الإصدار», 2026-11-15; `fix/charge-retry-key` (on `chore/migration-0102@72f0974`): «تكليف مالي»'s retry key (0102, task B11) — `chargeCitizenSchema.clientRequestId`, `replayCharge`, `FEE_CHARGE_REQUEST_REUSED`, the `charge:new` key scope, and the security gap row removed, 2026-11-15; `fix/2fa-replay-guard` (on `chore/migration-0101@7466f6d`): the TOTP replay guard burns the code's own step (`matchStep`, security audit N-1), one step either side, wrong codes counted per account with a lockout (`APP_CONFIG.totp`, `TOTP_CODE_INVALID` / `TOTP_CODE_REUSED` / `TOTP_LOCKED`, `TOTP_LOCKED_OUT`), 2026-11-15; `fix/fee-wizard-review` (on `feat/tiered-fees-cancel-and-wizard@aa35d4a`, uncommitted), 2026-10-27: `Field`'s `errorElsewhere` (the kit; the fee wizard's refusals said in a toast, FRM-2's exception), `FormSection` (`components/admin/fees/form-section.tsx`) for the wizard's details and scope rows, `IssueFeeFormSkeleton`, the payer of a shared unit bill chosen on the citizen file's cash page too (it sent none, and the server refused every such payment), from `SharedBillPayerField` (`components/admin/fees/shared-bill-payer.tsx`) on both pages, starting on the file's citizen, else the unit's «مالك مسؤول» (`defaultPayer` in `lib/shared-bill-payer.ts`; `sharedDebtors[].responsible`; `counterPayment.payerResponsible`/`payersFailed`/`payerFileFailed`/`payerRetry`), the unassessable citizens worded by their reason's code — the unit, its type, area and levels, why, and what to do (`components/admin/fees/unassessable-words.ts`, `fees.unassessable` in messages), in the preview's list and the issue's result panel, «المراجعة» rebuilt as `NoticeReview` (`components/admin/fees/notice-review.tsx`: the preview's figures pinned over `FormSection` rows read with `SummaryList` — «الرسم», «جدول الفئات» with each bracket's count and subtotal, «النطاق», what goes unbilled, «قبل الإصدار» — each step's row with its «تعديل»; `notice-preview.tsx` now `useNoticePreview`, `PreviewFigures`, `PreviewBrackets`, `PreviewFindings`, its bracket chips gone), «الوحدات المشمولة» (الشاغلة / الشاغرة / الكل) on the details step, the same `unitStates` as the scope step's «حالة الوحدة» (`occupancyOf`, `unitStatesFor` in `lib/fee-notice-draft.ts`; `fees.issueForm.occupancy`), bracket ranges typed and shown with both ends included in whole metres, «0 – 50» then «51 – 60» (`toMatrix` sends the «حتى» as the next metre; `floorAfter`, `wholeMetres`), «أضف فئة» naming each bracket in turn (`nextBracket`: «A»/«الفئة أ», «B»/«الفئة ب» …) and the bracket table narrowed to fit the card at 1440px, «مدّ الفئة» in the bracket editor (`extendBracket`, `withExtensions`, `BracketDraft.extendsKey` in `lib/fee-notice-draft.ts`; `fees.matrix.extend`/`extensionOf`/`removeWithExtensions`), `fees.issueForm.stepHeading`/`sections`/`refused` and `fees.issuePage.loading` in messages; nothing else in this guide changes; before that, «من يشمل الإشعار» (0100) on the wizard's «النطاق» step — `components/admin/fees/notice-scope.tsx` (`NoticeScopeFields`: حالة الوحدة، نوع الإقامة، نوع العقار as `Checkbox` lists, `ScopeWarnings`), the draft's `audience`/`categories`/`unitStates`/`residences`/`scopeConfirmed`, `noticeWarnings` and `issuePayload` in `lib/fee-notice-draft.ts`, the confirmation on the review step, the preview's per-state counts, `fees.scope` in messages, the test and key counts, 2026-10-26; the same branch earlier: the fee wizard's review fixes — `useStaffQuery`'s `fresh`, `useLeaveGuard` (`lib/use-leave-guard.ts`), the wizard's copy in `fees.issueForm`, the titles read under `fee-filter-options` and the four fee keys invalidated after an issue, `IssueResultPanel` (`components/admin/fees/issue-result-panel.tsx`) in place of the toasts; 2026-10-24; the same day, the bracket editor's helpers in `lib/fee-notice-draft.ts` (`standardBrackets`, `nextBracket`, `chainedFollowers`, `UNIT_TYPE_PRESETS`, `coverage`) and the preview's paged `DataTable`s; the wizard card `overflow-clip` so the preview's figures can stick (uncommitted); 2026-10-25, «جدول الفئات» a wizard step of its own under `TIERED_AREA` (`STEP_FIELDS.brackets`, `stepOf`), the editor an editable table at the page's width (uncommitted); `fix/fee-wizard-review` (on `feat/tiered-fees-cancel-and-wizard@aa35d4a`): «إشعارات الرسوم»'s «إيقاف الإشعار» / «استئناف الإشعار» (`setNoticeActive`, `FEE_ADMIN_ROLES`) and «إلغاء الإشعار» by period (`NoticePeriodsPicker`, `getFeeNoticePeriods`, `cancelFeeNotice` with `CancelNotice`); a shared bill's receipts printed payment by payment (`BillReceipts`' `onPrint`, `mayPrintSharedReceipt`, `receiptOfEntry`) and paid from a debtor's file with that debtor named; the preview's units outside the table by type; `describeAssessment`'s outside-table, disputed and billed-elsewhere notes; the `FEE_NOTICE_STOPPED`/`FEE_NOTICE_RESUMED` labels, 2026-10-26; `feat/tiered-fees-cancel-and-wizard` (uncommitted): «إشعارات الرسوم» (`/fees/notices`, under the `/fees` nav row): the notices in a `DataTable` and the manager's «إلغاء الإشعار» (`ConfirmDialog` with a required reason, `cancelFeeNotice`), the bills left listed after; linked from the fees page's header; 2026-10-23; `feat/tiered-fees-cancel-and-wizard` (uncommitted): «تسجيل دفعة» on a shared unit bill — the payer chosen from the bill's `sharedDebtors` (`getPaymentById`), required, sent as `paidByCitizenId`, and the receipt rebuilt from that payer's file; 2026-10-23; `feat/tiered-fees-cancel-and-wizard` (uncommitted): the issue wizard's `TIERED_AREA` basis — `components/admin/fees/tiered-matrix-editor.tsx` (the bracket table, checked by `feeMatrixSchema` through `matrixIssues`) and `components/admin/fees/notice-preview.tsx` (the required «معاينة قبل الإصدار» on the last step, `previewFeeNotice`) — and `lib/fee-notice-draft.ts`, the one notice payload the preview and the issue send (`noticePayload`: a category only with a category target, a citizen only with a citizen target); 2026-10-23; `feat/tiered-fees-cancel-and-wizard` (on `feat/tiered-fees-debtor-views@61b0e04`, uncommitted): `cancelFeeNotice` and `FeeNoticeCancelResult` in `lib/api-client.ts`, and the `FEE_NOTICE_CANCELLED` audit label; nothing else in this guide changes, 2026-10-23; `feat/tiered-fees-debtor-views` (on `feat/tiered-fees-shared-bills@a90a70a`, uncommitted): `sharedUnit` on the portal's and the citizen file's bills and `lastPaidByCitizenId` on the ledger's in `lib/api-client.ts`; the portal's «مدفوعاتي» explaining a shared bill (`citizen.sharedBill`) and offering no payment action for it; `describeAssessment` naming each unit's bracket under `TIERED_AREA` (`feeAssessment.tiered*`, `sharedBillUnits`); a shared bill's receipt reprinted from its payer's file; nothing else in this guide changes, 2026-10-23; `feat/tiered-fees-shared-bills` (on `feat/tiered-fees-matrix-engine@60b00e2`, uncommitted): a bill's citizen nullable in `lib/api-client.ts` (`AdminPaymentItem`, `PendingPayment`, with `sharedUnit`), the fees, payments, parcel-dues, collector and round screens naming a shared unit bill by its unit (`common.sharedUnitBill`, `parcelDues.sharedBill`) and offering no receipt reprint or bulk settlement for one; nothing else in this guide changes, 2026-10-23; `feat/tiered-fees-matrix-engine` (on `chore/migration-0098-0099@a5539a5`, uncommitted): `previewFeeNotice` in `lib/api-client.ts` (`POST fees/notices/preview`, types from the shared schemas), and the issue wizard leaving `TIERED_AREA` out of its bases until the bracket editor exists; nothing else in this guide changes, 2026-10-23; `feat/duplex-merge` (stacked on `feat/unit-levels`): «دمج كدوبلكس» and `UNIT_LEVELS_TO_CONFIRM`, D28, 2026-10-17; `feat/unit-levels` (stacked on `chore/migration-0095`, on `develop@a7e62087`): duplexes and the per-roof factor, a house that grows, D28, 2026-10-17; `fix/pr116-review` (PR #116 merged with `fix/pr115-review`, which stacks #123, #124 and #115 on `develop@5e8f5c3`, with its review fixes): `DatePicker`'s Escape and year list, the treasury pages' and the case editor's way back in the header, the back-navigation guard, «تكليف مباشر», the case editor, the cases page and «التقرير اليومي» in messages; phase 1 of the kit adoption (`Alert`, `StatStrip`, `Pager`, `HeaderBackLink`, the recording forms' frame), `StatItem`'s `hint`; signed cadastre layers, «أمان الحساب»'s own-account read, error state and password change, the sign-in page's copy in messages, a 401 that is an answer; citizen pickers, the building editor's held creation key and drafts, the offline queue's revised, held and refused records, 2026-10-15; and `bugs-fix` (on `develop@5e8f5c3`; the finance audit remediation: `cancelBill` and the notice retry key (`fee-notice:new`) in `lib/api-client.ts` and `lib/request-id.ts`, `BILL_CANCEL_ROLES` in `lib/staff-roles.ts`, the salary month and ceiling, the collector's fixed method on the settle page), 2026-10-12; `fix/finance-audit-remediation` (PR #120's review: `CASH_COUNTER_ROLES` and the collector sent to the settle page, the counter pages' re-read after `PAYMENT_IDEMPOTENCY_KEY_REUSED` (B6), a cancelled bill on the settle page and the portal's «مطالباتي», the notice wizard's replay warning, a `YYYY-MM` error param written as a month, `cancelBill` typed by `CancelBill`), 2026-10-13; the feature folders, the `loadSession` count and the message keys rechecked on `fix/fees-page-ux` from `develop@5e8f5c3` (uncommitted), 2026-10-12; the merged «الإيرادات والنفقات» page (`finance/movements`, the old addresses redirecting, `NavItem.also`, `SearchField`, `ChoiceCard`'s `trailing`, `DataTable` without its empty toolbar row, `pushState` for a pane over a list) on the same branch (uncommitted), 2026-10-12; the same day, the register split onto `finance/transactions` («الحركات المالية», its own nav row) and `finance/movements` left as the recording page, `WalletSelect`, the message count (uncommitted); later that day `finance/transactions` as one frame of dated rows with the voucher in a `Sheet`, `Sheet` on Radix Dialog, `pushState` for it at every width, the test and key counts (uncommitted); the recording page at full width, the page and kit counts (uncommitted); municipal requests — the staff queue, panel, counter form, types and paper (`requests/**`), the portal's «طلباتي», wizard and request page (`my-file/requests/**`), `lib/requests-api.ts`, `FileInput`, `CitizenPicker`, `useCitizenSession`, `compressPaper`, the `request:new` and `request:mine:<citizenId>` scopes, the page, kit, test and key counts — on the same branch (uncommitted), 2026-10-13; with the fixes of its review the same day (the fee editor reading the list, the panel re-read after a refusal, the settle page invalidating `requests`, the per-citizen key); online payment paused by the product owner the same day (`ONLINE_PAYMENT_OPEN` in `lib/online-payment.ts`, the three Whish buttons gated, the request copy as an ICU `select` on `online`, «طريقة الدفع» on «ملفّي»); and, on `fix/fees-page-ux` rebased onto `chore/migration-0092@16473f0` (2026-10-13), the review of PR #122: a request cancelled with its bill (`cancelRequestOfCancelledBill`), a card or a flat a request names never deleted (`PROPERTY_NAMED_BY_REQUEST`, `HAS_REQUESTS`), request bills stamp `issuedById`, the API's log lines without query strings, and the isolation tests; and, on `fix/pr122-review` (2026-10-15), the review's blocker and majors in `lib/api-client.ts`: `cancelBill` answers `CancelBillResult` (the request cancelled with the bill), `CitizenProfilePayment.request`, and `declarePayment` typed `DeclarePayment` (Whish Money only); the bill's cash page names its request, warns before «إلغاء الفاتورة» cancels it, and refreshes the requests queue; and the dev server on Turbopack (`next dev --turbo`), run against `develop@4634bdb`, 2026-10-15; and the dashboard's «الوحدات والعقارات» re-sourced from the building census (`DashboardAnalytics.census` in `lib/api-client.ts`, every tile reading `census.unitsByType`), so its figures match «سجل المباني» — verified against production, 2026-10-16, on `develop@a7e62087` (uncommitted).

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
                                        my-file/requests/new (the request wizard: four steps, the step
                                        in `?step=`, what was chosen in memory only, the identity copy
                                        required, photos shrunk by `compressPaper`; key `request:mine:<citizenId>`)
                                        my-file/requests/[requestId] (where it stands; while online
                                        payment is paused no «ادفع الآن» — once open: raise the bill,
                                        then Whish —, the note says pay at the municipality quoting the
                                        number; cancel while unbilled, add papers; papers listed by
                                        type and date, never served back)
                                        Online payment is paused (2026-10-13, docs/open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13):
                                        `ONLINE_PAYMENT_OPEN` (lib/online-payment.ts, false) gates
                                        «ادفع عبر Whish» on my-file and payments and «ادفع الآن» above;
                                        my-file's open bills say so and link «طريقة الدفع» to payments
                                        (PayDialog: cash as an instruction only, «حسناً» closes it and
                                        nothing is declared; and the manual Whish report, which stays).
                                        The front door links no phone-code sign-in (no SMS provider). The
                                        request copy that reads differently takes `onlineCopy()` as an
                                        ICU `select`; the server refuses regardless
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
    finance/movements (الإيرادات والنفقات — recording, 2026-10-12; TREASURY_WORK_ROLES on its nav
      row, a reader who reaches it through the `/finance` prefix is told so and linked to the
      register: one card, `movements/movement-composer.tsx`, «قبض | صرف» with the side in `?dir=in|out`,
      `RecordIncomeForm`/`RecordExpenseForm` across the full width, two columns from `md` and three from
      `xl`, the wallet a `WalletSelect`,
      the shared fields carried across the switch, a fresh form after each recorded act with the
      confirmation above it — «طباعة» to the print page, «عرض» to the voucher in finance/transactions.
      The manager records and orders; an accountant sends a request, or pays urgently under art. 35
      — lib/expense-order.ts decides the mode; the urgent path shows the wallet currency's ceiling and
      refuses above it with «أرسلها طلباً», except for the retry of a press whose answer was lost)
    finance/transactions (الحركات المالية, 2026-10-12: the income and expense vouchers in one
      list, newest first, `GET treasury/movements`, server-paged; one frame as `DataTable`'s, the
      filter bar at its top (`movements/movement-filters.tsx`: search — `useTabSearch` 'movements',
      `SearchField` — then period, direction, wallet, category (needs a direction), cancelled), the
      lines (`movements/movement-list.tsx`, the day in a column of its own) and `Pager`; every
      filter, the page and the open voucher (`voucher`+`kind`) in the URL; ?view=queue —
      «بانتظار أمر الصرف»: requests and urgent payments waiting on the manager's order,
      components/admin/finance/expense-queue.tsx, expense-dialogs.tsx. A line opens
      `movements/voucher-sheet.tsx` (a `Sheet`: every field, who recorded, ordered or cancelled it;
      print, cancel, issue the order), pushed onto history; header links (from md) and a bottom
      bar (phones) lead to the recording page. Pure rules: lib/treasury-movements.ts)
    finance/income · finance/expenses · finance/income/new · finance/expenses/new (old addresses:
      server redirects — the registers to finance/transactions, `?dir=in|out`, `?view=queue` and its
      `?status` kept; the «new» pages to finance/movements `?dir=in|out`)
    finance/expenses/[voucherId]/print (أمر الصرف — A4 portrait; `?print=1` opens the print dialog once)
    finance/income/[voucherId]/print (سند القبض — A4 portrait, QR of the number; `?print=1`)
    finance/income/categories (بنود الإيرادات — every reader sees the list, the manager edits it;
      under the «الحركات المالية» nav row through its `also` paths, as are both print pages)
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
    requests (طلبات المعاملات, 2026-10-13, REQUEST_READ_ROLES on its nav row; docs/municipal-requests-plan.md:
      the queue, server-paged, status chips and type/channel filters in the URL, a line opens
      `components/admin/requests/request-sheet.tsx` — a `Sheet`, pushed onto history, the open
      request in `?request=` — with the steps its status allows the reader's role: «تحصيل الرسم»
      (REQUEST_BILL_ROLES; raises the bill, then the settle page for PAYMENT_SETTLE_ROLES or the
      invoice named), «جاهزة للاستلام» with the statement, «رفض الطلب», «تسليم المعاملة», «إلغاء الطلب»
      (`request-dialogs.tsx`, REQUEST_HANDLE_ROLES), each paper opened through a five-minute link)
    requests/new (طلب جديد عند الشبّاك — `counter-request-form.tsx`: `CitizenPicker` (search on
      Enter; name, mother, رقم مرجعي, never the identity number), the offered types, the citizen's held
      cards from `getCitizenProfile`, the papers sent one at a time after filing; key `request:new`;
      REQUEST_HANDLE_ROLES, anyone else is told so)
    requests/types (أنواع الطلبات والرسوم — every reader sees the list; the manager sets each fee in an
      editor above it and stops or restarts a type, REQUEST_SETTINGS_ROLES)
    requests/[requestId]/print (the paper — `request-document.tsx`, A4 portrait through
      `data-print-root`, letterhead, QR of the request number, `readView`; ready or handed-over
      requests only; `?print=1`)

A home on several levels (D28, `0095`) is drawn from `layoutBuilding` in
`components/admin/building-unit-forms.tsx` (the matrix, the drawer) and `layoutBuildingFloors` (the
elevation), the editor seeding its drafts with the columns a home rises through; the paint grid treats a
draft's `levels` as rows it occupies. `components/admin/unit-levels.tsx` holds the «عدد طوابق المسكن» panel,
the continuation tile, the house-growth prompt (shown on `houseGrowthQuestionOf`, `lib/api-client.ts`, in
the matrix, the drawer and the editor's rehearsed save; the answer is re-sent and carried through the
duplicate check) and the «معامل السقوف» editor (Settings › المالية, saved alone). Copy under `unitLevels`.
`components/admin/duplex-merge-dialog.tsx` is «دمج كدوبلكس» (SUPER_ADMIN, beside «حذف تصحيحي» in the
matrix and the drawer, shown when `upperFlatOf` finds a flat above): the preview, its refusals in words,
the whole home's area, the reason and the upper flat's code; a stale preview is re-read
(`getDuplexMergePreview`, `applyDuplexMerge`).

`CitizenProfilePayment.invoiceNumber` carries «INV-2610-0001» and is what
`payment-receipt.tsx` prints as the bill's reference. It is null on every bill
raised before migration 0079, and those keep printing the reference derived from
the id — `billReference` is where that choice lives.

A receipt is printed with `recorded` (a `RecordedMovement`: the RCP number, its moment and the
amounts the server returned) wherever a movement is known: the citizen payment page, the
counter settle page and «جولتي». Without it `PaymentReceipt` falls back to the bill's reference
and today's date, which is a different document from the one the citizen was handed.
    citizens/** buildings/** cases/** fees/** (incl. fees/new — إصدار رسم جديد)
    fees/arrears («المتأخرات», old debts, docs/old-debts-plan.md task 7: ARREARS_PREPARE_ROLES, anyone else told so on
      the page; no nav row — «الرسوم والجباية» has five — so under `/fees` and linked from the fees page. «تصدير قالب»
      (`components/admin/arrears/export-template-dialog.tsx`: a zone, or a building found by its رقم العقار, and N; the
      server's rows written by `buildArrearsTemplate`, names and codes only; key `arrears:export`), then the batch's
      import in `?batch=` (`arrears-import-panel.tsx`: `parseArrearsCsv` keeps a blank row in the middle so every row
      keeps its Excel number, the server's dry run, the verdicts in `arrears-verdicts.tsx` with a keep or drop — and its
      reason — on every flagged line, `needsDecision` in `lib/arrears.ts`, the drops sent with the check and the write,
      the save held by `writeBlocker`, then the file's sum against the pages' total to the cent, `reconciles`, before
      «إرسال للاعتماد»), the batch list, and «سطر منفرد» (`single-line-dialog.tsx`, `CitizenPicker` with archived files
      or the name as the books wrote it; key `arrears:line`). The calls are `lib/arrears-api.ts`, every one served by `ArrearsController`)
    (an old debt's bill, wherever a bill shows — task 10: `ArrearsBillMark` (`components/arrears-bill-mark.tsx`) under the title, from the bill's
      `arrears` and never from its number or title: the «متأخرات سنوات سابقة» chip, «غرامة» on a penalty line, the year and the fee in the page's
      language, the «ARR-» number, and for staff only (`showOldReference`) the old books' reference. The portal groups the old debts under
      one heading and each year under its own, the oldest first (`splitArrears`, `groupArrearsByYear` in `lib/arrears-bill.ts`), and never
      shows the old reference. The cash counter's «إلغاء الفاتورة» asks staff to cite the old receipt when a citizen proves they paid)
    fees/arrears/review · fees/arrears/match · fees/arrears/settings (old debts task 8, linked from «المتأخرات»'s header.
      «اعتماد المتأخرات», ARREARS_APPROVE_ROLES: the submitted batches, the one under review in `?batch=`
      (`batch-review.tsx`: totals by year × fee × component, the preparer's flagged lines through `ArrearsVerdicts` with
      `readOnly`, the pages' total beside the file's, and «اعتماد» — whose confirmation names the bills, their total and the
      citizens they land on — «إعادة للمحضّر» with what to fix, «إلغاء الدفعة» with its reason). «أسطر للمطابقة»,
      ARREARS_PREPARE_ROLES: an approved batch's lines with no file, each linked through `CitizenPicker` (`includeArchived`;
      the picker still refuses to take an archived file, so one cannot be linked yet). «إعدادات المتأخرات»,
      ARREARS_APPROVE_ROLES: the cutoff year, and the books' total per year read-only (entering them is open-decisions
      §23.4). Every route is task 5's, `ArrearsController`, and every view is the shared contract's (`ArrearsBatchReview`,
      `ArrearsUnmatchedLine`, `ArrearsSettingsView`))
    fees/arrears/report · fees/arrears/batches/[batchId]/sheet (old debts task 11; no nav row, linked from the fees page and from «المتأخرات»'s
      header, `ARREARS_REPORT_ROLES` — the finance reports' readers, «مشاهد فقط» included, since neither names a citizen. «تقرير المتأخرات»: five
      figures (billed, collected, cancelled, written off, owed) and the lines waiting in «للمطابقة» said apart, then by year × fee, each year against the
      books' total («غير مدخل» until one is entered: open-decisions §23.4), the coverage, the collections of old debts apart from every other
      bill by year, and the approved batches, each opening its sheet; «تصدير CSV» is the by-year table through `csvCell`. The sheet is one A4 portrait
      document through `data-print-root` (`official-document.tsx`: letterhead, `SignatureBlock` for the preparer and the head of the municipality):
      who prepared and approved it and when, the totals, the lines by year and fee, and the dropped lines by رقم العقار with their reasons; it names
      no citizen. A draft or discarded batch has no sheet and the page shows the server's `ARREARS_BATCH_NOT_APPROVED`)
    fees/exemptions («قائمة الإعفاء من الرسوم», 0104: FEE_EXEMPTION_READ_ROLES, turned away otherwise on the
      page; under the `/fees` nav row, whose group already has five rows, and linked from the fees page. The
      standing or lifted periods server-paged, a reason filter and the status in the URL, the unit open in a
      `Sheet` pushed onto history (`?unit=`) with `FeeExemptionUnitCard`; «إضافة إعفاء» for the manager,
      `AddFeeExemptionSheet`: a citizen's units through `CitizenPicker`, or a unit by its full code.
      `components/admin/fee-exemptions/` also holds the form and the lift dialog the unit drawer's
      `FeeExemptionPanel` uses; keys `fee-exemptions`, `fee-exemption-unit`, `fee-exemption-citizen`)
    buildings/types («أنواع المباني», 0106: every role reads, the manager adds, edits, switches off and on,
      `components/admin/building-types/building-type-dialog.tsx`; linked from «سجل المباني». The list is
      read through `useBuildingTypes` (`lib/building-types.ts`, key `building-types`), which keeps the
      active list on the device for an inspector with no network (`readWithOfflineCopy`); the editor's
      picker, the ledger, the map and the dashboard read it too. A `SegmentedControl` in the URL, `?tab=`,
      switches to «أنواع الوحدات» (0109, `UnitTypesPanel`, `UnitTypeDialog`): the same list for units as **one flat list**
      (the user's decision of 2026-11-21) — شقة, محل … and what was added, each with how many units have it, and no
      system/municipality badge and no billing base on screen; the form asks for the names and the order only, and the
      server bills a new type as `DEFAULT_UNIT_TYPE_BASE` (مكتب). The manager adds, renames, switches off and
      on (`UNIT_TYPE_ADMIN_ROLES`). It is read through `useUnitTypes` (`lib/unit-types.ts`, key `unit-types`,
      the active list kept on the device like the building types, every type for the screens that name a unit
      by its type). The pickers — the editor's paint grid (`UnitGridPicker`'s `unitTypes`), the matrix view's
      and the drawer's «إضافة وحدة» — hold a select value that is a type's id, or the base `UnitType` itself
      for a floor block and while the list is not loaded (`unitTypeOptions`, `chosenType`, `optionValueOf`),
      and send `unitType` (the base) with `unitTypeId` when there is one; tiles and headings name a unit by its
      type (`unitTypeLabel`). Citizens' property cards and `building-unit-picker` still choose a base only. **The 27 default
      types are drawn each as itself** in the building elevation (`unit-figures.tsx`: a dome and minaret for مسجد, a canopy
      and pump for محطة وقود …; no manager picks a figure): `figuresByType(types)` maps a type's id to its `figureKey`, the
      matrix view and the drawer pass it as `BuildingElevation`'s `figures`, and `UnitFace` draws the figure on a unit of
      premises or storage, else the base's front as before; underground, dense or ghost drawings keep the plain one. A
      figure is laid out on a centred stage no wider than 1.9 times its height (`Box`, a size container) with vertical
      offsets in `cqh` — a percentage margin or padding is a share of the *width* and flattened them. The citizens'
      property pictures (`PropertyScene`) do not pass `figures` and draw the base's front)
    news/categories · news/publishers («الأخبار» on Day3ati, 2026-11-20: NEWS_EDITOR_ROLES — the administrator and
      the administrative officer — on both nav rows, in a «الأخبار» group of their own. The categories an article is
      filed under and who it is published as, kept on Day3ati and read and written through our API as the
      signed-in user (`getNewsCategories`, `createNewsCategory`, `updateNewsCategory` and the publishers' three, which
      send `?lang=`); a `DataTable`, a dialog (`components/admin/news/news-category-dialog.tsx`,
      `news-publisher-dialog.tsx`) and a `ConfirmDialog` to switch one off or on, never a delete. A category's key is
      typed once and shown locked. An edit and a switch send the whole record, because Day3ati replaces it. Read through
      `useNewsCategories` / `useNewsPublishers` (`lib/news.ts`, keys `news-categories` / `news-publishers`, `reference`),
      written names through `newsName` (the page's language, Arabic where none). A refusal Day3ati names by code
      (`NEWS_FIELD_ERROR_CODES`: a key already taken) is worded in `news.fieldErrors` and shown under its field by
      `newsFieldErrors`; any other `NEWS_*` refusal shows as the form's alert through `error.message`)
    news/articles · news/articles/new · news/articles/[articleId] («الأخبار», 2026-11-20: the article list — every
      status, newest edit first, `?status=` in the URL, a page of 20 and «عرض المزيد» for the cursor's next
      page (`getNewsArticles`; the first page is the query's, so a re-read resets the pages after it) — and the
      editor, `components/admin/news/article-editor.tsx`: the text in up to three languages
      (`article-fields.tsx`, a tab each, the default language required, a counter under every box), category and
      publisher pickers (active ones, and the article's own even when switched off), three place labels,
      «أرسل إشعاراً للأهالي», then «حفظ» and the moves its status allows (`actionsFor` in
      `lib/news-article-form.ts`: a draft is published now or scheduled; a scheduled one published now, moved or sent
      back; a published one archived or placed — never scheduled; an archived one published again; any deleted).
      A move is off while the form has unsaved changes, so what goes out is what was written; leaving with changes
      asks first (`useLeaveGuard`). A schedule is a day and a time on Beirut's clock
      (`article-schedule-dialog.tsx`, `day-time-fields.tsx`; `scheduleInstant` makes the UTC instant Day3ati takes,
      `municipalInstant` in shared-schemas) and every scheduled time is shown on that clock
      (`formatMunicipalDateTime`), whatever the browser's zone. «تثبيت وتمييز» is `article-placement-dialog.tsx`.
      The form, its rules and the status table are pure, in `lib/news-article-form.ts`, tested without a browser. A
      new article saves a draft and then moves to its own address; an existing one is read fresh each time it
      opens (`useNewsArticle`). A saved article also holds its **photos and PDFs** (`article-media.tsx`): files
      sent one after another through `uploadNewsMedia`, an `XMLHttpRequest` because `fetch` cannot report how far
      an upload has got (a progress bar; one token renewal like `apiFetch`'s, the form sent again), after the
      browser's own first check (`newsFileProblem`: JPEG, PNG, WebP, HEIC or PDF, 10 MB for a photo and 15 for a
      PDF, 20 files) which the server repeats on the bytes. A photo is `processing` for a moment: while any is,
      the editor reads the article again every 3 s (`refreshMedia`, a `background` read that touches only the
      files, so unsaved text is never lost). A failed photo is «رفع من جديد» (sent with the id it replaces),
      a ready one can be made the cover, any can be deleted. A thumbnail is drawn only from the one media host
      the page's policy lets images in from (`DAY3ATI_MEDIA_ORIGIN`, `thumbnailSrc`); otherwise an icon stands in.
      The News rows (the whole «الأخبار» group) are hidden when `GET news/availability` says `enabled: false`, read
      once in `AdminShell` (`useNewsAvailability`, only for an editor) and passed to the sidebar, the drawer and
      the palette; while it is unknown, or Day3ati could not be read, they stay.)
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
      Writes below; lib/bill-receipts-screens.test.ts parses both pages for the link and the mount.
      On a shared unit bill (0099) each payment names its payer and offers «طباعة الوصل» for that payment
      alone, from the payer's file (`mayPrintSharedReceipt`, `receiptOfEntry`, decision D9); the cash form
      names the file's citizen as the payer (`paidByCitizenId`). The citizen file and the fees and
      payments lists reprint no shared bill's total: they link here, through the last payer's file)
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

Of the 82 `page.tsx` files, 78 are `'use client'` and read `params` with `use(params)`; the other four are the server redirects from the treasury's old addresses (`finance/income`, `finance/expenses` and their `new`), which `await params` (counted 2026-10-13 as 77 and 73; the five «الأخبار» pages were added 2026-11-20).
`components/ui` is the kit (35 files, `search-field.tsx` added 2026-10-12, `file-input.tsx` 2026-10-13); `components/admin` holds staff screens (feature
folders `bulk-settle/`, `cases/`, `damage/`, `fees/` (the fees page's figures and its review dialog), `finance/`, `quality/`, `requests/`, `settings/`, `staff/`; `citizen-picker.tsx` finds a person on the register for a counter screen); `components/citizen` is mostly citizen-record
form pieces used by staff screens, and only `pay-dialog` and `my-requests` serve the portal. `lib` holds the
API client, session, hooks, formatters and offline queue; `public/sw.js` is the service worker.

## Composition roots and provider order

- `middleware.ts`: per-request CSP nonce sent on as `x-nonce`; locale redirect from the
  `NEXT_LOCALE` cookie, then Accept-Language, then `DEFAULT_LOCALE`; `/monitoring` exempt.
- `TenantLayout`: tenant config fetch (unknown tenant gives `notFound()`), `<html lang dir>`,
  `--brand-primary` through `safeHslTriple`, then `NextIntlClientProvider` > `ThemeProvider`
  > `AccentProvider`.
- `ProtectedAdminLayout`: `QueryProvider` > `TooltipProvider` > `ToastProvider` >
  `AdminShell` (registers the service worker; holds the page's `HeaderBackLink` for
  `AdminHeader` to draw) > `StaffRouteGuard`. `(citizen)/layout.tsx`
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
  one flight per tenant) and replays — except on the session routes (`SESSION_ROUTES`) and for a
  401 that answers the request (`ANSWERED_401`: a wrong current password in «أمان الحساب», and a
  wrong code confirming an authenticator, `TOTP_CODE_INVALID`). Endpoint functions MUST be shaped
  `fn(tenant, token, args?, signal?)` (model `getReviewQueue`), with shared-schemas types (CODE-3).
  Nothing calls the API with a bare `fetch`: it carries no token, and every route but the
  `@Public()` ones answers 401. The cadastre map layers are read through `fetchCadastreAsset`
  (`lib/cadastre-assets.ts`): the portal's `public/tenants/<slug>/` copy first, then
  `getCadastreAsset` with the token; `null` when neither answers, never a throw. The three maps
  hold the token in a ref (`tokenRef`), because the map's `load` handler outlives the render
  that created it.
- **Reads** MUST use `useStaffQuery` (`lib/use-staff-query.ts`) with key
  `[resource, tenant, ...every param that changes the answer]`. It waits for the token,
  clears the session on a 401, and returns `{data, loading, fetching, error, refusal, refetch}`. `error` is the caller's own wording and never the API's text; `refusal` is the API's own words for a refusal it gave a **specific code** for (already translated into the page's language, `refusalOf`), and null for anything else, so it never carries raw server text. `DataTable` shows one generic line for any `error` and ignores its content: a screen where the reason changes what to do (the News screens: no News access, News switched off, Day3ati down) shows `ErrorState` with `refusal ?? error` instead.
  `keepPrevious` for server-paged tables, `reference` for lookup lists, `refreshMs`
  for the few reads whose answer goes stale with nothing on the page to invalidate it
  (today only the staff presence read, `lib/use-staff-presence.ts`, at 60 s — the same
  minute the server's presence stamp is written on; the heavy `/staff` roster is read once).
  TanStack pauses the interval while the tab is hidden. It is not a way to make an ordinary
  table feel live; invalidating the key after a write is. `fresh` (`staleTime` and `gcTime` 0)
  for a read a write is about to be confirmed against: it is read again on every mount and never
  served from the cache (today only «معاينة قبل الإصدار», `components/admin/fees/notice-preview.tsx`,
  which also reports no answer while `fetching`, so «إصدار المطالبات» waits for the re-read).
  Share the key of a read another screen invalidates: the fee wizard read the titles under
  `fees-filter-options` while every invalidation named `fee-filter-options`, and under
  `reference` its list was never refreshed (fixed 2026-10-24).
  - **Leaving a half-filled form**: `useLeaveGuard(active)` (`lib/use-leave-guard.ts`) holds a
    click on an in-app link for the caller's `ConfirmDialog` (`pendingHref`, `leave`, `stay`) and
    asks through `beforeunload` on a reload or a closed tab. It cannot hold the browser's back
    button (the app router has no way to refuse a `popstate`). First user: the fee wizard.
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
    the form for the life of the tab. Scopes — `KeyScope`, sixteen of them (`arrears:export` and `arrears:line` added for old debts, 2026-11-21): `building:<parcel>` (a new
    building, whose key is its id; the building editor), `bulk-settle:<ids>` (the
    selected bills' ids, sorted; `bulkKeyScope`), `commission:<staffId>` (one per inspector paid;
    `commissionScope` in `lib/commission-payout.ts`; sent before go-live too, by `payoutRequest`,
    since the payout row keeps it, `0089`), `custody:<accountId>`, `expense:pay`,
    `expense:request`, `charge:new` («تكليف مالي», the one-off charge on `/fees`, 0102), `fee-notice:new` (the notice wizard, `fees/new`), `income:new`, `request:new`
    (a municipal request filed at the counter), `request:mine:<citizenId>` (one the citizen files in
    the portal; per citizen, because a shared phone signs one out and the next in on the same tab),
    `salary:<staffId>` (one per person paid),
    `settle:<paymentId>` (the settle page and the citizen cash page settle the same bill and
    share it), `transfer:new`. The key belongs to one act: it is minted when a screen first asks
    for it and kept across **every** failure (any 4xx, 401, 403, 408 and
    429 included, status 0, 5xx) and every edit, because a refusal proves only that this attempt
    wrote nothing, never that an earlier one with the key did not. The server binds a key to its
    act (an expense: wallet, amount, clerk, band, payee, reason; a salary: also the staff
    account; an income voucher: wallet, amount, clerk, category, description, payer; a handover:
    custody wallet, amount, clerk; a counter payment: the bill, the method, the collector, the
    reference and the sum, or the notes handed over (B6), the payer of a shared bill and the day
    (F18, 2026-11-15) — and both counter pages send `expected`, the credit and change they show, which
    the server refuses as `PAYMENT_FIGURES_CHANGED` when its lock reads others: nothing is written, the
    key is kept, and the page re-reads the bill (and the cash page the rate); the cash page asks a
    reason for change worth more than the manager's `largeExchangeThreshold` (F19,
    `counterPayment.largeChange`); a notice: title, figure, basis, bearer,
    recurrence, target, due date), so an edit after a lost answer is refused with
    `TREASURY_REQUEST_KEY_REUSED` (`PAYMENT_IDEMPOTENCY_KEY_REUSED` at the counter,
    `FEE_NOTICE_REQUEST_REUSED` for a notice) instead of recorded twice. Another notice that bills the
    same people for the same period is not a replay but a second act (finding F11): the preview lists it
    (`duplicates`), «قبل الإصدار» asks the clerk to confirm it by id (`NoticeDraft.duplicatesConfirmed`,
    `duplicatesConfirmed` in `lib/fee-notice-draft.ts`) before «إصدار» is live, and a refusal with
    `FEE_NOTICE_DUPLICATE` — one issued since the preview — keeps the key, nothing having been written,
    and re-reads the preview (`['fee-notice-preview', tenant]`). The key is spent (`spendKey`) only
    when the server confirms its act exists: a 2xx, or one of the refusals `keyIsSpent` names —
    `ACT_RECORDED`, the one list: `TREASURY_REQUEST_KEY_REUSED`, `EXPENSE_ALREADY_VOID`,
    `INCOME_ALREADY_VOID`, `TRANSFER_ALREADY_VOID`, `TRANSACTION_ALREADY_REVERSED`,
    `PAYMENT_IDEMPOTENCY_KEY_REUSED`, `BULK_SETTLE_REQUEST_REUSED`, `FEE_NOTICE_REQUEST_REUSED`, `FEE_CHARGE_REQUEST_REUSED`; the commission payout dialog
    also spends on `INSPECTOR_PAYOUT_REQUEST_REUSED` (`payoutKeyAfterFailure`) — after which the
    treasury queries are re-read. The expense, income and salary forms also
    re-read them after a failure `outcomeInDoubt` names, keeping the key. On the settle and cash
    pages such a refusal names the earlier receipt (`earlierRecorded`, `earlierReversed`) and re-reads
    the bill — the settle page in place (`rereadBill`), the cash page through
    `['citizen-profile', tenant, citizenId]` — with the button held until the read ends, and off
    while it has failed (`billStale`), so the next press is not judged against the old balance. No form
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
    dialog, handover, order, settle and cash pages, and the notice wizard, which names the
    notice's title and id). Since B6 a counter replay carries the sum, or the notes, the form sent;
    the rate is not compared, so the cash page's ليرة credit can differ from its preview when the
    official rate moved in between, and the receipt prints the server's.
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
  Its keys name the tenant, never who asked, so a read whose answer depends on the session kind stays
  out of it: the portal's settings (`getCitizenPortalSettings`, a citizen's three fields) are read
  uncached, while the staff screens share `settings:<tenant>:…` (review of 2026-11-20).
- Deviations: 15 `(protected)` pages and 7 components (besides `AdminShell` and
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
  `NAV_GROUPS` row to every role (CODE-4). Citizen pages call `loadSession` directly; the
  request pages (2026-10-13) through `useCitizenSession(tenant, base)` (`lib/use-citizen-session.ts`:
  `{token, citizenId, endIfSignedOut}`, the front door for a staff session or none, and for a 401).
- A screen about the signed-in account reads `getStaffSelf` (`GET auth/staff/me`), never the
  roster (`getStaff` is `SUPER_ADMIN`'s, and answered every other role 403). A password change
  (`changeStaffPassword`) ends this session too, so «أمان الحساب» signs out as `AdminHeader` does
  and goes to `signInAfterPasswordChange(base)`; the sign-in page shows why
  (`openedAfterPasswordChange`, both in `lib/password-change.ts`). So do confirming and removing
  the second factor (audit SEC-02): `signInAfterSecondFactorChange(base, 'on' | 'off')` and
  `secondFactorNoticeOf`. Starting an enrolment, first or again, goes through the card's
  confirmation dialog, which sends the password and, while a factor is confirmed, its current code
  (`beginStaffTotpEnrolment` and `disableStaffTotp` take `TotpReauth`); a refusal shows `error.message`.
- The portal's «خروج» ends the citizen's sessions on the server before clearing the browser
  (`signOutCitizen`, `lib/citizen-sign-out.ts`, over `logoutCitizen`; task S14); a 401 handler clears
  the local copy alone, since the server already ended that session. The staff reset page reads its
  token from the fragment with `parseResetLink` (`lib/reset-link.ts`), the shared rule the server
  writes the link with.
- Drafts and the offline queue survive sign-out: [docs/security.md](../../docs/security.md#known-gaps).

## Copy and i18n (decision D-i18n)

- New copy MUST go in next-intl messages, `messages/ar.json` and `messages/en.json`, with
  the same keys in both (4,239 leaf keys each, counted 2026-11-21 on `feat/unit-types`, with `unitTypes.*`, the `UNIT_TYPE_*` codes and their audit labels; 4,194 on `feat/arrears-approval-ui` merged with `develop`, with `arrears.review`, `.match` and `.settings`; 4,115 on `feat/arrears-import-ui` merged with `develop`, with `arrears.*`; 3,950 on `feat/arrears-write-off` with `counterPayment.writeOff` and the «شطب» codes; 3,907 counted 2026-11-21 with the News load-failure title and retry, the article media panel and `news.*` («الأخبار», categories, publishers and articles) and with `feeExemptions.*`, `buildingTypes.*` and the 2026-11-15/16 fixes; 3,422 on 2026-10-26 on `fix/fee-wizard-review`, with «من يشمل الإشعار» under `fees.scope`; 3,121 on 2026-10-15 on PR #122 rebased onto `develop@3211140`, with municipal requests: `requests.*` for the staff screens, `citizenRequests.*` for the portal's, `citizenPicker.*`; `finance.movements` holds the copy of both «الإيرادات والنفقات» and «الحركات المالية»). Read it with `useTranslations`.
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
  09/10/2026 like the page around it (PRIM-12), and a month (`YYYY-MM`: a salary's period) through
  `formatMonth`, «تشرين الأول 2026», as the salary dialog offers it.
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

- `lib/offline-db.ts`: IndexedDB `mechanization.offline` (`DB_VERSION = 3` since 2026-11-16), stores
  `citizenSubmissions` and `buildingSubmissions`, and `referenceData` (`saveReference`/`loadReference`: a list
  the server owns and a screen needs offline, one row per tenant and list — the building types, 0106; not
  citizen data; the upgrade is additive), keyed by `id`, a `clientSubmissionId` from
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
page their own list (the «الحركات المالية» register and its queue) share `?page=` / `?limit=`, so a
view switch clears the other view's parameters in the same write. A list whose rows leave it as they
are acted on steps back to the last page with rows once its answer is in (`pageWithRows` in
`lib/url-state.ts`; «مراجعة السجلات», which pages its cards with `Pager`).

`useUrlState` writes with `replaceState`: a filter is not a place. A page that opens something
over its list — the voucher `Sheet` of «الحركات المالية» — writes that one change with `pushState`
instead (Next keeps `useSearchParams` in step with both), so the back button closes it; closing it
from its own control steps back the same way. Opened by its address, it closes with a replace.

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

A municipal request's paper (`requests/request-document.tsx`, on `requests/[requestId]/print`) is a
document page too: one `data-print-root`, A4 portrait, the letterhead and the signature lines of
`finance/official-document.tsx`, a QR code holding the request number alone (D7), and the citizen's
identity number — never the رقم مرجعي.

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
   `case-editor`, `building-editor` and the settle page do (the citizen cash page sends a
   collector, who may settle but not into the safe, to the settle page: `CASH_COUNTER_ROLES`,
   and the citizen file's row button follows it), and a component that offers an
   action takes the permission as a required prop (`canSend`, `canAnswer`, `canOpen`)
   rather than a default that fails open.
4. **Messages**: a namespace in both message files, including `aria-label`, `title`,
   toasts, units and error texts (TXT-2).
5. **Read**: `useStaffSession`, then `useStaffQuery`; list state from `useUrlPagination`,
   `useTabSearch`, `useUrlState`.
6. **Layout**: root `w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8`, `PageHeader` (a title and
   no subtitle — the prop no longer exists, PRIM-1; a page with a way back declares it with
   `HeaderBackLink`, which the header draws, PRIM-2), `Card` > `CardContent className="p-0"` > borderless `DataTable`
   (`manualPagination manualFiltering sortable={false}`, `loading`, `error`, `onRetry`,
   labels from `useTableLabels`, with `{ columnsMenu: true }` when the table passes
   `columnStorageKey`) (LAY-1, BAN-4, PRIM-3). A failed write above it is `Alert`
   (`variant="destructive" live="alert"`), never a red `<p>` (CTL-12).
7. **Panels and cells**: `LoadingState`, `EmptyState`, `ErrorState`; `CellTag`, `Money`,
   `formatDate` and friends, `formatPhone` (PRIM-5 to PRIM-12). `Money` isolates the signed
   figure left to right (minus U+2212, `moneyParts` in `lib/currency.ts`) and leaves the unit in
   the page's direction; `currency` draws a dollar or euro figure the same way, `signed` adds «+»
   for a ledger movement, and `wrap` lets the unit drop under the figure — a figure in a
   `StatItem` passes it, because `StatItem` wraps and never truncates; its `hint` is a short muted
   line that qualifies the figure («منها متأخرات», «آخر دفعة: …»), not a local tile. The treasury draws every
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
| `NEXT_PUBLIC_API_URL` | 7 files, each with its own fallback (`'http://localhost:4000/api/v1'`): `lib/api-client.ts`, `middleware.ts`, three layouts, the manifest route, dashboard (debt: [docs/code-quality.md](../../docs/code-quality.md)) |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | `fullscreen-map.tsx`, `parcel-pin-picker.tsx`, `zone-editor-map.tsx` |
| `NEXT_PUBLIC_DAY3ATI_MEDIA_ORIGIN` | `middleware.ts` (adds it to the CSP's `img-src`) and `lib/news-media.ts` (`thumbnailSrc`): the https origin of Day3ati's media host, so News thumbnails load. Unset, malformed or plain http: no thumbnail, and the policy is unchanged (`httpsOrigin`) |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_VERCEL_ENV`, `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | `lib/sentry-options.ts` |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `CI`, `VERCEL`, `NEXT_DIST_DIR` | `next.config.mjs`, build time |

## Commands

| Purpose | Command |
|---|---|
| Dev server, port 3000, Turbopack (`next dev --turbo`; `next build` still compiles with webpack; its warnings: [gotchas](../../docs/gotchas.md#next-dev---turbo-warns-about-the-workspace-root-and-import-in-the-middle)) (root `pnpm dev` checks the env first) | `pnpm --filter @mechanization/frontend dev` |
| Typecheck | `pnpm --filter @mechanization/frontend typecheck` |
| Lint, as CI runs it (whether `next lint` reads the flat config is **Unverified**) | `pnpm lint` |
| Unused files, exports and dependencies, every workspace (knip; root `knip.jsonc`, new findings fail) | `pnpm lint:unused` |
| Unit tests, watch mode | `pnpm --filter @mechanization/frontend test`, `pnpm --filter @mechanization/frontend test:watch` |
| Production build that leaves the dev server's `.next` alone | `pnpm build:check` |
| First, after a shared-schemas change (the app reads its `dist/`) | `pnpm --filter @mechanization/shared-schemas build` |

## Tests

Vitest (`apps/frontend/vitest.config.mts`): `environment: 'node'`, only `lib/**/*.test.ts`,
with `vitest.setup.ts` stubbing `navigator.onLine` and `window`. 67 test files, 850 cases (counted 2026-11-21 on `feat/unit-types`, `lib/unit-types.test.ts` added; 66 and 842 on `feat/arrears-import-ui`, `lib/arrears.test.ts` added; 65 and 832 the same day, `lib/use-staff-query.test.ts` added; `lib/news-media.test.ts` and the News rows of `lib/nav.test.ts` added; `lib/news.test.ts` and `lib/news-article-form.test.ts` added; 57 and 742 counted
2026-10-26 on `fix/fee-wizard-review`). Several read components rather than render them:
`back-navigation.test.ts` every page and component under `app/` and `components/`, so that only
the header and the two toolbars PRIM-2 names draw a `BackLink`; `print-pages.test.ts` and `payout-hosts.test.ts` read every
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
