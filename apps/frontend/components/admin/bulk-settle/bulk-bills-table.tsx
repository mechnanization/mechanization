'use client';

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { SelectedBill } from '@/lib/bulk-settle';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionTooltip } from '@/components/ui/tooltip';
import { MoneyList } from './money-list';

/**
 * The bills a bulk settlement will pay, read back in the dialog in the order
 * the server settles them (oldest first, `bulkSettlementOrder`), each with what
 * is still owed on it, and the total per currency under them. Each row can be
 * unticked from here: the way out `BULK_SETTLE_SOME_ALREADY_PAID` names when the
 * bill sits on another page of the list.
 */
export function BulkBillsTable({
  bills,
  due,
  locale,
  onRemove,
}: {
  /** Already in settlement order. */
  bills: readonly SelectedBill[];
  /** What they owe, per currency (`dueByCurrency`). */
  due: ReadonlyArray<{ currency: string; amount: number }>;
  locale: string;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const t = useTranslations('bulkSettle.dialog');
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('bills')}</h3>
      <div className="max-h-56 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('colInvoice')}</TableHead>
              <TableHead>{t('colTitle')}</TableHead>
              <TableHead>{t('colDue')}</TableHead>
              <TableHead className="text-end">{t('colAmount')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('colRemove')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bills.map((bill) => (
              <TableRow key={bill.id}>
                <TableCell className="py-2 text-xs">
                  {bill.invoiceNumber ? (
                    <bdi dir="ltr" className="font-mono">
                      {bill.invoiceNumber}
                    </bdi>
                  ) : (
                    t('noInvoice')
                  )}
                </TableCell>
                <TableCell className="min-w-32 whitespace-normal py-2">{bill.title}</TableCell>
                <TableCell className="py-2 text-xs tabular-nums">{formatDate(bill.dueDate)}</TableCell>
                <TableCell className="py-2 text-end">
                  <Money amount={bill.remaining} currency={bill.currency} locale={locale} exact />
                </TableCell>
                <TableCell className="py-1">
                  <ActionTooltip label={t('remove', { title: bill.title })}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('remove', { title: bill.title })}
                      onClick={() => onRemove(bill.id)}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </ActionTooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <SummaryList>
        <SummaryRow label={t('total')}>
          <MoneyList entries={due} locale={locale} />
        </SummaryRow>
      </SummaryList>
    </section>
  );
}
