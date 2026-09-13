'use client';

import { useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  DoorOpen,
  FileQuestion,
  HandHeart,
  HardHat,
  House,
  KeyRound,
  Plus,
  Link2,
  Trash2,
  X,
} from 'lucide-react';
import {
  getLabels,
  isFlaggablePath,
  isUnoccupied,
  UNIT_STATUS,
  UNIT_TYPE,
} from '@mechanization/shared-schemas';
import type { UnitStatus, UnitType } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, useFieldFlags } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { UnitDraft } from '@/components/citizen/property-card';
import { cn, scopeErrors } from '@/lib/utils';

/**
 * What the census holds about one canonical `Unit`, as a card needs to read it.
 *
 * Declared here rather than beside the picker that produces it, because this is
 * the module that *consumes* it and the picker already depends on this one
 * (`BUILDING_UNIT_TYPES`). Putting it the other way round would have the
 * dependency pointing in both directions at runtime.
 *
 * Every field is nullable and the nulls are load-bearing: they are what tells a
 * field whether the register has an answer for it or is still waiting for one.
 * A surveyed flat routinely has a type and a floor and no area at all, because
 * `Unit.unitArea` is nullable and the census records that a flat exists long
 * before anybody measures it.
 *
 * `floor` crosses the same boundary `toggleUnit` crosses — `Unit.floor` is a
 * signed integer and a card's is free text — so it is carried already rendered
 * the way a person says it, and nothing downstream re-derives it.
 */
export interface CensusUnitFacts {
  id: string;
  unitCode: string;
  unitType: string | null;
  /** Already rendered — «الأرضي», not `0`. */
  floor: string | null;
  side: string | null;
  /** Stringified, because that is what a card's `unitArea` is. */
  unitArea: string | null;
}

/**
 * The «الوحدة» sub-form, and the pieces it is built from.
 *
 * Lifted out of `property-card` because it now has two homes rather than one.
 * A unit the officer ticked on the census matrix is edited **there**, directly
 * under the flat they tapped; a unit typed by hand — a card filed before the
 * building was surveyed — is edited in «وحدات المبنى» at the foot of the card.
 * Both render `UnitFields`, so the two places cannot drift into asking
 * different questions about the same row.
 *
 * It also breaks what would otherwise be an import cycle: `PropertyCard`
 * renders `BuildingUnitPicker`, and the picker now renders these fields. With
 * them here, nothing imports back into the card except the `UnitDraft` type,
 * which is erased at build time.
 */

/**
 * The unit types a مبنى can actually contain.
 *
 * Derived from `UNIT_TYPE` rather than retyped, which is the whole point: this
 * list said شقة / عيادة / محل for as long as it was a literal, and went on
 * saying it after the taxonomy gained مكتب and مستودع — so a municipality whose
 * schedule of fees charges a warehouse differently from a shop had no way to
 * record one, and two values sat in the database and in the fee-target list
 * reachable from nothing. Subtracting from the enum keeps this correct the next
 * time it widens.
 */
export const BUILDING_UNIT_TYPES = UNIT_TYPE.filter((type) => type !== 'INDEPENDENT_HOUSE');

/**
 * A card's dot-path for one of its fields — `properties.2.propertyNumber`.
 *
 * The index is the card's position in the form, which is the same index the
 * server's flag paths and the validator's error keys use. Written here rather
 * than interpolated at each of a dozen call sites so there is one place the
 * three vocabularies are made to agree.
 */
export function flagPath(index: number, field: string): string {
  return `properties.${index}.${field}`;
}

export function summariseUnit(unit: UnitDraft, locale: string = 'ar'): string {
  const labels = getLabels(locale);
  const parts = [
    unit.unitType ? labels.unitType[unit.unitType] : (locale === 'en' ? 'Unspecified type' : 'لم يُحدَّد النوع'),
    unit.floor ? (locale === 'en' ? `Floor ${unit.floor}` : `طابق ${unit.floor}`) : null,
    unit.unitArea ? `${unit.unitArea} ${locale === 'en' ? 'm²' : 'م²'}` : null,
    // Carried into the collapsed line because a building is reviewed folded:
    // the officer checking their work scrolls a list of one-line summaries, and
    // a vacancy invisible there is a vacancy nobody re-reads before saving.
    unit.unitStatus ? labels.unitStatus[unit.unitStatus] : null,
  ];
  return parts.filter(Boolean).join(' — ');
}

