'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { getLabels, recordStaffSalarySchema } from '@mechanization/shared-schemas';
import {
  getTreasuryOverview,
  logApiError,
  recordStaffSalary,
  type StaffSummary,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';

/**
 * «صرف راتب / أجر» — pays one staff member from a treasury wallet, from their
 * row on the staff page (docs/finance.md §5.8).
 *
 * ## Why a dialog, when recording an expense is a page
 *
 * The expense form left its dialog for a page (BAN-10) because it is nine
 * fields worked through with an invoice in hand. This is four, and the two
 * that make an expense hard — who was paid and under which بند — are not asked
 * at all: the server takes the name from the account and files the voucher
 * under «رواتب وأجور». What is left is the custody handover's shape (a wallet,
 * a figure, a line of text, with the balance answering «هل يكفي؟»), and that is
 * a dialog too.
 *
 * ## The balance decides the button
 *
 * The wallet's balance and what would be left are shown as the amount is
 * typed, and the submit is refused before any request when the amount is more
 * than the wallet holds. The server is still the authority — it re-checks under
 * the wallet's row lock (FRM-4) — so a balance that changed since this dialog
 * read it is refused there, with its own message.
 *
 * Recording is paying, so a second press must never pay twice: an in-flight ref
 * and a per-attempt idempotency key (STA-4).
 */
export function StaffSalaryDialog({
  tenant,
  base,
  token,
  locale,
  staff,
  onClose,
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}`, for the login redirect and the register link. */
  base: string;
  token: string;
  locale: string;
  staff: StaffSummary;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('staff.payout');
  const [busy, setBusy] = useState(false);

  /* The treasury page's own read, so paying here refreshes the balances there. */
  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const accounts = overview.data?.accounts ?? [];

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {/*
          Who is being paid, from the first frame rather than once the wallets
          load. Shown, not typed: the server writes the account's own name (FRM-5).
        */}
        <SummaryList className="rounded-md border bg-muted/20 px-3">
          <SummaryRow label={t('payee')}>
            <span className="font-semibold">{staff.fullName}</span>
          </SummaryRow>
        </SummaryList>

        {overview.error ? (
          <ErrorState title={overview.error} onRetry={overview.refetch} retryLabel={t('retry')} />
        ) : !overview.data ? (
          <LoadingState label={t('loading')} compact />
        ) : !overview.data.active ? (
          <Alert variant="warning" title={t('notActiveTitle')}>
            {t('notActiveBody')}
          </Alert>
        ) : accounts.length === 0 ? (
          <Alert variant="warning">{t('noAccounts')}</Alert>
        ) : (
          <SalaryForm
            tenant={tenant}
            base={base}
            token={token}
            locale={locale}
            staff={staff}
            accounts={accounts}
            onBusyChange={setBusy}
            onClose={onClose}
          />
        )}

        {/* The form brings its own footer; the other states only need a way out. */}
        {overview.data?.active && accounts.length > 0 ? null : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The fields, mounted once the wallets are in, so the first wallet can be the default. */
function SalaryForm({
  tenant,
  base,
  token,
  locale,
  staff,
  accounts,
  onBusyChange,
  onClose,
}: {
  tenant: string;
  base: string;
  token: string;
  locale: string;
  staff: StaffSummary;
  accounts: TreasuryAccountView[];
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('staff.payout');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  // Salaries are paid in cash far more often than by transfer, so a safe comes first.
  const [accountId, setAccountId] = useState(
    () => (accounts.find((candidate) => candidate.type === 'CASH_SAFE') ?? accounts[0]).id,
  );
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** One id per attempt; a refused payment was never recorded, so the retry is a new act. */
  const requestId = useRef(crypto.randomUUID());

  const account = accounts.find((candidate) => candidate.id === accountId);
  const decimals = account?.currency === 'LBP' ? 0 : 2;

  const typed = parseAmount(amount);
  const remaining = account ? Math.round((account.balance - typed) * 100) / 100 : 0;
  const short = Boolean(account) && typed > 0 && remaining < 0;

  const accountOptions = useMemo(
    () =>
      accounts.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.name} · ${labels.treasuryAccountType[candidate.type]}`,
      })),
    [accounts, labels],
  );

  const setWorking = (next: boolean): void => {
    setBusy(next);
    onBusyChange(next);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const parsed = recordStaffSalarySchema.safeParse({
      accountId,
      amount: typed,
      description,
      invoiceNumber: invoiceNumber.trim() || undefined,
      clientRequestId: requestId.current,
    });

    const next: Record<string, string> = {};
    if (!parsed.success) {
      /*
        The shared schema is the contract and its messages are Arabic by design,
        so only the field names come from it; the words are this screen's (TXT-1).
      */
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        if (!next[field]) next[field] = t(`errors.${field === 'clientRequestId' ? 'form' : field}`);
      }
    }
    // Refused here, before the round trip, rather than left for the server to refuse.
    if (short && !next.amount) next.amount = t('errors.short');

    if (!parsed.success || Object.keys(next).length > 0) {
      setErrors(next);
      setFormError(null);
      // Put the officer on the first thing to fix (FRM-2).
      const first = ['accountId', 'amount', 'description', 'invoiceNumber'].find((field) => next[field]);
      document.getElementById(`salary-${first ?? 'amount'}`)?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setWorking(true);
    try {
      const result = await recordStaffSalary(tenant, token, staff.id, parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      // The server's number, never a client-side reconstruction (STA-6).
      toast.success(t('successToast', { number: result.voucherNumber }), {
        description: t('successBody'),
        action: { label: t('openRegister'), onClick: () => router.push(`${base}/finance/expenses`) },
      });
      onClose();
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6); never branch on it.
      setFormError(caught instanceof Error ? caught.message : t('errors.form'));
      requestId.current = crypto.randomUUID();
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };

  return (
    <form noValidate className="space-y-4" onSubmit={submit}>
      <Field htmlFor="salary-accountId" label={t('payingWallet')} error={errors.accountId} required>
        <Select
          value={accountId}
          onValueChange={(next) => {
            setAccountId(next);
            const nextAccount = accounts.find((candidate) => candidate.id === next);
            // ليرة has no fractions to pay in; a dollar amount keeps its cents.
            setAmount((current) => formatTypedAmount(current, nextAccount?.currency === 'LBP' ? 0 : 2));
            setErrors(({ amount: _cleared, ...rest }) => rest);
          }}
        >
          <SelectTrigger id="salary-accountId">
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

      <Field htmlFor="salary-amount" label={t('amount')} error={errors.amount} required>
        <CurrencyInput
          id="salary-amount"
          unit={account ? currencyUnit(account.currency, locale) : ''}
          value={amount}
          placeholder="0"
          invalid={Boolean(errors.amount) || short}
          inputClassName="text-lg font-bold"
          onChange={(raw) => {
            setAmount(formatTypedAmount(raw, decimals));
            setErrors(({ amount: _cleared, ...rest }) => rest);
          }}
        />
      </Field>

      {/* «هل يكفي؟», answered while the figure is typed rather than after the submit. */}
      {account ? (
        <SummaryList className="rounded-md border bg-muted/20 px-3">
          <SummaryRow label={t('availableBalance')}>
            <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
          </SummaryRow>
          <SummaryRow label={t('balanceAfter')} className={short ? 'text-destructive' : undefined}>
            <TreasuryAmount amount={remaining} currency={account.currency} locale={locale} />
          </SummaryRow>
        </SummaryList>
      ) : null}

      {short ? (
        <Alert variant="destructive" live="status" title={t('shortTitle')}>
          {t('shortBody')}
        </Alert>
      ) : null}

      <Field htmlFor="salary-description" label={t('periodDescription')} error={errors.description} required>
        <Input
          id="salary-description"
          value={description}
          maxLength={1000}
          placeholder={t('periodPlaceholder')}
          invalid={Boolean(errors.description)}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <Field
        htmlFor="salary-invoiceNumber"
        label={t('receiptRef')}
        error={errors.invoiceNumber}
        optionalLabel={t('optional')}
      >
        <Input
          id="salary-invoiceNumber"
          value={invoiceNumber}
          maxLength={100}
          placeholder={t('receiptPlaceholder')}
          invalid={Boolean(errors.invoiceNumber)}
          onChange={(event) => setInvoiceNumber(event.target.value)}
        />
      </Field>

      {formError ? (
        <Alert variant="destructive" live="alert">
          {formError}
        </Alert>
      ) : null}

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={busy || short} className="w-full sm:w-auto">
          {busy ? t('saving') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
