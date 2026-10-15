'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
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
import { formatDate } from '@/lib/dates';
import { incomeCategoryLabel } from '@/lib/income-category-label';
import { heldKey, keyIsSpent, outcomeInDoubt, spendKey, type KeyScope } from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import { cn } from '@/lib/utils';
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
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { IncomeCategoryEditor } from './income-category-editor';
import { FormCard, FormSection, SummaryPanel, TREASURY_FORM_GRID, WalletSelect } from './treasury-form-parts';
import { TreasuryAmount } from './treasury-amount';

/**
 * The one scope the income form's key is held under (`heldKey`): there is one
 * act to record from it, and the key outlives the form — a failed re-read, a
 * trip to the register and back — until the server confirms the voucher.
 */
const KEY_SCOPE: KeyScope = 'income:new';

/**
 * «تسجيل إيراد جديد» — the whole act of receiving, as a form on its own page.
 *
 * The expense form's twin (`RecordExpenseForm`), run the other way, and laid
 * out the same so an accountant who knows one knows the other (UX-1): the
 * frame is `treasury-form-parts.tsx`, shared by both. The fields sit in one
 * card that scrolls on its own; beside it a summary that does not move reads
 * back the voucher as it will be recorded — the wallet,
 * the category, the payer, the day — and what the wallet holds now and once
 * this is recorded. Unlike an expense, nothing here can be short — receiving
 * only ever raises a balance — so the summary is a read-back, never a warning.
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
 * server says the act exists; once the server has answered with a 2xx the form
 * stays locked until the page moves on.
 */
