'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  logApiError,
  orderExpenseRequest,
  regularizeExpense,
  rejectExpenseRequest,
  voidExpense,
  withdrawExpenseRequest,
  type ExpenseRequestView,
  type ExpenseVoucherView,
} from '@/lib/api-client';
import { meansOutOfDate } from '@/lib/expense-order';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

/*
  The dialogs of «أمر الصرف» and of cancelling a voucher.

  All of them are `ConfirmDialog` with `destructive={false}` (DES-4): nothing is
  lost. A voucher stays with its reason, a request stays with its decision, and
  the register is where either is read afterwards. Each one:

  - guards the press with an in-flight ref, not only the dialog's own busy
    state (STA-4). These routes carry no retry key — the state is the guard: the
    manager's second order for a request he already ordered is answered with
    the voucher it paid (`replayed`), anyone else's with
    `EXPENSE_REQUEST_ALREADY_DECIDED`;
  - waits for the server before it says anything, and then says what the server
    recorded — the voucher number it returned (STA-6). Nothing here is
    optimistic, and money least of all (STA-5);
  - throws the server's refusal, so the dialog stays open and shows it beside
    the action (STA-3, TXT-6), and refreshes the lists when the refusal is that
    somebody else got there first.
*/

/** Refreshes the lists behind a refusal that says they are out of date, so the row that can no longer be acted on goes away. */
function refreshIfOutOfDate(queryClient: QueryClient, tenant: string, caught: unknown): void {
  if (caught instanceof ApiRequestError && meansOutOfDate(caught.code)) {
    void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
  }
}

/**
 * «إلغاء سند الصرف» — the manager's cancellation.
 *
 * `ConfirmDialog` with `destructive={false}` on purpose (DES-4): nothing is
 * lost. The voucher stays, the money comes back, and the copy says both, so the
 * manager is not warned about a consequence that does not happen.
 *
 * Also the way to refuse an urgent payment after the fact: a voucher the
 * manager will not order is cancelled, and that returns the money.
 *
 * The reason is required (the schema asks for five characters), and Confirm
 * waits for it, as `RejectRequestDialog` does: the too-short message was
 * shown twice, once under the field and once as the dialog's failure, by
 * refusing after the press.
 */
export function VoidExpenseDialog({
  tenant,
  token,
  voucher,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  voucher: ExpenseVoucherView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.voidDialog');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await voidExpense(tenant, token, { id: voucher.id, reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success', { number: voucher.voucherNumber }), { description: t('successBody') });
      onDone();
    } catch (caught) {
      logApiError(caught);
      refreshIfOutOfDate(queryClient, tenant, caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('title', { number: voucher.voucherNumber })}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      confirmDisabled={reason.trim().length < 5}
      onConfirm={confirm}
    >
      <Field htmlFor="void-reason" label={t('reason')} required>
        <Textarea
          id="void-reason"
          rows={2}
          maxLength={500}
          value={reason}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/**
 * «أمر بالصرف» — the manager orders a request and the money leaves.
 *
 * The wallet and the amount are in the dialog, not only in the row behind it:
 * this is the press that moves money, and what it moves is read back where the
 * finger is. If the wallet has fallen short since the request was filed the
 * server refuses (`TREASURY_INSUFFICIENT_FUNDS`, with the figures), the dialog
 * says so, and the request stays waiting.
 *
 * The manager pressing again after an answer was lost is answered with the
 * voucher his first press paid (`replayed`), and the dialog says that — the
 * number, and that no money left a second time — rather than a fresh success.
 * If that voucher has been cancelled since, the answer is
 * `EXPENSE_ALREADY_VOID` with its number, said as what happened to this request.
 */
export function OrderRequestDialog({
  tenant,
  token,
  locale,
  request,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  request: ExpenseRequestView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.queue');
  const queryClient = useQueryClient();
  const toast = useToast();
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await orderExpenseRequest(tenant, token, { id: request.id });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      if (result.replayed) {
        toast.warning(t('orderDialog.replayed', { number: result.voucherNumber }), {
          description: t('orderDialog.replayedBody'),
        });
      } else {
        toast.success(t('orderDialog.success', { number: result.voucherNumber }), {
          description: t('orderDialog.successBody'),
        });
      }
      onDone();
    } catch (caught) {
      logApiError(caught);
      refreshIfOutOfDate(queryClient, tenant, caught);
      const number =
        caught instanceof ApiRequestError && caught.code === 'EXPENSE_ALREADY_VOID'
          ? caught.payload.params?.voucherNumber
          : undefined;
      // `ConfirmDialog` shows a thrown error's message beside the action.
      throw number ? new Error(t('orderDialog.earlierVoided', { number: String(number) })) : caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('orderDialog.title')}
      description={t('orderDialog.body')}
      confirmLabel={t('orderDialog.confirm')}
      cancelLabel={t('orderDialog.cancel')}
      busyLabel={t('orderDialog.busy')}
      onConfirm={confirm}
    >
      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('fields.wallet')}>{request.account.name}</SummaryRow>
        <SummaryRow label={t('fields.amount')}>
          <TreasuryAmount amount={request.amount} currency={request.currency} locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('fields.payee')}>{request.payee}</SummaryRow>
        <SummaryRow label={t('fields.category')}>{request.category.name}</SummaryRow>
        {request.requestedByName ? (
          <SummaryRow label={t('fields.requestedBy')}>{request.requestedByName}</SummaryRow>
        ) : null}
      </SummaryList>
    </ConfirmDialog>
  );
}

