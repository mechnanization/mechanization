'use client';

import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { HowPaidFields } from './expense-form/how-paid-fields';
import { MoneyFields } from './expense-form/money-fields';
import { useRecordExpense, type RecordExpenseProps } from './expense-form/use-record-expense';
import { VoucherFields } from './expense-form/voucher-fields';

export type { RecordOutcome } from './expense-form/use-record-expense';

/**
 * «صرف» — the whole act of paying, on the recording page «الإيرادات والنفقات».
 *
 * ## Three ways to press the button
 *
 * Money leaves a municipal wallet on the payment order of the head of the
 * municipality (decree 5595/1982, art. 28 and 33), so what the button does
 * depends on who presses it (`ExpenseMode`):
 *
 * - the manager's recording **is** the order, so it pays at once;
 * - the accountant's default is a **request**. Nothing leaves a wallet, so there
 *   is no date (the money leaves on the day of the order) and no overdraft
 *   check — the balance is looked at when the manager orders it, from the
 *   register's queue;
 * - the accountant may instead pay **urgently** (art. 35: salaries, routine
 *   petty expenses, an emergency). It pays at once, says why, and the voucher
 *   waits for the manager's order.
 *
 * ## Why it is a page and not a dialog
 *
 * BAN-10 refuses a modal for a task that needs neither interruption nor
 * protected focus, and this is a nine-field form an accountant works through
 * with an invoice in hand. It is the recording page itself, with an address a
 * clerk can be sent to (`/finance/movements?dir=out`), the browser's back button
 * meaning what it says; the vouchers it joins are on «الحركات المالية». A
 * half-filled form is never one stray click on an overlay away from being lost.
 *
 * ## Why the balance is on the wallet choice
 *
 * The one fact that decides whether to press the button is what the wallet
 * holds. A municipal safe runs out, and the server refuses an overdraw — so each
 * wallet in the dropdown shows its balance, the line under it what the chosen
 * one will hold once paid, and it says «لا يكفي» the moment the remainder would
 * go below zero (`WalletSelect`).
 * That holds for a payment only; a request does not move money, and its wallets
 * show their balance alone. The server is still the authority: it recomputes
 * this under a row lock (FRM-4).
 *
 * ## Why a category can be created here
 *
 * An accountant who cannot find the right بند either files the expense under
 * «نفقات متفرقة» — which makes «قطع الحساب» useless — or leaves to go and add
 * one. The manager adds it inline instead, and the half-filled voucher stays
 * exactly as it is. Manager only, as docs/finance.md §9 sets out, and
 * `ExpensesController` enforces the same.
 *
 * ## The urgent-payment ceiling
 *
 * The manager may cap what an accountant pays on the urgent path, per voucher
 * and per currency (decision D6, docs/finance.md §5.1). When the chosen
 * wallet's currency has one, the urgent path says it, and an amount above it is
 * refused here with the way out — send it as a request — before the round
 * trip. The server is the authority (`EXPENSE_URGENT_OVER_CEILING`): this
 * screen read the ceiling when it opened, and the manager may have changed it.
 * After a press whose answer was lost (`heldInDoubt`) the ceiling is a warning
 * only: that press may have paid, a retry with its key is answered before the
 * ceiling is judged, and «send it as a request» would be a new act under a new
 * key. The request is offered again once the server itself refuses the retry.
 *
 * Recording is paying, so this form is the whole act: a second submission is
 * guarded by an in-flight ref *and* a retry key the server honours (STA-4),
 * because on a slow counter connection a clerk cannot tell a slow response from
 * a lost one. The key follows `keyIsSpent` (`lib/request-id.ts`). Once the
 * server has answered with a 2xx the form stays locked, and the composer
 * replaces it with a fresh one for the next voucher.
 *
 * ## Where each part is
 *
 * `useRecordExpense` holds the state and the press; the fields are
 * `HowPaidFields`, `MoneyFields` and `VoucherFields`, all in `expense-form/`.
 * This component lays them in one grid, under it what went wrong and the
 * actions.
 */
export function RecordExpenseForm({
  onClear,
  ...props
}: RecordExpenseProps & {
  /** «مسح»: the composer mounts an empty form. */
  onClear: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const form = useRecordExpense(props);
  const { mode, formError, busy, done, submit } = form;
  const { tenant, token, locale, accounts } = props;

  const submitLabel =
    mode === 'ORDER' ? t('submit') : mode === 'URGENT' ? t('submitUrgent') : t('submitRequest');

  return (
    <form noValidate className="space-y-5" onSubmit={submit}>
      {/*
        Two columns from `md` and three from `xl`, where the recording page is the
        full width, in the order the voucher is read, the income form's twin
        (UX-1): how it is paid (an accountant), the figure, the wallet it leaves and
        what it was, then who was paid, the day and the invoice, then the reason
        across the row. The whole voucher fits one screen of the
        recording page, its submit under it.
      */}
      <div className="grid gap-x-4 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        <HowPaidFields form={form} />
        <MoneyFields form={form} accounts={accounts} locale={locale} />
        <VoucherFields form={form} tenant={tenant} token={token} locale={locale} />
      </div>

      {mode === 'URGENT' ? <p className="text-xs text-muted-foreground">{t('urgentNote')}</p> : null}

      {formError ? (
        <Alert variant="destructive" live="alert">
          {formError}
        </Alert>
      ) : null}

      {/*
        The actions stay on screen at the foot of the card while the page scrolls
        the fields under them (`sticky`), and above a phone's home indicator. The
        negative margins reach the card's own padding (`p-4 sm:p-6`).
      */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex gap-2 rounded-b-lg border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
        <Button type="submit" className="flex-1" disabled={busy || done}>
          {busy ? (mode === 'REQUEST' ? t('sending') : t('saving')) : submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClear}>
          {t('clear')}
        </Button>
      </div>
    </form>
  );
}
