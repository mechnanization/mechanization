'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  canReceiveIncome,
  getLabels,
  municipalToday,
  recordIncomeVoucherSchema,
  TREASURY_ADMIN_ROLES,
} from '@mechanization/shared-schemas';
import {
  recordIncomeVoucher,
  logApiError,
  type IncomeCategoryView,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { incomeCategoryLabel } from '@/lib/income-category-label';
import { hasRole } from '@/lib/staff-roles';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { TreasuryAmount } from './treasury-amount';

/**
 * A heading over a group of fields. Not a card: the page frames the form, and a
 * card inside it is the nested frame BAN-4 refuses.
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
 * «تسجيل إيراد جديد» — the whole act of receiving, as a form on its own page.
 *
 * The expense form's twin (`RecordExpenseForm`), run the other way, and laid
 * out the same so an accountant who knows one knows the other (UX-1): the fields
 * on one side, and beside them a summary that stays on screen and answers what
 * the wallet holds now and what it will hold once this is recorded. Unlike an
 * expense, nothing here can be short — receiving only ever raises a balance —
 * so the summary is a read-back, never a warning.
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
 * credit the Fund's transfer twice.
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
}): React.JSX.Element {
  const t = useTranslations('finance.income.form');
  const labels = getLabels(locale);
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
  const inFlight = useRef(false);
  /** One id per attempt; a refused voucher was never recorded, so the retry is a new act. */
  const requestId = useRef(crypto.randomUUID());

  const account = receiving.find((candidate) => candidate.id === accountId);
  const backdated = receivedOn < today;

  const typed = parseAmount(amount);
  const receivingAmount = Number.isFinite(typed) && typed > 0 ? typed : 0;
  const after = account ? account.balance + receivingAmount : 0;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const parsed = recordIncomeVoucherSchema.safeParse({
      categoryId,
      accountId,
      amount: parseAmount(amount),
      payerName: payerName.trim() || undefined,
      description,
      externalReference: externalReference.trim() || undefined,
      receivedOn,
      adjustmentReason: adjustmentReason.trim() || undefined,
      clientRequestId: requestId.current,
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
    try {
      const result = await recordIncomeVoucher(tenant, token, parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success', { number: result.voucherNumber }), { description: t('successBody') });
      onRecorded();
    } catch (error) {
      logApiError(error);
      // Already the localised text for the code (TXT-6); never branch on it.
      setFormError(error instanceof Error ? error.message : t('errors.form'));
      requestId.current = crypto.randomUUID();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (receiving.length === 0) {
    return (
      <Alert variant="warning" title={t('title')}>
        {t('noAccounts')}
      </Alert>
    );
  }

  return (
    <form noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start" onSubmit={submit}>
      <div className="space-y-6">
        <FormSection title={t('sections.money')}>
          <Field htmlFor="income-account" label={t('account')} error={errors.accountId} required>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="income-account">
                <SelectValue placeholder={t('accountPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {receiving.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {`${candidate.name} · ${labels.treasuryAccountType[candidate.type]}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

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
              onClick={() => setAddingCategory(true)}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('newCategory')}
            </Button>
          ) : null}

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
                onSaved={(category) => {
                  /*
                    No refetch while this form is open — reloading the list
                    rebuilt the options under the select, and Radix answered the
                    churn with an empty selection (the expense form's finding).
                    The new category is already in hand; every category list
                    refreshes once the voucher is recorded.
                  */
                  setAdded((current) => [...current, category]);
                  setCategoryId(category.id);
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

        {formError ? (
          <Alert variant="destructive" live="alert">
            {formError}
          </Alert>
        ) : null}
      </div>

      {/*
        The summary, sticky beside the fields on a wide screen. The heights are
        the expense form's, for the reason measured there: `AdminShell` scrolls an
        inner pane that starts below the `h-14` header, so the room left is
        `100dvh - 3.5rem`, less the page's own `py-6` — `100dvh - 6.5rem`. Below
        `lg` it falls under the fields at its natural height, directly above the
        button it qualifies.
      */}
      <aside className="lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]">
        <Card className="flex h-full flex-col">
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>
            {account ? (
              <SummaryList>
                <SummaryRow label={t('summaryAccount')}>{account.name}</SummaryRow>
                <SummaryRow label={t('balanceNow')}>
                  <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryAmount')}>
                  <TreasuryAmount amount={receivingAmount} currency={account.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('balanceAfter')}>
                  <TreasuryAmount
                    amount={after}
                    currency={account.currency}
                    locale={locale}
                    className="font-semibold"
                  />
                </SummaryRow>
              </SummaryList>
            ) : (
              <p className="text-sm text-muted-foreground">{t('summaryEmpty')}</p>
            )}

            {/* `mt-auto` pushes the actions to the foot of a panel taller than its content. */}
            <div className="mt-auto flex flex-col gap-2 pt-2">
              <Button type="submit" disabled={busy}>
                {busy ? t('saving') : t('submit')}
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

/** The id suffix of the first field to fix, so focus lands on it (FRM-2). */
function firstFieldId(errors: Record<string, string>): string {
  const order = ['accountId', 'amount', 'categoryId', 'payerName', 'description', 'receivedOn', 'externalReference'];
  const first = order.find((field) => errors[field]) ?? 'amount';
  return first === 'accountId' ? 'account' : first === 'categoryId' ? 'category' : first;
}
