import { z } from 'zod';
import { municipalToday } from './cash-policy';
import type { TreasuryAccountType, TreasuryEntrySource } from './treasury.schema';

/**
 * جرد الصندوق وإقفال اليومية — counting every wallet at the end of a municipal
 * day, closing the day so nothing more is written into it, reopening it, and
 * the day's printed report. Design: docs/finance.md §7.
 *
 * Money crosses the wire as a plain number, as everywhere in the treasury; the
 * database keeps `DECIMAL(14,2)` and computes every difference itself.
 */

/** Kept in step with the Prisma enum `TreasuryDayStatus` and migration 0082: the two stored states. */
export const TREASURY_DAY_STORED_STATUSES = ['CLOSED', 'REOPENED'] as const;

/** A day as a screen reads it. A day with no closure row is OPEN. */
export const TREASURY_DAY_STATUSES = ['OPEN', 'CLOSED', 'REOPENED'] as const;
export type TreasuryDayStatus = (typeof TREASURY_DAY_STATUSES)[number];

/**
 * How long a reason for reopening a locked day must be. Longer than a void's
 * five characters: reopening unlocks a day the accountant signed off, and «خطأ»
 * says nothing an auditor can check.
 */
export const REOPEN_REASON_MIN = 10;

/** A real calendar day as `YYYY-MM-DD` — «2026-02-30» is refused, not rolled into March. */
function isCalendarDay(day: string): boolean {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}

/** `YYYY-MM-DD` on the municipality's own calendar. */
const businessDate = z
  .string({ required_error: 'اختر التاريخ' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح')
  .refine(isCalendarDay, 'تاريخ غير صالح');

/**
 * A day that has begun. Evaluated per parse, never at module load: a value
 * frozen when the process started would refuse today's count after midnight.
 */
const pastOrToday = businessDate.refine((day) => day <= municipalToday(), 'لا يُجرد يومٌ لم يأتِ بعد');

/** At most two decimals: the ledger's own precision. */
const twoDecimals = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** Whether two money figures are the same to the cent. */
export function sameMoney(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * counted − expected, to the cent: positive is a surplus (فائض), negative a
 * shortage (عجز). The screen shows it as the accountant types and the server
 * judges the count by it, so the two never disagree by a float's rounding.
 */
export function varianceOf(counted: number, expected: number): number {
  return (Math.round(counted * 100) - Math.round(expected * 100)) / 100;
}

/** What was found in a wallet: not negative, at most two decimals. */
const countedAmount = z
  .number({ required_error: 'اكتب المبلغ المعدود', invalid_type_error: 'المبلغ المعدود رقم' })
  .finite('المبلغ المعدود رقم')
  .min(0, 'المبلغ المعدود لا يكون سالباً')
  .max(999_999_999_999, 'المبلغ كبير جداً')
  .refine(twoDecimals, 'خانتان عشريتان على الأكثر');

/** The books' figure as the screen showed it. Signed, though the ledger never lets it go below zero. */
const shownExpected = z
  .number({ required_error: 'الرصيد الدفتري مطلوب', invalid_type_error: 'الرصيد الدفتري رقم' })
  .finite('الرصيد الدفتري رقم')
  .min(-999_999_999_999, 'الرصيد كبير جداً')
  .max(999_999_999_999, 'الرصيد كبير جداً')
  .refine(twoDecimals, 'خانتان عشريتان على الأكثر');

/**
 * One wallet as counted.
 *
 * `expectedAmount` is the figure the counter was comparing against. The server
 * recomputes it and refuses the count with `COUNT_EXPECTED_CHANGED` when the
 * books have moved since the screen loaded: a reason written for a 50,000 ل.ل
 * shortage does not explain a different one.
 */
export const dailyCountLineSchema = z
  .object({
    accountId: z.string().uuid('حساب غير صالح'),
    expectedAmount: shownExpected,
    countedAmount,
    varianceReason: z.string().trim().max(500, 'السبب طويل جداً').optional(),
  })
  .superRefine((line, ctx) => {
    if (!sameMoney(line.countedAmount, line.expectedAmount) && !line.varianceReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['varianceReason'],
        message: 'اكتب سبب الفرق بين المعدود والرصيد الدفتري',
      });
    }
  });

export type DailyCountLineInput = z.infer<typeof dailyCountLineSchema>;

/**
 * «سجّل الجرد» — one or more wallets counted for one day.
 *
 * Any subset: the safe is counted at the end of the shift and the Whish balance
 * read when the app is to hand. A wallet counted again replaces its count until
 * the day closes. Closing is what requires every wallet.
 */
export const recordDailyCountSchema = z
  .object({
    businessDate: pastOrToday,
    counts: z.array(dailyCountLineSchema).min(1, 'أدخل جرد حساب واحد على الأقل').max(50, 'عدد الحسابات كبير جداً'),
  })
  .refine((value) => new Set(value.counts.map((line) => line.accountId)).size === value.counts.length, {
    message: 'حساب مكرر في القائمة',
    path: ['counts'],
  });

export type RecordDailyCountInput = z.infer<typeof recordDailyCountSchema>;

/** «أقفل اليومية». Whether the day may close is the server's to judge (`planClosure`). */
export const closeDaySchema = z.object({
  businessDate,
});

export type CloseDayInput = z.infer<typeof closeDaySchema>;

/** «أعد فتح اليومية» — the manager's, the latest closed day only, with a reason that stays on the record. */
export const reopenDaySchema = z.object({
  businessDate,
  reason: z
    .string({ required_error: 'اكتب سبب إعادة الفتح' })
    .trim()
    .min(REOPEN_REASON_MIN, 'اكتب سبباً واضحاً لإعادة فتح اليومية')
    .max(500, 'السبب طويل جداً'),
});

export type ReopenDayInput = z.infer<typeof reopenDaySchema>;

/** `?date=` on the count sheet. Absent means the day that needs closing next. */
export const treasuryDayQuerySchema = z.object({
  date: businessDate.optional(),
});

export type TreasuryDayQuery = z.infer<typeof treasuryDayQuerySchema>;

/** `?date=` on the daily report, which always names its day — one that has begun. */
export const dailyCashReportQuerySchema = z.object({
  date: pastOrToday,
});

export type DailyCashReportQuery = z.infer<typeof dailyCashReportQuerySchema>;

/** `?limit=` on the closure history. */
export const treasuryClosureHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(366).optional(),
});