/**
 * «رفض» — the manager declines a request, with the reason its author will read.
 *
 * The reason is required (the schema asks for five characters), and Confirm
 * waits for it rather than refusing afterwards: the only refusals left to show
 * are the server's.
 */
export function RejectRequestDialog({
  tenant,
  token,
  request,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  request: ExpenseRequestView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.queue');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await rejectExpenseRequest(tenant, token, { id: request.id, reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('rejectDialog.success'), { description: t('rejectDialog.successBody') });
      onDone();
    } catch (caught) {
      logApiError(caught);
      refreshIfOutOfDate(queryClient, tenant, caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('rejectDialog.title')}
      description={t('rejectDialog.body')}
      confirmLabel={t('rejectDialog.confirm')}
      cancelLabel={t('rejectDialog.cancel')}
      busyLabel={t('rejectDialog.busy')}
      confirmDisabled={reason.trim().length < 5}
      onConfirm={confirm}
    >
      <Field htmlFor="reject-reason" label={t('rejectDialog.reason')} required>
        <Textarea
          id="reject-reason"
          rows={2}
          maxLength={500}
          value={reason}
          placeholder={t('rejectDialog.reasonPlaceholder')}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/**
 * «سحب الطلب» — its author, or the manager, takes back a request still waiting.
 *
 * Nothing left a wallet, so there is nothing to give back: the copy says the
 * request stays in the register as withdrawn, and that a new one can be filed.
 */
export function WithdrawRequestDialog({
  tenant,
  token,
  locale,
  request,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  request: ExpenseRequestView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.queue');
  const queryClient = useQueryClient();
  const toast = useToast();
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await withdrawExpenseRequest(tenant, token, { id: request.id });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('withdrawDialog.success'));
      onDone();
    } catch (caught) {
      logApiError(caught);
      refreshIfOutOfDate(queryClient, tenant, caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('withdrawDialog.title')}
      description={t('withdrawDialog.body')}
      confirmLabel={t('withdrawDialog.confirm')}
      cancelLabel={t('withdrawDialog.cancel')}
      busyLabel={t('withdrawDialog.busy')}
      onConfirm={confirm}
    >
      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('fields.payee')}>{request.payee}</SummaryRow>
        <SummaryRow label={t('fields.amount')}>
          <TreasuryAmount amount={request.amount} currency={request.currency} locale={locale} />
        </SummaryRow>
      </SummaryList>
    </ConfirmDialog>
  );
}

/**
 * «إصدار أمر الصرف» for an urgent payment already made (art. 35).
 *
 * The money moved when the accountant paid, so this changes no balance — it
 * stamps the manager's order on the voucher, once. The dialog says that, and
 * says what the other answer is: a payment the manager will not order is
 * cancelled, which returns the money.
 */
export function RegularizeExpenseDialog({
  tenant,
  token,
  locale,
  voucher,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  voucher: ExpenseVoucherView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.queue');
  const queryClient = useQueryClient();
  const toast = useToast();
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await regularizeExpense(tenant, token, { id: voucher.id });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('regularizeDialog.success', { number: result.voucherNumber }), {
        description: t('regularizeDialog.successBody'),
      });
      onDone();
    } catch (caught) {
      logApiError(caught);
      refreshIfOutOfDate(queryClient, tenant, caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('regularizeDialog.title', { number: voucher.voucherNumber })}
      description={t('regularizeDialog.body')}
      confirmLabel={t('regularizeDialog.confirm')}
      cancelLabel={t('regularizeDialog.cancel')}
      busyLabel={t('regularizeDialog.busy')}
      onConfirm={confirm}
    >
      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('fields.wallet')}>{voucher.account.name}</SummaryRow>
        <SummaryRow label={t('fields.amount')}>
          <TreasuryAmount amount={voucher.amount} currency={voucher.currency} locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('fields.payee')}>{voucher.payee}</SummaryRow>
        {voucher.recordedByName ? (
          <SummaryRow label={t('fields.recordedBy')}>{voucher.recordedByName}</SummaryRow>
        ) : null}
        {voucher.urgentReason ? (
          <SummaryRow label={t('fields.urgentReason')}>{voucher.urgentReason}</SummaryRow>
        ) : null}
      </SummaryList>
    </ConfirmDialog>
  );
}
