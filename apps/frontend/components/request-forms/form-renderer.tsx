'use client';

import { FileText, Lock, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  REQUEST_ATTACHMENT_MIME_TYPES,
  type OfferedRequestField,
  type RequestAnswerIssueCode,
} from '@mechanization/shared-schemas';
import { REQUEST_ATTACHMENT_MAX_MB } from '@/lib/request-attachments';
import type { AnswerInput } from '@/lib/request-form-fill';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * The one renderer of a request form's questions (docs/request-forms-plan.md §6), used by the citizen's wizard and the
 * counter's form alike: one question per type, each on the kit's own control, the words in the person's language (Arabic is
 * always there; English falls back to it, F10). It holds no state: what was typed, and what is wrong with it, come in as props.
 *
 * A question copied from the citizen's file (F4) is shown, never asked: it says where its value comes from, and when the file
 * has none, says the request waits for a clerk to complete the file. A file question's papers are the screen's own (`PaperFields`),
 * because compressing and sending them is its business.
 */

/** A question's words in the page's language, falling back to Arabic. */
export function wording(field: { labelAr: string; labelEn?: string | null }, locale: string): string {
  return locale === 'en' && field.labelEn ? field.labelEn : field.labelAr;
}
function hintOf(field: { helpAr?: string | null; helpEn?: string | null }, locale: string): string | undefined {
  const text = locale === 'en' && field.helpEn ? field.helpEn : field.helpAr;
  return text || undefined;
}

/** A form's name in the page's language, falling back to Arabic. */
export function formName(form: { nameAr: string; nameEn?: string | null }, locale: string): string {
  return locale === 'en' && form.nameEn ? form.nameEn : form.nameAr;
}

export function inputId(prefix: string, key: string): string {
  return `${prefix}-${key}`;
}

/** The questions a person answers, in the form's order, each with its problem beside it. */
export function AnswerFields({
  fields,
  values,
  issues,
  locale,
  disabled = false,
  idPrefix,
  onChange,
}: {
  fields: readonly OfferedRequestField[];
  values: Readonly<Record<string, AnswerInput | undefined>>;
  issues: Readonly<Record<string, RequestAnswerIssueCode | undefined>>;
  locale: string;
  disabled?: boolean;
  /** Distinguishes two renderers on one page, and anchors the focus after a refusal. */
  idPrefix: string;
  onChange: (key: string, value: AnswerInput) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {fields
        .filter((field) => field.type !== 'FILE')
        .map((field) =>
          field.linkedSource !== null ? (
            <CopiedField key={field.key} field={field} locale={locale} />
          ) : (
            <Question
              key={field.key}
              field={field}
              value={values[field.key]}
              issue={issues[field.key]}
              locale={locale}
              disabled={disabled}
              id={inputId(idPrefix, field.key)}
              onChange={(value) => onChange(field.key, value)}
            />
          ),
        )}
    </div>
  );
}

