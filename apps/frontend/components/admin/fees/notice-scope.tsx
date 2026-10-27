'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  CITIZEN_RESIDENCE,
  defaultUnitStates,
  FEE_TARGET_CATEGORY,
  getLabels,
  UNIT_STATUS,
  UNOCCUPIED_UNIT_STATUS,
  type FeeTargetCategory,
  type UnitStatus,
} from '@mechanization/shared-schemas';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormSection } from '@/components/admin/fees/form-section';
import { noticeWarnings, toMatrix, unitStatesOf, type NoticeDraft, type NoticeField } from '@/lib/fee-notice-draft';
import { cn } from '@/lib/utils';

/** «العقار»: the categories a whole card carries. The rest are units inside one. */
const PROPERTY_CATEGORIES: FeeTargetCategory[] = ['BUILDING', 'HOUSE', 'LAND', 'TENT'];
const UNIT_CATEGORIES = FEE_TARGET_CATEGORY.filter((category) => !PROPERTY_CATEGORIES.includes(category));

/** Where the wizard puts the focus when a filter is refused (FRM-2). */
export const SCOPE_FIELD_ID = {
  unitStates: `fee-state-${UNIT_STATUS[0]}`,
  residences: `fee-residence-${CITIZEN_RESIDENCE[0]}`,
  targetCategories: 'fee-category-all',
} as const;

/** Who pays for a unit in this state under this bearer, as the step says it beside each box. */
function payerOf(state: UnitStatus, bearer: NoticeDraft['bearer']): 'owner' | 'tenant' | 'freeOccupant' {
  if (bearer === 'OWNER') return 'owner';
  if (state === 'RENTED') return 'tenant';
  if (state === 'FREE_OCCUPIED') return 'freeOccupant';
  return 'owner';
}

/** A value added to a list, or taken out of it, in the list's own order. */
function toggled<T extends string>(order: readonly T[], chosen: readonly T[], value: T, on: boolean): T[] {
  return order.filter((item) => (item === value ? on : chosen.includes(item)));
}

/**
 * «من يشمل الإشعار» (0100; the user's decision, 2026-10-26) — the three filters
 * a notice to everyone applies, in the order the law asks them:
 *
 *  1. **حالة الوحدة** — whether anyone is in the unit, and who. Six boxes, each
 *     saying who pays for it under the chosen bearer. Ticked by default as the
 *     bearer has always charged (`defaultUnitStates`), and back to that when the
 *     bearer changes. Not asked under FLAT, which charges a person, not a unit.
 *  2. **نوع الإقامة** — which kinds of file. Every kind by default.
 *  3. **نوع العقار / الوحدة** — the categories, «الكل» by default, which is
 *     «جميع المواطنين». Under TIERED_AREA one press narrows them to what the
 *     bracket table prices, since a unit of a type the table does not price
 *     leaves its holder unassessed.
 *
 * Each is a `FormSection` row of the step's frame. Departing from what the law
 * charges is allowed, and said under the frame as it happens (`ScopeWarnings`,
 * which the wizard places); the review step asks the clerk to confirm it before
 * «إصدار». A notice to one citizen asks only the first.
 */
