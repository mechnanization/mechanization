'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, CornerDownRight, Layers, LayoutList, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getLabels, MAX_UNIT_LEVELS, unitLevelsLabel } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionTooltip } from '@/components/ui/tooltip';
import { formatTypedAmount } from '@/lib/currency';
import {
  chainedFollowers,
  coverage,
  extendBracket,
  extensionsOf,
  floorAfter,
  matrixIssues,
  nextBracket,
  nextExtensionLevels,
  presetOf,
  PRICED_UNIT_TYPES,
  standardBrackets,
  UNIT_TYPE_PRESET_KEYS,
  UNIT_TYPE_PRESETS,
  wholeMetres,
  withExtensions,
  type BracketDraft,
  type BracketField,
  type CoverageScale,
  type UnitTypePreset,
} from '@/lib/fee-notice-draft';
import { cn } from '@/lib/utils';

const FIELD_SUFFIX: Record<BracketField, string> = {
  code: 'code',
  labelAr: 'label',
  minArea: 'min',
  maxArea: 'max',
  levels: 'levels',
  amount: 'amount',
  // The button that opens the row's unit types.
  unitTypes: 'types',
};

/** A column heading: wrapped onto two lines over a narrow column rather than widening it. */
const HEAD = 'h-auto whitespace-normal px-1.5 py-2 align-bottom leading-tight';

/** The id of one bracket's field, so the wizard can put the focus on the one to fix (FRM-2). */
export function bracketFieldId(key: string, field: BracketField): string {
  return `${key}-${FIELD_SUFFIX[field]}`;
}

/** «أضف فئة»: where the focus goes when the table is refused for having no bracket at all. */
export const MATRIX_ADD_ID = 'matrix-add';

/** Puts the focus on a bracket's field after the paint that drew it. */
function focusField(key: string, field: BracketField) {
  requestAnimationFrame(() => document.getElementById(bracketFieldId(key, field))?.focus());
}

/**
 * «جدول الفئات» — the brackets of a TIERED_AREA notice, as the clerk types them
 * (decisions D1 and D7, docs/fees-system-rearchitecture-specification.md), on
 * the wizard's step of the same name.
 *
 * A table, one bracket a row, every cell an input: the code, the name, the area
 * range from «من» to «حتى» in whole metres, both included («0 – 50», then
 * «51 – 60»; `toMatrix` sends the engine's form), the level count, the unit types
 * and the fee, and a delete button. Nine brackets read down a column — the
 * floors under each other, the fees under each other — where the cards they
 * were in had to be read one at a time. A cell has no visible label of its
 * own; its column heading is that, and a hidden `<label>` names it with its row
 * for a screen reader. Below `md` the table scrolls sideways inside its frame,
 * never the page (LAY-5).
 *
 * The table is checked by the schema the server checks it by (`matrixIssues`,
 * over `feeMatrixSchema`): no two brackets of one scale overlap, none leaves a
 * gap, only the last is open-ended. A row's problems mark its cells — a red
 * border, the words in the wizard's toast (FRM-2's exception) — once the focus
 * has left the row, or once «التالي» was pressed (FRM-2: not per
 * keystroke, where typing «1» into «من» would flag an overlap before the «0»
 * after it). A choice — the level count, a unit type — is a finished answer and
 * counts at once. Their words are the schema's, Arabic on both locales, as
 * every validation message is today.
 *
 * Nine brackets typed row by row was the slow part, so: «نموذج 9 فئات» fills
 * the areas of A to I and leaves the fees (`standardBrackets`); a new bracket
 * is named next in turn — «A» and «الفئة أ», then «B» and «الفئة ب» — and
 * starts where the last ends (`nextBracket`); retyping a ceiling moves the
 * floor of the bracket that started there (`chainedFollowers`); the unit types
 * take one press for a group (`UNIT_TYPE_PRESETS`), in a menu that also holds
 * each type on its own; and a bar per scale over the table shows it whole, its
 * gaps and overlaps where they fall, each bracket a press away (`coverage`).
 *
 * A duplex or a triplex is priced by «مدّ الفئة», the button beside a row's
 * delete (the user's design, 2026-10-27): each press adds the next level
 * count's row under it — «D-2», then «D-3», up to `MAX_UNIT_LEVELS` — with the
 * row's name, range and unit types, which follow it, and a price of its
 * own (`extendBracket`, `withExtensions`). Deleting the row deletes them.
 */
