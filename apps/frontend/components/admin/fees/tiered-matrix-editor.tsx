'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  getLabels,
  MAX_UNIT_LEVELS,
  STRUCTURAL_UNIT_TYPE,
  UNIT_TYPE,
  unitLevelsLabel,
  type UnitType,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ActionTooltip } from '@/components/ui/tooltip';
import { emptyBracket, matrixIssues, type BracketDraft } from '@/lib/fee-notice-draft';

/** The unit types a bracket can price: every type but a floor nobody occupies. */
const PRICED_UNIT_TYPES = UNIT_TYPE.filter(
  (type) => !(STRUCTURAL_UNIT_TYPE as readonly string[]).includes(type),
) as UnitType[];

/**
 * «جدول الفئات» — the brackets of a TIERED_AREA notice, as the clerk types them
 * (decisions D1 and D7, docs/fees-system-rearchitecture-specification.md).
 *
 * Each bracket names the unit types and the level count it prices — a table
 * for one-level flats, another for duplexes — an area range from «من» up to,
 * not including, «حتى», and the fee. The table is checked by the schema the
 * server checks it by (`matrixIssues`, over `feeMatrixSchema`): no two brackets
 * of one scale overlap, none leaves a gap, only the last is open-ended. A
 * bracket's problems show once it has been edited. Their words are the
 * schema's, Arabic on both locales, as every validation message is today.
 */
export function TieredMatrixEditor({
  value,
  onChange,
  locale,
}: {
  value: readonly BracketDraft[];
  onChange: (next: BracketDraft[]) => void;
  locale: string;
}) {
  const t = useTranslations('fees.matrix');
  const labels = getLabels(locale);
  const issues = matrixIssues(value);
  const anyTouched = value.some((draft) => draft.touched);

  const update = (index: number, patch: Partial<BracketDraft>) =>
    onChange(value.map((draft, at) => (at === index ? { ...draft, ...patch, touched: true } : draft)));
  const remove = (index: number) => onChange(value.filter((_, at) => at !== index));

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('rangeHint')}</p>

      {value.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="divide-y rounded-md border">
          {value.map((draft, index) => {
            const errors = draft.touched ? (issues.rows[index] ?? {}) : {};
            const id = (field: string) => `${draft.key}-${field}`;
            const name = draft.code.trim() || t('newBracket');
            return (
              <li key={draft.key} className="space-y-3 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{t('rowTitle', { code: name })}</h3>
                  <ActionTooltip label={t('remove', { code: name })}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('remove', { code: name })}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </ActionTooltip>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('code')} htmlFor={id('code')} required error={errors.code}>
                    <Input
                      id={id('code')}
                      dir="ltr"
                      className="font-mono"
                      placeholder="A"
                      value={draft.code}
                      onChange={(event) => update(index, { code: event.target.value })}
                    />
                  </Field>
                  <Field label={t('label')} htmlFor={id('label')} required error={errors.labelAr}>
                    <Input
                      id={id('label')}
                      placeholder={t('labelPlaceholder')}
                      value={draft.labelAr}
                      onChange={(event) => update(index, { labelAr: event.target.value })}
                    />
                  </Field>
                  <Field label={t('minArea')} htmlFor={id('min')} required error={errors.minArea}>
                    <Input
                      id={id('min')}
                      inputMode="decimal"
                      dir="ltr"
                      className="tabular-nums"
                      placeholder="0"
                      value={draft.minArea}
                      onChange={(event) => update(index, { minArea: event.target.value })}
                    />
                  </Field>
                  <Field label={t('maxArea')} htmlFor={id('max')} optionalLabel={t('noCeiling')} error={errors.maxArea}>
                    <Input
                      id={id('max')}
                      inputMode="decimal"
                      dir="ltr"
                      className="tabular-nums"
                      placeholder={t('noCeiling')}
                      value={draft.maxArea}
                      onChange={(event) => update(index, { maxArea: event.target.value })}
                    />
                  </Field>
                  <Field label={t('levels')} htmlFor={id('levels')} required error={errors.levels}>
                    <Select value={draft.levels} onValueChange={(levels) => update(index, { levels })}>
                      <SelectTrigger id={id('levels')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: MAX_UNIT_LEVELS }, (_, at) => at + 1).map((count) => (
                          <SelectItem key={count} value={String(count)}>
                            {unitLevelsLabel(count, locale) ?? t('oneLevel')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t('amount')} htmlFor={id('amount')} required error={errors.amount}>
                    <CurrencyInput
                      id={id('amount')}
                      unit={t('lbp')}
                      placeholder="1,000,000"
                      value={draft.amount}
                      invalid={Boolean(errors.amount)}
                      onChange={(amount) => update(index, { amount })}
                    />
                  </Field>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t('unitTypes')}</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {PRICED_UNIT_TYPES.map((type) => {
                      const checkboxId = id(`type-${type}`);
                      return (
                        <label key={type} htmlFor={checkboxId} className="flex min-h-touch items-center gap-2 text-sm">
                          <Checkbox
                            id={checkboxId}
                            checked={draft.unitTypes.includes(type)}
                            onCheckedChange={(next) =>
                              update(index, {
                                unitTypes:
                                  next === true
                                    ? [...draft.unitTypes, type]
                                    : draft.unitTypes.filter((chosen) => chosen !== type),
                              })
                            }
                          />
                          {labels.unitType[type]}
                        </label>
                      );
                    })}
                  </div>
                  {errors.unitTypes ? (
                    <p role="alert" className="text-xs text-destructive">
                      {errors.unitTypes}
                    </p>
                  ) : null}
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}

      {anyTouched && issues.table ? (
        <p role="alert" className="text-xs text-destructive">
          {issues.table}
        </p>
      ) : null}

      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, emptyBracket()])}>
        <Plus className="size-4" aria-hidden />
        {t('add')}
      </Button>
    </div>
  );
}