export function NoticeScopeFields({
  values,
  set,
  locale,
  fieldError,
}: {
  values: NoticeDraft;
  set: (patch: Partial<NoticeDraft>) => void;
  locale: string;
  fieldError: (field: NoticeField) => string | undefined;
}) {
  const t = useTranslations('fees.scope');
  const labels = getLabels(locale);
  const flat = values.basis === 'FLAT';
  const bulk = values.audience === 'ALL';
  const states = unitStatesOf(values);
  const allCategories = FEE_TARGET_CATEGORY.every((category) => values.categories.includes(category));
  const someCategories = values.categories.length > 0 && !allCategories;
  // The unit types the bracket table prices, as categories: what «مطابقة جدول الفئات» ticks.
  const tableTypes =
    values.basis === 'TIERED_AREA'
      ? UNIT_CATEGORIES.filter((category) =>
          toMatrix(values.matrixBrackets).some((bracket) => (bracket.unitTypes as readonly string[]).includes(category)),
        )
      : [];

  // Rows of the step's `divide-y` frame, beside «لمن يصدر الإشعار»: a fragment, so each is a direct child.
  return (
    <>
      {flat ? null : (
        <FormSection
          title={t('states.legend')}
          description={t('states.hint')}
          action={
            values.unitStates !== null ? (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ unitStates: null })}>
                {t('states.reset')}
              </Button>
            ) : null
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {UNIT_STATUS.map((state) => {
              const id = `fee-state-${state}`;
              const unoccupiedOccupancyFee =
                values.bearer === 'OCCUPANT' && (UNOCCUPIED_UNIT_STATUS as readonly string[]).includes(state);
              return (
                <ScopeBox
                  key={state}
                  id={id}
                  checked={states.includes(state)}
                  onChange={(on) => set({ unitStates: toggled(UNIT_STATUS, states, state, on) })}
                  title={state === 'OWNER_OCCUPIED' ? t('states.ownerOccupied') : labels.unitStatus[state]}
                  hint={
                    unoccupiedOccupancyFee ? (
                      <span className="flex items-center gap-1 text-warning">
                        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                        {t('states.notOwed')}
                      </span>
                    ) : (
                      t('states.payer', { payer: payerOf(state, values.bearer) })
                    )
                  }
                />
              );
            })}
          </div>
          <FieldError message={fieldError('unitStates')} id="fee-unit-states-error" />
        </FormSection>
      )}

      {bulk ? (
        <FormSection title={t('residences.legend')} description={t('residences.hint')}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {CITIZEN_RESIDENCE.map((kind) => (
              <ScopeBox
                key={kind}
                id={`fee-residence-${kind}`}
                checked={values.residences.includes(kind)}
                onChange={(on) => set({ residences: toggled(CITIZEN_RESIDENCE, values.residences, kind, on) })}
                title={labels.citizenResidence[kind]}
              />
            ))}
          </div>
          <FieldError message={fieldError('residences')} id="fee-residences-error" />
        </FormSection>
      ) : null}

      {bulk ? (
        <FormSection
          title={t('categories.legend')}
          description={allCategories ? t(flat ? 'categories.allFlat' : 'categories.allHint') : undefined}
        >
          <label
            htmlFor={SCOPE_FIELD_ID.targetCategories}
            className="flex w-fit cursor-pointer select-none items-center gap-2 text-sm font-medium"
          >
            <Checkbox
              id={SCOPE_FIELD_ID.targetCategories}
              checked={allCategories ? true : someCategories ? 'indeterminate' : false}
              onCheckedChange={(next) => set({ categories: next === true ? [...FEE_TARGET_CATEGORY] : [] })}
            />
            {t('categories.all')}
          </label>
          {(
            [
              ['property', PROPERTY_CATEGORIES],
              ['unit', UNIT_CATEGORIES],
            ] as const
          ).map(([group, members]) => (
            <div key={group} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t(`categories.${group}`)}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {members.map((category) => (
                  <ScopeBox
                    key={category}
                    id={`fee-category-${category}`}
                    checked={values.categories.includes(category)}
                    onChange={(on) =>
                      set({ categories: toggled(FEE_TARGET_CATEGORY, values.categories, category, on) })
                    }
                    title={labels.feeTargetCategory[category]}
                  />
                ))}
              </div>
            </div>
          ))}
          {values.basis === 'TIERED_AREA' && tableTypes.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">
                {t('categories.tieredHint', {
                  types: tableTypes.map((category) => labels.feeTargetCategory[category]).join(t('separator')),
                })}
              </span>
              <Button type="button" variant="secondary" size="sm" onClick={() => set({ categories: tableTypes })}>
                {t('categories.matchTable')}
              </Button>
            </div>
          ) : null}
          <FieldError message={fieldError('targetCategories')} id="fee-categories-error" />
        </FormSection>
      ) : null}
    </>
  );
}

/**
 * What this scope departs from in the law, said as the clerk ticks it: an
 * occupancy fee on empty units, a status or a kind of file left out. The
 * review step asks for the confirmation; here it is only said.
 */
export function ScopeWarnings({ values, locale }: { values: NoticeDraft; locale: string }) {
  const t = useTranslations('fees.scope');
  const labels = getLabels(locale);
  const warnings = noticeWarnings(values);
  if (warnings.length === 0) return null;
  const states = unitStatesOf(values);
  const leftOutStates = defaultUnitStates(values.bearer).filter((state) => !states.includes(state));
  const leftOutKinds = CITIZEN_RESIDENCE.filter((kind) => !values.residences.includes(kind));

  return (
    <Alert variant="warning" title={t('warnings.title')}>
      <ul className="list-disc space-y-1 ps-5">
        {warnings.map((warning) => (
          <li key={warning}>
            {t(`warnings.${warning}`, {
              states: leftOutStates.map((state) => labels.unitStatus[state]).join(t('separator')),
              kinds: leftOutKinds.map((kind) => labels.citizenResidence[kind]).join(t('separator')),
            })}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** One box of a filter: the `Checkbox` primitive, its label and an optional line under it (PRIM-27). */
function ScopeBox({
  id,
  checked,
  onChange,
  title,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer select-none items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors',
        checked ? 'border-primary/50 bg-primary/5' : 'hover:bg-accent',
      )}
    >
      <Checkbox id={id} className="mt-0.5" checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-medium">{title}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function FieldError({ message, id }: { message?: string; id: string }) {
  return message ? (
    <p id={id} className="sr-only">
      {message}
    </p>
  ) : null;
}
