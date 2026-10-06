'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { activateTreasurySchema } from '@mechanization/shared-schemas';
import {
  activateTreasury,
  ApiRequestError,
  logApiError,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { formatTypedAmount } from '@/lib/currency';
import { parseOpeningAmount } from '@/lib/treasury-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

const NOTE_MAX = 500;

/** The unit segment of an amount field: «ل.ل» for the pound, «$» for the dollar, the code otherwise. */
function unitOf(currency: string, locale: string): string {
  if (currency === 'LBP') return locale === 'en' ? 'LBP' : 'ل.ل';
  return currency === 'USD' ? '$' : currency;
}

/**
 * «تفعيل الخزينة» — one counted balance per account, then a confirmation.
 *
 * The treasury goes live exactly once, so the form does not submit: «متابعة»
 * validates, and a second step restates the figures and says it cannot be
 * redone. Mounted by the page only while open, so every opening starts blank.
 *
 * The server refuses a list that leaves an account out, so every account is
 * asked for — a zero is a real count, an empty box is not.
 */
export function ActivateTreasuryDialog({
  tenant,
  token,
  locale,
  accounts,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  accounts: TreasuryAccountView[];
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.activate');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [raw, setRaw] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [counted, setCounted] = useState<Array<{ account: TreasuryAccountView; amount: number }>>([]);

  /** Reads every box; returns the validated payload, or null after marking what is wrong. */
  const validate = () => {
    const nextErrors: Record<string, string> = {};
    const values: Array<{ account: TreasuryAccountView; amount: number }> = [];
    for (const account of accounts) {
      const parsed = parseOpeningAmount(raw[account.id] ?? '');
      if (parsed.ok) values.push({ account, amount: parsed.value });
      else nextErrors[account.id] = t(`errors.${parsed.reason}`);
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return null;

    const input = {
      balances: values.map(({ account, amount }) => ({ accountId: account.id, amount })),
      note: note.trim() || undefined,
    };
    // The shared schema is the contract; its messages are Arabic, so only the verdict is used here.
    if (!activateTreasurySchema.safeParse(input).success) {
      setFormError(note.trim().length > NOTE_MAX ? t('errors.note') : t('errors.form'));
      return null;
    }
    return { input, values };
  };

  const goToConfirm = () => {
    const checked = validate();
    if (!checked) return;
    setCounted(checked.values);
    setConfirming(true);
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const checked = validate();
    if (!checked) {
      setConfirming(false);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await activateTreasury(tenant, token, checked.input);
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success'), { description: t('successBody') });
      onClose();
    } catch (error) {
      logApiError(error);
      // Somebody else activated it first: the page behind this dialog is out of date, not the form.
      if (error instanceof ApiRequestError && error.code === 'TREASURY_ALREADY_ACTIVE') {
        void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      }
      // `ConfirmDialog` shows `error.message` — already the localised text for the code (TXT-6).
      throw error;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => (open || busy || confirming ? undefined : onClose())}>
        <DialogContent className="max-w-lg" closeLabel={t('close')}>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              goToConfirm();
            }}
          >
            {accounts.map((account) => (
              <Field
                key={account.id}
                htmlFor={`opening-${account.id}`}
                label={t('accountLabel', { name: account.name, currency: account.currency })}
                error={errors[account.id]}
                required
              >
                <CurrencyInput
                  id={`opening-${account.id}`}
                  unit={unitOf(account.currency, locale)}
                  value={raw[account.id] ?? ''}
                  placeholder="0"
                  invalid={Boolean(errors[account.id])}
                  onChange={(value) =>
                    setRaw((current) => ({
                      ...current,
                      [account.id]: formatTypedAmount(value, account.currency === 'LBP' ? 0 : 2),
                    }))
                  }
                />
              </Field>
            ))}

            <Field htmlFor="opening-note" label={t('note')} optionalLabel={t('optional')}>
              <Textarea
                id="opening-note"
                rows={2}
                maxLength={NOTE_MAX}
                value={note}
                placeholder={t('notePlaceholder')}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>

            {formError ? (
              <Alert variant="destructive" live="alert">
                {formError}
              </Alert>
            ) : null}

            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={onClose} className="w-full sm:w-auto">
                {t('cancel')}
              </Button>
              <Button type="submit" className="w-full sm:w-auto">
                {t('next')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive={false}
        title={t('confirmTitle')}
        description={t('confirmBody')}
        confirmLabel={t('confirmAction')}
        cancelLabel={t('cancel')}
        busyLabel={t('confirming')}
        onConfirm={submit}
      >
        {/* The read-back of what is about to be recorded: one record, read down against the count (PRIM-7). */}
        <SummaryList className="rounded-md border bg-muted/20 px-3">
          {counted.map(({ account, amount }) => (
            <SummaryRow key={account.id} label={account.name}>
              <TreasuryAmount amount={amount} currency={account.currency} locale={locale} />
            </SummaryRow>
          ))}
        </SummaryList>
      </ConfirmDialog>
    </>
  );
}