export function TieredMatrixEditor({
  value,
  onChange,
  locale,
  showErrors = false,
}: {
  value: readonly BracketDraft[];
  onChange: (next: BracketDraft[]) => void;
  locale: string;
  /** «التالي» was pressed: the problems across the table show, an empty table's included. */
  showErrors?: boolean;
}) {
  const t = useTranslations('fees.matrix');
  const issues = matrixIssues(value);
  const anyTouched = value.some((draft) => draft.touched);
  const scales = coverage(value);
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  /*
    The brackets chained to the ceiling being edited, read when its field took
    the focus: by key, so the link survives the figure being half typed or
    cleared on the way from 100 to 120.
  */
  const chain = useRef<{ key: string; followers: string[] } | null>(null);

  // Every change goes out with the extensions brought in step with their bases (`withExtensions`).
  const emit = (next: BracketDraft[]) => onChange(withExtensions(next));
  const update = (index: number, patch: Partial<BracketDraft>) =>
    emit(value.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));
  const touch = (index: number) => {
    if (!value[index]?.touched) update(index, { touched: true });
  };
  // A bracket's extensions go with it (`withExtensions` drops a row whose base is gone).
  const remove = (index: number) => emit(value.filter((_, at) => at !== index));
  /** «مدّ الفئة»: the next level count's row under this one; its price is what is left to type. */
  const extend = (key: string) => {
    const next = extendBracket(value, key);
    const added = next.find((draft) => !value.some((old) => old.key === draft.key));
    onChange(next);
    if (added) focusField(added.key, 'amount');
  };

  const setCeiling = (index: number, maxArea: string) => {
    const self = value[index];
    const followers = chain.current?.key === self?.key ? chain.current.followers : [];
    // An emptied ceiling moves nobody: it is on its way to the next figure, or the top bracket's none.
    const moves = maxArea.trim() === '' ? [] : followers;
    emit(
      value.map((draft, at) =>
        at === index ? { ...draft, maxArea } : moves.includes(draft.key) ? { ...draft, minArea: floorAfter(maxArea) } : draft,
      ),
    );
  };

  const fillTemplate = () => {
    const next = standardBrackets();
    onChange(next);
    // The fees are what is left to type: start at A's.
    focusField(next[0]!.key, 'amount');
  };
  const typedAny = value.some((draft) =>
    [draft.code, draft.labelAr, draft.minArea, draft.maxArea, draft.amount].some((text) => text.trim() !== ''),
  );
  const add = () => {
    const added = nextBracket(value);
    onChange([...value, added]);
    // Named next in turn, its «من» the last one's «حتى»: what is left starts with its own «حتى».
    focusField(added.key, added.code ? 'maxArea' : 'code');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{t('rangeHint')}</p>
        <Button
          type="button"
          variant="secondary"
          className="w-full shrink-0 sm:w-auto"
          onClick={() => (typedAny ? setConfirmTemplate(true) : fillTemplate())}
        >
          <LayoutList className="size-4" aria-hidden />
          {t('template.action')}
        </Button>
      </div>

      {scales.length > 0 ? <CoverageBars scales={scales} value={value} locale={locale} /> : null}

      {value.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          {/*
            Sized by its inputs, each as wide as what it holds; the headings wrap
            over them rather than widen them, so the table fits the card at 1440px
            and scrolls inside its frame below that (LAY-5).
          */}
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className={HEAD}>{t('code')}</TableHead>
                <TableHead className={HEAD}>{t('label')}</TableHead>
                <TableHead className={HEAD}>{t('minArea')}</TableHead>
                <TableHead className={HEAD}>{t('maxAreaShort')}</TableHead>
                <TableHead className={HEAD}>{t('levels')}</TableHead>
                <TableHead className={HEAD}>{t('unitTypesShort')}</TableHead>
                <TableHead className={HEAD}>{t('amount')}</TableHead>
                <TableHead className={HEAD}>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.map((draft, index) => {
                const errors = draft.touched ? (issues.rows[index] ?? {}) : {};
                const id = (field: BracketField) => bracketFieldId(draft.key, field);
                const name = draft.code.trim() || t('newBracket');
                const row = index + 1;
                /** The cell's name for a screen reader: its column and its row. */
                const cellLabel = (field: BracketField, column: string) => (
                  <label htmlFor={id(field)} className="sr-only">
                    {t('cellLabel', { field: column, row })}
                  </label>
                );
                /** The cell's problem, tied to its input and read with it; on screen the red border and the wizard's toast say it (FRM-2's exception). */
                const cellError = (field: BracketField) =>
                  errors[field] ? (
                    <p id={`${id(field)}-error`} className="sr-only">
                      {errors[field]}
                    </p>
                  ) : null;
                const describedBy = (field: BracketField) => (errors[field] ? `${id(field)}-error` : undefined);
                /*
                  «مدّ الفئة»: an extension is its base's row again at more
                  levels. What it takes from the base is shown, not typed — it
                  follows the base (`withExtensions`) — and only its price is a
                  field. Indented under the base, its code after a ↳.
                */
                const base = draft.extendsKey ? value.find((other) => other.key === draft.extendsKey) : undefined;
                const levelsLabel = unitLevelsLabel(Number(draft.levels), locale) ?? t('oneLevel');
                const nextLevels = base ? null : nextExtensionLevels(value, draft.key);
                const extended = !base && extensionsOf(value, draft.key).length > 0;
                const removeLabel = extended ? t('removeWithExtensions', { code: name }) : t('remove', { code: name });
                // Its base's types as the base names them; only the dwellings among them are priced at more levels.
                const typesText = typesSummary(draft.unitTypes, locale, t);
                return (
                  <TableRow
                    key={draft.key}
                    className={cn('align-top hover:bg-transparent', base && 'bg-muted/30')}
                    // Once the focus leaves the row, not between its own cells.
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) touch(index);
                    }}
                  >
                    {base ? (
                      <>
                            <TableCell className="p-1.5">
                              <span className="flex h-10 items-center gap-1.5 ps-2 text-sm">
                                {/* Drawn for LTR, where the row it hangs from is to its left; mirrored in Arabic (RTL-3). */}
                                <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden />
                                <bdi className="font-mono font-medium">{draft.code}</bdi>
                                <span className="sr-only">
                                  {t('extensionOf', { code: base.code.trim() || t('newBracket'), levels: levelsLabel })}
                                </span>
                              </span>
                            </TableCell>
                            <TableCell className="p-1.5">
                              <Mirrored>{draft.labelAr || '—'}</Mirrored>
                            </TableCell>
                            <TableCell className="p-1.5">
                              <Mirrored numeric>{draft.minArea || '—'}</Mirrored>
                            </TableCell>
                            <TableCell className="p-1.5">
                              <Mirrored numeric>{draft.maxArea || t('noCeiling')}</Mirrored>
                            </TableCell>
                            <TableCell className="p-1.5">
                              <span className="flex h-10 items-center text-sm font-medium">{levelsLabel}</span>
                            </TableCell>
                            <TableCell className="p-1.5">
                              {/* Truncated in a narrow column, whole in its title (LAY-6). */}
                              <Mirrored title={`${typesText} — ${t('extensionTypesNote')}`}>{typesText}</Mirrored>
                            </TableCell>
                          </>
                        ) : (
                          <>
                        <TableCell className="p-1.5">
                          {cellLabel('code', t('code'))}
                          <Input
                            id={id('code')}
                            dir="ltr"
                            className="w-16 font-mono"
                            placeholder="A"
                            value={draft.code}
                            invalid={Boolean(errors.code)}
                            aria-describedby={describedBy('code')}
                            onChange={(event) => update(index, { code: event.target.value })}
                          />
                          {cellError('code')}
                        </TableCell>
                        <TableCell className="p-1.5">
                          {cellLabel('labelAr', t('label'))}
                          <Input
                            id={id('labelAr')}
                            className="w-32"
                            placeholder={t('labelPlaceholder')}
                            value={draft.labelAr}
                            invalid={Boolean(errors.labelAr)}
                            aria-describedby={describedBy('labelAr')}
                            onChange={(event) => update(index, { labelAr: event.target.value })}
                          />
                          {cellError('labelAr')}
                        </TableCell>
                        <TableCell className="p-1.5">
                          {cellLabel('minArea', t('minArea'))}
                          <Input
                            id={id('minArea')}
                            inputMode="numeric"
                            dir="ltr"
                            className="w-20 tabular-nums"
                            placeholder="0"
                            value={draft.minArea}
                            invalid={Boolean(errors.minArea)}
                            aria-describedby={describedBy('minArea')}
                            onChange={(event) => update(index, { minArea: wholeMetres(event.target.value) })}
                          />
                          {cellError('minArea')}
                        </TableCell>
                        <TableCell className="p-1.5">
                          {cellLabel('maxArea', t('maxArea'))}
                          <Input
                            id={id('maxArea')}
                            inputMode="numeric"
                            dir="ltr"
                            className="w-28 tabular-nums"
                            placeholder={t('noCeiling')}
                            value={draft.maxArea}
                            invalid={Boolean(errors.maxArea)}
                            aria-describedby={describedBy('maxArea')}
                            onFocus={() => {
                              chain.current = { key: draft.key, followers: chainedFollowers(value, index) };
                            }}
                            onBlur={() => {
                              chain.current = null;
                            }}
                            onChange={(event) => setCeiling(index, wholeMetres(event.target.value))}
                          />
                          {cellError('maxArea')}
                        </TableCell>
                        <TableCell className="p-1.5">
                          {cellLabel('levels', t('levels'))}
                          <Select
                            value={draft.levels}
                            // Fixed while it has extensions: theirs count up from it.
                            disabled={extended}
                            onValueChange={(levels) => update(index, { levels, touched: true })}
                          >
                            <SelectTrigger
                              id={id('levels')}
                              className={cn('w-28', errors.levels && 'border-destructive')}
                              aria-invalid={Boolean(errors.levels) || undefined}
                              aria-describedby={describedBy('levels')}
                            >
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
                          {cellError('levels')}
                        </TableCell>
                        <TableCell className="p-1.5">
                          {cellLabel('unitTypes', t('unitTypes'))}
                          <UnitTypesMenu
                            id={id('unitTypes')}
                            value={draft}
                            invalid={Boolean(errors.unitTypes)}
                            describedBy={describedBy('unitTypes')}
                            locale={locale}
                            onChange={(unitTypes) => update(index, { unitTypes, touched: true })}
                          />
                          {cellError('unitTypes')}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="p-1.5">
                      {cellLabel('amount', t('amount'))}
                      <CurrencyInput
                        id={id('amount')}
                        unit={t('lbp')}
                        // No placeholder: an example figure read as a price already typed (2026-10-27).
                        className="w-40"
                        value={draft.amount}
                        invalid={Boolean(errors.amount)}
                        aria-describedby={describedBy('amount')}
                        onChange={(amount) => update(index, { amount: formatTypedAmount(amount, 0) })}
                      />
                      {cellError('amount')}
                    </TableCell>
                    <TableCell className="p-1.5">
                      <div className="flex items-center gap-1">
                        {/* «مدّ الفئة»: the next level count's price under this row, beside its delete. */}
                        {nextLevels !== null ? (
                          <ActionTooltip
                            label={t('extend', {
                              code: name,
                              levels: unitLevelsLabel(nextLevels, locale) ?? t('oneLevel'),
                            })}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t('extend', {
                                code: name,
                                levels: unitLevelsLabel(nextLevels, locale) ?? t('oneLevel'),
                              })}
                              onClick={() => extend(draft.key)}
                            >
                              <Layers className="size-4" aria-hidden />
                            </Button>
                          </ActionTooltip>
                        ) : null}
                        <ActionTooltip label={removeLabel}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={removeLabel}
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </ActionTooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {(anyTouched || showErrors) && issues.table ? (
        <p role="alert" className="text-xs text-destructive">
          {issues.table}
        </p>
      ) : null}

      <Button id={MATRIX_ADD_ID} type="button" variant="outline" onClick={add}>
        <Plus className="size-4" aria-hidden />
        {t('add')}
      </Button>

      <ConfirmDialog
        open={confirmTemplate}
        onOpenChange={setConfirmTemplate}
        title={t('template.confirmTitle')}
        description={t('template.confirmBody', { count: value.length })}
        confirmLabel={t('template.confirm')}
        cancelLabel={t('template.cancel')}
        onConfirm={() => {
          setConfirmTemplate(false);
          fillTemplate();
        }}
      />
    </div>
  );
}

/**
 * A row's unit types in a few words: the group's name when they are one —
 * «جميع الوحدات», «سكني فقط» — or the types themselves. The menu's button and an
 * extension row both say it, so a duplex reads as its base does, and the review reads the sent table with it.
 */
export function typesSummary(
  unitTypes: BracketDraft['unitTypes'],
  locale: string,
  t: ReturnType<typeof useTranslations<'fees.matrix'>>,
): string {
  const preset = presetOf(unitTypes);
  if (preset) return t(`preset.${preset}`);
  const labels = getLabels(locale);
  return unitTypes.length > 0 ? unitTypes.map((type) => labels.unitType[type]).join(t('separator')) : t('noTypes');
}

/** A value an extension row takes from its base: read, not typed, at a field's height so the row stays in line. */
function Mirrored({ children, numeric, title }: { children: React.ReactNode; numeric?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'flex h-10 items-center text-sm text-muted-foreground',
        numeric && 'tabular-nums',
        title && 'block max-w-36 truncate leading-10',
      )}
    >
      {numeric ? <bdi dir="ltr">{children}</bdi> : children}
    </span>
  );
}

