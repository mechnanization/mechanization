'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Landmark, Wallet } from 'lucide-react';
import {
  createTreasuryAccountSchema,
  getLabels,
  type CreateTreasuryAccountInput,
} from '@mechanization/shared-schemas';
import { createTreasuryAccount, logApiError, type TreasuryRate } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useToast } from '@/components/ui/toast';

/**
 * «إضافة حساب» — the manager opens a bank account or a petty-cash fund.
 *
 * Three facts and nothing else: a name, a kind, a currency. It opens empty, by
 * decision of 2026-10-10 — money reaches it by «تحويل داخلي», so every amount
 * in it has a source in the ledger — and the dialog says so, so nobody looks
 * for an opening-balance box that is deliberately not there. The currency is
 * the municipality's base or secondary one, the two the server accepts.
 *
 * A dialog rather than a page: three fields, no document in hand, and the
 * balances it adds to are the page behind it (BAN-10 allows exactly this).
 */
export function AddAccountDialog({
  tenant,
  token,
  locale,
  rate,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  rate: TreasuryRate;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.addAccount');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();

  const currencies = [rate.baseCurrency, rate.secondaryCurrency].filter((code): code is string => Boolean(code));
  const [name, setName] = useState('');
  const [type, setType] = useState<CreateTreasuryAccountInput['type']>('BANK_ACCOUNT');
  const [currency, setCurrency] = useState(currencies[0] ?? 'LBP');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;
    const parsed = createTreasuryAccountSchema.safeParse({ name, type, currency });
    if (!parsed.success) {
      setError(t('errors.name'));
      document.getElementById('account-name')?.focus();
      return;
    }
    setError(null);
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const created = await createTreasuryAccount(tenant, token, parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success', { name: created.name }), { description: t('successBody') });
      onClose();
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6).
      setFormError(caught instanceof Error ? caught.message : t('errors.form'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field htmlFor="account-type" label={t('type')} required>
            <SegmentedControl
              aria-label={t('type')}
              value={type}
              onChange={(value) => setType(value as CreateTreasuryAccountInput['type'])}
              options={[
                { value: 'BANK_ACCOUNT', label: labels.treasuryAccountType.BANK_ACCOUNT, icon: Landmark },
                { value: 'PETTY_CASH', label: labels.treasuryAccountType.PETTY_CASH, icon: Wallet },
              ]}
            />
          </Field>

          <Field htmlFor="account-name" label={t('name')} error={error ?? undefined} required>
            <Input
              id="account-name"
              value={name}
              maxLength={120}
              placeholder={type === 'BANK_ACCOUNT' ? t('bankPlaceholder') : t('pettyPlaceholder')}
              invalid={Boolean(error)}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </Field>

          <Field htmlFor="account-currency" label={t('currency')} required>
            <SegmentedControl
              aria-label={t('currency')}
              value={currency}
              onChange={setCurrency}
              options={currencies.map((code) => ({ value: code, label: t(`currencies.${code}`) }))}
            />
          </Field>

          <Alert variant="info">{t('startsEmpty')}</Alert>

          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {busy ? t('saving') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
