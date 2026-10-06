'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import {
  getLabels,
  createExpenseCategorySchema,
  recordExpenseSchema,
  municipalToday,
  TREASURY_ADMIN_ROLES,
} from '@mechanization/shared-schemas';
import {
  createExpenseCategory,
  recordExpense,
  logApiError,
  type ExpenseCategoryView,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { formatTypedAmount, parseAmount } from '@/lib/currency';
import { hasRole } from '@/lib/staff-roles';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { TreasuryAmount } from './treasury-amount';

/** The unit segment of the amount field: «ل.ل», «$», or the code itself. */
function unitOf(currency: string, locale: string): string {
  if (currency === 'LBP') return locale === 'en' ? 'LBP' : 'ل.ل';
  return currency === 'USD' ? '$' : currency;
}

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
 * «سجّل نفقة» — the whole act of paying, as a form on its own page.
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
 * the submit, and turns red the moment the remainder would go below zero. The
 * server is still the authority: it recomputes this under a row lock (FRM-4).
 *
 * ## Why a category can be created here
 *
 * An accountant who cannot find the right بند either files the expense under
 * «نفقات متفرقة» — which makes «قطع الحساب» useless — or leaves to go and add
 * one. The manager adds it inline instead, and the half-filled voucher stays
 * exactly as it is. Manager only, as docs/finance.md §9 sets out, and
 * `ExpensesController` enforces the same.
 *
 * Recording is paying, so this form is the whole act: a second submission is
 * guarded by an in-flight ref *and* an idempotency key the server honours
 * (STA-4), because on a slow counter connection a clerk cannot tell a slow
 * response from a lost one.
 */
export function RecordExpenseForm({
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
  role: string | undefined;
  /** Where «إلغاء» goes, and where the form returns to once the voucher is written. */
  backHref: string;
  accounts: TreasuryAccountView[];
  categories: ExpenseCategoryView[];
  onRecorded: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();

  const today = municipalToday();
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [description, setDescription] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [hasPhysicalReceipt, setHasPhysicalReceipt] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** One id per attempt; a refused voucher was never recorded, so the retry is a new act. */
  const requestId = useRef(crypto.randomUUID());

  /** Bands added without leaving the form, so the select shows them at once. */
  const [added, setAdded] = useState<ExpenseCategoryView[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const canManageCategories = hasRole(TREASURY_ADMIN_ROLES, role);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const backdated = paidOn < today;

  const typed = parseAmount(amount);
  const spending = Number.isFinite(typed) && typed > 0 ? typed : 0;
  const remaining = account ? account.balance - spending : 0;
  const short = Boolean(account) && spending > 0 && remaining < 0;

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

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const parsed = recordExpenseSchema.safeParse({
      categoryId,
      accountId,
      amount: parseAmount(amount),
      payee,
      description,
      paidOn,
      adjustmentReason: adjustmentReason.trim() || undefined,
      invoiceNumber: invoiceNumber.trim() || undefined,
      hasPhysicalReceipt,
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
        if (!next[field]) next[field] = t(`errors.${field}`);
      }
      setErrors(next);
      setFormError(null);
      // Put the officer on the first thing to fix rather than leaving them to hunt (FRM-2).
      document.getElementById(`expense-${firstFieldId(next)}`)?.focus();
      return;
    }
    // The server asks for a reason on any back-dated voucher; say so before the round trip.
    if (backdated && !adjustmentReason.trim()) {
      setErrors({ adjustmentReason: t('errors.adjustmentReason') });
      document.getElementById('expense-adjustment')?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await recordExpense(tenant, token, parsed.data);
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

  return (
    <form
      noValidate
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      onSubmit={submit}
    >
      <div className="space-y-6">
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
              unit={account ? unitOf(account.currency, locale) : ''}
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
                  already in hand, and the list refreshes on the way back.
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

        <FormSection title={t('sections.paperwork')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="expense-date" label={t('paidOn')} error={errors.paidOn} required>
              <DatePicker
                id="expense-date"
                value={paidOn}
                max={today}
                locale={locale === 'en' ? 'en' : 'ar'}
                onChange={(value) => setPaidOn(value || today)}
              />
            </Field>

            <Field htmlFor="expense-invoice" label={t('invoiceNumber')} optionalLabel={t('optional')}>
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
        panel means «سجّل النفقة» is on screen the whole way down the form. The
        body scrolls inside the panel when the figures and a warning outgrow it.

        Below `lg` none of this applies: the panel falls under the fields, at its
        natural height, directly above the button it qualifies.
      */}
      <aside className="lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]">
        <Card className={cn('flex h-full flex-col', short && 'border-destructive/30')}>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>
            {account ? (
              <SummaryList>
                <SummaryRow label={t('summaryAccount')}>{account.name}</SummaryRow>
                <SummaryRow label={t('balanceNow')}>
                  <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('summaryAmount')}>
                  <TreasuryAmount amount={spending} currency={account.currency} locale={locale} />
                </SummaryRow>
                <SummaryRow label={t('balanceAfter')} className={cn(short && 'text-destructive')}>
                  <TreasuryAmount amount={remaining} currency={account.currency} locale={locale} />
                </SummaryRow>
              </SummaryList>
            ) : (
              <p className="text-sm text-muted-foreground">{t('summaryEmpty')}</p>
            )}

            {short ? (
              <Alert variant="destructive" live="status" title={t('shortTitle')}>
                {t('shortBody')}
              </Alert>
            ) : null}

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
  const order = ['accountId', 'amount', 'categoryId', 'payee', 'description', 'paidOn'];
  const first = order.find((field) => errors[field]) ?? 'amount';
  return first === 'accountId' ? 'account' : first === 'categoryId' ? 'category' : first;
}

/**
 * «بند صرف جديد», without leaving the half-filled voucher.
 *
 * Inline rather than a dialog over the form: a modal here would cover the very
 * fields the officer is deciding the band from, and losing what they typed is
 * the one failure this exists to avoid.
 */
function NewCategoryFields({
  tenant,
  token,
  existing,
  onCreated,
  onCancel,
}: {
  tenant: string;
  token: string;
  existing: ExpenseCategoryView[];
  onCreated: (category: ExpenseCategoryView) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.newCategory');
  const [name, setName] = useState('');
  const [chapterCode, setChapterCode] = useState('');
  const [itemCode, setItemCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /*
    A warning, not a block: nothing in the database stops two bands sharing a
    name, and refusing here would claim a guarantee the schema does not make.
    Duplicate *budget codes* are refused, by a partial unique index.
  */
  const duplicate =
    name.trim().length > 0 &&
    existing.some(
      (category) => category.name.trim().localeCompare(name.trim(), undefined, { sensitivity: 'base' }) === 0,
    );

  const create = async (): Promise<void> => {
    if (inFlight.current) return;
    const parsed = createExpenseCategorySchema.safeParse({
      name,
      chapterCode: chapterCode.trim() || undefined,
      itemCode: itemCode.trim() || undefined,
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'name');
      setError(field === 'name' ? t('errors.name') : t('errors.codes'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createExpenseCategory(tenant, token, parsed.data));
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof Error ? caught.message : t('errors.form'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>

      <Field htmlFor="new-category-name" label={t('name')} error={error ?? undefined} required>
        <Input
          id="new-category-name"
          value={name}
          placeholder={t('namePlaceholder')}
          invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>

      {duplicate ? (
        <Alert variant="warning" live="status">
          {t('duplicate')}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="new-category-chapter" label={t('chapterCode')} optionalLabel={t('optional')}>
          <Input
            id="new-category-chapter"
            dir="ltr"
            inputMode="numeric"
            value={chapterCode}
            placeholder={t('codePlaceholder')}
            onChange={(event) => setChapterCode(event.target.value)}
          />
        </Field>
        <Field htmlFor="new-category-item" label={t('itemCode')} optionalLabel={t('optional')}>
          <Input
            id="new-category-item"
            dir="ltr"
            inputMode="numeric"
            value={itemCode}
            placeholder={t('codePlaceholder')}
            onChange={(event) => setItemCode(event.target.value)}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('codesHint')}</p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={create} disabled={busy}>
          {busy ? t('saving') : t('create')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {/* Drawn for LTR; flipped in Arabic (RTL-3). */}
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
