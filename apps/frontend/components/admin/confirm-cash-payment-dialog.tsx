'use client';

import { Banknote, Loader2 } from 'lucide-react';
import type { AdminPaymentItem } from '@/lib/api-client';
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Cash handed over at the counter goes straight to PAID with no review step —
 * unlike Whish transfers, there is no later chance to catch a mistake here,
 * so this is the one checkpoint before the ledger is updated.
 */
export function ConfirmCashPaymentDialog({
  open,
  onOpenChange,
  payment,
  submitting,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: AdminPaymentItem | null;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent closeLabel="إغلاق" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="size-5 text-primary" aria-hidden />
            تأكيد تسجيل الدفعة
          </DialogTitle>
          <DialogDescription>
            يُسجَّل المبلغ كمقبوض نقداً فوراً، دون خطوة مراجعة لاحقة.
          </DialogDescription>
        </DialogHeader>

        {payment ? (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">المواطن</span>
              <span className="font-medium">{payment.citizenName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">المطالبة</span>
              <span className="font-medium">{payment.title}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">طريقة الدفع</span>
              <span className="font-medium">نقداً</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">تاريخ الاستحقاق</span>
              <span className="font-medium">
                {formatDate(payment.dueDate)}
              </span>
            </div>
            <div className="flex items-center justify-between border-t pt-2">
              <span className="text-muted-foreground">المبلغ</span>
              <span className="text-base font-semibold">{formatLbp(payment.amount)}</span>
            </div>
          </div>
        ) : null}

        {error ? (
          <Alert tone="error">
            {error}
          </Alert>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            إلغاء
          </Button>
          <Button disabled={submitting} onClick={onConfirm}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            تأكيد الاستلام
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
