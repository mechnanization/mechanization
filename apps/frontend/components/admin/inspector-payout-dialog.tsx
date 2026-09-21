'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HandCoins, Loader2 } from 'lucide-react';
import {
  PAYOUT_WEEKLY_CAP,
  payoutAllowance,
  payoutRefusal,
  type RecordInspectorPayoutInput,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getInspectorProfile,
  logApiError,
  recordInspectorPayout,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * What may be typed into an amount: digits, and at most one decimal point.
 *
 * Applied on every keystroke rather than checked on submit, because the field
 * is a plain text box now — nothing else stops «٤٠٠ ل.ل» or a second dot from
 * reaching `parseFloat`, which would read the first of them and silently pay
 * out a different number from the one on screen. Arabic-Indic digits are
 * folded to Latin so a keyboard set to Arabic still works.
 */
function sanitiseAmount(raw: string): string {
  const latin = raw.replace(/[٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) - 0x0660),
  );
  const cleaned = latin.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  const whole = parts[0] ?? '';
  if (parts.length === 1) return whole;
  // A second dot is dropped rather than starting a new decimal part, and cents
  // stop at two places — «12.345» is a typo, not a third of a cent.
  return `${whole}.${parts.slice(1).join('').slice(0, 2)}`;
}

/** `YYYY-MM-DD` for today, in the reader's own timezone rather than UTC. */
export function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * One payout, recorded against one staff member.
 *
 * Lifted out of the inspector dashboard because there are now three screens
 * that hand money over — the roster, a single inspector's dashboard, and the
 * payout history — and an amount validated in three copies is an amount that
 * will be accepted negative in one of them. The rule lives here once: a payout
 * is a positive number of dollars, and the caller is told what was recorded
 * instead of being left to re-read it.
 *
 * The payout rule — nothing before $100 earned, then at most $50 a week
 * counted from the first payout — is `payoutAllowance`, the same function the
 * server refuses with. The dialog reads the inspector's figures itself, so all
 * three screens show the same allowance without each passing it in, and it
 * follows the date: a payout backdated into last week is measured against
 * last week.
 */
