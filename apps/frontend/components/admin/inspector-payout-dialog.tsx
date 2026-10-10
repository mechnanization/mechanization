'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins } from 'lucide-react';
import {
  getLabels,
  municipalToday,
  payoutAllowance,
  payoutRefusal,
  type InspectorProfileResponse,
  type RecordInspectorPayoutInput,
} from '@mechanization/shared-schemas';
import {
  getInspectorProfile,
  getTreasuryOverview,
  logApiError,
  recordInspectorPayout,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { currencyUnit, formatMoney, formatTypedAmount, parseAmount } from '@/lib/currency';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * «صرف عمولة» — one commission payout to one inspector.
 *
 * Lifted out of the inspector dashboard because several screens hand money
 * over — the staff page, the roster, a single inspector's dashboard, and the
 * payout history — and an amount validated in four copies is an amount that
 * will be accepted negative in one of them. The payout rule — never more than
 * is still owed — is `payoutAllowance`, the same function the server refuses
 * with, read against the inspector's own figures.
 *
 * ## Two forms, chosen by the treasury
 *
 * Once the treasury is live a payout is money leaving a wallet
 * (docs/finance.md §5.6): the officer picks a dollar wallet, sees its balance
 * and what would be left as the amount is typed, and the submit is refused
 * before any request when the wallet cannot cover it. The server re-checks
 * under the wallet's lock, writes a «PV-» voucher and the payout together, and
 * the toast offers the voucher's print-out at once. Before go-live there is no
 * wallet to choose, and the form is the old one: an amount, a date, a slip.
 *
 * Recording is paying, so a second press must never pay twice: an in-flight ref
 * and a per-attempt idempotency key (STA-4).
 */
export function InspectorPayoutDialog({
  open,
  onOpenChange,
  tenant,
  base,
  token,
  locale,
  staff,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}`, for the payment order the toast offers to print. */
  base: string;
  /** Null until the session has been read; the form will not submit without it. */
  token: string | null;
  locale: string;
  staff: { id: string; name: string } | null;
  /** Refresh whatever the caller is showing. Awaited, after the toast. */
  onRecorded: () => void | Promise<void>;
}): React.JSX.Element {
  const t = useTranslations('staff.commission');
  const [busy, setBusy] = useState(false);
  const enabled = open && Boolean(token && staff);

  /*
    The key the inspector's dashboard reads the same figures under, so opening
    the dialog from there costs no request — and a recorded payout, which every
    caller answers by invalidating `['staff', tenant]`, refreshes this too.
  */
  const profile = useQuery({
    queryKey: ['staff', tenant, 'inspector-profile', staff?.id],
    queryFn: ({ signal }) => getInspectorProfile(tenant, token as string, staff!.id, signal),
    enabled,
  });

  /* The treasury page's own read, so paying here refreshes the balances there. */
  const overview = useQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: ({ signal }) => getTreasuryOverview(tenant, token as string, undefined, signal),
    enabled,
  });

  const failed = profile.isError || overview.isError;
  const ready = Boolean(profile.data && overview.data);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent closeLabel={t('close')} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="size-5 text-success" aria-hidden />
            {t('dialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {overview.data?.active ? t('descriptionLive') : staff ? t('descriptionLegacy', { name: staff.name }) : null}
          </DialogDescription>
        </DialogHeader>

        {failed ? (
          <ErrorState
            title={t('loadError')}
            onRetry={() => {
              void profile.refetch();
              void overview.refetch();
            }}
            retryLabel={t('retry')}
          />
        ) : !ready || !staff || !token ? (
          <LoadingState label={t('loading')} compact />
        ) : (
          <PayoutForm
            key={staff.id}
            tenant={tenant}
            base={base}
            token={token}
            locale={locale}
            staff={staff}
            profile={profile.data!}
            live={overview.data!.active}
            accounts={overview.data!.accounts.filter((account) => account.currency === 'USD')}
            onBusyChange={setBusy}
            onClose={() => onOpenChange(false)}
            onRecorded={onRecorded}
          />
        )}

        {ready && !failed ? null : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The fields, mounted once the figures are in, so the dollar safe can be the
 * default and a reopened dialog starts empty: it remounts per inspector (`key`),
 * and on the roster two names sit one row apart.
 */
function PayoutForm({
  tenant,
  base,
  token,
  locale,
  staff,
  profile,
  live,
  accounts,
  onBusyChange,
  onClose,
  onRecorded,
}: {
  tenant: string;
  base: string;
  token: string;
  locale: string;
  staff: { id: string; name: string };
  profile: InspectorProfileResponse;
  live: boolean;
  /** The active dollar wallets: commissions are counted, and paid, in dollars. */
  accounts: TreasuryAccountView[];
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onRecorded: () => void | Promise<void>;
}): React.JSX.Element {
  const t = useTranslations('staff.commission');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  // The main dollar safe first: commissions are handed over in cash.
  const [accountId, setAccountId] = useState(
    () => (accounts.find((account) => account.type === 'CASH_SAFE') ?? accounts[0])?.id ?? '',
  );
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(municipalToday);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** One id per attempt; a refused payout was never recorded, so the retry is a new act. */
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const allowance = useMemo(() => payoutAllowance({ pendingBalance: profile.pendingBalance }), [profile]);
  /** Nothing can be paid, whatever the amount. */
  const blocked = allowance.allowed ? null : payoutRefusal(allowance, 0);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const typed = parseAmount(amount);
  const remaining = account ? Math.round((account.balance - typed) * 100) / 100 : 0;
  const short = live && Boolean(account) && typed > 0 && remaining < 0;

  const setWorking = (next: boolean): void => {
    setBusy(next);
    onBusyChange(next);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const next: Record<string, string> = {};
    if (live && !account) next.accountId = t('errors.accountId');
    if (typed <= 0) next.amount = t('errors.amount');
    // The server checks again; this only saves a round trip to be told the same thing.
    const refusal = typed > 0 ? payoutRefusal(allowance, typed) : null;
    if (refusal && !next.amount) next.amount = refusal;
    if (short && !next.amount) next.amount = t('errors.short');

    if (Object.keys(next).length > 0) {
      setErrors(next);
      setFormError(null);
      // Put the officer on the first thing to fix (FRM-2).
      const first = ['accountId', 'amount'].find((field) => next[field]);
      document.getElementById(`payout-${first ?? 'amount'}`)?.focus();
      return;
    }

    const payload: RecordInspectorPayoutInput = live
      ? {
          amount: typed,
          currency: 'USD',
          accountId,
          note: note.trim() || undefined,
          reference: reference.trim() || undefined,
          clientRequestId: requestId.current,
        }
      : {
          amount: typed,
          currency: 'USD',
          /*
            Midday rather than midnight. The picker yields a date with no time,
            and `new Date('2026-09-20')` is parsed as UTC midnight — which in a
            timezone behind UTC is the 19th. A payout dated a day early is the
            kind of discrepancy somebody reconciles against a paper slip later.
          */
          paidAt: new Date(`${paidOn}T12:00:00`).toISOString(),
          note: note.trim() || undefined,
          reference: reference.trim() || undefined,
        };

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setWorking(true);
    try {
      const payout = await recordInspectorPayout(tenant, token, staff.id, payload);
      const voucher = payout.voucher;
      if (voucher) {
        await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
        // The server's number, never a client-side reconstruction (STA-6).
        toast.success(t('successLive', { number: voucher.voucherNumber }), {
          description: t('successLiveBody'),
          action: {
            label: t('printOrder'),
            onClick: () => router.push(`${base}/finance/expenses/${voucher.id}/print?print=1`),
          },
        });
      } else {
        toast.success(t('successLegacy', { amount: formatMoney(typed, 'USD', locale), name: staff.name }));
      }
      onClose();
      await onRecorded();
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
      {/* Who is paid and what he is owed, from the first frame: shown, not typed (FRM-5). */}
      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('payee')}>
          <span className="font-semibold">{staff.name}</span>
        </SummaryRow>
        <SummaryRow label={t('unitsSurveyed')} className="tabular-nums">
          {profile.totalProperties.toLocaleString('en-US')}
        </SummaryRow>
        <SummaryRow label={t('earned')}>
          <TreasuryAmount amount={profile.totalEarnings} currency="USD" locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('owed')} className={allowance.allowed ? 'text-success' : 'text-muted-foreground'}>
          <TreasuryAmount amount={allowance.owed} currency="USD" locale={locale} className="font-semibold" />
        </SummaryRow>
      </SummaryList>

      {blocked ? (
        <Alert variant="warning" live="status">
          {blocked}
        </Alert>
      ) : null}

      {live && accounts.length === 0 ? (
        <Alert variant="warning" title={t('noAccountsTitle')}>
          {t('noAccountsBody')}
        </Alert>
      ) : null}

      {live && accounts.length > 0 ? (
        <Field htmlFor="payout-accountId" label={t('payingWallet')} error={errors.accountId} required>
          <Select
            value={accountId}
            onValueChange={(nextId) => {
              setAccountId(nextId);
              setErrors(({ accountId: _cleared, ...rest }) => rest);
            }}
          >
            <SelectTrigger id="payout-accountId">
              <SelectValue placeholder={t('accountPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {`${candidate.name} · ${labels.treasuryAccountType[candidate.type]}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <Field htmlFor="payout-amount" label={t('amount')} error={errors.amount} required>
        {/*
          A text box with the kit's money formatting, not `type="number"`: the
          spinners nudge a payout from 40 to 45 under a hand resting on a
          tablet, and `inputMode="decimal"` still raises the numeric keypad.
          No placeholder figure — a payout of nothing is the mistake worth not
          suggesting.
        */}
        <CurrencyInput
          id="payout-amount"
          unit={currencyUnit('USD', locale)}
          value={amount}
          invalid={Boolean(errors.amount) || short}
          inputClassName="text-lg font-bold"
          onChange={(raw) => {
            setAmount(formatTypedAmount(raw, 2));
            setErrors(({ amount: _cleared, ...rest }) => rest);
          }}
        />
      </Field>

      {/* «هل يكفي؟», answered while the figure is typed rather than after the submit. */}
      {live && account ? (
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

      {/* Dated today once live: the voucher is, and a closed day takes nothing. */}
      {live ? null : (
        <Field htmlFor="payout-date" label={t('date')}>
          <DatePicker
            id="payout-date"
            value={paidOn}
            onChange={setPaidOn}
            max={municipalToday()}
            locale={locale === 'en' ? 'en' : 'ar'}
            disabled={busy}
          />
        </Field>
      )}

      <Field htmlFor="payout-note" label={live ? t('statement') : t('note')} optionalLabel={t('optional')}>
        <Textarea
          id="payout-note"
          rows={2}
          maxLength={500}
          placeholder={live ? t('statementPlaceholder') : t('notePlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      <Field htmlFor="payout-reference" label={t('reference')} optionalLabel={t('optional')}>
        <Input
          id="payout-reference"
          maxLength={100}
          placeholder={t('referencePlaceholder')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
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
        <Button
          type="submit"
          disabled={busy || short || Boolean(blocked) || (live && accounts.length === 0)}
          className="w-full sm:w-auto"
        >
          {busy ? t('saving') : live ? t('submitLive') : t('submitLegacy')}
        </Button>
      </DialogFooter>
    </form>
  );
}
