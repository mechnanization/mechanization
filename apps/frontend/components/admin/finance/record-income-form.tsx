'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  canReceiveIncome,
  municipalToday,
  recordIncomeVoucherSchema,
  TREASURY_ADMIN_ROLES,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  recordIncomeVoucher,
  logApiError,
  type IncomeCategoryView,
  type RecordIncomeVoucherResult,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { incomeCategoryLabel } from '@/lib/income-category-label';
import { heldKey, keyIsSpent, outcomeInDoubt, spendKey, type KeyScope } from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import type { MovementDraft } from '@/lib/treasury-movements';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { IncomeCategoryEditor } from './income-category-editor';
import { WalletSelect } from './wallet-select';

/**
 * The one scope the income form's key is held under (`heldKey`): there is one
 * act to record from it, and the key outlives the form — a failed re-read, a
 * switch to «صرف» and back — until the server confirms the voucher.
 */
const KEY_SCOPE: KeyScope = 'income:new';

/**
 * «قبض» — the whole act of receiving, on the recording page «الإيرادات والنفقات».
 *
 * The expense form's twin (`RecordExpenseForm`), run the other way and laid out
 * the same so an accountant who knows one knows the other (UX-1): the amount
 * first, then the wallet it arrived in (`WalletSelect`: each option with what it
 * holds, and under it what the chosen one will hold once this is recorded), then
 * what it was, on which day, who paid it and the cheque or transfer number.
 * Receiving only ever raises a balance, so nothing here can be short.
 *
 * Only wallets that may receive income are offered (`canReceiveIncome`): the
 * cash safes, Whish and a bank account, never a collector's custody. The server
 * refuses the rest regardless.
 *
 * The manager can add a missing category without leaving: «بند جديد» opens the
 * same editor the «بنود الإيرادات» page uses, inline, and selects what it
 * creates. Otherwise the choice is between filing the Fund's transfer under
 * «إيرادات متفرقة», which makes the register useless for the question it is
 * opened with, and abandoning a half-filled voucher.
 *
 * Recording is receiving, so a second submission is guarded by an in-flight ref
 * *and* a retry key the server honours (STA-4): on a slow connection a clerk
 * cannot tell a slow response from a lost one, and a double press must not
 * credit the Fund's transfer twice. The key follows the expense form's policy
 * (`keyIsSpent`, `lib/request-id.ts`): held outside the form under
 * `income:new`, kept across every failure and edit, spent on a 2xx or when the
 * server says the act exists. Once the server has answered with a 2xx the form
 * stays locked until the composer mounts a fresh one for the next voucher.
 */
