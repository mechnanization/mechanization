'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import {
  ARREARS_COMPONENT,
  ARREARS_FEE_TYPE,
  arrearsSingleLineSchema,
  getLabels,
  municipalToday,
  type ArrearsComponent,
  type ArrearsFeeType,
} from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { addArrearsSingleLine } from '@/lib/arrears-api';
import { heldKey, markInDoubt, outcomeInDoubt, spendKey } from '@/lib/request-id';
import { CitizenPicker, type PickedCitizen } from '@/components/admin/citizen-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * One old debt found after the batches (old-debts-plan §4.7): a one-line batch
 * through the same checks and the same approval, never a bill on its own. A
 * citizen's file, or — for a person not on the register yet — the name as the
 * old books wrote it, which waits in «للمطابقة» (decision 8). LBP only
 * (decision 13). The press carries a retry key held under `arrears:line`.
 */
export function SingleLineDialog({
  open,
  onOpenChange,
  tenant,
  token,
  locale,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string | null;
  locale: string;
  onAdded: () => void;
}) {
  const t = useTranslations('arrears.single');
  const labels = getLabels(locale);
  const [who, setWho] = useState<'FILE' | 'BOOKS'>('FILE');
  const [citizen, setCitizen] = useState<PickedCitizen | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [propertyNumber, setPropertyNumber] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const [year, setYear] = useState('');
  const [feeType, setFeeType] = useState<ArrearsFeeType | ''>('');
  const [feeTypeNote, setFeeTypeNote] = useState('');
  const [component, setComponent] = useState<ArrearsComponent>('PRINCIPAL');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [oldReference, setOldReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  const input = arrearsSingleLineSchema.safeParse({
    ...(who === 'FILE' ? { citizenId: citizen?.id } : { sourceName: optional(sourceName) }),
    propertyNumber: propertyNumber.trim(),
    unitCode: optional(unitCode),
    year: year.trim() === '' ? undefined : Number(year),
    feeType: feeType || undefined,
    feeTypeNote: feeType === 'OTHER' ? optional(feeTypeNote) : undefined,
    component,
    amount: amount.trim() === '' ? undefined : Number(amount.replace(/,/g, '')),
    dueDate: dueDate || undefined,
    oldReference: optional(oldReference),
    clientRequestId: heldKey(tenant, 'arrears:line'),
  });

  const run = async () => {
    if (!token || !input.success || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await addArrearsSingleLine(tenant, token, input.data);
      spendKey(tenant, 'arrears:line');
      onAdded();
      onOpenChange(false);
    } catch (caught) {
      logApiError(caught);
      if (outcomeInDoubt(caught)) markInDoubt(tenant, 'arrears:line');
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')} className="flex max-h-[88dvh] flex-col sm:max-w-2xl">
        <DialogHeader className="text-start">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {error ? (
            <Alert variant="destructive" live="alert">
              {error}
            </Alert>
          ) : null}

          <SegmentedControl
            aria-label={t('who')}
            value={who}
            onChange={(value) => setWho(value as 'FILE' | 'BOOKS')}
            options={[
              { value: 'FILE', label: t('onFile') },
              { value: 'BOOKS', label: t('notOnFile') },
            ]}
          />
          {who === 'FILE' ? (
            <Field label={t('citizen')} htmlFor="arrears-line-citizen" required>
              <CitizenPicker
                id="arrears-line-citizen"
                tenant={tenant}
                token={token}
                value={citizen}
                onChange={setCitizen}
                includeArchived
              />
            </Field>
          ) : (
            <Field label={t('sourceName')} htmlFor="arrears-line-name" required>
              <Input id="arrears-line-name" value={sourceName} maxLength={200} onChange={(event) => setSourceName(event.target.value)} />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('propertyNumber')} htmlFor="arrears-line-property" required>
              <Input id="arrears-line-property" dir="ltr" value={propertyNumber} maxLength={50} onChange={(event) => setPropertyNumber(event.target.value)} />
            </Field>
            <Field label={t('unitCode')} htmlFor="arrears-line-unit">
              <Input id="arrears-line-unit" dir="ltr" value={unitCode} maxLength={50} onChange={(event) => setUnitCode(event.target.value)} />
            </Field>
            <Field label={t('year')} htmlFor="arrears-line-year" required>
              <Input id="arrears-line-year" inputMode="numeric" dir="ltr" value={year} onChange={(event) => setYear(event.target.value)} />
            </Field>
            <Field label={t('feeType')} htmlFor="arrears-line-fee" required>
              <Select value={feeType} onValueChange={(value) => setFeeType(value as ArrearsFeeType)}>
                <SelectTrigger id="arrears-line-fee">
                  <SelectValue placeholder={t('choose')} />
                </SelectTrigger>
                <SelectContent>
                  {ARREARS_FEE_TYPE.map((code) => (
                    <SelectItem key={code} value={code}>
                      {labels.arrearsFeeType[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {feeType === 'OTHER' ? (
              <Field label={t('feeTypeNote')} htmlFor="arrears-line-fee-note" required>
                <Input id="arrears-line-fee-note" value={feeTypeNote} maxLength={200} onChange={(event) => setFeeTypeNote(event.target.value)} />
              </Field>
            ) : null}
            <Field label={t('component')} htmlFor="arrears-line-component">
              <SegmentedControl
                aria-label={t('component')}
                size="field"
                value={component}
                onChange={(value) => setComponent(value as ArrearsComponent)}
                options={ARREARS_COMPONENT.map((code) => ({ value: code, label: labels.arrearsComponent[code] }))}
              />
            </Field>
            <Field label={t('amount')} htmlFor="arrears-line-amount" required>
              <Input id="arrears-line-amount" inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </Field>
            <Field label={t('dueDate')} htmlFor="arrears-line-due">
              <DatePicker id="arrears-line-due" value={dueDate} onChange={setDueDate} max={municipalToday()} locale={locale === 'en' ? 'en' : 'ar'} />
            </Field>
            <Field label={t('oldReference')} htmlFor="arrears-line-reference">
              <Input id="arrears-line-reference" value={oldReference} maxLength={200} onChange={(event) => setOldReference(event.target.value)} />
            </Field>
          </div>
          <p className="text-sm text-muted-foreground">{t('note')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void run()} disabled={!input.success || busy || !token}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            {busy ? t('busy') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
