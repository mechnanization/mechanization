'use client';

import { useEffect, useState } from 'react';
import { Banknote, Building2, Clock, Loader2, MapPin, Smartphone } from 'lucide-react';
import type { CitizenPaymentItem, MunicipalitySettings } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

function lbp(amount: number): string {
  return `${amount.toLocaleString('en-US')} ل.ل`;
}

/**
 * How to pay one bill.
 *
 * Neither option settles anything here. Cash is an instruction to visit; the
 * Whish route records the citizen's own claim that they transferred, which a
 * clerk then matches against the municipality's account. The button says
 * "أبلغ عن الدفع" rather than "ادفع" for exactly that reason — promising a
 * citizen their bill is settled when nobody has checked would be the worst
 * thing this screen could do.
 */
export function PayDialog({
  payment,
  settings,
  submitting,
  error,
  onOpenChange,
  onDeclare,
  locale = 'ar',
}: {
  payment: CitizenPaymentItem | null;
  settings: MunicipalitySettings | null;
  submitting: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onDeclare: (input: { method: string; whishTransactionRef?: string }) => void;
  locale?: string;
}) {
  const whishAvailable = Boolean(settings?.whishMoneyNumber);
  const [method, setMethod] = useState<'CASH' | 'WHISH_MONEY'>('CASH');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (payment) {
      setMethod(whishAvailable ? 'WHISH_MONEY' : 'CASH');
      setReference('');
    }
  }, [payment, whishAvailable]);

  const canSubmit =
    !submitting && (method === 'CASH' || reference.trim().length >= 4);

  return (
    <Dialog open={payment !== null} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={locale === 'en' ? 'Close' : 'إغلاق'} className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 space-y-1 border-b p-6 text-start">
          <DialogTitle>
            {locale === 'en' ? `Pay ${payment?.title}` : `دفع ${payment?.title}`}
          </DialogTitle>
          <DialogDescription>
            {locale === 'en' ? 'Amount due: ' : 'المبلغ المستحق: '}
            <span className="font-semibold">{payment ? lbp(payment.amount) : ''}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="grid gap-3">
            <MethodCard
              active={method === 'CASH'}
              onSelect={() => setMethod('CASH')}
              icon={<Building2 className="size-5" aria-hidden />}
              title={locale === 'en' ? 'Cash at Municipality' : 'نقداً في البلدية'}
              description={
                locale === 'en'
                  ? 'Pay at the municipal finance office and receive an official receipt.'
                  : 'ادفع في مكتب المالية واستلم إيصالاً.'
              }
            />
            {whishAvailable ? (
              <MethodCard
                active={method === 'WHISH_MONEY'}
                onSelect={() => setMethod('WHISH_MONEY')}
                icon={<Smartphone className="size-5" aria-hidden />}
                title={locale === 'en' ? 'Transfer via Whish Money' : 'تحويل عبر Whish Money'}
                description={
                  locale === 'en'
                    ? 'Transfer the amount then enter the transaction reference.'
                    : 'حوّل المبلغ ثم أدخل رقم العملية.'
                }
              />
            ) : null}
          </div>

          {method === 'CASH' ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {settings?.cashOfficeAddress ??
                  (locale === 'en'
                    ? 'Municipal Building — Finance Department'
                    : 'مبنى البلدية — مكتب المالية')}
              </p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <Clock className="size-4 shrink-0" aria-hidden />
                {settings?.cashOfficeHours ??
                  (locale === 'en'
                    ? 'During official working hours'
                    : 'خلال أوقات الدوام الرسمية')}
              </p>
              <p className="text-muted-foreground">
                {locale === 'en'
                  ? 'Bring your reference number. Payment status is updated once recorded by the clerk.'
                  : 'أحضر رقمك المرجعي. تُحدَّث حالة الدفعة بعد أن يسجّلها الموظف.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <ol className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
                <li className="flex gap-2">
                  <span className="font-semibold text-primary">
                    {locale === 'en' ? '1.' : '١.'}
                  </span>
                  <span>
                    {locale === 'en'
                      ? 'Open Whish Money app and transfer '
                      : 'افتح تطبيق Whish Money وحوّل '}
                    <span className="font-semibold">{payment ? lbp(payment.amount) : ''}</span>
                    {locale === 'en' ? ' to number:' : ' إلى الرقم:'}
                  </span>
                </li>
                <li className="flex items-center justify-center rounded-md border bg-background p-3">
                  <span className="font-mono text-lg font-bold" dir="ltr">
                    {settings?.whishMoneyNumber}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-primary">
                    {locale === 'en' ? '2.' : '٢.'}
                  </span>
                  <span>
                    {locale === 'en'
                      ? 'Keep the transaction receipt and enter its reference below.'
                      : 'احتفظ بإيصال العملية وأدخل رقمها أدناه.'}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-primary">
                    {locale === 'en' ? '3.' : '٣.'}
                  </span>
                  <span>
                    {locale === 'en'
                      ? 'Payment status becomes "Pending Review" until confirmed by staff.'
                      : 'تُصبح الدفعة «قيد المراجعة» حتى يؤكّدها موظف البلدية.'}
                  </span>
                </li>
              </ol>

              <Field
                label={locale === 'en' ? 'Transfer Reference Number' : 'رقم عملية التحويل'}
                htmlFor="whish-ref"
                required
              >
                <Input
                  id="whish-ref"
                  dir="ltr"
                  className="text-start font-mono"
                  placeholder="TX123456789"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              onDeclare({
                method,
                ...(method === 'WHISH_MONEY' ? { whishTransactionRef: reference.trim() } : {}),
              })
            }
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {method === 'CASH'
              ? (locale === 'en' ? 'I will pay at municipality' : 'سأدفع في البلدية')
              : (locale === 'en' ? 'Declare Payment' : 'أبلغ عن الدفع')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MethodCard({
  active,
  onSelect,
  icon,
  title,
  description,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-start transition-colors',
        active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg',
          active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/** Kept for the payments page's empty state. */
export { Banknote };