/**
 * A row's unit types: a button naming the choice — the group's name, or the
 * types themselves — that opens the groups (`UNIT_TYPE_PRESETS`) and each type
 * on its own. The menu stays open while the clerk ticks, so several types are
 * one visit.
 */
function UnitTypesMenu({
  id,
  value,
  invalid,
  describedBy,
  locale,
  onChange,
}: {
  id: string;
  value: BracketDraft;
  invalid: boolean;
  describedBy?: string;
  locale: string;
  onChange: (unitTypes: BracketDraft['unitTypes']) => void;
}) {
  const t = useTranslations('fees.matrix');
  const labels = getLabels(locale);
  const preset = presetOf(value.unitTypes);
  const summary = typesSummary(value.unitTypes, locale, t);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          title={summary}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn('w-36 justify-between font-normal', invalid && 'border-destructive')}
        >
          <span className={cn('truncate', value.unitTypes.length === 0 && 'text-muted-foreground')}>{summary}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('presets')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preset ?? ''}
          onValueChange={(key) => onChange([...UNIT_TYPE_PRESETS[key as UnitTypePreset]])}
        >
          {UNIT_TYPE_PRESET_KEYS.map((key) => (
            <DropdownMenuRadioItem key={key} value={key} onSelect={(event) => event.preventDefault()}>
              {t(`preset.${key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('typesOneByOne')}</DropdownMenuLabel>
        {PRICED_UNIT_TYPES.map((type) => (
          <DropdownMenuCheckboxItem
            key={type}
            checked={value.unitTypes.includes(type)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) =>
              onChange(
                next === true ? [...value.unitTypes, type] : value.unitTypes.filter((chosen) => chosen !== type),
              )
            }
          >
            {labels.unitType[type]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * «تغطية المساحات» — one bar per scale, its brackets in order of area, so the
 * clerk sees the whole table at a glance: a gap between two brackets is its
 * own block in `warning`, a bracket that starts inside the one before it is
 * drawn in `destructive`, each with an icon and words (COL-3). Each bracket is
 * a button that takes the focus to its row. Equal widths, not areas: the top
 * bracket has no ceiling to scale by, and the point is the order and the joins.
 */
function CoverageBars({
  scales,
  value,
  locale,
}: {
  scales: CoverageScale[];
  value: readonly BracketDraft[];
  locale: string;
}) {
  const t = useTranslations('fees.matrix.coverage');
  const tm = useTranslations('fees.matrix');
  const labels = getLabels(locale);
  const steps = scales.flatMap((scale) => scale.steps);
  const gaps = steps.filter((step) => step.kind === 'gap').length;
  const overlaps = steps.filter((step) => step.kind === 'bracket' && step.overlaps).length;
  // «متصل» only of the whole table: a bracket whose areas are not figures yet is not on a bar.
  const drawn = new Set(steps.flatMap((step) => (step.kind === 'bracket' ? [step.index] : [])));
  const complete = drawn.size === value.length;
  const figure = (area: number) => area.toLocaleString('en-US');

  return (
    <section aria-labelledby="matrix-coverage-title" className="space-y-3 rounded-md bg-muted/40 p-3">
      <h3 id="matrix-coverage-title" className="text-sm font-semibold">
        {t('title')}
      </h3>
      {scales.map((scale) => {
        const scaleName = t('scale', {
          types: scale.unitTypes.map((type) => labels.unitType[type]).join(tm('separator')),
          levels: unitLevelsLabel(scale.levels, locale) ?? tm('oneLevel'),
        });
        let tone = 0;
        return (
          <div key={`${scale.levels}:${scale.unitTypes.join(',')}`} className="space-y-1">
            <p className="text-xs text-muted-foreground">{scaleName}</p>
            <ol aria-label={scaleName} className="flex w-full gap-0.5">
              {scale.steps.map((step) => {
                if (step.kind === 'gap') {
                  const sentence = t('gap', { from: figure(step.from), to: figure(step.to) });
                  return (
                    <li
                      key={`gap-${step.from}-${step.to}`}
                      title={sentence}
                      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md bg-warning/10 px-1 py-1.5 text-xs text-warning"
                    >
                      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                      <span className="sr-only">{sentence}</span>
                      <span aria-hidden dir="ltr" className="hidden max-w-full truncate tabular-nums sm:block">
                        {figure(step.from)}–{figure(step.to)}
                      </span>
                    </li>
                  );
                }
                const draft = value[step.index]!;
                const code = step.code || tm('newBracket');
                const range =
                  step.max === null ? `${figure(step.min)}+` : `${figure(step.min)}–${figure(step.max)}`;
                const sentence =
                  step.max === null
                    ? t(step.overlaps ? 'openOverlap' : 'open', { code, min: figure(step.min) })
                    : t(step.overlaps ? 'bracketOverlap' : 'bracket', {
                        code,
                        min: figure(step.min),
                        max: figure(step.max),
                      });
                tone += 1;
                return (
                  <li key={draft.key} className="flex min-w-0 flex-1">
                    <button
                      type="button"
                      title={sentence}
                      aria-label={sentence}
                      onClick={() => focusField(draft.key, 'minArea')}
                      className={cn(
                        'flex min-h-10 w-full min-w-0 flex-col items-center justify-center rounded-md px-1 py-1.5 text-xs transition-colors coarse:min-h-touch',
                        step.overlaps
                          ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                          : tone % 2 === 0
                            ? 'bg-primary/15 text-foreground hover:bg-primary/25'
                            : 'bg-primary/5 text-foreground hover:bg-primary/15',
                      )}
                    >
                      <span className="flex max-w-full items-center gap-0.5 font-mono font-semibold">
                        {step.overlaps ? <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> : null}
                        <span className="truncate">{code}</span>
                      </span>
                      <span dir="ltr" className="hidden max-w-full truncate tabular-nums text-muted-foreground sm:block">
                        {range}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
      {gaps === 0 && overlaps === 0 ? (
        complete ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            {t('continuous')}
          </p>
        ) : null
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {t('problems', { gaps, overlaps })}
        </p>
      )}
    </section>
  );
}
