/*
  What the server recorded for one payment, as plain types (ARCH-20).

  Declared in `components/admin/payment-receipt.tsx`, which prints it, and read
  by `lib/bill-receipts.ts`, which decides what may be done with it — a `lib`
  module importing a component. The receipt still exports both names.
*/

/** Cash as it was handed over — the ليرة part and a foreign part at the rate used. */
export interface RecordedTender {
  local: number;
  foreign: number;
  foreignCurrency: string;
  exchangeRate: number;
  /** The municipality's own rate at the time; printed when the one used differs. */
  officialExchangeRate: number | null;
}

/** What the server recorded for one payment — everything the receipt prints about it. */
export interface RecordedMovement {
  receiptNumber: string;
  occurredAt: string;
  received: number;
  remaining: number;
  changeGiven: number;
  tender: RecordedTender | null;
  /**
   * How this movement was paid — `CASH`, `WHISH_MONEY`, `COLLECTOR`. The bill's
   * own `paymentMethod` is its last movement's, which on a part-paid bill can be
   * an earlier one's; the receipt prints this one's. Optional for a caller that
   * does not know it (the bill's is printed then).
   */
  method?: string | null;
}
