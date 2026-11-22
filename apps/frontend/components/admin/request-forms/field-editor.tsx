'use client';

import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  REQUEST_ATTACHMENT_MAX_BYTES,
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_ATTACHMENT_MIME_TYPES,
  REQUEST_ATTACHMENT_TYPE,
  REQUEST_FORM_MAX_CHOICES,
  getLabels,
  type RequestAttachmentType,
} from '@mechanization/shared-schemas';
import { changeType, emptyChoice, linkableSources, type FieldDraft, type FieldProblem } from '@/lib/request-form-draft';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { REQUEST_FIELD_TYPE } from '@mechanization/shared-schemas';

const MAX_MB = Math.round(REQUEST_ATTACHMENT_MAX_BYTES / (1024 * 1024));

/** What a problem is worded as, under the question it names. */
function useProblemText(): (problem: FieldProblem) => string {
  const t = useTranslations('requests.forms.builder.problems');
  return (problem) => (problem === 'FILES_RANGE' ? t(problem, { max: REQUEST_ATTACHMENTS_MAX }) : t(problem));
}

/**
 * One question of the form, edited in place (docs/request-forms-plan.md §6): its type, its words, the file field it copies
 * from, and the options of its type. The key is never shown for typing — it is made once and kept across versions — and every
 * question is required, so there is no switch for that (F4). The shared schema judges validity; `problems` are only what the
 * manager can read and fix.
 */
