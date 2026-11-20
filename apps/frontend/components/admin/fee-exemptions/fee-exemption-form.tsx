'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  FEE_EXEMPTION_DECISION_REF_MAX,
  FEE_EXEMPTION_REASON,
  FEE_EXEMPTION_TEXT_MAX,
  getLabels,
  municipalToday,
  setUnitFeeExemptionSchema,
  type FeeExemptionReason,
  type SetUnitFeeExemptionInput,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** What an exemption is granted or amended with (0077, 0104). */
export interface FeeExemptionDraft {
  reason: FeeExemptionReason | '';
  note: string;
  decisionRef: string;
  /** `YYYY-MM-DD`, or '' for no last day. */
  validUntil: string;
}

export const EMPTY_FEE_EXEMPTION_DRAFT: FeeExemptionDraft = { reason: '', note: '', decisionRef: '', validUntil: '' };

/** The body `PUT …/fee-exemption` takes for a grant or an amendment, or null without a reason. */
export function grantInput(draft: FeeExemptionDraft): SetUnitFeeExemptionInput | null {
  if (!draft.reason) return null;
  return {
    reason: draft.reason,
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(draft.decisionRef.trim() ? { decisionRef: draft.decisionRef.trim() } : {}),
    validUntil: draft.validUntil || null,
  };
}

/**
 * Grant or amend a unit's exemption from fees: the reason, the reason in words
 * («سبب آخر» needs it), the council's decision number and an optional last day
 * (decision 1 of 2026-11-16). Checked by the server's own schema
 * (`setUnitFeeExemptionSchema`); a last day before today is offered by no
 * calendar and refused by the server (`FEE_EXEMPTION_VALID_UNTIL_PAST`).
 *
 * Errors show once a field has been left or a save tried (FRM-2). A unit
 * somebody rents or lives in rent-free is warned about: exempting it exempts
 * them too.
 */
export function FeeExemptionForm({
  idPrefix,
  locale,
  busy,
  initial = EMPTY_FEE_EXEMPTION_DRAFT,
  occupied,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** Unique per unit on the page, for the fields' ids. */
  idPrefix: string;
  locale: string;
  busy: boolean;
  initial?: FeeExemptionDraft;
  /** A tenant or a free occupant is recorded on the unit. */
  occupied: boolean;
  submitLabel: string;
  onSubmit: (input: SetUnitFeeExemptionInput) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('feeExemption');
  const labels = getLabels(locale);
  const [draft, setDraft] = useState<FeeExemptionDraft>(initial);
  const [touched, setTouched] = useState<{ note: boolean; decisionRef: boolean }>({ note: false, decisionRef: false });
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const decisionRef = useRef<HTMLInputElement>(null);

  const input = grantInput(draft);
  const parsed = input ? setUnitFeeExemptionSchema.safeParse(input) : null;
  const issueOn = (field: string) =>
    parsed && !parsed.success ? parsed.error.issues.find((issue) => String(issue.path[0]) === field) : undefined;
  const noteIssue = issueOn('note');
  const noteError = noteIssue ? (noteIssue.code === 'too_big' ? t('noteTooLong') : t('noteRequired')) : undefined;
  const decisionError = issueOn('decisionRef') ? t('decisionRefTooLong') : undefined;
  const set = (patch: Partial<FeeExemptionDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = () => {
    setTouched({ note: true, decisionRef: true });
    if (!input || !parsed?.success) {
      if (noteIssue) noteRef.current?.focus();
      else if (decisionError) decisionRef.current?.focus();
      return;
    }
    onSubmit(input);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t('intro')}</p>
        <p className="text-xs text-muted-foreground">{t('validUntilHint')}</p>
        {occupied ? <p className="text-xs text-warning">{t('occupiedWarning')}</p> : null}
      </div>
      <Field label={t('reason')} htmlFor={`${idPrefix}-reason`} required>
        <Select value={draft.reason} onValueChange={(value) => set({ reason: value as FeeExemptionReason })} disabled={busy}>
          <SelectTrigger id={`${idPrefix}-reason`}>
            <SelectValue placeholder={t('reasonPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {FEE_EXEMPTION_REASON.map((value) => (
              <SelectItem key={value} value={value}>
                {labels.feeExemptionReason[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t('note')}
        htmlFor={`${idPrefix}-note`}
        required={draft.reason === 'OTHER'}
        error={touched.note ? noteError : undefined}
      >
        <Textarea
          ref={noteRef}
          id={`${idPrefix}-note`}
          rows={2}
          maxLength={FEE_EXEMPTION_TEXT_MAX}
          value={draft.note}
          aria-invalid={(touched.note && Boolean(noteError)) || undefined}
          onChange={(event) => set({ note: event.target.value })}
          onBlur={() => setTouched((current) => ({ ...current, note: true }))}
          placeholder={t('notePlaceholder')}
          disabled={busy}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('decisionRef')}
          htmlFor={`${idPrefix}-decision`}
          error={touched.decisionRef ? decisionError : undefined}
        >
          <Input
            ref={decisionRef}
            id={`${idPrefix}-decision`}
            dir="ltr"
            maxLength={FEE_EXEMPTION_DECISION_REF_MAX}
            value={draft.decisionRef}
            aria-invalid={(touched.decisionRef && Boolean(decisionError)) || undefined}
            onChange={(event) => set({ decisionRef: event.target.value })}
            onBlur={() => setTouched((current) => ({ ...current, decisionRef: true }))}
            placeholder={t('decisionRefPlaceholder')}
            disabled={busy}
          />
        </Field>
        <Field label={t('validUntil')} htmlFor={`${idPrefix}-until`}>
          <DatePicker
            id={`${idPrefix}-until`}
            value={draft.validUntil}
            onChange={(value) => set({ validUntil: value })}
            min={municipalToday()}
            placeholder={t('noEnd')}
            locale={locale === 'en' ? 'en' : 'ar'}
            disabled={busy}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !draft.reason} onClick={submit}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