export type TreasuryClosureHistoryQuery = z.infer<typeof treasuryClosureHistoryQuerySchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

/** The wallet a count or a report line is about. Never a collector's custody. */
export interface CountedWalletView {
  id: string;
  name: string;
  type: TreasuryAccountType;
  currency: string;
  isPrimary: boolean;
  active: boolean;
}

/** One day's lock state, and who put it there. */
export interface TreasuryDayState {
  businessDate: string;
  status: TreasuryDayStatus;
  /** Closed without a count because none of the counted wallets moved that day. */
  autoClosed: boolean;
  closedAt: string | null;
  closedByName: string | null;
  /** Only while the day stands REOPENED. */
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
}

/** A recorded count, as it stands. */
export interface DailyCountView {
  /** The books' figure when the count was recorded. */
  expectedAmount: number;
  countedAmount: number;
  /** counted − expected. Positive is a surplus (فائض), negative a shortage (عجز). */
  difference: number;
  varianceReason: string | null;
  countedByName: string | null;
  countedAt: string;
  /** The books have moved since the count: closing refuses until it is recounted. */
  stale: boolean;
}

/** One wallet on the count sheet. */
export interface DailyCountLineView {
  account: CountedWalletView;
  /** The wallet's entries summed to the end of the day, as the books stand now. */
  expectedAmount: number;
  count: DailyCountView | null;
}

/**
 * Whether the day can be closed now, as `planClosure` judges it — the same
 * verdict `POST closures` reaches, so the button and the server never disagree.
 */
