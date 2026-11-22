'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { REQUEST_PROPERTY_MODE, updateRequestFormSchema, type RequestFormView } from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { updateRequestForm } from '@/lib/request-forms-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * A form's own settings: its name, fee, what it asks beside its questions (the property, the applicant's capacity, the
 * purpose — F6) and the statement draft (F9). Not versioned (F2): saved on their own, at any time, and the fee in force is
 * the one charged when the bill is raised (D1). Read only for a role that cannot write (`canManage`) and for an archived form.
 */
export function FormSettings({
  tenant,
  token,
  locale,
  form,
  canManage,
  onSaved,
}: {
  tenant: string;
  token: string;
  locale: string;
  form: RequestFormView;
  canManage: boolean;
  onSaved: (form: RequestFormView) => void;
}): React.JSX.Element {
  const t = useTranslations('requests.forms.builder.settings');
  const modes = useTranslations('requests.forms.builder.settings.propertyModes');
  const toast = useToast();
  const readOnly = !canManage || form.archivedAt !== null;

  const [nameAr, setNameAr] = useState(form.nameAr);
  const [nameEn, setNameEn] = useState(form.nameEn ?? '');
  const [fee, setFee] = useState(() => (form.feeAmount > 0 ? formatTypedAmount(String(form.feeAmount), 0) : ''));
  const [propertyMode, setPropertyMode] = useState(form.propertyMode);
  const [askCapacity, setAskCapacity] = useState(form.askCapacity);
  const [askPurpose, setAskPurpose] = useState(form.askPurpose);
  const [requiresNoDues, setRequiresNoDues] = useState(form.requiresNoDues);
  const [template, setTemplate] = useState(form.statementTemplate ?? '');
  const [errors, setErrors] = useState<{ name?: string; fee?: string; save?: string }>({});
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || readOnly) return;
    const parsed = updateRequestFormSchema.safeParse({
      nameAr,
      nameEn,
      feeAmount: parseAmount(fee),
      propertyMode,
      askCapacity,
      askPurpose,
      requiresNoDues,
      statementTemplate: template,
      sortOrder: form.sortOrder,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'nameAr') next.name = t('nameRequired');
        else if (issue.path[0] === 'feeAmount') next.fee = t('feeInvalid');
        else next.save = t('saveError');
      }
      setErrors(next);
      document.getElementById(next.name ? 'form-name-ar' : next.fee ? 'form-fee' : 'form-name-ar')?.focus();
      return;
    }
    setErrors({});
    inFlight.current = true;
    setSaving(true);
    try {
      onSaved(await updateRequestForm(tenant, token, form.id, parsed.data));
      toast.success(t('saved'));
    } catch (caught) {
      logApiError(caught);
      setErrors({ save: caught instanceof Error && caught.message ? caught.message : t('saveError') });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <h2>{t('title')}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="form-name-ar" label={t('nameAr')} required error={errors.name}>
              <Input id="form-name-ar" dir="rtl" value={nameAr} disabled={readOnly} invalid={Boolean(errors.name)} onChange={(event) => setNameAr(event.target.value)} />
            </Field>
            <Field htmlFor="form-name-en" label={t('nameEn')}>
              <Input id="form-name-en" dir="ltr" value={nameEn} disabled={readOnly} onChange={(event) => setNameEn(event.target.value)} />
            </Field>
            <Field htmlFor="form-fee" label={t('fee')} error={errors.fee}>
              <CurrencyInput
                id="form-fee"
                unit={currencyUnit('LBP', locale)}
                value={fee}
                placeholder="0"
                disabled={readOnly}
                invalid={Boolean(errors.fee)}
                onChange={(raw) => setFee(formatTypedAmount(raw, 0))}
              />
            </Field>
            <Field htmlFor="form-property-mode" label={t('propertyMode')}>
              <SegmentedControl
                aria-label={t('propertyMode')}
                size="field"
                value={propertyMode}
                disabled={readOnly}
                onChange={(value) => {
                  setPropertyMode(value as typeof propertyMode);
                  // The dues check needs a required card: leaving it off the check is the only consistent answer.
                  if (value !== 'REQUIRED') setRequiresNoDues(false);
                }}
                options={REQUEST_PROPERTY_MODE.map((mode) => ({ value: mode, label: modes(mode) }))}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('nameEnHint')} {t('feeHint')} {t('propertyModeHint')}</p>

          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={askCapacity} disabled={readOnly} onCheckedChange={(next) => setAskCapacity(next === true)} />
              <span className="space-y-0.5">
                <span className="block font-medium">{t('askCapacity')}</span>
                <span className="block text-xs text-muted-foreground">{t('askCapacityHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={requiresNoDues}
                disabled={readOnly || propertyMode !== 'REQUIRED'}
                onCheckedChange={(next) => setRequiresNoDues(next === true)}
              />
              <span className="space-y-0.5">
                <span className="block font-medium">{t('requiresNoDues')}</span>
                <span className="block text-xs text-muted-foreground">{t('requiresNoDuesHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={askPurpose} disabled={readOnly} onCheckedChange={(next) => setAskPurpose(next === true)} />
              <span className="space-y-0.5">
                <span className="block font-medium">{t('askPurpose')}</span>
                <span className="block text-xs text-muted-foreground">{t('askPurposeHint')}</span>
              </span>
            </label>
          </div>

          <Field htmlFor="form-template" label={t('template')} optionalLabel={t('templateOptional')}>
            <Textarea id="form-template" rows={3} maxLength={5000} value={template} disabled={readOnly} onChange={(event) => setTemplate(event.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground">{t('templateHint')}</p>

          {errors.save ? (
            <p role="alert" className="text-sm text-destructive">
              {errors.save}
            </p>
          ) : null}
          {readOnly ? null : (
            <Button type="submit" disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
