'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef, PaginationState, Updater } from '@tanstack/react-table';
import { Banknote, Calendar, Receipt as ReceiptIcon, ReceiptText, Wallet } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { CitizenProfile, CitizenProfilePayment } from '@/lib/api-client';
import { Button, buttonVariants } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { ArrearsBillMark, useArrearsPropertyText } from '@/components/arrears-bill-mark';
import { BillCheckbox } from '@/components/admin/bulk-settle/bill-checkbox';
import { describeAssessment } from '@/lib/fee-assessment';
import { formatDate } from '@/lib/dates';
import { billPageLink } from '@/lib/bill-receipts';
import { fromCitizenPayment, isBulkSettleable, pageSelection, rowBlock } from '@/lib/bulk-settle';
import type { BulkSelection } from '@/lib/use-bulk-selection';
import { useTableLabels } from '@/lib/use-table-labels';

/** Bills shown at a time on a citizen's file — a household's years of them would otherwise run the page out. */
export const BILLS_PAGE_SIZE = 10;

/**
 * The citizen file's bill list: item · status · due · frequency · amount · actions,
 * as a `DataTable` (GOD-24) — the kit's frame, header, page footer and phone cards —
 * in place of the hand-built grid of rows and its own `Pager`.
 *
 * The bills are all in memory already, so the table pages a slice of them
 * (`manualPagination`) with the page held in the URL by the caller (`?feesPage=`;
 * 0-based here). «تسديد الفواتير المحددة»'s box rides in the item cell, as before,
 * with «تحديد الكل» over this page's bills above the table.
 */