export function RecordIncomeForm({
  tenant,
  token,
  locale,
  role,
  accounts,
  categories,
  initial,
  onDraftChange,
  onRecorded,
  onClear,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** Decides whether «بند جديد» is offered: the manager's alone (docs/finance.md §4.3). */
  role: string | undefined;
  accounts: TreasuryAccountView[];
  /** Every category the register knows; the form offers the active ones. */
  categories: IncomeCategoryView[];
  /** What the clerk had typed on the «صرف» side before switching here. */
  initial?: Partial<MovementDraft>;
  /** Fires as the shared fields change, so a switch to «صرف» keeps them. */
  onDraftChange?: (draft: MovementDraft) => void;
  /**
   * The voucher is written — or an earlier press had written it (`replayed`).
   * The composer says which, above a fresh form for the next one, with the
   * voucher's print one press away.
   */
  onRecorded: (result: RecordIncomeVoucherResult) => void;
  /** «مسح»: the composer mounts an empty form. */
  onClear: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.income.form');
  const queryClient = useQueryClient();

  const receiving = useMemo(
    () => accounts.filter((account) => account.active && canReceiveIncome(account.type)),
    [accounts],
  );

  /** Categories added without leaving the form, so the select shows them at once. */
  const [added, setAdded] = useState<IncomeCategoryView[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const canManageCategories = hasRole(TREASURY_ADMIN_ROLES, role);

  /* Deduplicated by id: a category added here is in `added`, and arrives again from the list. */
  const activeCategories = useMemo(() => {
    const byId = new Map<string, IncomeCategoryView>();
    for (const category of categories) if (category.active) byId.set(category.id, category);
    for (const category of added) byId.set(category.id, category);
    return [...byId.values()];
  }, [categories, added]);

  const today = municipalToday();
  /* A wallet carried over from «صرف» only when it can receive: petty cash cannot. */
  const carried = initial?.accountId;
  const [accountId, setAccountId] = useState(
    carried && receiving.some((account) => account.id === carried) ? carried : (receiving[0]?.id ?? ''),
  );
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [payerName, setPayerName] = useState(initial?.party ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [externalReference, setExternalReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [adjustmentReason, setAdjustmentReason] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the act is recorded, and the form stays locked. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    onDraftChange?.({ amount, accountId, party: payerName, description });
  }, [onDraftChange, amount, accountId, payerName, description]);

  const account = receiving.find((candidate) => candidate.id === accountId);
  const backdated = receivedOn < today;

  const typed = parseAmount(amount);
  const receivingAmount = Number.isFinite(typed) && typed > 0 ? typed : 0;

  /**
   * Re-reads the treasury figures — the balances on the wallets, the register —
   * but not the category list under the open select: refetching a list while
   * its select is mounted is what dropped the expense form's value.
   */
  const refreshFigures = (): Promise<void> =>
    queryClient.invalidateQueries({
      queryKey: ['treasury', tenant],
      predicate: (query) => query.queryKey[2] !== 'income-categories',
    });

  /**
   * The words for a failed press: the localised text for the code (TXT-6),
   * except where this form knows more than the code does — a cancelled earlier
   * press from this form, after which the next press records a new voucher.
   */
  const failureText = (error: unknown): string => {
    if (error instanceof ApiRequestError && error.code === 'INCOME_ALREADY_VOID') {
      const number = error.payload.params?.voucherNumber;
      if (number) return t('errors.earlierVoided', { number: String(number) });
    }
    return error instanceof Error && error.message ? error.message : t('errors.form');
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || done) return;

    const parsed = recordIncomeVoucherSchema.safeParse({
      categoryId,
      accountId,
      amount: parseAmount(amount),
      payerName: payerName.trim() || undefined,
      description,
      externalReference: externalReference.trim() || undefined,
      receivedOn,
      adjustmentReason: adjustmentReason.trim() || undefined,
      clientRequestId: heldKey(tenant, KEY_SCOPE),
    });

    if (!parsed.success) {
      /*
        The shared schema is the contract, and its messages are Arabic by
        design, so only the field names come from it and the words from this
        screen's own messages (TXT-1).
      */
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        if (!next[field]) next[field] = t.has(`errors.${field}`) ? t(`errors.${field}`) : t('errors.form');
      }
      setErrors(next);
      setFormError(null);
      // Put the clerk on the first thing to fix rather than leaving them to hunt (FRM-2).
      document.getElementById(`income-${firstFieldId(next)}`)?.focus();
      return;
    }
    // The server asks for a reason on any back-dated voucher; say so before the round trip.
    if (backdated && !adjustmentReason.trim()) {
      setErrors({ adjustmentReason: t('errors.adjustmentReason') });
      document.getElementById('income-adjustment')?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    let result: RecordIncomeVoucherResult;
    try {
      result = await recordIncomeVoucher(tenant, token, parsed.data);
    } catch (error) {
      logApiError(error);
      setFormError(failureText(error));
      if (keyIsSpent(error)) {
        // That act exists: the next press is a new one, and the figures on screen are behind it.
        spendKey(tenant, KEY_SCOPE);
        void refreshFigures();
      } else if (outcomeInDoubt(error)) {
        /*
          It may have been recorded. Re-read, so the balance on screen is not
          the one from before the lost answer; the key is kept, so a retry of
          the same voucher is answered from it rather than recorded again.
        */
        void refreshFigures();
      }
      // A failed attempt releases the button; a recorded one never does.
      inFlight.current = false;
      setBusy(false);
      return;
    }

    /*
      Recorded. This form stays locked from here — `inFlight` is never released
      and `done` disables the button — and the composer replaces it with a fresh
      one: a second press on this one would be a second act.
    */
    setDone(true);
    setBusy(false);
    spendKey(tenant, KEY_SCOPE);
    await refreshFigures();
    // What the server recorded (STA-6), said by the composer above the next entry — a replay included.
    onRecorded(result);
  };

  if (receiving.length === 0) {
    return (
      <Alert variant="warning" title={t('title')}>
        {t('noAccounts')}
      </Alert>
    );
  }

  return (
    <form noValidate className="space-y-5" onSubmit={submit}>
      {/*
        Two columns from `md` and three from `xl`, where the recording page is the
        full width, in the order the voucher is read: the figure, where it arrived
        and what it was, then the day, who paid and the paper that came with it,
        then the wording across the row. The whole voucher fits
        one screen of the recording page, its submit under it.
      */}
      <div className="grid gap-x-4 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        {/* The figure is the point of the task: typed first, in the heaviest type of the form (PRIM-25). */}
        <Field htmlFor="income-amount" label={t('amount')} error={errors.amount} required>
          <CurrencyInput
            id="income-amount"
            unit={account ? currencyUnit(account.currency, locale) : ''}
            value={amount}
            placeholder="0"
            invalid={Boolean(errors.amount)}
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

        <Field htmlFor="income-account" label={t('account')} error={errors.accountId} required>
          <WalletSelect
            id="income-account"
            placeholder={t('accountPlaceholder')}
            accounts={receiving}
            value={accountId}
            onChange={setAccountId}
            amount={receivingAmount}
            direction="in"
            locale={locale}
            invalid={Boolean(errors.accountId)}
            disabled={done}
          />
        </Field>

        <div className="space-y-2">
          <Field htmlFor="income-category" label={t('category')} error={errors.categoryId} required>
            {/*
              Keyed on the number of categories added here, so adding one remounts
              the select: Radix discards a controlled value set while its list is
              closed, because the item backing it has never registered — the
              expense form met it first (docs/gotchas.md).
            */}
            <Select key={added.length} value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="income-category">
                <SelectValue placeholder={t('categoryPlaceholder')}>
                  {(() => {
                    const selected = activeCategories.find((category) => category.id === categoryId);
                    return selected ? incomeCategoryLabel(selected, locale) : undefined;
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {activeCategories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {incomeCategoryLabel(category, locale)}
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

        <Field htmlFor="income-receivedOn" label={t('receivedOn')} error={errors.receivedOn} required>
          <DatePicker
            id="income-receivedOn"
            value={receivedOn}
            max={today}
            locale={locale === 'en' ? 'en' : 'ar'}
            onChange={(value) => setReceivedOn(value || today)}
          />
        </Field>

        {addingCategory ? (
          /*
            Inline rather than a dialog over the form: a modal would cover the
            very fields the category is being chosen for, and losing what was
            typed is the one failure this exists to avoid. One frame, dashed,
            so it reads as a step inside the form rather than a second form;
            across the row, so its own fields have the room.
          */
          <div className="space-y-2 rounded-lg border border-dashed bg-muted/20 p-3 md:col-span-2 xl:col-span-3">
            <p className="text-xs font-medium text-muted-foreground">{t('newCategoryTitle')}</p>
            <IncomeCategoryEditor
              tenant={tenant}
              token={token}
              existing={activeCategories}
              onCancel={() => setAddingCategory(false)}
              onSaved={(category) => {
                /*
                  No refetch while this form is open — reloading the list
                  rebuilt the options under the select, and Radix answered the
                  churn with an empty selection (the expense form's finding).
                  The new category is already in hand, and the editor has
                  written it into both cached lists, so the register's filter
                  and the next form have it without a read.
                */
                setAdded((current) => [...current, category]);
                setCategoryId(category.id);
                setAddingCategory(false);
              }}
            />
          </div>
        ) : null}

        {backdated ? (
          <Field
            htmlFor="income-adjustment"
            label={t('adjustmentReason')}
            error={errors.adjustmentReason}
            required
            className="md:col-span-2 xl:col-span-3"
          >
            <Input
              id="income-adjustment"
              value={adjustmentReason}
              maxLength={500}
              placeholder={t('adjustmentPlaceholder')}
              invalid={Boolean(errors.adjustmentReason)}
              onChange={(event) => setAdjustmentReason(event.target.value)}
            />
          </Field>
        ) : null}

        <Field htmlFor="income-payerName" label={t('payer')} error={errors.payerName} optionalLabel={t('optional')}>
          <Input
            id="income-payerName"
            value={payerName}
            maxLength={200}
            placeholder={t('payerPlaceholder')}
            invalid={Boolean(errors.payerName)}
            onChange={(event) => setPayerName(event.target.value)}
          />
        </Field>

        <Field
          htmlFor="income-externalReference"
          label={t('externalReference')}
          error={errors.externalReference}
          optionalLabel={t('optional')}
        >
          {/* A cheque or transfer number is a code: read left to right whatever the page (RTL-2). */}
          <Input
            id="income-externalReference"
            dir="ltr"
            value={externalReference}
            maxLength={100}
            placeholder={t('externalReferencePlaceholder')}
            onChange={(event) => setExternalReference(event.target.value)}
          />
        </Field>

        <Field
          htmlFor="income-description"
          label={t('description')}
          error={errors.description}
          required
          className="md:col-span-2 xl:col-span-3"
        >
          <Textarea
            id="income-description"
            rows={2}
            maxLength={1000}
            className="min-h-20"
            value={description}
            placeholder={t('descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>

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
          {busy ? t('saving') : t('submit')}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClear}>
          {t('clear')}
        </Button>
      </div>
    </form>
  );
}

/** The id suffix of the first field to fix, so focus lands on it (FRM-2). */
function firstFieldId(errors: Record<string, string>): string {
  const order = ['amount', 'accountId', 'categoryId', 'receivedOn', 'payerName', 'externalReference', 'description'];
  const first = order.find((field) => errors[field]) ?? 'amount';
  return first === 'accountId' ? 'account' : first === 'categoryId' ? 'category' : first;
}
