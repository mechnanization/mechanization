'use client';

import { useEffect, useState } from 'react';
import { Banknote, CreditCard, Loader2, UserCheck } from 'lucide-react';
import { formatLbp } from '@/lib/currency';
import { tafqeet } from '@/lib/tafqeet';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export interface SettleTarget {
  id: string;
  title: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  dueDate: string;
}

export interface SettleValues {
  method: 'CASH' | 'WHISH_MONEY' | 'COLLECTOR';
  amount: number;
  whishTransactionRef?: string;
  collectedById?: string;
  note?: string;
}

export interface CollectorOption {
  id: string;
  fullName: string;
  role: string;
  isActive: boolean;
}

export function SettlePaymentDialog({
  open,
  onOpenChange,
  payment,
  submitting,
  error,
  collectors = [],
  onSubmit,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: SettleTarget | null;
  submitting: boolean;
  error: string | null;
  collectors?: CollectorOption[];
  onSubmit: (values: SettleValues) => void;
  locale?: string;
}) {
  const [method, setMethod] = useState<SettleValues['method']>('CASH');
  const [reference, setReference] = useState('');
  const [collectedById, setCollectedById] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const methods = [
    {
      value: 'CASH' as const,
      title: locale === 'en' ? 'Cash' : 'نقداً',
      description: locale === 'en' ? 'Cash in office register' : 'استلام في الصندوق',
      icon: Banknote,
    },
    {
      value: 'WHISH_MONEY' as const,
      title: locale === 'en' ? 'Whish Transfer' : 'تحويل Whish',
      description: locale === 'en' ? 'Verified transfer' : 'تحويل مؤكد',
      icon: CreditCard,
    },
    {
      value: 'COLLECTOR' as const,
      title: locale === 'en' ? 'Through Collector' : 'عبر المحصّل',
      description: locale === 'en' ? 'Field collection' : 'استلام ميداني',
      icon: UserCheck,
    },
  ];

  useEffect(() => {
    if (!open || !payment) return;
    setAmount(String(Math.round(payment.remaining)));
    setMethod('CASH');
    setReference('');
    setCollectedById('');
    setNote('');
  }, [open, payment]);

  if (!payment) return null;

  const received = Number(amount.replace(/\D/g, '')) || 0;
  const isWhish = method === 'WHISH_MONEY';
  const isCollector = method === 'COLLECTOR';
  const missingReference = isWhish && reference.trim() === '';
  const missingCollector = isCollector && collectedById === '';
  const valid =
    Number.isFinite(received) &&
    received > 0 &&
    received <= payment.remaining &&
    !missingReference &&
    !missingCollector;
  const isPartial = received > 0 && received < payment.remaining;
  const tooMuch = received > payment.remaining;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={locale === 'en' ? 'Close' : 'إغلاق'} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{locale === 'en' ? 'Record Payment' : 'تسجيل دفعة'}</DialogTitle>
          <DialogDescription>{payment.title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between rounded-lg bg-muted/40 p-3 text-sm">
            <span className="text-muted-foreground">
              {locale === 'en' ? 'Remaining Balance:' : 'الرصيد المستحق:'}
            </span>
            <span className="font-bold tabular-nums">{formatLbp(payment.remaining, locale)}</span>
          </div>

          <Field label={locale === 'en' ? 'Payment Method' : 'طريقة الدفع'} htmlFor="settle-method" required>
            <div className="grid gap-2 sm:grid-cols-3">
              {methods.map((option) => (
                <ChoiceCard
                  key={option.value}
                  name="settle-method"
                  value={option.value}
                  checked={method === option.value}
                  onChange={(next) => {
                    setMethod(next as SettleValues['method']);
                    if (next !== 'WHISH_MONEY') setReference('');
                    if (next !== 'COLLECTOR') setCollectedById('');
                  }}
                  title={option.title}
                  description={option.description}
                  icon={option.icon}
                />
              ))}
            </div>
          </Field>

          {isWhish ? (
            <Field
              label={locale === 'en' ? 'Transaction Reference Number' : 'رقم عملية التحويل'}
              htmlFor="settle-reference"
              required
            >
              <Input
                id="settle-reference"
                dir="ltr"
                className="text-start font-mono font-semibold"
                placeholder="TRX-000000"
                invalid={missingReference && reference !== ''}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          ) : null}

          {isCollector ? (
            <Field
              label={locale === 'en' ? 'Collector' : 'المحصّل'}
              htmlFor="settle-collector"
              required
            >
              {collectors.length === 0 ? (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                  {locale === 'en' ? 'No staff accounts found.' : 'لا توجد حسابات موظفين.'}
                </p>
              ) : (
                <Select value={collectedById} onValueChange={setCollectedById}>
                  <SelectTrigger id="settle-collector">
                    <SelectValue placeholder={locale === 'en' ? 'Select collector…' : 'اختر المحصّل…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {collectors.map((collector) => (
                      <SelectItem key={collector.id} value={collector.id}>
                        {collector.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          ) : null}

          <div className="space-y-1.5">
            <Field
              label={locale === 'en' ? 'Received Amount (LBP)' : 'المبلغ المستلم (ل.ل)'}
              htmlFor="settle-amount"
              required
              error={
                tooMuch
                  ? (locale === 'en'
                      ? `Amount exceeds remaining balance (${formatLbp(payment.remaining, locale)})`
                      : `المبلغ أكبر من الرصيد (${formatLbp(payment.remaining, locale)})`)
                  : undefined
              }
            >
              <Input
                id="settle-amount"
                inputMode="numeric"
                dir="ltr"
                className="text-start text-lg font-bold tabular-nums"
                invalid={tooMuch}
                value={amount ? Number(amount).toLocaleString('en-US') : ''}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                placeholder="0"
              />
            </Field>

            {received > 0 && !tooMuch && locale === 'ar' ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">كتابةً:</span> {tafqeet(received)}
              </p>
            ) : null}
          </div>

          {isPartial ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              {locale === 'en' ? (
                <>
                  Partial payment — <span className="font-bold">{formatLbp(payment.remaining - received, locale)}</span> will remain due.
                </>
              ) : (
                <>
                  دفعة جزئية — سيبقى <span className="font-bold">{formatLbp(payment.remaining - received, locale)}</span> مستحقاً.
                </>
              )}
            </p>
          ) : null}

          <Field label={locale === 'en' ? 'Notes' : 'ملاحظة'} htmlFor="settle-note">
            <Textarea
              id="settle-note"
              rows={2}
              placeholder={locale === 'en' ? 'Notes…' : 'ملاحظات…'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            disabled={!valid || submitting}
            className="font-semibold"
            onClick={() =>
              onSubmit({
                method,
                amount: received,
                whishTransactionRef: isWhish ? reference.trim() : undefined,
                collectedById: isCollector ? collectedById : undefined,
                note: note.trim() || undefined,
              })
            }
          >
            {submitting ? <Loader2 className="size-4 animate-spin rtl:ml-2 ltr:mr-2" aria-hidden /> : null}
            {locale === 'en' ? `Record ${formatLbp(valid ? received : 0, locale)}` : `تسجيل ${formatLbp(valid ? received : 0, locale)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
