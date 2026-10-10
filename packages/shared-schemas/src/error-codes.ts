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
  'FEE_DUE_DATE_INVALID',
  'FEE_NOTICE_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_ALREADY_PAID',
  'PAYMENT_ALREADY_UNDER_REVIEW',
  'PAYMENT_STATE_CHANGED',
  'PAYMENT_NO_PENDING_REVIEW',
  'PAYMENT_NOTHING_OUTSTANDING',
  'CHARGE_ALREADY_PAID',
  'CHARGE_PAYMENT_PENDING',
  'CHARGE_CHANGED_DURING_CHECKOUT',
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
  // «تركة (ورثة المرحوم)» (migration 0076)
  'ESTATE_OWNS_ONLY',
  // Corrections
  'UNIT_CORRECTION_PREVIEW_STALE',
  'UNIT_CONFIRM_CODE_MISMATCH',
  'UNIT_CORRECTION_UNVERIFIED',
  'UNIT_CORRECTION_BUSY',
  'UNIT_NOT_FOUND',
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
  'EXPENSE_NOT_FOUND',
  'EXPENSE_ALREADY_VOID',
  'EXPENSE_CATEGORY_NOT_FOUND',
  'EXPENSE_CATEGORY_INACTIVE',
  'EXPENSE_DATE_IN_FUTURE',
  'EXPENSE_DATE_BEFORE_GO_LIVE',
  'EXPENSE_BACKDATE_REASON_REQUIRED',
  'EXPENSE_CATEGORY_CODE_TAKEN',
  'SALARY_PAYEE_NOT_FOUND',
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
  // A query-string value that does not parse (presentation/controllers/query-params.ts)
  'INVALID_QUERY_DATE',
  'INVALID_QUERY_VALUE',
  // Fixed messages the filter and the tenant layer already send
  'INTERNAL_ERROR',
  'TENANT_MISMATCH',
  'TENANT_NOT_PROVISIONED',
  // Sessions
  'AUTHENTICATION_REQUIRED',
  'SESSION_INVALID',
  'SESSION_ENDED',
  'ORIGIN_NOT_ALLOWED',
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
