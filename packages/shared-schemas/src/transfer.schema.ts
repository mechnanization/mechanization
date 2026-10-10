import { z } from 'zod';
import { hasAtMostTwoDecimals } from './money-amount';

/**
 * المناقلات — money moving between the municipality's own wallets.
 * Design: docs/finance.md §6.
 *
 * The first and, today, only kind wired is «تسليم صندوق الجابي»: a collector
 * hands in the cash he took at people's doors, and it leaves his custody wallet
 * for the safe. A Whish cash-out, a bank deposit and a currency exchange are the
 * same act with different ends and come later.
 */

/** An amount handed over: greater than zero, at most two decimals. */
const transferAmount = z
  .number({ required_error: 'اكتب المبلغ', invalid_type_error: 'المبلغ رقم' })
  .finite('المبلغ رقم')
  .positive('المبلغ أكبر من صفر')
  .max(999_999_999_999, 'المبلغ كبير جداً')
  .refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر');

/**
 * «استلام صندوق الجابي» — the accountant receives what the collector counted out.
 *
 * The amount is stated rather than assumed to be the whole custody balance: a
 * collector may hand in part of what he holds, and the rest stays on his name
 * until he brings it. The server refuses more than he holds.
 */
export const receiveCustodySchema = z.object({
  /** The collector's custody wallet the money leaves. */
  custodyAccountId: z.string().uuid('اختر عهدة الجابي'),
  amount: transferAmount,
  /** Counted together before the button is pressed; free text for what was agreed. */
  note: z.string().trim().max(500, 'الملاحظة طويلة جداً').optional(),
  /** One id per press, so a retry does not move the money twice. */
  clientRequestId: z.string().uuid().optional(),
});

export type ReceiveCustodyInput = z.infer<typeof receiveCustodySchema>;

/** «إلغاء سند المناقلة» — the manager's cancellation, with its reason. */
export const voidTransferSchema = z.object({
  reason: z
    .string({ required_error: 'اكتب سبب الإلغاء' })
    .trim()
    .min(5, 'اكتب سبباً واضحاً للإلغاء')
    .max(500, 'السبب طويل جداً'),
});

export type VoidTransferInput = z.infer<typeof voidTransferSchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

/** What one collector is still carrying, per currency. */
export interface CollectorCustodyView {
  /** The custody wallet. One per collector per currency. */
  accountId: string;
  collectorId: string | null;
  collectorName: string | null;
  currency: string;
  /** What he holds now — the sum of his wallet's entries. */
  held: number;
  /** How many movements make it up, so a count can be read back against the receipts. */
  movements: number;
  /** When he last took money at a door, or null if his wallet is empty. */
  lastCollectedAt: string | null;
  /** Receipts he wrote today on the municipality's clock (Asia/Beirut), reversals netted. */
  receiptsToday: number;
  /** What he took today, in this wallet's currency. */
  collectedToday: number;
  /**
   * Derived, never stored: nothing in the system records whether a man is out
   * on a round. Read it as an inference from his receipts, not as a report
   * from the field.
   */
  status: 'COLLECTING_TODAY' | 'NOT_OUT_TODAY' | 'SETTLED';
}

export interface TransferView {
  id: string;
  transferNumber: string;
  status: 'RECORDED' | 'VOID';
  from: { id: string; name: string; currency: string };
  to: { id: string; name: string; currency: string };
  amount: number;
  receivedAmount: number;
  description: string;
  occurredAt: string;
  recordedByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface ReceiveCustodyResult {
  transferNumber: string;
  id: string;
  /** What the collector still carries once this is recorded — zero on a full handover. */
  remainingInCustody: number;
  /** The safe's balance after the money arrived. */
  safeBalanceAfter: number;
  currency: string;
  /** True when this answers a retry of a handover already recorded. */
  replayed: boolean;
}

/**
 * One receipt a collector wrote at a door.
 *
 * The citizen is named, because the point of the screen is to read the round
 * back against the notes. The رقم مرجعي is deliberately absent: it is a sign-in
 * credential, and nothing here needs it (docs/security.md).
 */
export interface CollectorCollectionRow {
  id: string;
  receiptNumber: string;
  occurredAt: string;
  citizenId: string;
  /** The three parts — «غسان جواد حيدر» — because two «غسان حيدر» in one village is ordinary. */
  citizenName: string;
  /** His own number. Null when the file has none; see `citizenHasNoPhone`. */
  citizenPhone: string | null;
  /** A relative's, shown as a relative's and only when he has none of his own. */
  citizenContactPhone: string | null;
  /** «لا يملك رقم هاتف» — a recorded fact, not a blank (migration 0069). */
  citizenHasNoPhone: boolean;
  /** The sector he lives in, from his current unit's parcel. Null if he is in no unit. */
  zoneName: string | null;
  /** What the invoice was raised for — «رسم النفايات 2026». */
  paymentTitle: string;
  amount: number;
  currency: string;
  /** True for the opposing row itself, when a payment was reversed. */
  isReversal: boolean;
  /** True for a collection that has since been reversed. */
  reversed: boolean;
  note: string | null;
}

export interface CollectorCollectionsResult {
  collector: { id: string; name: string | null };
  /** What he is carrying now, per currency — the same figures the custody panel shows. */
  custody: Array<{ currency: string; held: number }>;
  rows: CollectorCollectionRow[];
  total: number;
  /**
   * What his receipts put in his custody, per wallet currency, read from the
   * ledger (a refund he paid out nets out; one paid from the safe does not).
   *
   * This is **not** his custody balance: the two differ by exactly what he has
   * handed in, because a handover moves money without touching a receipt. The
   * screen says so rather than letting the two figures look like a discrepancy.
   */
  totals: Array<{ currency: string; amount: number }>;
  /**
   * Where the list starts: the go-live moment. A receipt from before it never
   * reached his custody, so it is not counted here either. Null while the
   * treasury is not active, when every receipt is listed.
   */
  since: string | null;
}

// ───────────────────────────  the collector's own round  ───────────────────────────

/**
 * One door on the round, as the collector sees it on his phone.
 *
 * Reversed receipts and their opposing rows are both left out: this list is
 * "the money in my pocket", and a cancelled payment is not in it. The admin
 * screen, which is a reconciliation view rather than a pocket, keeps them.
 */
export interface CollectorRoundRow {
  id: string;
  receiptNumber: string;
  occurredAt: string;
  /** The invoice, so the receipt can be reopened and shared. */
  paymentId: string;
  citizenId: string;
  citizenName: string;
  /** «0304» — floor-based, readable off the door. Null if he is in no censused unit. */
  unitCode: string | null;
  /** «A-1042-B», so a unit code has a building to hang on (D14). */
  buildingCode: string | null;
  amount: number;
  currency: string;
  paymentTitle: string;
}

export interface CollectorRoundCurrency {
  currency: string;
  /** What the ledger says is in his pocket. The authoritative figure. */
  held: number;
  /** What the receipts listed below add up to. */
  listed: number;
  /**
   * `held − listed`: cash he is still carrying from before his last handover.
   *
   * Non-zero only after a **partial** handover, and it exists because a
   * handover moves an amount rather than a set of receipts — so the receipts
   * since that handover cannot account for all of what he holds. Naming the
   * remainder is the only honest way to let the list and the pocket disagree.
   */
  carriedOver: number;
}

/** «جولتي» — what one collector is carrying and which doors it came from. */
export interface CollectorRoundView {
  collector: { id: string; name: string };
  /** His last handover that still stands, or null if he has never handed in. */
  lastHandoverAt: string | null;
  currencies: CollectorRoundCurrency[];
  rows: CollectorRoundRow[];
}
