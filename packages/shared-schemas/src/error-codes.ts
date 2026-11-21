/**
 * Error codes: the one vocabulary the API speaks when it refuses something.
 *
 * The backend throws a DomainError carrying one of these codes; the frontend
 * looks the code up in `messages/{ar,en}.json` under `errors` and shows that
 * text. The English message a DomainError also carries is for logs only and is
 * never meant to reach a screen. A code is a stable machine identifier: rename
 * one only together with both dictionaries, and never reuse a retired one for a
 * different meaning.
 *
 * Adding a code: add it here, add `errors.<CODE>` to both message files (the
 * frontend test fails if either is missing or their placeholders differ), then
 * throw it. Message parameters travel in `params`; never put a national ID, a
 * phone number or a رقم مرجعي in one unless the screen already shows it.
 */

/**
 * What kind of refusal it is, which decides the HTTP status. Every DomainError
 * subclass has one. A thrown error that has not been given a specific code yet
 * sends its kind as its code.
 */
export const ERROR_KINDS = [
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'TENANT_MISMATCH',
  'TENANT_NOT_PROVISIONED',
  'HTTP_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Specific codes, each with `errors.<CODE>` in both message files. */
export const ERROR_CODES = [
  // Fees and payments
  'FEE_NO_MATCHING_CITIZENS',
  'FEE_NOTHING_TO_CHARGE',
  'FEE_CITIZEN_ARCHIVED',
  'FEE_DUE_DATE_INVALID',
  // A notice's period is a year before the old-debts cutoff (`params.year`, `params.cutoffYear`): those years are
  // entered as old debts, and a notice would bill them a second time (docs/old-debts-plan.md §8).
  'FEE_PERIOD_BEFORE_ARREARS_CUTOFF',
  'FEE_NOTICE_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_ALREADY_PAID',
  'PAYMENT_ALREADY_UNDER_REVIEW',
  // A citizen reports a Whish Money transfer only, with its reference; cash is paid at the office (open-decisions §21).
  'PAYMENT_DECLARATION_WHISH_ONLY',
  // Staff side: a counter payment or a reversal on a bill whose citizen claim is still under review.
  'PAYMENT_CLAIM_UNDER_REVIEW',
  'PAYMENT_STATE_CHANGED',
  'PAYMENT_NO_PENDING_REVIEW',
  'PAYMENT_NOTHING_OUTSTANDING',
  'CHARGE_ALREADY_PAID',
  'CHARGE_PAYMENT_PENDING',
  'CHARGE_CHANGED_DURING_CHECKOUT',
  // Paying online through Whish is paused until the provider is wired (open-decisions §21).
  'ONLINE_PAYMENT_UNAVAILABLE',
  'PAYMENT_CURRENCY_MISMATCH',
  'EXCHANGE_RATE_MISSING',
  'EXCHANGE_RATE_OVERRIDE_FORBIDDEN',
  'EXCHANGE_RATE_NOT_SET',
  'PAYMENT_BACKDATE_FORBIDDEN',
  'PAYMENT_RATE_REASON_REQUIRED',
  'PAYMENT_BACKDATE_REASON_REQUIRED',
  'PAYMENT_AMOUNT_NOT_POSITIVE',
  'PAYMENT_DATE_BEFORE_INVOICE',
  'PAYMENT_TENDER_EXCEEDS_BALANCE',
  'PAYMENT_EXCEEDS_BALANCE',
  'TRANSACTION_NOT_FOUND',
  'TRANSACTION_ALREADY_REVERSED',
  'TRANSACTION_IS_REVERSAL',
  'PAYMENT_IDEMPOTENCY_KEY_REUSED',
  // A collector settles only into his own custody: method COLLECTOR, himself named (finance audit B1).
  'COLLECTOR_CANNOT_SELECT_METHOD',
  // A Whish reference already on a receipt still standing (`params.receiptNumber`).
  'PAYMENT_EXTERNAL_REF_REUSED',
  // Confirming from the review queue a bill whose Whish checkout was set aside as MISMATCHED:
  // the clerk refuses the claim and records what the provider shows (`params.reference`, the provider's
  // transaction number, or the checkout's own when the provider sent none).
  'PAYMENT_CHECKOUT_MISMATCHED',
  // A counter rate further from the official one than the tolerance (`params.deviation`, `params.tolerance`).
  'EXCHANGE_RATE_OVERRIDE_BEYOND_TOLERANCE',
  // A bill cancelled by the manager takes no payment, claim or checkout.
  'PAYMENT_BILL_CANCELLED',
  // A shared unit bill (0099) is paid by one of its debtors, named; a citizen's own bill names no payer.
  'SHARED_BILL_PAYER_REQUIRED',
  'SHARED_BILL_PAYER_NOT_DEBTOR',
  'SHARED_BILL_PAYER_ON_OWN_BILL',
  // A debtor's claim or online payment on a shared unit bill: it is paid at the office.
  'SHARED_BILL_PAY_AT_OFFICE',
  // Cancelling a bill that has money on it, or one already cancelled.
  'BILL_CANCEL_HAS_PAYMENTS',
  'BILL_ALREADY_CANCELLED',
  // «شطب» (0107, docs/old-debts-plan.md decision 10): a bill already written off takes no write-off,
  // cancellation, payment, claim or checkout, and none of its receipts is reversed while it stands.
  'BILL_ALREADY_WRITTEN_OFF',
  'PAYMENT_BILL_WRITTEN_OFF',
  'PAYMENT_REVERSAL_BILL_WRITTEN_OFF',
  // Nothing is left on the bill to write off: it is paid.
  'BILL_WRITE_OFF_NOTHING_LEFT',
  // The council's decision is dated after today (`params.today`).
  'BILL_WRITE_OFF_DECISION_IN_FUTURE',
  // A retry key already used to issue a different notice.
  'FEE_NOTICE_REQUEST_REUSED',
  // «تكليف مالي»: a retry key already used for a different one-off charge (0102). `params.invoiceNumber`
  // names the bill the key raised.
  'FEE_CHARGE_REQUEST_REUSED',
  // An active notice would bill the same people for the same period (`FeeNoticeDuplicate`), not
  // confirmed in `acknowledgedDuplicates`. `params.title` is the first one's title, `params.count`
  // how many; `details.duplicates` lists them.
  'FEE_NOTICE_DUPLICATE',
  // A single counter payment whose credit or change, worked out under the bill's lock, is not what the
  // screen showed (`expected`): `params.credit`, `params.change` and `params.currency` are the server's.
  'PAYMENT_FIGURES_CHANGED',
  // Counter change worth more than the manager's large-exchange threshold, with no reason given.
  // `params.threshold` is the threshold and `params.currency` the foreign currency it is counted in.
  'PAYMENT_LARGE_CHANGE_REASON_REQUIRED',
  // Several of one citizen's bills settled in one press (docs/finance.md §3.7)
  'BULK_SETTLE_CITIZEN_MISMATCH',
  // A selected bill was settled since it was ticked (`params.invoice`: its INV- number, or its title).
  'BULK_SETTLE_SOME_ALREADY_PAID',
  // The notes do not cover every selected bill (`params.shortBy`, `params.currency`).
  'BULK_SETTLE_TENDER_SHORT',
  // Notes in one currency above what is owed in it (`params.amount`, `params.due`, `params.currency`).
  'BULK_SETTLE_TENDER_EXCEEDS',
  // A bill in neither the municipality's currency nor the notes' foreign one (`params.currency`).
  'BULK_SETTLE_CURRENCY_UNSUPPORTED',
  'BULK_SETTLE_RATE_NOT_SET',
  // A retry key already used to settle another set of bills.
  'BULK_SETTLE_REQUEST_REUSED',
  // A selected bill is a Whish claim waiting for review (`params.invoice`): confirm it, do not take the money again.
  'BULK_SETTLE_BILL_PENDING_REVIEW',
  // What the bills owe in a currency is not what the clerk was shown (`params.currency`, `params.expected`, `params.due`).
  'BULK_SETTLE_DUE_CHANGED',
  'PAYMENT_SETTLEMENT_NOT_FOUND',
  'INVOICE_NOT_FOUND',
  'INVOICE_NOT_OPEN',
  'INVOICE_NOT_CHARGED',
  'INVOICE_FIGURE_CHANGED',
  'CITIZENS_ONLY',
  // Ownership, tenancy and occupancy
  'PROPERTY_CARD_NOT_FOUND',
  'OWNERSHIP_ALREADY_ENDED',
  'OWNERSHIP_CARD_NOT_OWNER',
  'CARD_UNITS_CHANGED',
  'OWNERSHIP_SELECT_UNITS',
  'OCCUPANCY_NOT_FOUND',
  'OCCUPANCY_NOT_OWNERSHIP',
  'OWNER_CARD_COVERS_STRUCTURE',
  'OWNER_NOT_FOUND',
  'OWNERSHIP_NONE_ACTIVE',
  'OWNER_HAS_LINKED_TENANTS',
  'OWNERSHIP_END_BEFORE_START',
  'NEW_OWNER_ONLY_ON_SALE',
  'NEW_OWNER_IS_CURRENT',
  'NEW_OWNER_NOT_FOUND',
  'OWNERSHIP_AFTER_STATUS_REQUIRED',
  'NEW_OWNER_REQUIRED_FOR_STATUS',
  'VACANCY_BASIS_REQUIRED',
  'OWNERSHIP_CHANGED_CONCURRENTLY',
  'CARD_UNITS_CHANGED_CONCURRENTLY',
  'CITIZEN_REQUIRED',
  'TENANCY_ENDED_CANNOT_LINK',
  'CITIZEN_NOT_FOUND',
  'OWNER_CARD_HAS_NO_LANDLORD',
  'LANDLORD_IS_FILER',
  'LANDLORD_DOES_NOT_MATCH',
  'CARD_LINKED_TO_OTHER_LANDLORD',
  'CITIZEN_FILE_DISABLED',
  'LANDLORD_LINK_CHANGED_CONCURRENTLY',
  'OCCUPANCY_ENDED_CANNOT_LINK',
  'OWNER_CANNOT_HAVE_LANDLORD',
  'LANDLORD_IS_SELF',
  'LANDLORD_NOT_OWNER_OF_UNIT',
  'LANDLORD_RECORDED_AFTER_TENANT',
  'TENANT_CARD_NOT_FOUND',
  'UNIT_ON_CARD_WITH_OTHER_CAPACITY',
  'TENANT_CARD_LINKED_TO_OTHER_OWNER',
  'TENANT_CARD_UNITS_UNSET',
  'UNIT_SPLIT_FAILED',
  'UNIT_NO_LONGER_EXISTS',
  'LANDLORD_LINK_CHANGED_DURING_UPDATE',
  'TENANCY_ENDED_LINK_KEPT',
  'DISMISS_CANDIDATES_REQUIRED',
  'OWNERSHIP_END_REASON_INVALID',
  'TENANCY_END_REASON_INVALID',
  'OCCUPANCY_ALREADY_ENDED',
  'TENANCY_ALREADY_ENDED',
  'CARD_IS_OWNER_CARD',
  'UNIT_NOT_ON_CARD',
  'TENANCY_SELECT_UNITS',
  'TENANCY_NONE_ACTIVE',
  'OCCUPANCY_END_BEFORE_START',
  'UNIT_STATUS_AFTER_EXIT_REQUIRED',
  'NON_RESIDENT_OWNER_CANNOT_OCCUPY',
  'OCCUPANCY_CHANGED_CONCURRENTLY',
  // «توزيع الرسم على المالكين» (migration 0075)
  'OWNER_BILLING_NOT_CO_OWNED',
  'OWNER_BILLING_STRUCTURAL_UNIT',
  'OWNER_BILLING_RESPONSIBLE_NOT_OWNER',
  'OWNER_BILLING_RESPONSIBLE_NOT_BILLED',
  'OWNER_BILLING_SHARES_NOT_OWNER',
  'OWNER_BILLING_SHARES_MISSING',
  // «معفاة من الرسوم» (migration 0077)
  'FEE_EXEMPTION_STRUCTURAL_UNIT',
  // «قائمة الإعفاء من الرسوم» (migration 0104): a last day before today (`params.validUntil`, `params.today`),
  // a lift with no reason in words, and a unit with an exemption history that a delete would erase
  // (`params.unitCode`; the building delete names the first such unit).
  'FEE_EXEMPTION_VALID_UNTIL_PAST',
  'FEE_EXEMPTION_LIFT_REASON_REQUIRED',
  'UNIT_HAS_FEE_EXEMPTION_HISTORY',
  // «أنواع المباني» (migration 0106): a type that does not exist; one switched off, on a new building
  // (`params.name`); a name another type has (`params.name`); a system type's structure, which never
  // changes; a custom type's structure while buildings are filed under it (`params.count`).
  'BUILDING_TYPE_NOT_FOUND',
  'BUILDING_TYPE_INACTIVE',
  'BUILDING_TYPE_NAME_TAKEN',
  'BUILDING_TYPE_SYSTEM_STRUCTURE',
  'BUILDING_TYPE_STRUCTURE_IN_USE',
  // «تركة (ورثة المرحوم)» (migration 0076)
  'ESTATE_OWNS_ONLY',
  // One home on several levels, and a house that grows (migration 0095, decision D28)
  'UNIT_LEVELS_NOT_DWELLING',
  'UNIT_LEVELS_BLOCKED',
  'UNIT_LEVELS_MAX',
  'UNIT_ON_UPPER_LEVEL',
  'HOUSE_GROWTH_UNANSWERED',
  'HOUSE_GROWTH_NOT_ABOVE',
  'HOUSE_CARD_ON_MULTI_UNIT_BUILDING',
  // Corrections
  'UNIT_CORRECTION_PREVIEW_STALE',
  'UNIT_CONFIRM_CODE_MISMATCH',
  'UNIT_CORRECTION_UNVERIFIED',
  'UNIT_CORRECTION_BUSY',
  'UNIT_NOT_FOUND',
  // «دمج كدوبلكس» (D28)
  'DUPLEX_MERGE_NO_UPPER',
  'DUPLEX_MERGE_BLOCKED',
  'PARCEL_HAS_OTHER_BUILDINGS',
  'PARCEL_CHANGED_CONCURRENTLY',
  'BUILDING_CODE_TAKEN',
  'BUILDING_NOT_FOUND',
  'PARCEL_NUMBER_REQUIRED',
  'PARCEL_NUMBER_UNCHANGED',
  // Citizen files: duplicates, edits, status, merges
  'CITIZEN_DUPLICATE_BLOCKED',
  'CITIZEN_POSSIBLE_DUPLICATE',
  'PHONE_BELONGS_TO_OTHER',
  'CITIZEN_FILE_STALE_MERGED',
  'CITIZEN_EDITED_BY_OTHER',
  'CITIZEN_EDITED_SINCE_OPENED',
  'EDIT_REASON_REQUIRED',
  'PROPERTY_TYPE_NOT_ACCEPTED',
  'TENANCY_ENDED_SINCE_OPENED',
  'PROPERTY_NOT_IN_LATEST_FILING',
  'REMOVAL_REASON_FOR_KEPT_CARD',
  'SALE_REASON_OWNER_ONLY',
  'OWNER_HAS_LINKED_TENANTS_ON_SAVE',
  // A save that deletes a card or a flat a municipal request names (0092); end it instead (`params.requests`, `params.count`).
  'PROPERTY_NAMED_BY_REQUEST',
  'CITIZEN_FILE_CHANGED_DURING_SAVE',
  'TENANCY_ENDED_ON_CARD_SINCE_OPENED',
  // The two rules migration 0072 keeps on a citizen's numbers.
  'CITIZEN_NO_PHONE_HAS_NUMBER',
  'CITIZEN_CONTACT_PHONE_IS_OWN',
  // Retired 2026-10-05 with the citizen hard delete (a citizen is archived,
  // never deleted). Kept because a code is never given a new meaning.
  'CITIZEN_IN_MERGE',
  'CITIZEN_HAS_RECORDS',
  'MERGE_PREVIEW_STALE',
  'MERGE_NOT_FOUND',
  'MERGE_ABSORBED_CHANGED',
  'CITIZEN_MERGED_AWAY',
  // A passport number another file already holds (`users` is unique on the document). Names nobody.
  'CITIZEN_IDENTITY_DOC_TAKEN',
  // A new filing for a file that is archived (`isActive` false): reactivate it first. `details.citizenId`.
  'CITIZEN_FILE_ARCHIVED',
  // Property entries (domain invariants)
  'OWNER_NAME_REQUIRED',
  'LANDLORD_PHONE_REQUIRED',
  'LOCATION_INCOMPLETE',
  'LOCATION_OUTSIDE_LEBANON',
  // Treasury (docs/finance.md)
  'TREASURY_NOT_ACTIVE',
  'TREASURY_ALREADY_ACTIVE',
  'TREASURY_ACCOUNT_NOT_FOUND',
  'TREASURY_ACCOUNT_MISSING',
  'TREASURY_OPENING_BALANCES_INCOMPLETE',
  'TREASURY_INSUFFICIENT_FUNDS',
  // An outflow dated on an earlier day that would leave that day's close, or a later one, below
  // zero although the wallet holds enough now (`params.date`, the first such day, and its close).
  'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
  'EXPENSE_NOT_FOUND',
  'EXPENSE_ALREADY_VOID',
  'EXPENSE_CATEGORY_NOT_FOUND',
  'EXPENSE_CATEGORY_INACTIVE',
  'EXPENSE_DATE_IN_FUTURE',
  'EXPENSE_DATE_BEFORE_GO_LIVE',
  'EXPENSE_BACKDATE_REASON_REQUIRED',
  'EXPENSE_CATEGORY_CODE_TAKEN',
  'SALARY_PAYEE_NOT_FOUND',
  'INSPECTOR_PAYOUT_WALLET_REQUIRED',
  'INSPECTOR_PAYOUT_WALLET_NOT_USD',
  'INSPECTOR_PAYOUT_DATE_NOT_ALLOWED',
  'INSPECTOR_PAYOUT_REQUEST_REUSED',
  // Before go-live a payout is a figure with no wallet, voucher or order: the manager's alone (finance.md §5.6).
  'INSPECTOR_PAYOUT_BEFORE_LIVE_MANAGER_ONLY',
  // A payout recorded before go-live and dated after today.
  'INSPECTOR_PAYOUT_DATE_IN_FUTURE',
  // An accountant paying a commission to himself on the urgent path (decision D9, the D8 rule).
  'COMMISSION_SELF_PAYOUT',
  // A بند only its own path may file under: «تعويضات المسح والجباية» is the payout's (`params.category`).
  'EXPENSE_CATEGORY_RESERVED',
  'INCOME_VOUCHER_NOT_FOUND',
  'INCOME_VOUCHER_ALREADY_VOIDED',
  'INCOME_CATEGORY_NOT_FOUND',
  'INCOME_CATEGORY_INACTIVE',
  'INCOME_CATEGORY_CODE_TAKEN',
  'INCOME_ACCOUNT_NOT_RECEIVING',
  'INCOME_DATE_IN_FUTURE',
  'INCOME_DATE_BEFORE_GO_LIVE',
  'INCOME_BACKDATE_REASON_REQUIRED',
  'TREASURY_INSUFFICIENT_FUNDS_FOR_VOID',
  'TRANSFER_NOT_FOUND',
  'TRANSFER_ALREADY_VOID',
  'CUSTODY_ACCOUNT_NOT_FOUND',
  'COLLECTOR_NOT_FOUND',
  'CUSTODY_EXCEEDS_HELD',
  'CUSTODY_SELF_RECEIPT',
  'SALARY_SELF_PAYOUT',
  'TREASURY_REQUEST_KEY_REUSED',
  'PAYMENT_DATE_BEFORE_GO_LIVE',
  'EXPENSE_ACCOUNT_NOT_PAYABLE',
  'EXPENSE_ORDER_REQUIRED',
  'EXPENSE_ALREADY_ORDERED',
  'EXPENSE_REQUEST_NOT_FOUND',
  'EXPENSE_REQUEST_ALREADY_DECIDED',
  'EXPENSE_REQUEST_NOT_YOURS',
  // A retried «سجّل الإيراد» whose voucher has been cancelled since (`params.voucherNumber`).
  // Not INCOME_VOUCHER_ALREADY_VOIDED, which refuses cancelling a voucher twice.
  'INCOME_ALREADY_VOID',
  // An accountant's urgent payment (art. 35) above the manager's ceiling (`params.ceiling`, `params.currency`).
  'EXPENSE_URGENT_OVER_CEILING',
  // Someone other than the manager changing the urgent-payment ceiling in الإعدادات.
  'URGENT_EXPENSE_CEILING_FORBIDDEN',
  // A second salary for one staff member and one month (`params.period`, `params.voucherNumber`).
  'SALARY_PERIOD_ALREADY_PAID',
  // A salary for a month after the municipality's current one: an advance is not a salary (`params.period`).
  'SALARY_PERIOD_IN_FUTURE',
  // A salary for a month before the window «صرف راتب» offers (`params.period`, `params.oldest`).
  'SALARY_PERIOD_TOO_OLD',
  // An accountant's salary payout above the manager's salary ceiling (`params.ceiling`, `params.currency`).
  'SALARY_OVER_CEILING',
  // Someone other than the manager changing the official rate or the two currencies.
  'FINANCE_SETTINGS_MANAGER_ONLY',
  // The base or second currency changed once the treasury is live: every wallet and rate is read in them.
  'CURRENCIES_LOCKED_AFTER_GO_LIVE',
  // A query-string value that does not parse (presentation/controllers/query-params.ts)
  'INVALID_QUERY_DATE',
  'INVALID_QUERY_VALUE',
  'TRANSFER_SAME_ACCOUNT_FORBIDDEN',
  'TRANSFER_CURRENCY_MISMATCH',
  'EXCHANGE_SAME_CURRENCY_FORBIDDEN',
  'EXCHANGE_RATE_TOLERANCE_EXCEEDED',
  'EXCHANGE_PAIR_UNSUPPORTED',
  'TRANSFER_ACCOUNT_NOT_ALLOWED',
  'TRANSFER_ALREADY_REVIEWED',
  'TRANSFER_NOT_FLAGGED',
  'TRANSFER_DATE_IN_FUTURE',
  'TRANSFER_DATE_BEFORE_GO_LIVE',
  'TRANSFER_BACKDATE_REASON_REQUIRED',
  'EXPENSE_IS_TRANSFER_FEE',
  'TREASURY_ACCOUNT_CURRENCY_UNSUPPORTED',
  // «إضافة حساب» naming a wallet of that kind and currency that already exists (`params.name`).
  'TREASURY_ACCOUNT_NAME_TAKEN',
  'EXCHANGE_RULE_MANAGER_ONLY',
  // The daily count and closing the day (docs/finance.md §7)
  'COUNT_DATE_IN_FUTURE',
  'COUNT_VARIANCE_REASON_REQUIRED',
  'COUNT_EXPECTED_CHANGED',
  // A close whose dialog listed counts that were since recorded, replaced or added (`params.count`).
  'COUNT_CHANGED_SINCE_LOADED',
  'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS',
  'DAY_ALREADY_CLOSED',
  'DAY_NOT_CLOSED',
  'DAY_NOT_OVER',
  'DAY_BEFORE_GO_LIVE',
  'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER',
  'UNRESOLVED_ACTIVE_DAYS_EXIST',
  'CLOSED_DAY_MUTATION_BLOCKED',
  'REOPEN_REASON_REQUIRED',
  'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED',
  // Municipal requests (docs/municipal-requests-plan.md)
  'REQUEST_NOT_FOUND',
  // A type the municipality has not switched on (`params.type` is the enum value).
  'REQUEST_TYPE_NOT_OFFERED',
  'REQUEST_PROPERTY_REQUIRED',
  // A card or unit line that is not the citizen's own, or no longer current.
  'REQUEST_PROPERTY_NOT_YOURS',
  // One open request per citizen, type and card (`params.number` is the open one, when known).
  'REQUEST_ALREADY_OPEN',
  // The same retry key sent for a different request (`params.number` is the first).
  'REQUEST_KEY_REUSED',
  // The request is no longer where this act starts (`params.status`).
  'REQUEST_STATE_CHANGED',
  // A request whose fee bill is raised and unpaid cannot be cancelled or rejected yet.
  'REQUEST_BILL_OPEN',
  'REQUEST_FREE_NO_BILL',
  'REQUEST_IDENTITY_COPY_REQUIRED',
  // A براءة ذمة refused while the property owes (`params.total`, in pounds).
  'REQUEST_CLEARANCE_DUES_OUTSTANDING',
  'REQUEST_CLEARANCE_NO_PROPERTY_NUMBER',
  'REQUEST_ATTACHMENT_NOT_FOUND',
  'REQUEST_ATTACHMENT_UNSUPPORTED',
  'REQUEST_ATTACHMENT_EMPTY',
  // `params.max`: how many papers one request may carry.
  'REQUEST_ATTACHMENT_LIMIT',
  'REQUEST_ATTACHMENTS_CLOSED',
  'FILE_UPLOAD_FAILED',
  'FILE_OPEN_FAILED',
  // Old debts, «متأخرات سنوات سابقة» (0108, docs/old-debts-plan.md).
  // No cutoff year set yet: every import is refused until the manager sets it.
  'ARREARS_CUTOFF_NOT_SET',
  // A year that is not before the cutoff (`params.year`, `params.cutoffYear`): the system bills it.
  'ARREARS_YEAR_NOT_BEFORE_CUTOFF',
  // The same citizen, رقم العقار, unit, year, fee and component already has a live line
  // (the index's last word; the import names the line itself in its verdicts).
  'ARREARS_LINE_DUPLICATE',
  // The batch is no longer a draft (`params.status`): only a draft takes lines or is submitted.
  'ARREARS_BATCH_NOT_DRAFT',
  // Maker ≠ checker, reserved: open-decisions §23.3 has not decided it yet.
  'ARREARS_APPROVER_IS_PREPARER',
  // The control total is not the sum of the batch's lines (`params.controlTotal`, `params.linesTotal`).
  'ARREARS_CONTROL_TOTAL_MISMATCH',
  // Old debts are in LBP at face value (decision 13); `params.currency` is what was sent.
  'ARREARS_CURRENCY_NOT_LBP',
  'ARREARS_BATCH_NOT_FOUND',
  'ZONE_NOT_FOUND',
  // The export found no citizen in the zone or building who is not already in a batch.
  'ARREARS_EXPORT_NOTHING_LEFT',
  // An export's retry key already used for another zone, building or count.
  'ARREARS_EXPORT_REQUEST_REUSED',
  // A non-dry import with rows the dry run refuses (`params.count`): nothing was written.
  'ARREARS_IMPORT_HAS_REFUSED_ROWS',
  // A batch's file holds more rows than one import takes (`params.max`).
  'ARREARS_IMPORT_TOO_MANY_ROWS',
  // Submit, approve, return: the batch is not in the state the act needs (`params.status`).
  'ARREARS_BATCH_NOT_SUBMITTED',
  // A batch with no line is not submitted.
  'ARREARS_BATCH_EMPTY',
  // Only the preparer, or the manager, acts on a draft batch.
  'ARREARS_BATCH_NOT_YOURS',
  // Approval re-ran the checks that change with time and some line fails (`details.problems`): the manager
  // returns the batch, and the preparer imports it again.
  'ARREARS_APPROVAL_CHECKS_FAILED',
  'ARREARS_LINE_NOT_FOUND',
  // A line is linked once, from «للمطابقة», on an approved batch.
  'ARREARS_LINE_NOT_WAITING',
  // A single line refused by the same checks as an imported one (`details.issues`).
  'ARREARS_LINE_REFUSED',
  // A debt older than the prescription period is never entered or linked (decision 14).
  'ARREARS_LINE_PRESCRIBED',
  // A single line's retry key already used for another line (`params.batchId`).
  'ARREARS_LINE_REQUEST_REUSED',
  // The cutoff year is set once and then fixed: a batch has been approved, so moving it would let one year be old
  // debt in one batch and billed by a notice in another (`params.cutoffYear` is the year it stays).
  'ARREARS_CUTOFF_LOCKED',
  // Fixed messages the filter and the tenant layer already send
  'INTERNAL_ERROR',
  'TENANT_MISMATCH',
  'TENANT_NOT_PROVISIONED',
  // Sessions
  'AUTHENTICATION_REQUIRED',
  'SESSION_INVALID',
  'SESSION_ENDED',
  'ORIGIN_NOT_ALLOWED',
  // A staff member's own account («أمان الحساب»): the password typed to confirm a change is wrong.
  'STAFF_CURRENT_PASSWORD_INCORRECT',
  // A staff second factor (TOTP): a wrong code (401), a right one already used (409), and wrong
  // codes having locked the account; `params.minutes` is how long is left, rounded up (403).
  'TOTP_CODE_INVALID',
  'TOTP_CODE_REUSED',
  'TOTP_LOCKED',
  // The phone-code sign-in (`citizen/otp/*`) while no SMS provider is live; the portal signs in by رقم مرجعي.
  'CITIZEN_OTP_UNAVAILABLE',
  // News on Day3ati, the partner API (task «Day3ati HTTP client and error handling»). The first two are the
  // user's role and account (403); the next three are the municipality's setup or the service (409); the rest
  // are the call itself: `NEWS_INVALID_INPUT` carries `details: [{ path, message }]` for the form (422), as
  // every validation refusal does. `NEWS_REQUEST_REFUSED` is any other refusal, with `details.status`.
  'NEWS_FORBIDDEN',
  'NEWS_NOT_A_MEMBER',
  'NEWS_MODULE_DISABLED',
  'NEWS_VILLAGE_NOT_LINKED',
  'NEWS_UNAVAILABLE',
  'NEWS_INVALID_INPUT',
  'NEWS_NOT_FOUND',
  'NEWS_REQUEST_REFUSED',
  // Scheduling an article that is already published (Day3ati's `news.already_published`, 409).
  'NEWS_ARTICLE_ALREADY_PUBLISHED',
  // Raised by the portal itself when no response arrives or it cannot be read
  'NETWORK_ERROR',
  'UNKNOWN',
  'SESSION_REFRESH_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Values a message interpolates. Formatting (digits, grouping) is the frontend's job. */
export type ErrorParams = Readonly<Record<string, string | number>>;

/** The JSON body of every error response. */
export interface ApiErrorBody {
  /** The specific code, or the kind when the throw site has no specific code yet. */
  code: ErrorCode | ErrorKind;
  kind: ErrorKind;
  /** For logs and debugging. Shown only for an error with no specific code. */
  message: string;
  params?: ErrorParams;
  details?: unknown;
  correlationId?: string;
}

const SPECIFIC = new Set<string>(ERROR_CODES);

/** Whether `code` is a specific code (one the dictionaries translate) rather than a kind. */
export function isSpecificErrorCode(code: string | undefined): code is ErrorCode {
  return code !== undefined && SPECIFIC.has(code);
}