export function RecordIncomeForm({
  tenant,
  token,
  locale,
  role,
  backHref,
  accounts,
  categories,
  onRecorded,
  onPrint,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** Decides whether «بند جديد» is offered: the manager's alone (docs/finance.md §4.3). */
  role: string | undefined;
  /** Where «إلغاء» goes. */
  backHref: string;
  accounts: TreasuryAccountView[];
  categories: IncomeCategoryView[];
  onRecorded: () => void;
  /** Opens the voucher just written, to print: the success toast's action. */
  onPrint: (voucherId: string) => void;
}): React.JSX.Element {
  const t = useTranslations('finance.income.form');
  const queryClient = useQueryClient();
  const toast = useToast();

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
  const [accountId, setAccountId] = useState(receiving[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [payerName, setPayerName] = useState('');
  const [description, setDescription] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [adjustmentReason, setAdjustmentReason] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the act is recorded, and the form stays locked. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  const account = receiving.find((candidate) => candidate.id === accountId);
  const category = activeCategories.find((candidate) => candidate.id === categoryId);
  const backdated = receivedOn < today;

  const typed = parseAmount(amount);
  const receivingAmount = Number.isFinite(typed) && typed > 0 ? typed : 0;
  const after = account ? account.balance + receivingAmount : 0;

  /**
   * Re-reads the treasury figures — the balance the summary adds to, the
   * register — but not the category list under the open select: refetching a
   * list while its select is mounted is what dropped the expense form's value.
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
      Recorded. The form stays locked from here — `inFlight` is never released
      and `done` disables the button — until the page moves on: a page stays
      mounted until the next route is ready, and a second press would be a
      second act.
    */
    setDone(true);
    setBusy(false);
    spendKey(tenant, KEY_SCOPE);
    await refreshFigures();
    const voucherId = result.id;
    const print = { label: t('print'), onClick: () => onPrint(voucherId) };
    if (result.replayed) {
      // An earlier press recorded it and its answer was lost: that voucher stands, as first recorded.
      toast.warning(t('replayed', { number: result.voucherNumber }), {
        description: t('replayedBody'),
        action: print,
      });
    } else {
      toast.success(t('success', { number: result.voucherNumber }), { description: t('successBody'), action: print });
    }
    onRecorded();
  };

  if (receiving.length === 0) {
    return (
      <Alert variant="warning" title={t('title')}>
        {t('noAccounts')}
      </Alert>
    );
  }

  return (
    <form noValidate className={TREASURY_FORM_GRID} onSubmit={submit}>
      <FormCard disabled={busy || done}>
        <FormSection title={t('sections.money')}>
          <WalletSelect
            id="income-account"
            label={t('account')}
            placeholder={t('accountPlaceholder')}
            accounts={receiving}
            value={accountId}
            onChange={setAccountId}
            locale={locale}
            error={errors.accountId}
          />

          <Field htmlFor="income-amount" label={t('amount')} error={errors.amount} required>
            <CurrencyInput
              id="income-amount"
              unit={account ? currencyUnit(account.currency, locale) : ''}
              value={amount}
              placeholder="0"
              invalid={Boolean(errors.amount)}
              onChange={(value) => setAmount(formatTypedAmount(value, account?.currency === 'LBP' ? 0 : 2))}
            />
          </Field>
        </FormSection>

        <FormSection title={t('sections.what')}>
          {/* A row of its own: a category's name is long, and beside another field the select clipped it. */}
          <Field htmlFor="income-category" label={t('category')} error={errors.categoryId} required>
            <div className="flex flex-wrap gap-2">
              {/*
                Keyed on the number of categories added here, so adding one remounts
                the select: Radix discards a controlled value set while its list is
                closed, because the item backing it has never registered — the
                expense form met it first (docs/gotchas.md).
              */}
              <Select key={added.length} value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="income-category" className="min-w-0 flex-1 basis-40">
                  <SelectValue placeholder={t('categoryPlaceholder')}>
                    {category ? incomeCategoryLabel(category, locale) : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {activeCategories.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {incomeCategoryLabel(option, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Beside the list it adds to, and under it when the row is too narrow for both; gone while the editor is open. */}
              {canManageCategories && !addingCategory ? (
                <Button type="button" variant="outline" className="shrink-0" onClick={() => setAddingCategory(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t('newCategory')}
                </Button>
              ) : null}
            </div>
          </Field>

          {addingCategory ? (
            /*
              Inline rather than a dialog over the form: a modal would cover the
              very fields the category is being chosen for, and losing what was
              typed is the one failure this exists to avoid. One frame, dashed,
              so it reads as a step inside the form rather than a second form.
            */
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/20 p-3">
              <p className="text-xs font-medium text-muted-foreground">{t('newCategoryTitle')}</p>
              <IncomeCategoryEditor
                tenant={tenant}
                token={token}
                existing={activeCategories}
                onCancel={() => setAddingCategory(false)}
                onSaved={(saved) => {
                  /*
                    No refetch while this form is open — reloading the list
                    rebuilt the options under the select, and Radix answered the
                    churn with an empty selection (the expense form's finding).
                    The new category is already in hand, and the editor has
                    written it into both cached lists, so the register's filter
                    and the next form have it without a read: they are reference
                    reads, and nothing here re-reads them (`refreshFigures`
                    leaves them out).
                  */
                  setAdded((current) => [...current, saved]);
                  setCategoryId(saved.id);
                  setAddingCategory(false);
                }}
              />
            </div>
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

          <Field htmlFor="income-description" label={t('description')} error={errors.description} required>
            <Textarea
              id="income-description"
              rows={2}
              maxLength={1000}
              value={description}
              placeholder={t('descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </FormSection>

        <FormSection title={t('sections.paperwork')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="income-receivedOn" label={t('receivedOn')} error={errors.receivedOn} required>
              <DatePicker
                id="income-receivedOn"
                value={receivedOn}
                max={today}
                locale={locale === 'en' ? 'en' : 'ar'}
                onChange={(value) => setReceivedOn(value || today)}
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
          </div>

          {backdated ? (
            <Field htmlFor="income-adjustment" label={t('adjustmentReason')} error={errors.adjustmentReason} required>
              <Input
                id="income-adjustment"
                value={adjustmentReason}
                placeholder={t('adjustmentPlaceholder')}
                invalid={Boolean(errors.adjustmentReason)}
                onChange={(event) => setAdjustmentReason(event.target.value)}
              />
            </Field>
          ) : null}
        </FormSection>
      </FormCard>

      <SummaryPanel
        title={t('summaryTitle')}
        footer={
          <>
            {formError ? (
              <Alert variant="destructive" live="alert">
                {formError}
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" disabled={busy || done}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {busy ? t('saving') : t('submit')}
              </Button>
              <Button asChild type="button" variant="outline" disabled={busy}>
                <Link href={backHref}>{t('cancel')}</Link>
              </Button>
            </div>
          </>
        }
      >
        {account ? (
          <>
            {/* The voucher as it will be recorded, to check against the slip in hand (UX-4). */}
            <SummaryList>
              <SummaryRow label={t('summaryAccount')}>{account.name}</SummaryRow>
              <SummaryRow label={t('category')} className={cn(!category && 'font-normal text-muted-foreground')}>
                {category ? incomeCategoryLabel(category, locale) : '—'}
              </SummaryRow>
              <SummaryRow label={t('payer')} className={cn(!payerName.trim() && 'font-normal text-muted-foreground')}>
                {payerName.trim() || '—'}
              </SummaryRow>
              <SummaryRow label={t('receivedOn')}>
                <span className="tabular-nums">{formatDate(`${receivedOn}T12:00:00.000Z`)}</span>
              </SummaryRow>
            </SummaryList>

            {/* What it does to the wallet: now, plus the amount, equals after — the last line is the answer. */}
            <SummaryList className="border-t">
              <SummaryRow label={t('balanceNow')}>
                <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
              </SummaryRow>
              <SummaryRow label={t('summaryAmount')}>
                <TreasuryAmount amount={receivingAmount} currency={account.currency} locale={locale} signed />
              </SummaryRow>
              <SummaryRow label={t('balanceAfter')} className="text-base">
                <TreasuryAmount amount={after} currency={account.currency} locale={locale} />
              </SummaryRow>
            </SummaryList>
          </>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">{t('summaryEmpty')}</p>
        )}
      </SummaryPanel>
    </form>
  );
}

/** The id suffix of the first field to fix, so focus lands on it (FRM-2). */
function firstFieldId(errors: Record<string, string>): string {
  const order = ['accountId', 'amount', 'categoryId', 'payerName', 'description', 'receivedOn', 'externalReference'];
  const first = order.find((field) => errors[field]) ?? 'amount';
  return first === 'accountId' ? 'account' : first === 'categoryId' ? 'category' : first;
}