export function UnitStatusChoice({
  idPrefix,
  value,
  onChange,
  locale = 'ar',
}: {
  idPrefix: string;
  value: UnitStatus | undefined;
  onChange: (next: UnitStatus | undefined) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const isEnglish = locale === 'en';

  return (
    <Field
      label={isEnglish ? 'Unit Status' : 'حالة الوحدة'}
      htmlFor={idPrefix}
      hint={
        isEnglish
          ? 'Optional. Leave blank if not established — a blank unit is treated as occupied.'
          : 'اختياري. اتركه فارغاً إذا لم يُتحقَّق منه — الوحدة غير المحدَّدة تُعامَل كمشغولة.'
      }
    >
      <div id={idPrefix} className="flex flex-wrap gap-2 pt-1">
        {UNIT_STATUS.map((option) => {
          const Icon = UNIT_STATUS_ICON[option];
          const selected = value === option;
          // The two states that can exempt a unit from a fee are tinted apart
          // from the two that cannot, so what a tap costs is visible before it
          // is made.
          const exempting = isUnoccupied(option);

          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? undefined : option)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors select-none',
                selected
                  ? exempting
                    ? 'border-warning/60 bg-warning/15 text-warning'
                    : 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border/70 bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">{labels.unitStatus[option]}</span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** One glyph per status, so the five are told apart before they are read. */
const UNIT_STATUS_ICON: Record<UnitStatus, typeof House> = {
  OWNER_OCCUPIED: House,
  RENTED: KeyRound,
  // A key for the tenancy, an open hand for the arrangement with no key and no
  // بدل — «مشغولة بتسامح» sits between «مؤجرة» and «مشغولة من المالك» and has
  // to be distinguishable from both at a glance, because picking the wrong one
  // of the three is what decides whether two people are billed for one flat.
  FREE_OCCUPIED: HandHeart,
  // A calendar: lived in for some months of the year, by people who live elsewhere.
  SEASONAL: CalendarDays,
  VACANT: DoorOpen,
  UNDER_CONSTRUCTION: HardHat,
};

export function SharedRightsField({
  idPrefix,
  path,
  selected,
  onChange,
  locale = 'ar',
}: {
  idPrefix: string;
  /**
   * Absent for a unit's own shared rights — those live inside a building's
   * units, and this form flags the unit collection as a whole rather than
   * field by field inside it. See `UnitsEditor`.
   */
  path?: string;
  selected: string[];
  onChange: (next: string[]) => void;
  locale?: string;
}) {
  const sharedRightsOptions = locale === 'en'
    ? ['Parking space', 'Shared entrance', 'Shared rooftop', 'Shared garden']
    : ['موقف سيارات', 'مدخل مشترك', 'سطح مشترك', 'حديقة مشتركة'];

  return (
    <Field
      label={locale === 'en' ? 'Shared Rights' : 'حقوق مشتركة'}
      htmlFor={idPrefix}
      path={path}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 pt-1">
        {sharedRightsOptions.map((right, rightIndex) => {
          const checked = selected.includes(right);
          const id = `${idPrefix}-${rightIndex}`;
          return (
            <label
              key={right}
              htmlFor={id}
              className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-xs text-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={() =>
                  onChange(
                    checked ? selected.filter((r) => r !== right) : [...selected, right],
                  )
                }
              />
              <span className="truncate">{right}</span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}

/**
 * The units inside a building.
 *
 * A citizen who owns the whole building has one عقار — one رقم العقار, one
 * اسم المبنى — and several apartments or shops inside it. Filing that as one
 * property card per apartment is not possible: رقم العقار is unique per
 * municipality, so the second card would be rejected as a duplicate of the
 * first. The units therefore live inside the building rather than beside it.
 *
 * Collapsible for the same reason the property cards above it are: a citizen
 * filing a ten-unit building should not have to scroll past nine finished
 * units to reach the tenth, so adding one folds the rest shut — every unit
 * stays a tap away, because copying a floor's details from the one above it
 * is the usual reason to open an earlier one again.
 */
export function UnitsEditor({
  index,
  units,
  unitCodes = {},
  censusUnits = {},
  defaultUnitType,
  asksUnitStatus,
  errors,
  onChange,
  locale = 'ar',
}: {
  index: number;
  units: UnitDraft[];
  /**
   * What the census holds about each linked flat, keyed by canonical unit id.
   *
   * Only rows carrying a `unitId` have an entry, and a row's fields are locked
   * one by one against it — a field with an answer in the register is stated,
   * a field without one stays open. See `censusUnits` in `PropertyCard` for why
   * the rule is per field rather than per row.
   */
  censusUnits?: Record<string, CensusUnitFacts>;
  /**
   * `unitId` → the code the census gave that flat (`0202`), for the rows
   * created by ticking the matrix.
   *
   * Supplied by the card, which learns it from `BuildingUnitPicker` — the one
   * component that has already loaded the building. Empty while the matrix is
   * still loading, or for a card linked to nothing, and every row then falls
   * back to its position.
   */
  unitCodes?: Record<string, string>;
  /**
   * What a new row's «نوع الوحدة» starts as, from the structure this card is
   * about — `STRUCTURE_TYPE_MAP[structureType].defaultUnitType`.
   *
   * The building editor has always done this: choosing «مجمع تجاري» there sets
   * the blueprint's unit type to محل, «مستودع / هنغار» to مستودع. This form
   * offered the identical structure-type list and then left every unit's type
   * blank, so the same building created from the two screens came out
   * differently — and the officer re-answered a question the structure type
   * had already answered, once per flat.
   */
  defaultUnitType?: UnitType;
  /** False on a tenant's or free occupant's card — see `asksUnitStatus`. */
  asksUnitStatus: boolean;
  errors: Record<string, string>;
  /**
   * An updater, for the same reason `PropertyCard.onChange` is one: every
   * operation here is computed *from* the previous array, so a handler built
   * against a stale `units` prop silently drops whatever landed between the
   * render and the click.
   */
  onChange: (update: (current: UnitDraft[]) => UnitDraft[]) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());

  /*
    The whole unit list is flaggable; the fields inside one are not.

    "We could not go through the building" is a real afternoon — the caretaker
    was out, the stairwell was locked, the owner is abroad — and it is the
    answer this control records. "We wrote down apartment 3 but not its floor"
    is not that; it is an unfinished form, and letting it through one field at
    a time would turn a building into a list of half-units nobody can bill.
  */
  const flagging = useFieldFlags();
  const path = flagPath(index, 'units');
  const flaggable = Boolean(flagging && isFlaggablePath(path));
  const reason = flaggable ? flagging?.flags.get(path) : undefined;
  const flagged = reason !== undefined;

  const setUnit = (unitIndex: number, patch: Partial<UnitDraft>) =>
    onChange((current) => current.map((u, i) => (i === unitIndex ? { ...u, ...patch } : u)));

  const toggleCollapsed = (unitIndex: number) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(unitIndex)) next.delete(unitIndex);
      else next.add(unitIndex);
      return next;
    });

  const addUnit = () => {
    // Inherits the previous unit's type *and* status: a floor of eight
    // identical rented flats is the ordinary case, and re-answering both
    // questions eight times is how the second one stops being answered.
    onChange((current) => {
      const previous = current.at(-1);
      return [
        ...current,
        // The previous row first — a floor of eight identical flats is the
        // ordinary case — then the structure's own default, so the first row
        // on a مجمع تجاري starts as محل rather than as nothing.
        { unitType: previous?.unitType ?? defaultUnitType, unitStatus: previous?.unitStatus },
      ];
    });
    setCollapsed(new Set(units.map((_, i) => i)));
  };

  /**
   * One status onto every unit at once.
   *
   * The control that decides whether this field is used at all. A landlord
   * filing a twenty-flat building is answering the same question twenty times,
   * and a form that demands that gets one of two things: a blank column, or a
   * column filled in by pattern rather than by looking. Setting the common case
   * in one tap leaves the officer with the handful of units that differ, which
   * is the number of real decisions there actually were.
   */
  const setAllStatuses = (unitStatus: UnitStatus) =>
    onChange((current) => current.map((unit) => ({ ...unit, unitStatus })));

  const removeUnit = (unitIndex: number) => {
    onChange((current) => current.filter((_, i) => i !== unitIndex));
    setCollapsed((current) => {
      const next = new Set<number>();
      for (const i of current) {
        if (i < unitIndex) next.add(i);
        else if (i > unitIndex) next.add(i - 1);
      }
      return next;
    });
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-semibold">
            {locale === 'en' ? 'Building Units' : 'وحدات المبنى'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {locale === 'en'
              ? 'If you own the entire building, add each unit separately. Property number and building name remain the same for all units.'
              : 'إذا كنت تملك المبنى بالكامل، أضف كل وحدة فيه على حدة. رقم العقار واسم المبنى يبقيان كما هما لجميع الوحدات.'}
          </p>
        </div>

        {flaggable ? (
          <button
            type="button"
            onClick={() => (flagged ? flagging?.clear(path) : flagging?.set(path, ''))}
            aria-pressed={flagged}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              flagged
                ? 'bg-warning/15 text-warning ring-1 ring-warning/40'
                : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground',
            )}
          >
            {flagged ? (
              <X className="size-3 shrink-0" aria-hidden />
            ) : (
              <FileQuestion className="size-3 shrink-0" aria-hidden />
            )}
            {flagged
              ? locale === 'en'
                ? 'Undo'
                : 'تراجع'
              : locale === 'en'
                ? 'Units not surveyed'
                : 'الوحدات غير مجرودة'}
          </button>
        ) : null}
      </header>

      {flagged ? (
        <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2">
          <label
            htmlFor={`units-reason-${index}`}
            className="text-[11px] font-medium text-warning"
          >
            {locale === 'en'
              ? 'Why were the units not recorded? (required)'
              : 'سبب عدم جرد الوحدات (إلزامي)'}
          </label>
          <input
            id={`units-reason-${index}`}
            value={reason ?? ''}
            onChange={(event) => flagging?.set(path, event.target.value)}
            placeholder={
              locale === 'en'
                ? 'e.g. Caretaker absent — return visit scheduled'
                : 'مثال: الناطور غير موجود — زيارة لاحقة'
            }
            className="h-9 w-full rounded-md border border-warning/40 bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
          />
        </div>
      ) : null}

      {flagged || !asksUnitStatus || units.length < 2 ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/20 p-2.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {locale === 'en'
              ? `Set all ${units.length} units to:`
              : `تعيين حالة الوحدات الـ${units.length} جميعاً:`}
          </span>
          {UNIT_STATUS.map((option) => {
            const Icon = UNIT_STATUS_ICON[option];
            return (
              <button
                key={option}
                type="button"
                onClick={() => setAllStatuses(option)}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                {labels.unitStatus[option]}
              </button>
            );
          })}
        </div>
      )}

      {/*
        Every unit the owner holds, in one list — whether it was ticked on the
        census matrix or typed by hand.

        Split briefly across two places and put back: a linked unit edited
        beside the matrix and a hand-typed one edited down here meant the
        officer had to look in two places to review what they had entered about
        one building, and the two lists numbered their rows independently. The
        matrix is for *choosing* which flats this citizen holds; describing them
        is this section's job, and it is the same job for both kinds.

        What a linked row keeps is its identity — see the header below, which
        heads it with the code the matrix gave it rather than «الوحدة ١».
      */}
      {flagged ? null : units.map((unit, unitIndex) => {
        const unitCollapsed = collapsed.has(unitIndex);
        const unitErrors = scopeErrors(errors, String(unitIndex));

        return (
          /*
            One hairline border and a tinted ground — no accent rail.

            The 2px `border-s-primary` this used to carry was doing a job the
            row does not need: these are siblings in a list, all of equal
            weight, and a coloured edge on every one of them says "important"
            about all of them and therefore about none. The chain icon in the
            header already marks the distinction that matters — which rows the
            census knows about — and it marks only the rows it applies to.
          */
          <div
            key={unitIndex}
            className="space-y-5 rounded-lg border border-border/70 bg-muted/20 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => toggleCollapsed(unitIndex)}
                aria-expanded={!unitCollapsed}
                className="-m-2 flex min-w-0 flex-1 items-center gap-2 rounded-md p-2 text-start transition-colors hover:bg-accent"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    unitCollapsed && '-rotate-90 rtl:rotate-90',
                  )}
                  aria-hidden
                />
                <span className="min-w-0">
                  {/*
                    A linked row is headed by the code the matrix gave it.

                    «الوحدة ٢» is a position in this form and means nothing to
                    an officer who picked `0202` off the building's matrix —
                    and when a card holds four flats, matching the four forms
                    back to the four chips by counting is exactly the step that
                    gets done wrong. The chain icon also marks, at a glance,
                    which rows the census knows about and which are this card's
                    own account of a flat nobody has surveyed.
                  */}
                  <h4 className="flex items-center gap-1.5 font-semibold">
                    {unit.unitId && unitCodes[unit.unitId] ? (
                      <>
                        <Link2 className="size-3.5 shrink-0 text-primary" aria-hidden />
                        <span className="font-mono" dir="ltr">
                          {unitCodes[unit.unitId]}
                        </span>
                      </>
                    ) : (
                      (locale === 'en' ? `Unit ${unitIndex + 1}` : `الوحدة ${unitIndex + 1}`)
                    )}
                  </h4>
                  {unitCollapsed ? (
                    <span className="mt-0.5 block truncate text-sm font-normal text-muted-foreground">
                      {summariseUnit(unit, locale)}
                    </span>
                  ) : null}
                </span>
              </button>

              {units.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => removeUnit(unitIndex)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {locale === 'en' ? 'Delete' : 'حذف'}
                </Button>
              ) : null}
            </div>

            {unitCollapsed ? null : (
              <UnitFields
                idPrefix={`${index}-${unitIndex}`}
                unit={unit}
                census={unit.unitId ? censusUnits[unit.unitId] : undefined}
                errors={unitErrors}
                asksUnitStatus={asksUnitStatus}
                onPatch={(patch) => setUnit(unitIndex, patch)}
                locale={locale}
              />
            )}
          </div>
        );
      })}

      {flagged ? null : (
        <Button variant="outline" className="w-full border-dashed" onClick={addUnit}>
          <Plus className="size-4" aria-hidden />
          {locale === 'en' ? 'Add Another Unit' : 'إضافة وحدة أخرى'}
        </Button>
      )}
    </section>
  );
}


/**
 * Everything asked about one unit, wherever that unit is being edited.
 *
 * Rendered in two places and deliberately identical in both: inline under the
 * flat an officer just ticked on the census matrix, and inside «وحدات المبنى»
 * for units typed by hand. Before this existed the matrix could only tick a
 * flat — the questions about it were a screen away at the foot of the card,
 * which is what made a ticked unit look like it had failed to save.
 *
 * Stateless and index-free. The caller owns the row and says how to patch it,
 * so the same markup serves a row addressed by array position and one
 * addressed by canonical unit id.
 */
export function UnitFields({
  idPrefix,
  unit,
  census,
  errors,
  asksUnitStatus,
  onPatch,
  locale = 'ar',
}: {
  /** Disambiguates every `id`/`htmlFor` on the page — a card index and a row. */
  idPrefix: string;
  unit: UnitDraft;
  /**
   * What the census records about this flat, when the row is linked to one.
   *
   * Each field is locked against its own value here, never against the
   * presence of this object: a surveyed flat routinely has a type and a floor
   * and no area at all, because `Unit.unitArea` is nullable and the census
   * records that a flat exists long before anybody measures it. Locking the
   * whole row on the strength of the two fields that *are* filled would leave
   * «مساحة الوحدة» permanently blank and read-only — unrecordable by the
   * officer standing inside it, which is the one place it can be established.
   */
  census?: CensusUnitFacts;
  /** Already scoped to this unit, so keys are bare field names. */
  errors: Record<string, string>;
  asksUnitStatus: boolean;
  onPatch: (patch: Partial<UnitDraft>) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const en = locale === 'en';

  /**
   * «من سجل المباني» — said once, the same way, wherever a field is stated.
   *
   * It has to name *where* the correction is made. A read-only field with no
   * explanation is indistinguishable from a broken one, and an officer who can
   * see the area is wrong and cannot see how to fix it will unlink the card
   * instead — which throws away the census link to correct a number.
   */
  const fromCensus = (value: string | null | undefined) =>
    value != null && value !== ''
      ? en
        ? `From the census record for ${census?.unitCode}. Edit it on the unit itself.`
        : `من سجل المباني (${census?.unitCode}). التعديل يتم على الوحدة نفسها.`
      : undefined;

  const lockedType = fromCensus(census?.unitType);
  const lockedFloor = fromCensus(census?.floor);
  const lockedArea = fromCensus(census?.unitArea);
  const lockedSide = fromCensus(census?.side);

  /*
    A field the census has answered is not rendered here at all.

    Every one of these values is already printed, per unit and by code, in the
    «من سجل المباني» strip at the head of the card. Repeating it as a disabled
    input is the same fact in two places, and the copy with a label and a box
    around it is the one that looks like work: an officer opening a linked flat
    to record حالة الوحدة was met with four boxes they could not type in and
    one they could.

    So a linked row shows what is still *askable* — the status, the shared
    rights — and nothing else. A row the officer typed by hand has no `census`
    entry and keeps every field, because there the questions are real.

    Per field, never per row: `Unit.unitArea` is nullable and frequently null,
    and a flat the census recorded without measuring must still be measurable
    from here.
  */
  const showType = !lockedType;
  const showFloor = !lockedFloor;
  const showArea = !lockedArea;
  const showSide = !lockedSide;

  return (
    <div className="space-y-5">
                <div className={cn('grid gap-3.5 sm:grid-cols-2', !showType && !showFloor && 'hidden')}>
                  <Field
                    label={locale === 'en' ? 'Unit Type' : 'نوع الوحدة'}
                    htmlFor={`ut-${idPrefix}`}
                    required
                    error={errors.unitType}
                    hint={lockedType}
                    className={cn(!showType && 'hidden')}
                  >
                    <Select
                      value={unit.unitType ?? ''}
                      onValueChange={(next) => onPatch({ unitType: next as UnitType })}
                      disabled={Boolean(lockedType)}
                    >
                      <SelectTrigger id={`ut-${idPrefix}`}>
                        <SelectValue placeholder={locale === 'en' ? 'Select…' : 'اختر…'} />
                      </SelectTrigger>
                      {/*
                        `INDEPENDENT_HOUSE` is the one exclusion, and not an
                        oversight: a منزل مستقل is not a unit inside a building,
                        it is what a whole منزل card is. `PropertyEntry` derives
                        it there, so offering it here would invite someone to
                        file a house as a flat on the third floor — and produce
                        a row that a fee aimed at «منازل مستقلة» would then
                        charge twice over.
                      */}
                      <SelectContent>
                        {BUILDING_UNIT_TYPES.map((o) => (
                          <SelectItem key={o} value={o}>
                            {labels.unitType[o]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field
                    label={locale === 'en' ? 'Floor' : 'الطابق'}
                    htmlFor={`fl-${idPrefix}`}
                    required
                    error={errors.floor}
                    hint={lockedFloor}
                    className={cn(!showFloor && 'hidden')}
                  >
                    <Input
                      id={`fl-${idPrefix}`}
                      invalid={Boolean(errors.floor)}
                      value={unit.floor ?? ''}
                      onChange={(e) => onPatch({ floor: e.target.value })}
                      readOnly={Boolean(lockedFloor)}
                      aria-readonly={Boolean(lockedFloor) || undefined}
                      className={cn(lockedFloor && 'bg-muted text-muted-foreground')}
                    />
                  </Field>
                </div>

                <div
                  className={cn('grid gap-3.5 sm:grid-cols-2', !showArea && !showSide && 'hidden')}
                >
                  <Field
                    label={locale === 'en' ? 'Unit Area (sq. meters)' : 'مساحة الوحدة (متر مربع)'}
                    htmlFor={`ua-${idPrefix}`}
                    required
                    error={errors.unitArea}
                    hint={lockedArea}
                    className={cn(!showArea && 'hidden')}
                  >
                    <Input
                      id={`ua-${idPrefix}`}
                      inputMode="decimal"
                      invalid={Boolean(errors.unitArea)}
                      value={unit.unitArea ?? ''}
                      onChange={(e) => onPatch({ unitArea: e.target.value })}
                      readOnly={Boolean(lockedArea)}
                      aria-readonly={Boolean(lockedArea) || undefined}
                      className={cn(lockedArea && 'bg-muted text-muted-foreground')}
                    />
                  </Field>

                  <Field
                    label={locale === 'en' ? 'Side / Orientation' : 'الجهة'}
                    htmlFor={`sd-${idPrefix}`}
                    hint={lockedSide}
                    className={cn(!showSide && 'hidden')}
                  >
                    <Input
                      id={`sd-${idPrefix}`}
                      placeholder={locale === 'en' ? 'e.g. North, South' : 'مثال: شمالي، جنوبي'}
                      value={unit.side ?? ''}
                      onChange={(e) => onPatch({ side: e.target.value })}
                      readOnly={Boolean(lockedSide)}
                      aria-readonly={Boolean(lockedSide) || undefined}
                      className={cn(lockedSide && 'bg-muted text-muted-foreground')}
                    />
                  </Field>
                </div>

                <SharedRightsField
                  idPrefix={`sr-${idPrefix}`}
                  selected={unit.sharedRights ?? []}
                  onChange={(sharedRights) => onPatch({ sharedRights })}
                  locale={locale}
                />

                {asksUnitStatus ? (
                  <UnitStatusChoice
                    idPrefix={`us-${idPrefix}`}
                    value={unit.unitStatus}
                    onChange={(unitStatus) => onPatch({ unitStatus })}
                    locale={locale}
                  />
                ) : null}
              </div>
  );
}