export function FieldEditor({
  field,
  index,
  total,
  locale,
  problems,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  field: FieldDraft;
  index: number;
  total: number;
  locale: string;
  problems: readonly FieldProblem[];
  disabled: boolean;
  onChange: (next: FieldDraft) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const t = useTranslations('requests.forms.builder.field');
  const problemText = useProblemText();
  const labels = getLabels(locale);
  const id = (name: string) => `field-${field.uid}-${name}`;
  const set = (patch: Partial<FieldDraft>) => onChange({ ...field, ...patch });
  const has = (...kinds: FieldProblem[]) => problems.find((problem) => kinds.includes(problem));
  const text = (...kinds: FieldProblem[]) => {
    const found = has(...kinds);
    return found ? problemText(found) : undefined;
  };
  const sources = linkableSources(field.type);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('number', { n: index + 1 })}</h3>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('moveUp')}
              title={t('moveUp')}
              disabled={disabled || index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('moveDown')}
              title={t('moveDown')}
              disabled={disabled || index === total - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('remove')} title={t('remove')} disabled={disabled} onClick={onRemove}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={id('type')} label={t('type')}>
            <Select value={field.type} disabled={disabled} onValueChange={(value) => onChange(changeType(field, value as FieldDraft['type']))}>
              <SelectTrigger id={id('type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REQUEST_FIELD_TYPE.map((type) => (
                  <SelectItem key={type} value={type}>
                    {labels.requestFieldType[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {sources.length > 0 ? (
            <Field htmlFor={id('link')} label={t('link')}>
              <Select
                value={field.linkedSource ?? 'NONE'}
                disabled={disabled}
                onValueChange={(value) => set({ linkedSource: value === 'NONE' ? null : (value as FieldDraft['linkedSource']) })}
              >
                <SelectTrigger id={id('link')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">{t('linkNone')}</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source} value={source}>
                      {labels.requestLinkedSource[source]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>

        {sources.length > 0 ? <p className="text-xs text-muted-foreground">{t('linkHint')}</p> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={id('labelAr')} label={t('labelAr')} required error={text('LABEL_REQUIRED', 'LABEL_TOO_LONG')}>
            <Input
              id={id('labelAr')}
              dir="rtl"
              value={field.labelAr}
              disabled={disabled}
              invalid={Boolean(has('LABEL_REQUIRED', 'LABEL_TOO_LONG'))}
              onChange={(event) => set({ labelAr: event.target.value })}
            />
          </Field>
          <Field htmlFor={id('labelEn')} label={t('labelEn')} optionalLabel={t('optional')}>
            <Input id={id('labelEn')} dir="ltr" value={field.labelEn} disabled={disabled} onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
          <Field htmlFor={id('helpAr')} label={t('helpAr')} optionalLabel={t('optional')}>
            <Input id={id('helpAr')} dir="rtl" value={field.helpAr} disabled={disabled} onChange={(event) => set({ helpAr: event.target.value })} />
          </Field>
          <Field htmlFor={id('helpEn')} label={t('helpEn')} optionalLabel={t('optional')}>
            <Input id={id('helpEn')} dir="ltr" value={field.helpEn} disabled={disabled} onChange={(event) => set({ helpEn: event.target.value })} />
          </Field>
        </div>

        {field.linkedSource === null ? <TypeOptions field={field} id={id} disabled={disabled} set={set} onChange={onChange} text={text} has={has} locale={locale} /> : null}
      </CardContent>
    </Card>
  );
}

/** The options one type has: bounds for text and numbers, the choices, the papers. A linked question has none: its value is the file's. */
function TypeOptions({
  field,
  id,
  disabled,
  set,
  onChange,
  text,
  has,
  locale,
}: {
  field: FieldDraft;
  id: (name: string) => string;
  disabled: boolean;
  set: (patch: Partial<FieldDraft>) => void;
  onChange: (next: FieldDraft) => void;
  text: (...kinds: FieldProblem[]) => string | undefined;
  has: (...kinds: FieldProblem[]) => FieldProblem | undefined;
  locale: string;
}): React.JSX.Element | null {
  const t = useTranslations('requests.forms.builder.field');
  const labels = getLabels(locale);
  const number = (name: string, label: string, value: string, patch: (next: string) => Partial<FieldDraft>, errors: FieldProblem[]) => (
    <Field htmlFor={id(name)} label={label} optionalLabel={name === 'decimals' ? undefined : t('optional')} error={text(...errors)}>
      <Input
        id={id(name)}
        inputMode="decimal"
        dir="ltr"
        value={value}
        disabled={disabled}
        invalid={Boolean(has(...errors))}
        onChange={(event) => set(patch(event.target.value))}
      />
    </Field>
  );

  switch (field.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {number('minLength', t('minLength'), field.minLength, (v) => ({ minLength: v }), ['NUMBER', 'RANGE'])}
          {number('maxLength', t('maxLength'), field.maxLength, (v) => ({ maxLength: v }), ['NUMBER'])}
        </div>
      );
    case 'INTEGER':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {number('min', t('min'), field.min, (v) => ({ min: v }), ['NUMBER', 'RANGE', 'INVALID'])}
          {number('max', t('max'), field.max, (v) => ({ max: v }), ['NUMBER'])}
        </div>
      );
    case 'DECIMAL':
      return (
        <div className="grid gap-4 sm:grid-cols-3">
          {number('min', t('min'), field.min, (v) => ({ min: v }), ['NUMBER', 'RANGE'])}
          {number('max', t('max'), field.max, (v) => ({ max: v }), ['NUMBER'])}
          {number('decimals', t('decimals'), field.decimals, (v) => ({ decimals: v }), ['INVALID'])}
        </div>
      );
    case 'DATE':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={id('minDate')} label={t('minDate')} optionalLabel={t('optional')} error={text('DATE', 'RANGE')}>
            <Input id={id('minDate')} dir="ltr" placeholder="YYYY-MM-DD" value={field.minDate} disabled={disabled} invalid={Boolean(has('DATE', 'RANGE'))} onChange={(event) => set({ minDate: event.target.value })} />
          </Field>
          <Field htmlFor={id('maxDate')} label={t('maxDate')} optionalLabel={t('optional')}>
            <Input id={id('maxDate')} dir="ltr" placeholder="YYYY-MM-DD" value={field.maxDate} disabled={disabled} onChange={(event) => set({ maxDate: event.target.value })} />
          </Field>
        </div>
      );
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE':
      return (
        <div className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('choices')}</legend>
            {field.choices.map((choice, position) => (
              <div key={choice.uid} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <Field htmlFor={`${id('choice')}-${choice.uid}-ar`} label={t('choiceAr', { n: position + 1 })} required>
                  <Input
                    id={`${id('choice')}-${choice.uid}-ar`}
                    dir="rtl"
                    value={choice.labelAr}
                    disabled={disabled}
                    invalid={Boolean(has('CHOICE_LABEL_REQUIRED')) && choice.labelAr.trim() === ''}
                    onChange={(event) =>
                      set({ choices: field.choices.map((entry) => (entry.uid === choice.uid ? { ...entry, labelAr: event.target.value } : entry)) })
                    }
                  />
                </Field>
                <Field htmlFor={`${id('choice')}-${choice.uid}-en`} label={t('choiceEn', { n: position + 1 })} optionalLabel={t('optional')}>
                  <Input
                    id={`${id('choice')}-${choice.uid}-en`}
                    dir="ltr"
                    value={choice.labelEn}
                    disabled={disabled}
                    onChange={(event) =>
                      set({ choices: field.choices.map((entry) => (entry.uid === choice.uid ? { ...entry, labelEn: event.target.value } : entry)) })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('removeChoice')}
                  title={t('removeChoice')}
                  disabled={disabled || field.choices.length <= 2}
                  onClick={() => set({ choices: field.choices.filter((entry) => entry.uid !== choice.uid) })}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            {text('CHOICES_FEW', 'CHOICE_LABEL_REQUIRED') ? (
              <p role="alert" className="text-sm text-destructive">
                {text('CHOICES_FEW', 'CHOICE_LABEL_REQUIRED')}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || field.choices.length >= REQUEST_FORM_MAX_CHOICES}
              onClick={() => onChange({ ...field, choices: [...field.choices, emptyChoice(field.choices.map((entry) => entry.key))] })}
            >
              <Plus className="size-4" aria-hidden />
              {t('addChoice')}
            </Button>
          </fieldset>
          {field.type === 'MULTI_CHOICE' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {number('minSelected', t('minSelected'), field.minSelected, (v) => ({ minSelected: v }), ['NUMBER', 'SELECTED_RANGE'])}
              {number('maxSelected', t('maxSelected'), field.maxSelected, (v) => ({ maxSelected: v }), ['NUMBER'])}
            </div>
          ) : null}
        </div>
      );
    case 'FILE':
      return (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={id('attachmentType')} label={t('attachmentType')}>
              <Select value={field.attachmentType} disabled={disabled} onValueChange={(value) => set({ attachmentType: value as RequestAttachmentType })}>
                <SelectTrigger id={id('attachmentType')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_ATTACHMENT_TYPE.map((type) => (
                    <SelectItem key={type} value={type}>
                      {labels.requestAttachmentType[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {number('maxFiles', t('maxFiles'), field.maxFiles, (v) => ({ maxFiles: v }), ['FILES_RANGE'])}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('accept')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {REQUEST_ATTACHMENT_MIME_TYPES.map((mime) => (
                <label key={mime} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={field.accept.includes(mime)}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      set({
                        accept: next === true
                          ? REQUEST_ATTACHMENT_MIME_TYPES.filter((candidate) => candidate === mime || field.accept.includes(candidate))
                          : field.accept.filter((candidate) => candidate !== mime),
                      })
                    }
                  />
                  {t(`mime.${mime}`)}
                </label>
              ))}
            </div>
            {text('ACCEPT_EMPTY') ? (
              <p role="alert" className="text-sm text-destructive">
                {text('ACCEPT_EMPTY')}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('fileHint', { mb: MAX_MB })}</p>
          </fieldset>
        </div>
      );
    default:
      return null;
  }
}
