'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers, Loader2 } from 'lucide-react';
import {
  MAX_UNIT_LEVELS,
  canSpanLevels,
  layoutBuildingFloors,
  levelFactorsSchema,
  unitLevelsLabel,
  type HouseGrowth,
} from '@mechanization/shared-schemas';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HouseGrowthQuestion } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/*
  «دوبلكس» and «تريبلكس» — one home on several levels (migration 0095, decision
  D28) — and the question a house on somebody's file is asked before it grows.
  The rules are in shared-schemas (`unit-levels.ts`); these are the four places
  an officer meets them.
*/

/** «دوبلكس» beside a unit's code, or nothing for a one-level unit. */
export function UnitLevelsBadge({ levels, locale }: { levels: number | undefined; locale: string }) {
  const name = unitLevelsLabel(levels, locale);
  if (!name) return null;
  return (
    <Badge variant="soft-info" className="gap-1">
      <Layers className="size-3" aria-hidden />
      {name}
    </Badge>
  );
}

/**
 * «عدد طوابق المسكن» — how many levels this one home spans upward from its
 * floor. Offered on a dwelling only; on any other type it says why it is not.
 */
export function UnitLevelsSelect({
  id,
  unitType,
  value,
  onChange,
  disabled,
  locale,
}: {
  id: string;
  unitType: string;
  value: number;
  onChange: (levels: number) => void;
  disabled?: boolean;
  locale: string;
}) {
  const t = useTranslations('unitLevels.field');
  const dwelling = canSpanLevels(unitType);
  return (
    // Always answered — one level is an answer — so never «(اختياري)».
    <Field label={t('label')} htmlFor={id} required caution={dwelling ? t('caution') : undefined}>
      <Select
        value={String(value)}
        onValueChange={(next) => onChange(Number(next))}
        disabled={disabled || !dwelling}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: MAX_UNIT_LEVELS }, (_, index) => index + 1).map((count) => (
            <SelectItem key={count} value={String(count)}>
              {count === 1
                ? t('one')
                : count <= 3
                  ? t('many', { count, name: unitLevelsLabel(count, locale) ?? '' })
                  : unitLevelsLabel(count, locale)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!dwelling ? <p className="text-xs text-muted-foreground">{t('notDwelling')}</p> : null}
    </Field>
  );
}

/**
 * «هذا المنزل يصبح مبنى» — asked when adding a unit to a structure whose one
 * unit is a home on somebody's file, or a bare «منزل مستقل» (the server's
 * `HOUSE_GROWTH_UNANSWERED`). Nothing is written until it is answered.
 *
 * A level of the same home goes directly above it, so that answer is offered
 * only on that floor; a separate unit cannot be added to a «منزل مستقل» at all,
 * so that answer says what to change first.
 */
