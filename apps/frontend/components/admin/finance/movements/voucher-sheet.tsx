'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Printer } from 'lucide-react';
import { TREASURY_ADMIN_ROLES } from '@mechanization/shared-schemas';
import {
  getExpense,
  getIncomeVoucher,
  type ExpenseVoucherView,
  type IncomeVoucherView,
  type TreasuryMovement,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { mayRegularize, type OrderActor } from '@/lib/expense-order';
import { hasRole } from '@/lib/staff-roles';
import { isAwaitingOrder, movementCategory, type ComposerDirection } from '@/lib/treasury-movements';
import { useStaffQuery } from '@/lib/use-staff-query';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { RegularizeExpenseDialog, VoidExpenseDialog } from '../expense-dialogs';
import { VoidIncomeDialog } from '../income-dialogs';
import { TreasuryAmount } from '../treasury-amount';

/**
 * A line of «الحركات المالية», opened: the voucher in a side panel over the
 * list (`Sheet`, from the inline end; the whole screen on a phone). What it
 * says, every field of it, who recorded it, who ordered it and who cancelled
 * it, and, in the panel's footer, what can be done with it: print it, issue
 * its order, cancel it.
 *
 * Every voucher prints, a cancelled one too (its paper says so). Cancelling is
 * the manager's (`TREASURY_ADMIN_ROLES`, as `IncomeController` and
 * `ExpensesController` enforce); so is issuing the order for an urgent payment
 * made before it (`mayRegularize`). A mistake is cancelled, never edited, and
 * the cancelled voucher stays in the list with its reason.
 *
 * The line in hand is drawn at once. A voucher opened by its address
 * (`?voucher=…&kind=…`, as the recording page's «عرض» links) that is not on the
 * list's page — another period, a link from elsewhere — is read by its id,
 * under the print page's own key, so printing it next needs no second read.
 */
export function VoucherSheet({
  open,
  onClose,
  tenant,
  base,
  token,
  locale,
  actor,
  kind,
  voucherId,
  fromList,
}: {
  open: boolean;
  onClose: () => void;
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  actor: OrderActor | null;
  kind: ComposerDirection;
  voucherId: string;
  /** The line as the list already holds it, when it is on the page. */
  fromList: TreasuryMovement | null;
}): React.JSX.Element {
  const t = useTranslations('finance.movements.voucher');
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const [regularizing, setRegularizing] = useState(false);

  // A confirmation left open when the panel closed (the back button) does not come back with it.
  useEffect(() => {
    if (open) return;
    setVoiding(false);
    setRegularizing(false);
  }, [open]);

  const read = useStaffQuery<IncomeVoucherView | ExpenseVoucherView>({
    queryKey: ['treasury', tenant, kind === 'in' ? 'income-voucher' : 'expense', voucherId],
    queryFn: (accessToken, signal) =>
      kind === 'in'
        ? getIncomeVoucher(tenant, accessToken, { id: voucherId }, signal)
        : getExpense(tenant, accessToken, { id: voucherId }, signal),
    tenant,
    base,
    // Read only while open, and only when the list's page does not already hold it.
    token: open && !fromList ? token : null,
    errorMessage: t('loadError'),
  });

  const movement: TreasuryMovement | null =
    fromList ??
    (read.data
      ? kind === 'in'
        ? { direction: 'IN', day: '', voucher: read.data as IncomeVoucherView }
        : { direction: 'OUT', day: '', voucher: read.data as ExpenseVoucherView }
      : null);

  const sheet = (title: React.ReactNode, body: React.ReactNode, footer?: React.ReactNode): React.JSX.Element => (
    <Sheet open={open} onClose={onClose} title={title} footer={footer} closeLabel={t('close')} className="sm:max-w-lg">
      {body}
    </Sheet>
  );

  if (!movement) {
    return sheet(
      t('title'),
      read.error ? (
        <ErrorState title={read.error} onRetry={read.refetch} retryLabel={t('retry')} compact />
      ) : (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-64 w-full" />
        </div>
      ),
    );
  }

  const voucher = movement.voucher;
  const incoming = movement.direction === 'IN';
  const cancelled = voucher.status === 'VOID';
  const awaiting = isAwaitingOrder(movement);
  const canVoid = hasRole(TREASURY_ADMIN_ROLES, actor?.role) && voucher.status === 'RECORDED';
  const regularizes = movement.direction === 'OUT' && mayRegularize(movement.voucher, actor);
  const printHref = `${base}/finance/${incoming ? 'income' : 'expenses'}/${voucher.id}/print?print=1`;
  const { chapterCode, itemCode } = voucher.category;

  const title = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>{incoming ? t('titleIn') : t('titleOut')}</span>
      {/* A voucher number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */}
      <bdi dir="ltr" className="font-mono text-base font-medium">
        {voucher.voucherNumber}
      </bdi>
    </span>
  );

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline">
        <Link href={printHref} aria-label={t('printFor', { number: voucher.voucherNumber })}>
          <Printer className="size-4" aria-hidden />
          {t('print')}
        </Link>
      </Button>
      {regularizes ? (
        <Button type="button" variant="outline" onClick={() => setRegularizing(true)}>
          {t('regularize')}
        </Button>
      ) : null}
      {canVoid ? (
        <Button type="button" variant="ghost" className="ms-auto" onClick={() => setVoiding(true)}>
          <Ban className="size-4" aria-hidden />
          {t('void')}
        </Button>
      ) : null}
    </div>
  );

  const body = (
    <div className="space-y-5">
      <div className="space-y-1.5">
        {cancelled || awaiting ? (
          <div className="flex flex-wrap gap-1.5">
            {cancelled ? <Badge variant="soft-warning">{t('cancelled')}</Badge> : null}
            {awaiting ? <Badge variant="soft-warning">{t('awaitingOrder')}</Badge> : null}
          </div>
        ) : null}
        <TreasuryAmount
          amount={incoming ? voucher.amount : -voucher.amount}
          currency={voucher.currency}
          locale={locale}
          signed
          wrap
          /*
            Received money in the success colour with its «+», paid money in the
            ink with its «−»: the sign and the word under it carry it without the
            colour (COL-3). A cancelled voucher moved nothing in the end, so its
            figure is struck through as well as dimmed.
          */
          className={cn(
            'block text-2xl font-semibold',
            cancelled ? 'text-muted-foreground line-through' : incoming ? 'text-success' : 'text-foreground',
          )}
        />
        <p className="text-sm text-muted-foreground">
          {incoming ? t('directionIn') : t('directionOut')}
          {' · '}
          <bdi>{voucher.account.name}</bdi>
        </p>
      </div>

      <SummaryList>
        <SummaryRow label={incoming ? t('payer') : t('payee')}>
          {(incoming ? (voucher as IncomeVoucherView).payerName : (voucher as ExpenseVoucherView).payee) ?? '—'}
        </SummaryRow>
        <SummaryRow label={t('category')}>{movementCategory(movement, locale)}</SummaryRow>
        {/* «الباب 6 · البند 6.1», as the budget names them — not two bare codes read in an unknown order. */}
        {chapterCode || itemCode ? (
          <SummaryRow label={t('budget')}>
            <span className="tabular-nums">
              {chapterCode && itemCode
                ? t('budgetBoth', { chapter: chapterCode, item: itemCode })
                : chapterCode
                  ? t('budgetChapter', { chapter: chapterCode })
                  : t('budgetItem', { item: itemCode ?? '' })}
            </span>
          </SummaryRow>
        ) : null}
        <SummaryRow label={t('date')}>
          <span className="tabular-nums">{formatDate(voucher.occurredAt)}</span>
        </SummaryRow>
        {voucher.adjustmentReason ? (
          <SummaryRow label={t('adjustmentReason')}>{voucher.adjustmentReason}</SummaryRow>
        ) : null}
        <SummaryRow label={t('description')}>{voucher.description}</SummaryRow>
        {movement.direction === 'IN' && movement.voucher.externalReference ? (
          <SummaryRow label={t('reference')} className="font-mono">
            <bdi dir="ltr">{movement.voucher.externalReference}</bdi>
          </SummaryRow>
        ) : null}
        {movement.direction === 'OUT' && movement.voucher.invoiceNumber ? (
          <SummaryRow label={t('invoice')}>
            <bdi dir="ltr">{movement.voucher.invoiceNumber}</bdi>
          </SummaryRow>
        ) : null}
        {movement.direction === 'OUT' ? (
          <SummaryRow label={t('physicalReceipt')}>
            {movement.voucher.hasPhysicalReceipt ? t('yes') : t('no')}
          </SummaryRow>
        ) : null}
        <SummaryRow label={t('recordedBy')}>{voucher.recordedByName ?? '—'}</SummaryRow>
        {/*
          The order is the legal basis of a payment (decree 5595/1982 art. 28,
          33), so the voucher says whose it is and when — or, for an urgent
          payment still waiting, why it was paid first (art. 35).
        */}
        {movement.direction === 'OUT' ? (
          <SummaryRow label={t('order')}>
            {movement.voucher.orderStatus === 'ORDERED' && movement.voucher.orderedAt
              ? t('orderedBy', {
                  name: movement.voucher.orderedByName ?? '—',
                  date: formatDate(movement.voucher.orderedAt),
                })
              : t('orderPending', { reason: movement.voucher.urgentReason ?? '—' })}
          </SummaryRow>
        ) : null}
        {cancelled ? (
          <SummaryRow label={t('cancellation')}>
            {t('cancelledBy', {
              name: voucher.voidedByName ?? '—',
              date: voucher.voidedAt ? formatDate(voucher.voidedAt) : '—',
              reason: voucher.voidReason ?? '—',
            })}
          </SummaryRow>
        ) : null}
      </SummaryList>

      {/* Over the panel, as dialogs of their own: Radix stacks them on the sheet. */}
      {voiding && token && movement.direction === 'IN' ? (
        <VoidIncomeDialog
          tenant={tenant}
          token={token}
          voucher={movement.voucher}
          onDone={() => {
            setVoiding(false);
            void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
          }}
          onCancel={() => setVoiding(false)}
        />
      ) : null}
      {voiding && token && movement.direction === 'OUT' ? (
        <VoidExpenseDialog
          tenant={tenant}
          token={token}
          voucher={movement.voucher}
          onDone={() => setVoiding(false)}
          onCancel={() => setVoiding(false)}
        />
      ) : null}
      {regularizing && token && movement.direction === 'OUT' ? (
        <RegularizeExpenseDialog
          tenant={tenant}
          token={token}
          locale={locale}
          voucher={movement.voucher}
          onDone={() => setRegularizing(false)}
          onCancel={() => setRegularizing(false)}
        />
      ) : null}
    </div>
  );

  return sheet(title, body, actions);
}
