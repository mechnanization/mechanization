'use client';

import { useEffect, useState } from 'react';
import { HandCoins, Loader2 } from 'lucide-react';
import type { RecordInspectorPayoutInput } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, recordInspectorPayout } from '@/lib/api-client';
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
 */
export function InspectorPayoutDialog({
  open,
  onOpenChange,
  tenant,
  token,
  locale,
  staff,
  pendingBalance,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** Null until the session has been read; the form will not submit without it. */
  token: string | null;
  locale: string;
  staff: { id: string; name: string } | null;
  /** Shown under the amount, so the figure being settled stays in view. */
  pendingBalance?: number;
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
            {typeof pendingBalance === 'number' ? (
              <p className="text-xs text-muted-foreground">
                {isAr ? 'الرصيد المتبقي حالياً:' : 'Pending balance:'}{' '}
                <bdi className="font-semibold tabular-nums">${pendingBalance.toFixed(2)}</bdi>
              </p>
            ) : null}
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
              disabled={submitting || !token || !staff}
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
