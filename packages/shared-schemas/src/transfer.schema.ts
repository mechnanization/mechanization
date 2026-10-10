import { z } from 'zod';

/**
 * المناقلات — money moving between the municipality's own wallets.
 * Design: docs/finance.md §6.
 *
 * Three kinds, one table and one ledger source:
 *
 *  - «تسليم صندوق الجابي»: a collector hands in the cash he took at people's
 *    doors, and it leaves his custody wallet for the safe (`receiveCustody`).
 *  - «تحويل داخلي»: the same currency between any two working wallets — a Whish
 *    cash-out, a bank deposit, funding petty cash — with an optional fee.
 *  - «مصارفة»: two currencies, the rate derived from the two amounts and judged
 *    by `judgeExchange` (`exchange-policy.ts`).
 */

/** An amount handed over: greater than zero, at most two decimals. */
const transferAmount = z
  .number({ required_error: 'اكتب المبلغ', invalid_type_error: 'المبلغ رقم' })
  .finite('المبلغ رقم')
  .positive('المبلغ أكبر من صفر')
  .max(999_999_999_999, 'المبلغ كبير جداً')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'خانتان عشريتان على الأكثر');

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

/** The two kinds the transfer form records; a handover has its own form. */
export const TRANSFER_KINDS = ['SAME_CURRENCY', 'EXCHANGE'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/** `YYYY-MM-DD` on the municipality's calendar. */
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');

const optionalText = (max: number, tooLong: string) => z.string().trim().max(max, tooLong).optional();

/** What both kinds carry. */
const transferBase = {
  fromAccountId: z.string().uuid('اختر الحساب الذي يخرج منه المبلغ'),
  toAccountId: z.string().uuid('اختر الحساب الذي يصل إليه المبلغ'),
  /** What leaves the source, in its currency — the fee is on top. */
  amount: transferAmount,
  /**
   * What a bank or Whish charged, in the source's currency. The source loses
   * amount + fee, and the fee is booked as its own voucher under «رسوم تحويل
   * ومصرفية».
   */
  feeAmount: transferAmount.optional(),
  description: z
    .string({ required_error: 'اكتب بيان المناقلة' })
    .trim()
    .min(3, 'اكتب بيان المناقلة')
    .max(500, 'البيان طويل جداً'),
  /** Absent means today. Not in the future, not before go-live, and earlier needs a reason. */
  transferredOn: businessDate.optional(),
  backdateReason: optionalText(500, 'السبب طويل جداً'),
  /** Required: one id per press, so a retry does not move the money twice. */
  clientRequestId: z.string().uuid(),
};

/**
 * «تحويل داخلي» or «مصارفة» — what the transfer form sends.
 *
 * The shape is checked here; the rules that need the database — the wallets'
 * currencies, the balance, the official rate and the tolerance — are the
 * server's, with the same `judgeExchange` the form warns with. A schema cannot
 * know the municipality's rate, so «a reason when the rate strays» is enforced
 * where the rate is: the server refuses it with `EXCHANGE_RATE_TOLERANCE_EXCEEDED`.
 */
export const createTransferSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('SAME_CURRENCY'), ...transferBase }),
    z.object({
      kind: z.literal('EXCHANGE'),
      ...transferBase,
      /** What reached the destination, in its currency. The rate is derived from the two. */
      receivedAmount: transferAmount,
      /** The صرّاف, when there was one. */
      moneyChangerName: optionalText(200, 'الاسم طويل جداً'),
      /** Why the rate strays from the official one; required beyond the tolerance. */
      adjustmentReason: optionalText(1000, 'السبب طويل جداً'),
    }),
  ])
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: 'اختر حسابين مختلفين',
    path: ['toAccountId'],
  });

export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/** «اعتماد المراجعة» — the auditor clears a flagged exchange, with an optional note. */
export const reviewTransferSchema = z.object({
  note: optionalText(500, 'الملاحظة طويلة جداً'),
});

export type ReviewTransferInput = z.infer<typeof reviewTransferSchema>;

/** The register's filters. */
export const listTransfersQuerySchema = z
  .object({
    kind: z.enum(['HANDOVER', 'SAME_CURRENCY', 'EXCHANGE']).optional(),
    /** `PENDING`: flagged and not yet reviewed — the auditor's queue. */
    review: z.enum(['PENDING', 'REVIEWED']).optional(),
    from: businessDate.optional(),
    to: businessDate.optional(),
    includeVoid: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'بداية الفترة بعد نهايتها',
    path: ['to'],
  });

export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;

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
  /** Derived, never stored: a handover leaves a custody wallet, an exchange changes currency. */
  kind: 'HANDOVER' | TransferKind;
  from: { id: string; name: string; currency: string; type: string };
  to: { id: string; name: string; currency: string; type: string };
  amount: number;
  receivedAmount: number;
  /** The fee and the «PV-» voucher that books it; null when there was none. */
  fee: { amount: number; voucherId: string; voucherNumber: string } | null;
  /** An exchange's rate, base currency per one unit of the other side; null otherwise. */
  exchangeRate: number | null;
  /** The municipality's own rate when it was booked. */
  officialExchangeRate: number | null;
  /** Why the rate strays from the official one. */
  adjustmentReason: string | null;
  moneyChangerName: string | null;
  backdateReason: string | null;
  description: string;
  occurredAt: string;
  recordedByName: string | null;
  /** Null when the transfer was never flagged. */
  review: {
    reviewedAt: string | null;
    reviewedByName: string | null;
    note: string | null;
  } | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface TransferListResult {
  transfers: TransferView[];
  total: number;
  /** Flagged and not reviewed, over the whole register: the auditor's count. */
  pendingReview: number;
}

export interface CreateTransferResult {
  id: string;
  transferNumber: string;
  /** The fee's «PV-» number, when there was a fee. */
  feeVoucherNumber: string | null;
  requiresReview: boolean;
  /** The two wallets' balances once it is booked. */
  fromBalanceAfter: number;
  toBalanceAfter: number;
  /** True when this answers a retry of a transfer already recorded. */
  replayed: boolean;
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
   * What the listed receipts add up to, per currency, reversals netted out.
   *
   * This is **not** his custody balance and the two will differ the moment he
   * hands anything in: a handover moves money without touching a receipt. The
   * screen says so rather than letting the two figures look like a discrepancy.
   */
  totals: Array<{ currency: string; amount: number }>;
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
