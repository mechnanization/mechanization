'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Zap } from 'lucide-react';
import {
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
import { firstFieldToFix, formCategories, isExpenseField } from '@/lib/expense-form';
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
import type { MovementDraft } from '@/lib/treasury-movements';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { NewCategoryFields } from './new-category-fields';
import { WalletSelect } from './wallet-select';

/**
 * What the form did, for the composer to say next: a voucher was paid, or a
 * request went to the head of the municipality.
 */
export type RecordOutcome =
  | { kind: 'PAID'; result: RecordExpenseResult }
  | { kind: 'REQUESTED'; result: RequestExpenseResult };

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
 */
export function RecordExpenseForm({
  tenant,
  token,
  locale,
  role,
  accounts,
  categories,
  urgentCeilings,
  initial,
  onDraftChange,
  onRecorded,
  onClear,
}: {
  tenant: string;
  token: string;
  locale: string;
  role: string | undefined;
  accounts: TreasuryAccountView[];
  categories: ExpenseCategoryView[];
  /**
   * The manager's urgent-payment ceiling per currency (`LBP`, `USD`), `null`
   * for none; absent while the settings have not been read, when the server's
   * refusal is the only check.
   */
  urgentCeilings?: Partial<Record<string, number | null>>;
  /** What the clerk had typed on the «قبض» side before switching here. */
  initial?: Partial<MovementDraft>;
  /** Fires as the shared fields change, so a switch to «قبض» keeps them. */
  onDraftChange?: (draft: MovementDraft) => void;
  /** The voucher or the request is written; the composer mounts a fresh form for the next one. */
  onRecorded: (outcome: RecordOutcome) => void;
  /** «مسح»: the composer mounts an empty form. */
  onClear: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const queryClient = useQueryClient();

  const today = municipalToday();
  /** What an accountant chose; the manager has nothing to choose (`expenseModeFor`). */
  const [choice, setChoice] = useState<Exclude<ExpenseMode, 'ORDER'>>('REQUEST');
  const mode = expenseModeFor(role, choice);
  const pays = paysNow(mode);

  const carried = initial?.accountId;
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState(
    carried && accounts.some((account) => account.id === carried) ? carried : (accounts[0]?.id ?? ''),
  );
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [payee, setPayee] = useState(initial?.party ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
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

  useEffect(() => {
    onDraftChange?.({ amount, accountId, party: payee, description });
  }, [onDraftChange, amount, accountId, payee, description]);

  /*
    The retry keys (STA-4, `keyIsSpent`), held in `lib/request-id.ts` rather
    than here, so they outlive this form: a background re-read that failed, or
    a switch to «قبض» and back, unmounts it, and a key that died with it paid a
    second time. Kept across every failure and every edit: a refusal proves
    only that this attempt wrote nothing, never that an earlier one with the
    key did not. An edit made after an answer was lost is caught by the server,
    which binds the key to the wallet, the amount, the band, the payee and the
    reason, and refuses it (`TREASURY_REQUEST_KEY_REUSED`) instead of paying a
    second time. A key is spent only when the server says its act exists.

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
  /** A request moves no money, so there is nothing for it to overdraw. */
  const short = pays && Boolean(account) && spending > 0 && (account?.balance ?? 0) - spending < 0;

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

  /*
    Deduplicated by id: a band added here is in `added`, and arrives again from
    the list. Never «تعويضات المسح والجباية», which «صرف عمولة» alone pays.
  */
  const allCategories = useMemo(() => formCategories(categories, added), [categories, added]);

  /** What a failure with nothing better to say reads, for the act this press would be. */
  const failedText = t(mode === 'REQUEST' ? 'errors.requestForm' : 'errors.form');

  /**
   * Re-reads the treasury figures — the balances on the wallets, the register,
   * the queue — but not the band list under the open select: refetching that
   * list while the select is mounted is what dropped its value (see the select
   * below).
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
    let issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> = [];
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
      Above the manager's ceiling the urgent path is closed; the form offers the
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
          It may have been recorded. Re-read, so the balance the wallets show
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
      Recorded. This form stays locked from here — `inFlight` is never released
      and `done` disables the button — and the composer replaces it with a
      fresh one: a second press on this one would be a second act.
    */
    setDone(true);
    setBusy(false);
    // The act is confirmed: the next one in this scope gets a new key.
    spendKey(tenant, scope(mode));
    await refreshFigures();
    /*
      What the server says it recorded, not what this screen meant to ask for
      (STA-6) — said by the composer above the next entry: a request sent or one
      an earlier press had sent (`replayed`), a voucher paid, paid before the
      order (`AWAITING_ORDER`), or paid by an earlier press whose answer was lost.
    */
    if (filed) onRecorded({ kind: 'REQUESTED', result: filed });
    else if (paid) onRecorded({ kind: 'PAID', result: paid });
  };

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
        {mode !== 'ORDER' ? (
          <div className="space-y-2 md:col-span-2 xl:col-span-3">
            {/*
              Two ways for an accountant to press the button, side by side, each
              saying what it does: the request (the default, nothing leaves a
              wallet) or the urgent payment (art. 35). Outlined choices, not a
              second filled switch under «قبض | صرف»: on the page the one accent
              belongs to the direction and the submit. What art. 35 covers
              (salaries, petty expenses, an emergency) is in the urgent card.
            */}
            <div role="radiogroup" aria-label={t('how.aria')} className="grid grid-cols-2 gap-2">
              <ChoiceCard
                name="expense-how"
                value="REQUEST"
                checked={choice === 'REQUEST'}
                onChange={() => choose('REQUEST')}
                title={t('how.request')}
                description={t('how.requestBody')}
                icon={Send}
                className="items-start py-2"
              />
              <ChoiceCard
                name="expense-how"
                value="URGENT"
                checked={choice === 'URGENT'}
                onChange={() => choose('URGENT')}
                title={t('how.urgent')}
                description={t('how.urgentBody')}
                icon={Zap}
                className="items-start py-2"
              />
            </div>

            {ceiling !== null ? (
              <p className="text-xs text-muted-foreground">{t('ceiling.note', { ceiling: ceilingText })}</p>
            ) : null}
          </div>
        ) : null}

        {mode === 'URGENT' ? (
          <Field
            htmlFor="expense-urgent"
            label={t('how.urgentReason')}
            error={errors.urgentReason}
            required
            className="md:col-span-2 xl:col-span-3"
          >
            <Textarea
              id="expense-urgent"
              rows={2}
              maxLength={500}
              className="min-h-20"
              value={urgentReason}
              placeholder={t('how.urgentReasonPlaceholder')}
              onChange={(event) => setUrgentReason(event.target.value)}
            />
          </Field>
        ) : null}

        {/* The figure is the point of the task: typed first, in the heaviest type of the form (PRIM-25). */}
        <div className="space-y-2">
          <Field htmlFor="expense-amount" label={t('amount')} error={errors.amount} required>
            <CurrencyInput
              id="expense-amount"
              unit={account ? currencyUnit(account.currency, locale) : ''}
              value={amount}
              placeholder="0"
              invalid={Boolean(errors.amount) || short || refusesOverCeiling}
              /*
                The height of every other field (40px, 48px on a touch screen); the
                figure in a larger, heavier type. `Input` sets `text-base sm:text-sm`,
                and tailwind-merge keeps a `sm:` class against an unprefixed one: the
                size is given at both breakpoints or it falls back to 14px from 640px.
              */
              inputClassName="text-lg font-semibold sm:text-lg"
              onChange={(value) => setAmount(formatTypedAmount(value, account?.currency === 'LBP' ? 0 : 2))}
            />
          </Field>

          {/*
            Above the ceiling — as typed, or as the server judged it — the way on is
            the request: one press switches to it and keeps what was typed. Under the
            figure it is about, so it is on screen while the figure is typed. Not
            while a lost press may have paid it: then the way on is the same press
            again, which the server answers from its key. Gone once the act is
            recorded: a replay spends the key, and the composer mounts a fresh form.
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
        </div>

        <div className="space-y-2">
          <Field htmlFor="expense-account" label={t('account')} error={errors.accountId} required>
            <WalletSelect
              id="expense-account"
              placeholder={t('accountPlaceholder')}
              accounts={accounts}
              value={accountId}
              onChange={setAccountId}
              // A request moves nothing yet: its wallet shows what it holds, not what it would.
              amount={pays ? spending : 0}
              direction="out"
              locale={locale}
              invalid={Boolean(errors.accountId)}
              disabled={done}
            />
          </Field>
          {mode === 'REQUEST' ? <p className="text-xs text-muted-foreground">{t('requestNote')}</p> : null}
          {short ? (
            <Alert variant="destructive" live="status" title={t('shortTitle')}>
              {t('shortBody')}
            </Alert>
          ) : null}
        </div>

        <div className="space-y-2">
          <Field htmlFor="expense-category" label={t('category')} error={errors.categoryId} required>
            {/*
              Keyed on the number of bands added here, so adding one remounts the
              select. Radix keeps a controlled value that was present when it
              mounted, but discards one set while its list is closed, because the
              item backing it has never registered. That left a freshly created
              band created, listed, and not selected (docs/gotchas.md).
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
        </div>

        <Field htmlFor="expense-payee" label={t('payee')} error={errors.payee} required>
          <Input
            id="expense-payee"
            value={payee}
            maxLength={200}
            placeholder={t('payeePlaceholder')}
            invalid={Boolean(errors.payee)}
            onChange={(event) => setPayee(event.target.value)}
          />
        </Field>

        {addingCategory ? (
          // Across the row, so the new band's own fields have the room.
          <div className="md:col-span-2 xl:col-span-3">
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
          </div>
        ) : null}

        {/* A request has no date and no back-dating: the money leaves on the day of the order. */}
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

        <div className="space-y-3">
          <Field
            htmlFor="expense-invoice"
            label={t('invoiceNumber')}
            error={errors.invoiceNumber}
            optionalLabel={t('optional')}
          >
            <Input
              id="expense-invoice"
              value={invoiceNumber}
              maxLength={100}
              placeholder={t('invoicePlaceholder')}
              onChange={(event) => setInvoiceNumber(event.target.value)}
            />
          </Field>

          <label htmlFor="expense-receipt" className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              id="expense-receipt"
              checked={hasPhysicalReceipt}
              onCheckedChange={(checked) => setHasPhysicalReceipt(checked === true)}
              className="mt-0.5"
            />
            <span>{t('hasPhysicalReceipt')}</span>
          </label>
        </div>

        {backdated ? (
          <Field
            htmlFor="expense-adjustment"
            label={t('adjustmentReason')}
            error={errors.adjustmentReason}
            required
            className="md:col-span-2 xl:col-span-3"
          >
            <Input
              id="expense-adjustment"
              value={adjustmentReason}
              maxLength={500}
              placeholder={t('adjustmentPlaceholder')}
              invalid={Boolean(errors.adjustmentReason)}
              onChange={(event) => setAdjustmentReason(event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          htmlFor="expense-description"
          label={t('reason')}
          error={errors.description}
          required
          className="md:col-span-2 xl:col-span-3"
        >
          <Textarea
            id="expense-description"
            rows={2}
            maxLength={1000}
            className="min-h-20"
            value={description}
            placeholder={t('reasonPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
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