/** What the file holds for a copied question: shown with where it came from, or the notice that the request waits. */
function CopiedField({ field, locale }: { field: OfferedRequestField; locale: string }): React.JSX.Element {
  const t = useTranslations('requestForms.fill');
  const value = field.linkedValue;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{wording(field, locale)}</p>
      {value ? (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <bdi dir="auto">{field.type === 'DOCUMENT_NUMBER' ? maskedTail(value) : value}</bdi>
        </p>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {value === null ? t('blockedField') : t('copiedAtFiling')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('fromFile')}</p>
    </div>
  );
}

/** A number from the file, shown with all but its last three characters hidden, as the citizen reads it on their own request. */
function maskedTail(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 3 ? '•'.repeat(characters.length) : '•'.repeat(characters.length - 3) + characters.slice(-3).join('');
}

function Question({
  field,
  value,
  issue,
  locale,
  disabled,
  id,
  onChange,
}: {
  field: OfferedRequestField;
  value: AnswerInput | undefined;
  issue: RequestAnswerIssueCode | undefined;
  locale: string;
  disabled: boolean;
  id: string;
  onChange: (value: AnswerInput) => void;
}): React.JSX.Element {
  const issues = useTranslations('requestForms.fill.issues');
  const t = useTranslations('requestForms.fill');
  const text = typeof value === 'string' ? value : '';
  const error = issue ? issues(issue, issueParams(field, issue)) : undefined;
  const help = hintOf(field, locale);
  const choiceLabel = (choice: { labelAr: string; labelEn?: string | null }) => wording(choice, locale);
  const wrap = (control: React.ReactNode) => (
    <Field htmlFor={id} label={wording(field, locale)} error={error} required>
      {control}
      {help ? <p className="mt-1 text-xs text-muted-foreground">{help}</p> : null}
    </Field>
  );

  switch (field.type) {
    case 'SHORT_TEXT':
      return wrap(
        <Input id={id} value={text} disabled={disabled} invalid={Boolean(error)} maxLength={field.config.maxLength ?? 500} onChange={(event) => onChange(event.target.value)} />,
      );
    case 'LONG_TEXT':
      return wrap(
        <Textarea id={id} rows={4} value={text} disabled={disabled} aria-invalid={Boolean(error)} maxLength={field.config.maxLength ?? 5000} onChange={(event) => onChange(event.target.value)} />,
      );
    case 'INTEGER':
    case 'DECIMAL':
      return wrap(
        <Input id={id} dir="ltr" inputMode={field.type === 'INTEGER' ? 'numeric' : 'decimal'} value={text} disabled={disabled} invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />,
      );
    case 'DATE':
      return wrap(
        <DatePicker
          id={id}
          value={text}
          onChange={(day) => onChange(day)}
          min={field.config.min}
          max={field.config.max}
          locale={locale === 'en' ? 'en' : 'ar'}
        />,
      );
    case 'PHONE':
      return wrap(
        <Input id={id} type="tel" dir="ltr" inputMode="tel" autoComplete="tel" value={text} disabled={disabled} invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />,
      );
    case 'DOCUMENT_NUMBER':
      return wrap(
        <Input id={id} dir="ltr" value={text} disabled={disabled} invalid={Boolean(error)} maxLength={40} onChange={(event) => onChange(event.target.value)} />,
      );
    case 'SINGLE_CHOICE':
      return wrap(
        <Select value={text} disabled={disabled} onValueChange={(next) => onChange(next)}>
          <SelectTrigger id={id} aria-invalid={Boolean(error)}>
            <SelectValue placeholder={t('choose')} />
          </SelectTrigger>
          <SelectContent>
            {field.config.choices.map((choice) => (
              <SelectItem key={choice.key} value={choice.key}>
                {choiceLabel(choice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      );
    case 'MULTI_CHOICE': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset className="space-y-2" aria-describedby={error ? `${id}-error` : undefined}>
          <legend className="text-sm font-medium">
            {wording(field, locale)} <span className="text-destructive">*</span>
          </legend>
          {field.config.choices.map((choice) => (
            <label key={choice.key} className="flex min-h-touch items-center gap-2 text-sm">
              <Checkbox
                checked={picked.includes(choice.key)}
                disabled={disabled}
                onCheckedChange={(next) => onChange(next === true ? [...picked, choice.key] : picked.filter((key) => key !== choice.key))}
              />
              {choiceLabel(choice)}
            </label>
          ))}
          {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    }
    case 'YES_NO':
      return wrap(
        <SegmentedControl
          aria-label={wording(field, locale)}
          size="field"
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          disabled={disabled}
          invalid={Boolean(error)}
          onChange={(next) => onChange(next === 'yes')}
          options={[
            { value: 'yes', label: t('yes') },
            { value: 'no', label: t('no') },
          ]}
        />,
      );
    default:
      return <></>;
  }
}

/** The bound a message names for an issue (`BELOW_MIN`'s `min` …): taken from the question's own options. */
function issueParams(field: OfferedRequestField, issue: RequestAnswerIssueCode): Record<string, string | number> {
  const config = field.config as unknown as Record<string, unknown>;
  const num = (name: string): number => (typeof config[name] === 'number' ? (config[name] as number) : 0);
  const str = (name: string): string => (typeof config[name] === 'string' ? (config[name] as string) : '');
  switch (issue) {
    case 'TOO_SHORT':
      return { min: field.type === 'SHORT_TEXT' || field.type === 'LONG_TEXT' ? (num('minLength') || 1) : 1 };
    case 'TOO_LONG':
      return { max: num('maxLength') || (field.type === 'LONG_TEXT' ? 5000 : 500) };
    case 'BELOW_MIN':
      return { min: field.type === 'DATE' ? str('min') : num('min') };
    case 'ABOVE_MAX':
      return { max: num('max') };
    case 'BEFORE_MIN_DATE':
      return { min: str('min') };
    case 'AFTER_MAX_DATE':
      return { max: str('max') };
    case 'TOO_MANY_DECIMALS':
      return { decimals: num('decimals') || 2 };
    case 'TOO_FEW_CHOICES':
      return { min: num('minSelected') || 1 };
    case 'TOO_MANY_CHOICES':
      return { max: num('maxSelected') || (Array.isArray(config.choices) ? (config.choices as unknown[]).length : 1) };
    default:
      return {};
  }
}

/** A paper queued for a question: the screen sends it once the request exists. */
export interface QueuedFormPaper {
  key: string;
  fieldKey: string;
  file: File;
}

/**
 * The file questions: for each, what is queued and the control that adds more, up to the question's own count. The kinds of file
 * the question takes narrow the file dialog; the server judges the bytes again (`accept` is the browser's courtesy).
 */
export function PaperFields({
  fields,
  papers,
  issues,
  locale,
  preparing,
  idPrefix,
  onPick,
  onRemove,
}: {
  fields: readonly OfferedRequestField[];
  papers: readonly QueuedFormPaper[];
  /** A question left without its paper after pressing «التالي». */
  issues: Readonly<Record<string, boolean | undefined>>;
  locale: string;
  preparing: boolean;
  idPrefix: string;
  onPick: (field: OfferedRequestField, files: File[]) => void;
  onRemove: (key: string) => void;
}): React.JSX.Element {
  const t = useTranslations('requestForms.fill');
  return (
    <div className="space-y-5">
      {fields
        .filter((field) => field.type === 'FILE')
        .map((field) => {
          const mine = papers.filter((paper) => paper.fieldKey === field.key);
          const max = field.type === 'FILE' ? field.config.maxFiles : 1;
          const accept = field.type === 'FILE' ? field.config.accept.join(',') : REQUEST_ATTACHMENT_MIME_TYPES.join(',');
          const missing = issues[field.key] && mine.length === 0;
          const id = inputId(idPrefix, field.key);
          const help = hintOf(field, locale);
          return (
            <section key={field.key} className="space-y-2" aria-labelledby={`${id}-heading`}>
              <h3 id={`${id}-heading`} className="text-sm font-medium">
                {wording(field, locale)} <span className="text-destructive">*</span>
              </h3>
              {help ? <p className="text-sm text-muted-foreground">{help}</p> : null}
              {mine.length > 0 ? (
                <ul className="space-y-2">
                  {mine.map((paper) => (
                    <li key={paper.key} className="flex items-center gap-3 rounded-lg border p-3">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <bdi className="block truncate text-sm font-medium">{paper.file.name}</bdi>
                        <span className="block text-xs text-muted-foreground">{t('size', { kb: Math.max(1, Math.round(paper.file.size / 1024)) })}</span>
                      </span>
                      <Button type="button" variant="ghost" size="icon" aria-label={t('removePaper', { name: paper.file.name })} onClick={() => onRemove(paper.key)}>
                        <X className="size-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {mine.length < max ? (
                <FileInput
                  id={id}
                  accept={accept}
                  multiple={max - mine.length > 1}
                  disabled={preparing}
                  onSelect={(files) => onPick(field, files.slice(0, max - mine.length))}
                  label={preparing ? t('preparing') : t('pickPaper')}
                  hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB })}
                />
              ) : null}
              {missing ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('paperRequired')}
                </p>
              ) : null}
            </section>
          );
        })}
    </div>
  );
}