export type DayClosureVerdict =
  | {
      ok: true;
      /** Quiet days before this one that closing it would close too, uncounted. */
      sweeps: string[];
    }
  | {
      ok: false;
      code:
        | 'TREASURY_NOT_ACTIVE'
        | 'DAY_BEFORE_GO_LIVE'
        | 'DAY_NOT_OVER'
        | 'DAY_ALREADY_CLOSED'
        | 'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER'
        | 'UNRESOLVED_ACTIVE_DAYS_EXIST'
        | 'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS'
        | 'COUNT_EXPECTED_CHANGED';
      /** The day the refusal is about, where there is one: the open day in the way, the go-live day. */
      day?: string;
      /** How many days with movement are still open before this one. */
      days?: number;
      /** How many wallets are uncounted, or counted against figures that have since moved. */
      accounts?: number;
    };

/** «جرد وإقفال اليومية» — everything the screen draws for one day. */
export interface DailyCountSheet {
  day: TreasuryDayState;
  /** Beirut's today, by the server's clock. */
  today: string;
  /** The treasury's first day, or null while it is not active. */
  goLiveOn: string | null;
  /** The latest CLOSED day, or null when none is. */
  closedThrough: string | null;
  /** Where the work is: the day the screen should offer when none is asked for. */
  nextDayToClose: string | null;
  lines: DailyCountLineView[];
  closure: DayClosureVerdict;
  /** Whether the manager may reopen this day: it is the latest CLOSED one. */
  reopenable: boolean;
}

export interface CloseDayResult {
  businessDate: string;
  closedAt: string;
  /** The quiet days closed with it, oldest first. */
  sweptDays: string[];
}

/** A closed or reopened day, as the history lists it. */
export type TreasuryDayClosureView = TreasuryDayState;

/** One thing that happened to a day, read from the audit log. */
export interface TreasuryDayEvent {
  action: 'TREASURY_COUNT_RECORDED' | 'TREASURY_DAY_CLOSED' | 'TREASURY_DAY_AUTO_CLOSED' | 'TREASURY_DAY_REOPENED';
  at: string;
  actorName: string | null;
  /** The reopening's reason. */
  reason: string | null;
  /** How many wallets a count covered. */
  accounts: number | null;
}

/** What moved a wallet on the day, by where it came from. */
export interface DailyCashSourceLine {
  source: TreasuryEntrySource;
  receipts: number;
  payments: number;
}

/** One wallet on «تقرير الصندوق اليومي». */
export interface DailyCashReportWallet {
  account: CountedWalletView;
  /** Everything before the day began. */
  openingBalance: number;
  /** Money in on the day: the sum of its positive entries. */
  receipts: number;
  /** Money out on the day, as a positive figure: the sum of its negative entries. */
  payments: number;
  /** opening + receipts − payments: the books at the end of the day. */
  closingBalance: number;
  movements: number;
  bySource: DailyCashSourceLine[];
  count: DailyCountView | null;
}

/** «مبالغ بعهدة الجباة» — cash collectors carried at the end of the day. Never part of the count. */
export interface DailyCashReportCustody {
  collectorId: string | null;
  collectorName: string | null;
  currency: string;
  /** Collected at doors on the day. */
  receipts: number;
  /** Handed into the safe, or reversed, on the day, as a positive figure. */
  payments: number;
  /** Still on him when the day ended. */
  heldAtClose: number;
}

/** Each currency's column totals. `counted` and `difference` are null until every wallet in it is counted. */
export interface DailyCashReportTotal {
  currency: string;
  openingBalance: number;
  receipts: number;
  payments: number;
  closingBalance: number;
  counted: number | null;
  difference: number | null;
}

/** «تقرير الصندوق اليومي». */
export interface DailyCashReport {
  day: TreasuryDayState;
  generatedAt: string;
  /** The staff member who asked for it. */
  generatedByName: string | null;
  wallets: DailyCashReportWallet[];
  totals: DailyCashReportTotal[];
  custody: DailyCashReportCustody[];
  custodyTotals: Array<{ currency: string; heldAtClose: number }>;
  timeline: TreasuryDayEvent[];
}
