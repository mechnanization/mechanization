'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Zap } from 'lucide-react';
import {
  getLabels,
  recordExpenseSchema,
  requestExpenseSchema,
  municipalToday,
  TREASURY_ADMIN_ROLES,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  recordExpense,
  requestExpense,
  logApiError,
  type ExpenseCategoryView,
  type RecordExpenseInput,
  type RecordExpenseResult,
  type RequestExpenseInput,
  type RequestExpenseResult,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { currencyUnit, formatMoney, formatTypedAmount, parseAmount } from '@/lib/currency';
import { firstFieldToFix, isExpenseField } from '@/lib/expense-form';
import { expenseModeFor, paysNow, type ExpenseMode } from '@/lib/expense-order';
import {
  heldInDoubt,
  heldKey,
  keyIsSpent,
  markInDoubt,
  outcomeInDoubt,
  spendKey,
  type KeyScope,
} from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { NewCategoryFields } from './new-category-fields';
import { TreasuryAmount } from './treasury-amount';

/**
 * A heading over a group of fields.
 *
 * Not a card: the page already frames the form, and a card inside it is the
 * nested frame BAN-4 refuses. No letter-spacing either — Arabic headings do not
 * take tracking (TYP-5).
 */
function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="border-b pb-1.5 text-xs font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/**
 * What the form did, for the page to decide where to go next: the register
 * after a payment, the queue after a request.
 */
export type RecordOutcome = 'PAID' | 'REQUESTED';

/**
 * «سجّل نفقة» — the whole act of paying, as a form on its own page.
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
 * ## Why a page and not the dialog this replaces
 *
 * BAN-10 refuses a modal for a task that needs neither interruption nor
 * protected focus, and this is a nine-field form an accountant works through
 * with an invoice in hand: it is read, cross-checked and corrected, not dashed
 * off. A route also gives it an address — a clerk can be sent «افتح صفحة تسجيل
 * نفقة», the browser's back button means what it says, and a half-filled form is
 * no longer one stray click on an overlay away from being lost.
 *
 * ## Why the balance is the loudest thing on it
 *
 * The one fact that decides whether to press the button is what the wallet
 * holds. A municipal safe runs out, and the server refuses an overdraw — so the
 * summary answers «هل يكفي؟» while the amount is being typed rather than after
 * the submit, and turns red the moment the remainder would go below zero. That
 * holds for a payment only; a request does not move money. The server is still
 * the authority: it recomputes this under a row lock (FRM-4).
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
 * a lost one. The key follows `keyIsSpent` (`lib/request-id.ts`), and once the
 * server has answered with a 2xx the form stays locked until the page moves on.
 */
export function RecordExpenseForm({
  tenant,
  token,
  locale,
  role,
  backHref,
  accounts,
  categories,
  urgentCeilings,
  onRecorded,
}: {
  tenant: string;
  token: string;
  locale: string;
  role: string | undefined;
  /** Where «إلغاء» goes. */
  backHref: string;
  accounts: TreasuryAccountView[];
  categories: ExpenseCategoryView[];
  /**
   * The manager's urgent-payment ceiling per currency (`LBP`, `USD`), `null`
   * for none; absent while the settings have not been read, when the server's
   * refusal is the only check.
   */
  urgentCeilings?: Partial<Record<string, number | null>>;
  /** The voucher or the request is written; the page decides where to go. */
  onRecorded: (outcome: RecordOutcome) => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();

  const today = municipalToday();
  /** What an accountant chose; the manager has nothing to choose (`expenseModeFor`). */
  const [choice, setChoice] = useState<Exclude<ExpenseMode, 'ORDER'>>('REQUEST');
  const mode = expenseModeFor(role, choice);
  const pays = paysNow(mode);

  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [description, setDescription] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [urgentReason, setUrgentReason] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [hasPhysicalReceipt, setHasPhysicalReceipt] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** The server refused the urgent payment as above the ceiling: offer the request instead. */
  const [refusedOverCeiling, setRefusedOverCeiling] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the act is recorded, and the form stays locked. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  /*
    The retry keys (STA-4, `keyIsSpent`), held in `lib/request-id.ts` rather
    than here, so they outlive this form: a background re-read that failed, or
    a trip to the register and back, unmounts it, and a key that died with it
    paid a second time. Kept across every failure and every edit: a refusal
    proves only that this attempt wrote nothing, never that an earlier one with
    the key did not. An edit made after an answer was lost is caught by the
    server, which binds the key to the wallet, the amount, the band, the payee
    and the reason, and refuses it (`TREASURY_REQUEST_KEY_REUSED`) instead of
    paying a second time. A key is spent only when the server says its act
    exists.

    One scope per route, because they are two acts: a request is filed, a
    payment is made, and a retry of the one must never be answered as the other.
  */
  const scope = (forMode: ExpenseMode): KeyScope => (forMode === 'REQUEST' ? 'expense:request' : 'expense:pay');

  /** Bands added without leaving the form, so the select shows them at once. */
  const [added, setAdded] = useState<ExpenseCategoryView[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const canManageCategories = hasRole(TREASURY_ADMIN_ROLES, role);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const backdated = pays && paidOn < today;

  const typed = parseAmount(amount);
  const spending = Number.isFinite(typed) && typed > 0 ? typed : 0;
  const remaining = account ? account.balance - spending : 0;
  /** A request moves no money, so there is nothing for it to overdraw. */
  const short = pays && Boolean(account) && spending > 0 && remaining < 0;

  /**
   * The ceiling that holds this voucher: the urgent path only, in the wallet's
   * currency. Equal to it is under it, as the server judges (`urgentCeilingBreached`).
   */
  const ceiling = mode === 'URGENT' && account ? (urgentCeilings?.[account.currency] ?? null) : null;
  const overCeiling = ceiling !== null && spending > ceiling;
  /**
   * An urgent press under the held payment key got no answer: the ceiling as
   * this screen read it may not refuse the retry. Read on each render; every
   * press that changes it also sets state.
   */
  const retrying = mode === 'URGENT' && heldInDoubt(tenant, scope(mode));
  const refusesOverCeiling = overCeiling && !retrying;
  const ceilingText = ceiling !== null && account ? formatMoney(ceiling, account.currency, locale) : '';

  /* Deduplicated by id: a band added here is in `added`, and arrives again from the list. */
  const allCategories = useMemo(() => {
    const byId = new Map<string, ExpenseCategoryView>();
    for (const category of categories) if (category.active) byId.set(category.id, category);
    for (const category of added) byId.set(category.id, category);
    return [...byId.values()];
  }, [categories, added]);

  const accountOptions = useMemo(
    () =>
      accounts.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.name} · ${labels.treasuryAccountType[candidate.type]}`,
      })),
    [accounts, labels],
  );

  /** What a failure with nothing better to say reads, for the act this press would be. */
  const failedText = t(mode === 'REQUEST' ? 'errors.requestForm' : 'errors.form');

  /**
   * Re-reads the treasury figures — the balance the summary checks the amount
   * against, the register, the queue — but not the band list under the open
   * select: refetching that list while the select is mounted is what dropped
   * its value (see the select below).
   */
  const refreshFigures = (): Promise<void> =>
    queryClient.invalidateQueries({
      queryKey: ['treasury', tenant],
      predicate: (query) => query.queryKey[2] !== 'expense-categories',
    });

  /**
   * The words for a failed press. Already the localised text for the code
   * (TXT-6), except where this form knows more than the code does: an earlier
   * press from this form that was recorded and then cancelled is answered with
   * `EXPENSE_ALREADY_VOID`, which on its own reads as a refusal to cancel.
   */
  const failureText = (error: unknown): string => {
    if (error instanceof ApiRequestError && error.code === 'EXPENSE_ALREADY_VOID') {
      const number = error.payload.params?.voucherNumber;
      if (number) return t('errors.earlierVoided', { number: String(number) });
    }
    /*
      The ceiling the server judged by — it may be newer than the one this
      screen read — written with the currency's own unit rather than its code.
    */
    if (error instanceof ApiRequestError && error.code === 'EXPENSE_URGENT_OVER_CEILING') {
      const { ceiling: limit, currency } = error.payload.params ?? {};
      if (typeof limit === 'number' && typeof currency === 'string') {
        return t('ceiling.refused', { ceiling: formatMoney(limit, currency, locale) });
      }
    }
    return error instanceof Error && error.message ? error.message : failedText;
  };

  /** Switching how it is paid keeps everything typed and drops only the complaints about the old way. */
  const choose = (next: Exclude<ExpenseMode, 'ORDER'>): void => {
    setChoice(next);
    setErrors({});
    setFormError(null);
    setRefusedOverCeiling(false);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || done) return;

    const shared = {
      categoryId,
      accountId,
      amount: parseAmount(amount),
      payee,
      description,
      invoiceNumber: invoiceNumber.trim() || undefined,
      hasPhysicalReceipt,
    };
    /*
      The shared schema is the contract, and its messages are Arabic by
      design, so only the field names come from it and the words from this
      screen's own messages (TXT-1).
    */
    let request: RequestExpenseInput | null = null;
    let payment: RecordExpenseInput | null = null;
    let issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }> = [];
    if (mode === 'REQUEST') {
      const parsed = requestExpenseSchema.safeParse({ ...shared, clientRequestId: heldKey(tenant, scope('REQUEST')) });
      if (parsed.success) request = parsed.data;
      else issues = parsed.error.issues;
    } else {
      const parsed = recordExpenseSchema.safeParse({
        ...shared,
        paidOn,
        adjustmentReason: adjustmentReason.trim() || undefined,
        // The manager's recording is the order; only an accountant paying first says why.
        urgentReason: mode === 'URGENT' ? urgentReason : undefined,
        clientRequestId: heldKey(tenant, scope(mode)),
      });
      if (parsed.success) payment = parsed.data;
      else issues = parsed.error.issues;
    }

    if (!request && !payment) {
      const next: Record<string, string> = {};
      for (const issue of issues) {
        const field = String(issue.path[0] ?? '');
        if (isExpenseField(field) && !next[field]) next[field] = t(`errors.${field}`);
      }
      setErrors(next);
      // An issue on nothing the officer can edit would otherwise fail without a word.
      setFormError(Object.keys(next).length === 0 ? failedText : null);
      // Put the officer on the first thing to fix rather than leaving them to hunt (FRM-2).
      const target = firstFieldToFix(next);
      if (target) document.getElementById(target)?.focus();
      return;
    }
    // The server asks for a reason on any back-dated voucher; say so before the round trip.
    if (backdated && !adjustmentReason.trim()) {
      setErrors({ adjustmentReason: t('errors.adjustmentReason') });
      document.getElementById('expense-adjustment')?.focus();
      return;
    }
    /*
      Above the manager's ceiling the urgent path is closed; the panel offers the
      request instead. Not for the retry of a lost press: the server answers that.
    */
    if (refusesOverCeiling) {
      setErrors({ amount: t('ceiling.overField', { ceiling: ceilingText }) });
      document.getElementById('expense-amount')?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    setRefusedOverCeiling(false);
    inFlight.current = true;
    setBusy(true);
    let filed: RequestExpenseResult | null = null;
    let paid: RecordExpenseResult | null = null;
    try {
      if (request) filed = await requestExpense(tenant, token, request);
      else if (payment) paid = await recordExpense(tenant, token, payment);
    } catch (error) {
      logApiError(error);
      setFormError(failureText(error));
      setRefusedOverCeiling(error instanceof ApiRequestError && error.code === 'EXPENSE_URGENT_OVER_CEILING');
      if (keyIsSpent(error)) {
        // That act exists: the next press is a new one, and the register on screen is behind it.
        spendKey(tenant, scope(mode));
        void refreshFigures();
      } else if (outcomeInDoubt(error)) {
        /*
          It may have been recorded. Re-read, so the balance the summary checks
          is not the one from before the lost answer; the key is kept, so a
          retry of the same act is answered from it rather than paid again.
          Marked in doubt, so a ceiling lowered since does not refuse that retry.
        */
        markInDoubt(tenant, scope(mode));
        void refreshFigures();
      }
      // A failed attempt releases the button; a recorded one never does.
      inFlight.current = false;
      setBusy(false);
      return;
    }

    /*
      Recorded. The form stays locked from here — `inFlight` is never released
      and `done` disables the button — until the page moves on: a page stays
      mounted until the next route is ready, and a second press here would be
      a second act.
    */
    setDone(true);
    setBusy(false);
    // The act is confirmed: the next one in this scope gets a new key.
    spendKey(tenant, scope(mode));
    await refreshFigures();
    if (filed) {
      if (filed.replayed) {
        // An earlier press filed it and its answer was lost: that request stands, as it was first sent.
        toast.warning(t('requestReplayed'), { description: t('requestReplayedBody') });
      } else {
        toast.success(t('requestSent'), { description: t('requestSentBody') });
      }
      onRecorded('REQUESTED');
    } else if (paid) {
      // What the server says it recorded, not what this screen meant to ask for.
      if (paid.replayed) {
        toast.warning(t('replayed', { number: paid.voucherNumber }), { description: t('replayedBody') });
      } else if (paid.orderStatus === 'AWAITING_ORDER') {
        toast.success(t('urgentSuccess', { number: paid.voucherNumber }), {
          description: t('urgentSuccessBody'),
        });
      } else {
        toast.success(t('success', { number: paid.voucherNumber }), { description: t('successBody') });
      }
      onRecorded('PAID');
    }
  };

  const submitLabel =
    mode === 'ORDER' ? t('submit') : mode === 'URGENT' ? t('submitUrgent') : t('submitRequest');

  return (
    <form
      noValidate
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      onSubmit={submit}
    >
      <div className="space-y-6">
        {mode !== 'ORDER' ? (
          <FormSection title={t('sections.how')}>
            <div role="radiogroup" aria-label={t('how.aria')} className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard
                name="expense-how"
                value="REQUEST"
                checked={choice === 'REQUEST'}
                onChange={() => choose('REQUEST')}
                title={t('how.request')}
                description={t('how.requestBody')}
                icon={Send}
              />
              <ChoiceCard
                name="expense-how"
                value="URGENT"
                checked={choice === 'URGENT'}
                onChange={() => choose('URGENT')}
                title={t('how.urgent')}
                description={t('how.urgentBody')}
                icon={Zap}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('how.rule')}</p>

            {mode === 'URGENT' ? (
              <Field htmlFor="expense-urgent" label={t('how.urgentReason')} error={errors.urgentReason} required>
                <Textarea
                  id="expense-urgent"
                  rows={2}
                  maxLength={500}
                  value={urgentReason}
                  placeholder={t('how.urgentReasonPlaceholder')}
                  onChange={(event) => setUrgentReason(event.target.value)}
                />
              </Field>
            ) : null}

            {ceiling !== null ? (
              <p className="text-xs text-muted-foreground">{t('ceiling.note', { ceiling: ceilingText })}</p>
            ) : null}
          </FormSection>
        ) : null}

        <FormSection title={t('sections.money')}>
          <Field htmlFor="expense-account" label={t('account')} error={errors.accountId} required>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="expense-account">
                <SelectValue placeholder={t('accountPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {accountOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field htmlFor="expense-amount" label={t('amount')} error={errors.amount} required>
            <CurrencyInput
              id="expense-amount"
              unit={account ? currencyUnit(account.currency, locale) : ''}
              value={amount}
              placeholder="0"
              invalid={Boolean(errors.amount) || short}
              onChange={(value) => setAmount(formatTypedAmount(value, account?.currency === 'LBP' ? 0 : 2))}
            />
          </Field>
        </FormSection>

        <FormSection title={t('sections.what')}>
          <Field htmlFor="expense-category" label={t('category')} error={errors.categoryId} required>
            {/*
              Keyed on the number of bands added here, so adding one remounts the
              select. Radix keeps a controlled value that was present when it
              mounted — the account select above proves it — but discards one set
              while its list is closed, because the item backing it has never
              registered. That left a freshly created band created, listed, and not
              selected (docs/gotchas.md).
            */}
            <Select key={added.length} value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="expense-category">
                <SelectValue placeholder={t('categoryPlaceholder')}>
                  {allCategories.find((category) => category.id === categoryId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {allCategories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {canManageCategories && !addingCategory ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs"
              disabled={done}
              onClick={() => setAddingCategory(true)}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('newCategory')}
            </Button>
          ) : null}

          {addingCategory ? (
            <NewCategoryFields
              tenant={tenant}
              token={token}
              existing={allCategories}
              onCancel={() => setAddingCategory(false)}
              onCreated={(category) => {
                /*
                  No refetch while this form is open: reloading the categories
                  query rebuilt the option list under the select, and Radix
                  answered the churn with an empty selection. The new band is
                  already in hand, and `NewCategoryFields` has written it into
                  the cached list, so the register's filter and the next form
                  have it without a read.
                */
                setAdded((current) => [...current, category]);
                setCategoryId(category.id);
                setAddingCategory(false);
              }}
            />
          ) : null}

          <Field htmlFor="expense-payee" label={t('payee')} error={errors.payee} required>
            <Input
              id="expense-payee"
              value={payee}
              placeholder={t('payeePlaceholder')}
              invalid={Boolean(errors.payee)}
              onChange={(event) => setPayee(event.target.value)}
            />
          </Field>

          <Field htmlFor="expense-description" label={t('reason')} error={errors.description} required>
            <Textarea
              id="expense-description"
              rows={2}
              maxLength={1000}
              value={description}
              placeholder={t('reasonPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </FormSection>

        {/* A request has no date and no back-dating: the money leaves on the day of the order. */}
        <FormSection title={pays ? t('sections.paperwork') : t('sections.documents')}>
          <div className={cn('grid gap-4', pays && 'sm:grid-cols-2')}>
            {pays ? (
              <Field htmlFor="expense-date" label={t('paidOn')} error={errors.paidOn} required>
                <DatePicker
                  id="expense-date"
                  value={paidOn}
                  max={today}
                  locale={locale === 'en' ? 'en' : 'ar'}
                  onChange={(value) => setPaidOn(value || today)}
                />
              </Field>
            ) : null}

            <Field
              htmlFor="expense-invoice"
              label={t('invoiceNumber')}
              error={errors.invoiceNumber}
              optionalLabel={t('optional')}
            >
              <Input
                id="expense-invoice"
                value={invoiceNumber}
                placeholder={t('invoicePlaceholder')}
                onChange={(event) => setInvoiceNumber(event.target.value)}
              />
            </Field>
          </div>

          {backdated ? (
            <Field htmlFor="expense-adjustment" label={t('adjustmentReason')} error={errors.adjustmentReason} required>
              <Input
                id="expense-adjustment"
                value={adjustmentReason}
                placeholder={t('adjustmentPlaceholder')}
                invalid={Boolean(errors.adjustmentReason)}
                onChange={(event) => setAdjustmentReason(event.target.value)}
              />
            </Field>
          ) : null}

          <label htmlFor="expense-receipt" className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              id="expense-receipt"
              checked={hasPhysicalReceipt}
              onCheckedChange={(checked) => setHasPhysicalReceipt(checked === true)}
              className="mt-0.5"
            />
            <span>{t('hasPhysicalReceipt')}</span>
          </label>
        </FormSection>

        {formError ? (
          <Alert variant="destructive" live="alert">
            {formError}
          </Alert>
        ) : null}
      </div>

      {/*
        The summary: as tall as the screen, and it stays there while the fields
        scroll past.

        Sized to the viewport rather than to the row, because those are different
        heights and only one of them can be stuck. `items-start` on the grid keeps
        the row from stretching it — a panel stretched to the full row has nowhere
        to travel and `sticky` does nothing — and the explicit height then fills
        the screen instead.

        The two numbers come from the shell, not from taste. The page does not
        scroll the window: `AdminShell` is `h-[100dvh] overflow-hidden` and the
        content sits in an inner `overflow-y-auto` pane, which is what `sticky`
        measures against. That pane starts below the `h-14` header, so the
        viewport left for it is `100dvh - 3.5rem`, and `top-6` plus a matching
        `6` of air at the foot is the page's own `py-6` — hence
        `100dvh - 6.5rem`. Measured first: at 900px the pane is 844 and the panel
        796, so it has somewhere to stick. An earlier version used `top-16` and
        `100dvh - 5.5rem`, which wanted 876px of an 844px pane and therefore
        scrolled away instead of sticking. `100dvh`, not `100vh`, so a phone's
        collapsing address bar does not make it taller than the screen.

        The actions sit at its foot through `mt-auto`, which on a viewport-tall
        panel means the submit button is on screen the whole way down the form.
        The body scrolls inside the panel when the figures and a warning outgrow it.

        Below `lg` none of this applies: the panel falls under the fields, at its
        natural height, directly above the button it qualifies.
      */}
      <aside className="lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]">
        <Card className={cn('flex h-full flex-col', short && 'border-destructive/30')}>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold">{pays ? t('summaryTitle') : t('summaryRequestTitle')}</h2>
            {account ? (
              <SummaryList>
                <SummaryRow label={t('summaryAccount')}>{account.name}</SummaryRow>
                <SummaryRow label={t('balanceNow')}>
                  <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryAmount')}>
                  <TreasuryAmount amount={spending} currency={account.currency} locale={locale} />
                </SummaryRow>
                {pays ? (
                  <SummaryRow label={t('balanceAfter')} className={cn(short && 'text-destructive')}>
                    <TreasuryAmount amount={remaining} currency={account.currency} locale={locale} />
                  </SummaryRow>
                ) : null}
              </SummaryList>
            ) : (
              <p className="text-sm text-muted-foreground">{t('summaryEmpty')}</p>
            )}

            {mode === 'REQUEST' ? <p className="text-xs text-muted-foreground">{t('requestNote')}</p> : null}
            {mode === 'URGENT' ? <p className="text-xs text-muted-foreground">{t('urgentNote')}</p> : null}

            {short ? (
              <Alert variant="destructive" live="status" title={t('shortTitle')}>
                {t('shortBody')}
              </Alert>
            ) : null}

            {/*
              Above the ceiling — as typed, or as the server judged it — the way
              on is the request: one press switches to it and keeps what was typed.
              Not while a lost press may have paid it: then the way on is the
              same press again, which the server answers from its key. Gone once
              the act is recorded: a replay spends the key, and the page moves on.
            */}
            {done ? null : overCeiling && retrying && !refusedOverCeiling ? (
              <Alert variant="warning" live="status" title={t('ceiling.overTitle')}>
                {t('ceiling.inDoubtBody', { ceiling: ceilingText })}
              </Alert>
            ) : (overCeiling || refusedOverCeiling) && mode === 'URGENT' ? (
              <Alert variant="warning" live="status" title={t('ceiling.overTitle')}>
                <div className="space-y-2">
                  <p>{overCeiling ? t('ceiling.overBody', { ceiling: ceilingText }) : t('ceiling.refusedBody')}</p>
                  <Button type="button" size="sm" variant="outline" disabled={done} onClick={() => choose('REQUEST')}>
                    <Send className="size-4" aria-hidden />
                    {t('ceiling.sendAsRequest')}
                  </Button>
                </div>
              </Alert>
            ) : null}

            {/* `mt-auto` pushes the actions to the foot of a panel taller than its content. */}
            <div className="mt-auto flex flex-col gap-2 pt-2">
              <Button type="submit" disabled={busy || done}>
                {busy ? (mode === 'REQUEST' ? t('sending') : t('saving')) : submitLabel}
              </Button>
              <Button asChild type="button" variant="outline" disabled={busy}>
                <Link href={backHref}>{t('cancel')}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </aside>
    </form>
  );
}