export function HouseGrowthPrompt({
  question,
  floor,
  floorText,
  structureIsHouse,
  busy,
  locale,
  onAnswer,
  onCancel,
}: {
  question: HouseGrowthQuestion;
  /** The floor the officer is adding to. */
  floor: number;
  /** How that floor reads on this screen («الطابق الأول»). */
  floorText: (floor: number) => string;
  structureIsHouse: boolean;
  busy: boolean;
  locale: string;
  onAnswer: (growth: HouseGrowth) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('unitLevels.growth');
  const above = floor === question.nextLevelFloor;
  const grown = unitLevelsLabel(question.levels + 1, locale) ?? '';
  const canGrow = above && question.levels < MAX_UNIT_LEVELS && canSpanLevels(question.unitType);

  return (
    <Alert
      variant="warning"
      live="status"
      title={question.holders.length > 0 ? t('titleOnFile') : t('titleBare')}
    >
      <div className="space-y-2">
        <p>{t('question', { unitCode: question.unitCode })}</p>
        {question.holders.length > 0 ? (
          <p className="font-medium">
            {t('holders', { names: question.holders.map((holder) => holder.name).join('، ') })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-2 pt-1">
          <div className="min-w-0 flex-1 basis-full space-y-1 sm:basis-0">
            <Button size="sm" disabled={busy || !canGrow} onClick={() => onAnswer('EXTRA_LEVEL')}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              {t('extraLevel')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {canGrow
                ? t('extraLevelHint', { unitCode: question.unitCode, name: grown })
                : t('notAbove', { floor: floorText(question.nextLevelFloor), unitCode: question.unitCode })}
            </p>
          </div>
          <div className="min-w-0 flex-1 basis-full space-y-1 sm:basis-0">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || structureIsHouse}
              onClick={() => onAnswer('SEPARATE_UNIT')}
            >
              {t('separate')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {structureIsHouse ? t('separateHouse') : t('separateHint', { unitCode: question.unitCode })}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </Alert>
  );
}

/**
 * The upper level of a home entering below, drawn in the same columns and
 * joined to it. It opens the same unit; nothing else may be drawn on it.
 */
export function UnitContinuationTile({
  unitCode,
  levels,
  locale,
  selected,
  toneClassName,
  onSelect,
}: {
  unitCode: string;
  levels: number;
  locale: string;
  selected: boolean;
  /** The entrance tile's status colours, so the two read as one home. */
  toneClassName: string;
  onSelect: () => void;
}) {
  const t = useTranslations('unitLevels');
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t('continuationAria', { unitCode })}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md border-b-0 px-1 py-1.5 text-center ring-1 ring-inset transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        toneClassName,
        'opacity-80',
        selected && 'ring-2 ring-primary',
      )}
    >
      <span className="font-mono text-xs font-bold" dir="ltr">
        {t('continuation', { unitCode })}
      </span>
      <span className="block max-w-full truncate text-xs leading-tight">{unitLevelsLabel(levels, locale)}</span>
    </button>
  );
}

/**
 * «معامل السقوف» — what a flat on N levels weighs in roofs under a per-unit
 * notice, per N. A count left without a factor is not billed until one is set,
 * so the editor offers every count up to the maximum and saves only those filled.
 * Its heading is the settings card's (`unitLevels.factors.title`).
 */
export function LevelFactorsEditor({
  value,
  canEdit,
  busy,
  locale,
  onSave,
}: {
  value: Record<string, number>;
  canEdit: boolean;
  busy: boolean;
  locale: string;
  onSave: (factors: Record<string, number>) => void;
}) {
  const t = useTranslations('unitLevels.factors');
  const counts = Array.from({ length: MAX_UNIT_LEVELS - 1 }, (_, index) => index + 2);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(Object.fromEntries(counts.map((count) => [String(count), value[String(count)]?.toString() ?? ''])));
    // `counts` is fixed; the draft follows what the server holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const save = () => {
    const table: Record<string, number> = {};
    for (const [key, raw] of Object.entries(draft)) {
      if (raw.trim() === '') continue;
      table[key] = Number(raw);
    }
    const parsed = levelFactorsSchema.safeParse(table);
    if (!parsed.success) {
      const key = String(parsed.error.issues[0]?.path[0] ?? '');
      setError(t('invalid', { name: unitLevelsLabel(Number(key), locale) ?? key, max: Number(key) || MAX_UNIT_LEVELS }));
      return;
    }
    setError(null);
    onSave(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {counts.map((count) => {
          const key = String(count);
          const name = unitLevelsLabel(count, locale) ?? key;
          return (
            <Field key={key} label={t('row', { name })} htmlFor={`level-factor-${key}`}>
              <Input
                id={`level-factor-${key}`}
                inputMode="decimal"
                dir="ltr"
                className="tabular-nums"
                aria-label={t('factorAria', { name })}
                placeholder={t('unset')}
                value={draft[key] ?? ''}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{t('range', { max: count })}</p>
            </Field>
          );
        })}
      </div>
      {error ? (
        <Alert variant="destructive" live="alert">
          {error}
        </Alert>
      ) : null}
      {canEdit ? (
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * «عدد طوابق المسكن» under the selected unit — for a dwelling only, since
 * nothing else can span levels. Saved on its own, like the fee exemption.
 */
export function UnitLevelsPanel({
  unit,
  locale,
  busy,
  canEdit,
  onSave,
}: {
  unit: { id: string; unitCode: string; unitType: string; levels?: number };
  locale: string;
  busy: boolean;
  canEdit: boolean;
  onSave: (levels: number) => void;
}) {
  const t = useTranslations('unitLevels.field');
  const stored = unit.levels ?? 1;
  const [levels, setLevels] = useState(stored);
  useEffect(() => setLevels(stored), [stored, unit.id]);

  if (!canSpanLevels(unit.unitType)) return null;
  if (!canEdit) {
    return stored > 1 ? <UnitLevelsBadge levels={stored} locale={locale} /> : null;
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <UnitLevelsSelect
        id={`unit-levels-${unit.id}`}
        unitType={unit.unitType}
        value={levels}
        onChange={setLevels}
        disabled={busy}
        locale={locale}
      />
      {levels !== stored ? (
        <Button size="sm" disabled={busy} onClick={() => onSave(levels)}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The flat directly above `unit` that «دمج كدوبلكس» would fold into it, or
 * null — the server's own pair rule (`mergePair`): on the floor the unit's top
 * level reaches, in its columns as drawn; one with exactly its columns, else the
 * only one overlapping them. Both must be flats.
 */
export function upperFlatOf<
  T extends { id: string; floor: number; sequence: number; levels?: number; unitType: string; startCol: number | null; endCol: number | null },
>(units: readonly T[], unit: T): T | null {
  if (unit.unitType !== 'APARTMENT') return null;
  const layouts = layoutBuildingFloors([...units].sort((a, b) => a.floor - b.floor || a.sequence - b.sequence));
  const span = layouts.get(unit.floor)?.blocks.find((block) => block.unit.id === unit.id && !block.continuation);
  if (!span) return null;
  const top = unit.floor + (unit.levels ?? 1);
  const above = (layouts.get(top)?.blocks ?? []).filter(
    (block) =>
      !block.continuation &&
      block.unit.floor === top &&
      block.startCol <= span.endCol &&
      span.startCol <= block.endCol,
  );
  const exact = above.find((block) => block.startCol === span.startCol && block.endCol === span.endCol);
  const upper = exact?.unit ?? (above.length === 1 ? above[0]!.unit : null);
  return upper && upper.unitType === 'APARTMENT' ? upper : null;
}