export function InspectorPayoutDialog({
  open,
  onOpenChange,
  tenant,
  token,
  locale,
  staff,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** Null until the session has been read; the form will not submit without it. */
  token: string | null;
  locale: string;
  staff: { id: string; name: string } | null;
  /** Refresh whatever the caller is showing. Awaited, after the toast. */
  onRecorded: () => void | Promise<void>;
}): React.JSX.Element {
  const isAr = locale !== 'en';
  const toast = useToast();

  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
    The key the inspector's dashboard reads the same figures under, so opening
    the dialog from there costs no request — and a recorded payout, which every
    caller answers by invalidating `['staff', tenant]`, refreshes this too.
  */
  const profile = useQuery({
    queryKey: ['staff', tenant, 'inspector-profile', staff?.id],
    queryFn: ({ signal }) => getInspectorProfile(tenant, token as string, staff!.id, signal),
    enabled: open && Boolean(token && staff),
  });

  // Null while the picker holds no date — there is no week to measure against.
  const paidAtDate = new Date(`${paidOn}T12:00:00`);
  const paidAt = Number.isNaN(paidAtDate.getTime()) ? null : paidAtDate.toISOString();
  const allowance = useMemo(
    () =>
      profile.data && paidAt
        ? payoutAllowance({
            totalEarnings: profile.data.totalEarnings,
            pendingBalance: profile.data.pendingBalance,
            payouts: profile.data.payouts,
            paidAt,
          })
        : null,
    [profile.data, paidAt],
  );
  /** Nothing can be paid on this date, whatever the amount. */
  const blocked = allowance && !allowance.allowed ? payoutRefusal(allowance, 0) : null;

  /*
    Reset on open, not on close. Closing by Escape or mid-submit would
    otherwise leave one person's amount typed into the next person's payout —
    and on the roster those two names sit one row apart.
  */
  useEffect(() => {
    if (!open) return;
    setAmount('');
    setPaidOn(todayIso());
    setReference('');
    setNote('');
    setError(null);
  }, [open, staff?.id]);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token || !staff) return;

    const parsed = Number.parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(isAr ? 'يرجى إدخال مبلغ صحيح أكبر من صفر' : 'Enter a valid amount greater than zero');
      return;
    }
    // The server checks again; this only saves a round trip to be told the same thing.
    const refusal = allowance ? payoutRefusal(allowance, parsed) : null;
    if (refusal) {
      setError(refusal);
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const payload: RecordInspectorPayoutInput = {
        amount: parsed,
        currency: 'USD',
        /*
          Midday rather than midnight. The picker yields a date with no time,
          and `new Date('2026-09-20')` is parsed as UTC midnight — which in a
          timezone behind UTC is the 19th. Beirut is ahead, so this is belt and
          braces, but a payout dated a day early is the kind of discrepancy
          somebody reconciles against a paper receipt months later.
        */
        paidAt: new Date(`${paidOn}T12:00:00`).toISOString(),
        note: note.trim() || undefined,
        reference: reference.trim() || undefined,
      };

      await recordInspectorPayout(tenant, token, staff.id, payload);

      toast.success(
        isAr
          ? `تم تسجيل دفعة بقيمة $${parsed.toFixed(2)} لـ ${staff.name}`
          : `Recorded a $${parsed.toFixed(2)} payout to ${staff.name}`,
      );
      onOpenChange(false);
      await onRecorded();
    } catch (err) {
      logApiError(err);
      setError(
        err instanceof ApiRequestError
          ? err.message
          : isAr
            ? 'تعذّر تسجيل الدفعة'
            : 'Failed to record the payout',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent closeLabel={isAr ? 'إغلاق' : 'Close'} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="size-5 text-emerald-600" aria-hidden />
            {isAr ? 'تسجيل دفعة' : 'Record a payout'}
          </DialogTitle>
          <DialogDescription>
            {staff
              ? isAr
                ? `تسليم مبلغ إلى ${staff.name}، يُخصم من رصيده المتبقي.`
                : `A payment handed to ${staff.name}. It reduces their pending balance.`
              : null}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {/*
            What the rule allows on the date below, read before an amount is
            typed: rows, one figure each, the same as every read-back here.
            When nothing can be paid, the reason — and the button is off.
          */}
          {profile.isLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {isAr ? 'جارٍ حساب المبلغ المتاح…' : 'Working out the allowance…'}
            </p>
          ) : allowance ? (
            <SummaryList className="rounded-lg border px-3">
              {allowance.reason === 'BELOW_THRESHOLD' ? (
                <>
                  <SummaryRow label={isAr ? 'إجمالي الأرباح' : 'Total earned'} className="tabular-nums">
                    ${profile.data!.totalEarnings.toFixed(2)}
                  </SummaryRow>
                  <SummaryRow label={isAr ? 'المتبقي لبلوغ 100$' : 'Left to reach $100'} className="tabular-nums text-amber-600 dark:text-amber-400">
                    ${allowance.shortBy.toFixed(2)}
                  </SummaryRow>
                </>
              ) : (
                <>
                  <SummaryRow label={isAr ? 'الرصيد المستحق' : 'Pending balance'} className="tabular-nums">
                    ${allowance.owed.toFixed(2)}
                  </SummaryRow>
                  <SummaryRow label={isAr ? 'أسبوع الصرف' : 'Payout week'} className="tabular-nums">
                    {formatDate(`${allowance.weekStart}T12:00:00`)} – {formatDate(`${allowance.weekEnd}T12:00:00`)}
                  </SummaryRow>
                  <SummaryRow label={isAr ? 'صُرف في هذا الأسبوع' : 'Paid this week'} className="tabular-nums">
                    ${allowance.paidThisWeek.toFixed(2)} / ${PAYOUT_WEEKLY_CAP.toFixed(2)}
                  </SummaryRow>
                  <SummaryRow
                    label={isAr ? 'أقصى مبلغ الآن' : 'Most payable now'}
                    className={
                      allowance.maxAmount > 0
                        ? 'tabular-nums text-emerald-600 dark:text-emerald-400'
                        : 'tabular-nums text-muted-foreground'
                    }
                  >
                    ${allowance.maxAmount.toFixed(2)}
                  </SummaryRow>
                </>
              )}
            </SummaryList>
          ) : null}

          {blocked ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
              {blocked}
            </p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="payout-amount" className="text-xs font-semibold">
              {isAr ? 'المبلغ المسلّم (USD) *' : 'Amount handed over (USD) *'}
            </Label>
            <div className="relative">
              {/*
                A text box, not `type="number"`.

                The spinners were the problem the number type brought with it:
                a hand resting on a tablet nudges a payout from 40 to 45, and
                on a touchscreen those two arrows are the easiest thing in the
                dialog to hit by accident. `inputMode="decimal"` still raises
                the numeric keypad on a phone, and the filter below is what
                keeps the value a number — one that no longer depends on the
                browser's own stepping.

                No placeholder either: «0.00» sitting in an empty amount field
                is a figure the eye reads as a value, and a payout of nothing
                is exactly the mistake worth not suggesting.
              */}
              <Input
                id="payout-amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                className="pe-14 text-start text-lg font-bold"
                value={amount}
                onChange={(event) => setAmount(sanitiseAmount(event.target.value))}
              />
              <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                USD
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="payout-date" className="text-xs font-semibold">
              {isAr ? 'تاريخ الدفع' : 'Payment date'}
            </Label>
            <DatePicker
              id="payout-date"
              value={paidOn}
              onChange={setPaidOn}
              max={todayIso()}
              locale={isAr ? 'ar' : 'en'}
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="payout-reference" className="text-xs font-semibold">
              {isAr ? 'رقم الإيصال (اختياري)' : 'Receipt number (optional)'}
            </Label>
            <Input
              id="payout-reference"
              maxLength={100}
              placeholder={isAr ? 'مثال: REC-2026-004' : 'e.g. REC-2026-004'}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="payout-note" className="text-xs font-semibold">
              {isAr ? 'ملاحظات (اختياري)' : 'Notes (optional)'}
            </Label>
            <Textarea
              id="payout-note"
              rows={2}
              maxLength={500}
              placeholder={
                isAr ? 'مثال: دفعة نقدية عن مسح حي الزهور' : 'e.g. cash, for the Zuhour survey'
              }
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              disabled={submitting || !token || !staff || Boolean(blocked)}
              className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-800"
            >
              {submitting ? (
                <>
                  <Loader2 className="me-1.5 size-4 animate-spin" aria-hidden />
                  {isAr ? 'جارٍ الحفظ…' : 'Saving…'}
                </>
              ) : isAr ? (
                'حفظ الدفعة'
              ) : (
                'Record payout'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