export function BillsPanel({
  citizen,
  payments,
  page,
  onPageChange,
  canManage,
  canTakeCash,
  selection,
  settleHref,
  onReceipt,
  locale,
}: {
  citizen: CitizenProfile;
  payments: CitizenProfilePayment[];
  /** 0-based, already clamped to the pages that exist. */
  page: number;
  onPageChange: (page: number) => void;
  canManage: boolean;
  /** Whether a bill's own button says «تسجيل دفعة نقدية» (the cash page) or «تسجيل دفعة» (a collector's counter page). */
  canTakeCash: boolean;
  /** The bills ticked for «تسديد الفواتير المحددة», or null for a role that may not settle several at once. */
  selection: BulkSelection | null;
  settleHref: (paymentId: string) => string;
  onReceipt: (payment: CitizenProfilePayment) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const tSelect = useTranslations('bulkSettle.select');
  const tReceipts = useTranslations('billReceipts');
  const arrearsPropertyText = useArrearsPropertyText();
  const tableLabels = useTableLabels({ empty: en ? 'No fees billed yet' : 'لا رسوم بعد' });

  const pagePayments = payments.slice(page * BILLS_PAGE_SIZE, (page + 1) * BILLS_PAGE_SIZE);
  /** This page's bills that may be ticked, and where «تحديد الكل» stands over them. */
  const pageEligible = pagePayments.filter(isBulkSettleable).map((row) => fromCitizenPayment(citizen, row));
  const pageState = selection ? pageSelection(selection.bills, pageEligible) : null;

  const pagination: PaginationState = { pageIndex: page, pageSize: BILLS_PAGE_SIZE };
  const changePage = (next: Updater<PaginationState>) => {
    const value = typeof next === 'function' ? next(pagination) : next;
    onPageChange(value.pageIndex);
  };

  const columns = useMemo<ColumnDef<CitizenProfilePayment>[]>(() => {
    const labels = getLabels(locale);
    return [
      {
        id: 'item',
        header: en ? 'Item' : 'البند',
        meta: { mobile: 'primary' },
        cell: ({ row }) => {
          const payment = row.original;
          const breakdown = describeAssessment(payment.assessment, locale);
          return (
            <div className="flex min-w-0 items-start gap-3">
              {/* A bill that cannot be ticked keeps the box's width, so every title lines up. */}
              {selection ? (
                isBulkSettleable(payment) ? (
                  <BillCheckbox
                    subject={{ kind: 'row', title: payment.title }}
                    checked={selection.bills.some((entry) => entry.id === payment.id)}
                    blocked={rowBlock(selection.bills, fromCitizenPayment(citizen, payment))}
                    onToggle={() => selection.toggle(fromCitizenPayment(citizen, payment))}
                  />
                ) : (
                  <span aria-hidden className="size-6 shrink-0" />
                )
              ) : null}
              <div className="min-w-0 space-y-0.5">
                <p className="break-words font-semibold">{payment.title}</p>
                {payment.arrears ? (
                  // An old debt (task 10): the chip, its year and fee, the «ARR-» number, the parcel and the old books' reference.
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ArrearsBillMark arrears={payment.arrears} invoiceNumber={payment.invoiceNumber} showOldReference />
                    <span className="text-xs font-normal text-muted-foreground">
                      {arrearsPropertyText(payment.arrears)}
                    </span>
                  </div>
                ) : null}
                {/* «ليش عليّ هالمبلغ؟» — the breakdown stored on the payment, answered where the collector is asked it. */}
                {breakdown ? (
                  <p className="text-xs font-normal text-muted-foreground">
                    <bdi>{breakdown}</bdi>
                  </p>
                ) : null}
                {payment.reviewNote ? (
                  <p className="text-xs font-normal text-muted-foreground">
                    {en ? 'Staff note: ' : 'ملاحظة الموظف: '}
                    {payment.reviewNote}
                  </p>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: 'status',
        header: en ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const payment = row.original;
          const partly = payment.paymentStatus !== 'PAID' && payment.paidAmount > 0;
          return (
            <span>
              {labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus}
              {partly ? (en ? ' · partly paid' : ' · جزئياً') : null}
            </span>
          );
        },
      },
      {
        id: 'due',
        header: en ? 'Due' : 'الاستحقاق',
        cell: ({ row }) => {
          const payment = row.original;
          return (
            <span className="inline-flex flex-wrap items-center gap-1 tabular-nums">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground lg:hidden" aria-hidden />
              {formatDate(payment.dueDate)}
              {payment.paidAt ? (
                <span className="ms-1 text-xs text-success">
                  ({en ? 'paid ' : 'سُدّد '}
                  {formatDate(payment.paidAt)})
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'frequency',
        header: en ? 'Frequency' : 'الدورية',
        cell: ({ row }) => {
          const { frequency } = row.original;
          return frequency ? (labels.feeFrequency?.[frequency as never] ?? frequency) : null;
        },
      },
      {
        id: 'amount',
        header: en ? 'Amount' : 'المبلغ',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const payment = row.original;
          const partly = payment.paymentStatus !== 'PAID' && payment.paidAmount > 0;
          return (
            <div className="text-end">
              <Money amount={payment.amount} exact className="text-base font-bold" />
              {partly ? (
                <p className="text-xs font-normal text-muted-foreground">
                  {en ? 'Remaining ' : 'متبقٍ '}
                  <Money amount={payment.remaining} exact />
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        meta: { mobile: 'actions', align: 'end' },
        cell: ({ row }) => {
          const payment = row.original;
          return canManage ? (
            <div className="flex items-center justify-end gap-2">
              {/*
                Every bill links to its own page, named by what it holds now
                (`billPageLink`): the cash form while it is owed, the receipts once
                it is not — the way to a paid bill's «عكس الوصل» (review of PR #113).
                A collector is sent to the counter settle page (D13), and a bill with
                no payment to take shows him no link.
              */}
              {canTakeCash || billPageLink(payment) === 'settle' ? (
                <Link href={settleHref(payment.id)} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                  {billPageLink(payment) === 'settle' ? (
                    <>
                      <Banknote className="size-4" aria-hidden />
                      {canTakeCash
                        ? en
                          ? 'Record cash'
                          : 'تسجيل دفعة نقدية'
                        : en
                          ? 'Record payment'
                          : 'تسجيل دفعة'}
                    </>
                  ) : (
                    <>
                      <ReceiptText className="size-4" aria-hidden />
                      {tReceipts('open')}
                    </>
                  )}
                </Link>
              ) : null}
              {/*
                A shared unit bill (0099) is not reprinted from here: its receipt names
                whoever paid, and that is not necessarily the person whose file this is
                (D9). Its receipts are printed one payment at a time on the bill's own
                page, «وصولات الفاتورة», which the row links to.
              */}
              {payment.paidAmount > 0 && !payment.sharedUnit ? (
                <Button size="sm" variant="ghost" onClick={() => onReceipt(payment)}>
                  <ReceiptIcon className="size-4" aria-hidden />
                  {en ? 'Receipt' : 'الوصل'}
                </Button>
              ) : null}
            </div>
          ) : null;
        },
      },
    ];
  }, [
    en,
    locale,
    selection,
    citizen,
    canManage,
    canTakeCash,
    settleHref,
    onReceipt,
    arrearsPropertyText,
    tReceipts,
  ]);

  return (
    <div className="space-y-2">
      {selection && pageState && pageState.eligible > 0 ? (
        <div className="flex items-center gap-2">
          <BillCheckbox
            id="citizen-fees-select-page"
            subject={{ kind: 'page', allSelected: pageState.allSelected }}
            checked={pageState.allSelected}
            blocked={pageState.blocked}
            onToggle={() => selection.toggleRows(pageEligible)}
          />
          <label htmlFor="citizen-fees-select-page" className="text-sm">
            {pageState.allSelected ? tSelect('pageClear') : tSelect('page')}
          </label>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        data={pagePayments}
        labels={tableLabels}
        getRowId={(payment) => payment.id}
        searchable={false}
        sortable={false}
        manualPagination
        manualFiltering
        pageCount={Math.max(Math.ceil(payments.length / BILLS_PAGE_SIZE), 1)}
        totalRowCount={payments.length}
        pagination={pagination}
        onPaginationChange={changePage}
        pageSizeOptions={[BILLS_PAGE_SIZE]}
        emptyIcon={<Wallet className="size-10 text-muted-foreground/60" />}
      />
    </div>
  );
}
