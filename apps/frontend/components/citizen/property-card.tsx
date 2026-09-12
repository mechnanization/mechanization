'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MapPin,
  Plus,
  TriangleAlert,
  Users,
} from 'lucide-react';
import {
  getLabels,
  isUnoccupied,
  LAND_TYPE,
  OCCUPANCY_TYPE,
  PROPERTY_FIELD_MAP,
  STRUCTURE_TYPE_MAP,
} from '@mechanization/shared-schemas';
import type {
  LandType,
  OccupancyType,
  PropertyType,
  StructureType,
  UnitStatus,
  UnitType,
} from '@mechanization/shared-schemas';
import {
  checkPropertyNumber,
  peekPropertyNumberCheck,
  type PropertyNumberCheck,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  BuildingUnitPicker,
  type LinkedBuildingFacts,
  type LockedCensusTarget,
} from '@/components/admin/building-unit-picker';
import { LandlordMatchHint } from '@/components/admin/landlord-match-hint';
import { cn, scopeErrors } from '@/lib/utils';
import {
  type CensusUnitFacts,
  flagPath,
  SharedRightsField,
  UnitsEditor,
  UnitStatusChoice,
} from '@/components/citizen/unit-fields';

export interface UnitDraft {
  /**
   * The canonical `Unit` this line describes, when the officer linked one.
   *
   * Set by `BuildingUnitPicker` and never typed. Where it is present the
   * census record outranks this row field by field (P2-T8); where it is absent
   * — a card filed before the building was surveyed — this row is all there is,
   * and that is permanent rather than transitional.
   */
  unitId?: string;
  unitType?: UnitType;
  floor?: string;
  side?: string;
  unitArea?: string;
  sharedRights?: string[];
  /** حالة الوحدة. Undefined is "not recorded", which is not «مشغولة». */
  unitStatus?: UnitStatus;
}

export interface PropertyDraft {
  id?: string;
  /** The censused structure this card is about, when one was linked (§3.7). */
  buildingId?: string;
  /**
   * Set when the officer chose «منشأة جديدة على هذا العقار» and the building
   * does not exist yet.
   *
   * `buildingId` is filled in at the same moment, with the id carried here —
   * the browser mints it, and `clientSubmissionId` makes it the row's primary
   * key, so every other part of the form can reference the structure before it
   * has been sent. The creation itself is issued at submit time, before the
   * registration, because a card must never name a building that failed to be
   * made.
   *
   * Stripped by `toPayloadProperty`: this describes work still to be done, not
   * a field of the card.
   */
  pendingBuilding?: {
    /** Minted in the picker; becomes `Building.id` via `clientSubmissionId`. */
    id: string;
    parcelNumber: string;
    structureType: StructureType;
    /**
     * «تحقَّقت، وهذه منشأة مختلفة» (D18), or "the census could not be reached
     * and a person said to create one anyway". Both are a human answering the
     * question, which is the only thing the server's guard is asking for.
     */
    acknowledgedDuplicates: boolean;
  };
  occupancyType?: OccupancyType;
  landlordName?: string;
  landlordPhone?: string;
  propertyType?: PropertyType;
  neighborhood?: string;
  propertyNumber?: string;
  landType?: LandType;
  buildingName?: string;
  side?: string;
  tentLocation?: string;
  unitArea?: string;
  /** أرض only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares?: string;
  sharedRights?: string[];
  /** منزل only — a مبنى states this per unit inside `units`. */
  unitStatus?: UnitStatus;
  units?: UnitDraft[];
}

const CHECK_DEBOUNCE_MS = 500;

export function PropertyCard({
  tenant,
  index,
  draft,
  allowedTypes,
  collapsed,
  onToggleCollapse,
  onChange,
  onAddOnSameParcel,
  onViewParcel,
  onRemove,
  canRemove,
  errors = {},
  locale = 'ar',
  title,
  token,
  citizenId,
  censusPicker = false,
  lockedCensusTarget,
}: {
  tenant: string;
  index: number;
  draft: PropertyDraft;
  /**
   * The citizen this card belongs to, when they already have an id.
   *
   * Forwarded to `BuildingUnitPicker` and read only by its unit chips, to tell
   * "this person is already recorded in that flat" from "somebody else is".
   * The first is a confirmation and the second decides who pays the رسم نظافة;
   * without an id the control could not distinguish them and said the same
   * thing for both.
   */
  citizenId?: string;
  allowedTypes: readonly PropertyType[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  /**
   * An updater, deliberately — never a finished draft.
   *
   * Forcing every caller through `(current) => next` is what makes concurrent
   * writes compose instead of clobbering each other. A signature that also
   * accepted a plain `PropertyDraft` would let the old snapshot-spreading shape
   * back in, and its failure mode is silent: the card renders correctly and the
   * value is lost on save. See `set` below.
   */
  onChange: (update: (current: PropertyDraft) => PropertyDraft) => void;
  /**
   * Start another structure on this same رقم العقار.
   *
   * Offered only while this card is the sole one on its parcel — once a second
   * one exists, `citizen-form.tsx` groups them under one shared header and the
   * "add" action moves there, so it is not repeated once per card.
   */
  onAddOnSameParcel?: () => void;
  /** Show who else is registered on this parcel. Admin form only. */
  onViewParcel?: (propertyNumber: string) => void;
  onRemove: () => void;
  canRemove: boolean;
  errors?: Record<string, string>;
  locale?: string;
  /** Overrides the default "العقار {index+1}" heading — used when grouped under a shared parcel. */
  title?: string;
  /** A staff session. Without one the census picker is not rendered at all. */
  token?: string | null;
  /** Opt-in, so the citizen wizard's own use of this card is unchanged. */
  censusPicker?: boolean;
  /** Set when the form was launched from a building's unit matrix. */
  lockedCensusTarget?: LockedCensusTarget | null;
}) {
  const labels = getLabels(locale);
  const visible: readonly string[] = draft.propertyType
    ? PROPERTY_FIELD_MAP[draft.propertyType]
    : [];

  /*
    Every write is expressed against the card's *current* value, never against
    the `draft` prop this render closed over.

    `onChange({ ...draft, ...patch })` was the old shape, and it made each write
    a full-copy replacement built from a snapshot. Two writes landing in one
    commit both spread the same snapshot, so the second reverted the first —
    and the census picker issues exactly that pattern: linking a building sets
    `buildingId`, the fetch it triggers fires the effect that copies
    «اسم المبنى» down, and that second write — built from the pre-link snapshot
    — put `buildingId` back to undefined. The officer watched the building stay
    selected, saved, and was told «بلا ربط بسجل المباني».
  */
  const set = (patch: Partial<PropertyDraft>) =>
    onChange((current) => ({ ...current, ...patch }));

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /**
   * Whether the census-known fields are shown as fields rather than as facts.
   *
   * Closed by default, because the whole point is that an officer filling a
   * linked card should not have to scan six read-only boxes to find the one
   * question they came to ask. Opened when they want to check a value against
   * the flat in front of them — which is a deliberate act, and rare.
   */
  const [showCensusDetails, setShowCensusDetails] = useState(false);

  /**
   * The censused structure this card is linked to, reported up by the picker.
   *
   * Held here rather than fetched again because the picker already loads it,
   * and two components asking the server the same question is how they end up
   * disagreeing about the answer. It is what «اسم المبنى» reads from when the
   * register has a name for the block.
   */
  const [linkedBuilding, setLinkedBuilding] = useState<LinkedBuildingFacts | null>(null);

  /**
   * `unitId` → `0202`, so «وحدات المبنى» can head a linked row by the code the
   * officer picked off the matrix rather than by its position in this form.
   *
   * Derived from what the picker already loaded. The alternative — the card
   * fetching the building a second time — is how two components start
   * disagreeing about it, which is the same reason `linkedBuilding` is
   * reported upward rather than re-read.
   */
  /**
   * What «نوع الوحدة» starts as on a new row, decided by the structure.
   *
   * `STRUCTURE_TYPE_MAP` is the one statement of which unit a structure is made
   * of, and the building editor has always read it — picking «مستودع / هنغار»
   * there defaults the blueprint to مستودع. This card offered the same
   * structure-type list and then asked the question again per flat.
   *
   * Read from the *pending* structure only. A card linked to a building that
   * already exists gets its unit rows from the matrix, where each flat carries
   * the type the census recorded for it, and a default would be overruling a
   * surveyed fact with a guess about the block as a whole.
   */
  const defaultUnitType = draft.pendingBuilding
    ? STRUCTURE_TYPE_MAP[draft.pendingBuilding.structureType].defaultUnitType
    : undefined;

  const unitCodes = useMemo(() => {
    const codes: Record<string, string> = {};
    for (const unit of linkedBuilding?.units ?? []) codes[unit.id] = unit.unitCode;
    return codes;
  }, [linkedBuilding]);

  /**
   * What the census holds about each linked flat, keyed by canonical unit id.
   *
   * The rule every lock on this card follows: **a field is stated rather than
   * asked if, and only if, the register has an answer for it.** A `Unit` with
   * no recorded area leaves «مساحة الوحدة» open, because the officer standing
   * in the flat with a tape measure is the person who can establish it — and
   * locking an empty field would make the value unrecordable by the only person
   * in a position to record it. That is the rule «اسم المبنى» has always
   * followed; this is the same rule, applied per field.
   */
  const censusUnits = useMemo(() => {
    const facts: Record<string, CensusUnitFacts> = {};
    for (const unit of linkedBuilding?.units ?? []) facts[unit.id] = unit;
    return facts;
  }, [linkedBuilding]);

  /** The register has an answer, so the field states it instead of asking. */
  const namedByCensus = Boolean(draft.buildingId && linkedBuilding?.name);

  /**
   * رقم العقار belongs to the structure once the card is linked to one.
   *
   * Locked whenever a *censused* building is loaded — never for a pending one,
   * which has no parcel of its own and takes the card's. `BuildingUnitPicker`
   * mirrors the register's value down, so by the time this is true the field
   * already shows it; the lock is what stops the two drifting apart again.
   */
  const parcelFromCensus =
    draft.buildingId && linkedBuilding && draft.buildingId === linkedBuilding.id
      ? linkedBuilding.parcelNumber
      : null;

  /**
   * Whether نوع العقار is the census's answer rather than this form's question.
   *
   * The same condition as `parcelFromCensus` and deliberately derived from it:
   * both facts belong to the structure, so they become statements at exactly
   * the same moment — when a card is linked to a building that actually exists.
   */
  const typeFromCensus = Boolean(parcelFromCensus);

  const isBuilding = draft.propertyType === 'BUILDING';
  const units = draft.units ?? [];

  const isTenant = draft.occupancyType === 'TENANT';
  const isNonOwner = isTenant || draft.occupancyType === 'FREE_OCCUPANT';
  /*
    Only an owner is asked whether a unit is empty.

    A مستأجر or a شاغل بتسامح *is* the شاغل of the unit they are filing, so the
    question contradicts the card it would sit on — and a «شاغرة» left behind
    on one after the occupancy was changed could exempt someone from a fee they
    owe. `PropertyEntry.normalise` strips it server-side for the same reason;
    this is the half that stops it being asked in the first place.
  */
  const asksUnitStatus = draft.occupancyType === 'OWNER';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-2 border-b">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="-m-2 flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-start transition-colors hover:bg-accent"
        >
          <ChevronDown
            className={cn(
              'size-5 shrink-0 text-muted-foreground transition-transform',
              collapsed && '-rotate-90 rtl:rotate-90',
            )}
            aria-hidden
          />
          <span className="min-w-0">
            <CardTitle className="text-xl">
              {title ?? (locale === 'en' ? `Property ${index + 1}` : `العقار ${index + 1}`)}
            </CardTitle>
            {collapsed ? (
              <span className="mt-1 block truncate text-sm font-normal text-muted-foreground">
                {summarise(draft, locale)}
              </span>
            ) : null}
          </span>
        </button>

        {canRemove ? (
          <Button
            variant="ghost"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmingRemove(true)}
          >
            {locale === 'en' ? 'Delete' : 'حذف'}
          </Button>
        ) : null}
      </CardHeader>

      {/*
        Folded away with CSS, not unmounted.

        `{collapsed ? null : …}` threw the body away, and with it everything the
        census picker had loaded and decided. Re-opening a card re-mounted the
        picker, which re-fetched the parcel's structures and the linked
        building's matrix — «جاري مراجعة سجل المباني…» again on every fold, on
        the phones least able to afford it.

        Worse than the spinner was what came back wrong. «بدون ربط» lives in the
        picker's own state, because "declined" and "not yet decided" are the
        same absence in the draft; a re-mount forgot it, and the auto-preselect
        that arms a new structure on an empty parcel was then free to fire
        again. Folding a card the officer had deliberately left unlinked could
        silently queue a building for creation.

        Hidden rather than removed, so the picker keeps its fetches and its
        answers for as long as the form is open. The cost is that a collapsed
        card loads its matrix too — which is work the officer was going to
        need anyway, and it is now done before they open the card rather than
        while they wait.
      */}
      <div className={cn(collapsed && 'hidden')}>
        <CardContent className="space-y-4 pt-4">
          {/*
            What the register already knows, said once, as a statement.

            These values were read-only inputs a moment ago and that was the
            wrong shape for them. A disabled field still costs a label, a box,
            a row of the grid and a beat of the officer's attention — six of
            them on a linked card, every one of which they must scan past to
            reach «نوع الإشغال», the single question they are at the door to
            ask. Facts do not need input boxes; they need to be legible and out
            of the way.

            Nothing is hidden in the sense of unavailable. «عرض التفاصيل»
            reveals the same fields, still read-only and still carrying the
            hint that names where each is corrected, for the officer who wants
            to check a value against the flat in front of them.
          */}
          {parcelFromCensus && linkedBuilding ? (
            <CensusFacts
              building={linkedBuilding}
              draft={draft}
              censusUnits={censusUnits}
              expanded={showCensusDetails}
              onToggle={() => setShowCensusDetails((open) => !open)}
              locale={locale}
            />
          ) : null}

          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field
              label={locale === 'en' ? 'Neighborhood' : 'الحي'}
              htmlFor={`nb-${index}`}

              path={flagPath(index, 'neighborhood')}
              required
              error={errors.neighborhood}
            >
              <Input
                id={`nb-${index}`}
                invalid={Boolean(errors.neighborhood)}
                value={draft.neighborhood ?? ''}
                onChange={(e) => set({ neighborhood: e.target.value })}
              />
            </Field>

            {/*
              Withdrawn from the grid once the strip above states it. Rendered
              again, unchanged and still read-only, when «عرض التفاصيل» is open
              — the field is the detail view of the fact, not a second copy of
              it, so there is exactly one place a parcel can be read from at any
              moment.
            */}
            {parcelFromCensus && !showCensusDetails ? null : (
              <PropertyNumberField
                tenant={tenant}
                index={index}
                value={draft.propertyNumber ?? ''}
                onChange={(propertyNumber) => set({ propertyNumber })}
                onViewParcel={onViewParcel}
                lockedToBuilding={
                  parcelFromCensus && linkedBuilding ? linkedBuilding.code : null
                }
                locale={locale}
              />
            )}
          </div>

          {/*
            The census link, on the two types that can stand on a structure.

            Staff-only, because it needs a session to read the census — the
            citizen wizard renders this same card and simply does not get the
            control, which is correct: a resident has no view of the
            municipality's survey and nothing to link against.

            أرض has nothing standing on it and a خيمة stays a bare card (Q2), so
            neither is offered one.
          */}
          {token && censusPicker && (draft.propertyType === 'BUILDING' || draft.propertyType === 'HOUSE') ? (
            <BuildingUnitPicker
              tenant={tenant}
              token={token}
              draft={draft}
              citizenId={citizenId}
              // The card's own updater, passed straight through rather than
              // wrapped in `set`: the picker computes `units` from the previous
              // array, so it needs the current card, not a patch applied to it.
              onChange={onChange}
              onLinkedBuilding={setLinkedBuilding}
              locked={lockedCensusTarget}
              locale={locale}
            />
          ) : null}

          {onAddOnSameParcel && draft.propertyNumber ? (
            <button
              type="button"
              onClick={onAddOnSameParcel}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-dashed border-primary/50 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
            >
              <Plus className="size-3.5 shrink-0" aria-hidden />
              {locale === 'en'
                ? `Add another property on parcel ${draft.propertyNumber}`
                : `إضافة ملكية أخرى على العقار ${draft.propertyNumber}`}
            </button>
          ) : null}

          <div className="space-y-4">
            <Field
              label={locale === 'en' ? 'Occupancy Type' : 'نوع الإشغال'}
              htmlFor={`occ-${index}`}
              required
              error={errors.occupancyType}
            >
              <SegmentedControl
                value={draft.occupancyType ?? ''}
                invalid={Boolean(errors.occupancyType)}
                onChange={(v) => set({ occupancyType: v as OccupancyType })}
                options={OCCUPANCY_TYPE.map((option) => ({
                  value: option,
                  label: labels.occupancyType[option] ?? option,
                }))}
              />
            </Field>

            <Field
              label={locale === 'en' ? 'Property Type' : 'نوع العقار'}
              htmlFor={`pt-${index}`}
              required
              error={errors.propertyType}
              // Stated by the strip while it is collapsed — see `CensusFacts`.
              className={cn(typeFromCensus && !showCensusDetails && 'hidden')}
              /*
                What stands on the parcel is the census's answer, not this
                form's, once the card is linked to a structure.

                `STRUCTURE_TYPE_MAP` is the single statement of the
                correspondence (D15) and `censusDraft` seeds the card through
                it — a مجمع تجاري becomes a مبنى card, a منزل مستقل a منزل. The
                control stayed switchable anyway, so an officer could flip a
                flat they had been sent to into أرض or خيمة while `buildingId`
                went on pointing at a residential block. `branchFieldsOnly`
                then silently drops the link on anything but مبنى/منزل, so the
                card saved unlinked with no complaint anywhere — the exact
                failure `census-link.spec.ts` exists about, reachable by one
                tap.

                A *pending* structure is left switchable: nothing stands there
                yet, the officer chose the structure type moments ago, and
                changing their mind is a correction rather than a contradiction.
              */
              hint={
                typeFromCensus
                  ? locale === 'en'
                    ? `Determined by what stands on the parcel (${linkedBuilding!.code}). Unlink to change it.`
                    : `يحدّده ما هو قائم على العقار (${linkedBuilding!.code}). لتغييره، ألغِ الربط.`
                  : undefined
              }
            >
              <SegmentedControl
                value={draft.propertyType ?? ''}
                invalid={Boolean(errors.propertyType)}
                disabled={typeFromCensus}
                onChange={(v) =>
                  onChange((current) => changePropertyType(current, v as PropertyType))
                }
                options={allowedTypes.map((option) => ({
                  value: option,
                  label: labels.propertyType[option] ?? option,
                }))}
              />
            </Field>
          </div>

          {/*
            The landlord block belongs to both non-owner occupancies.

            A شاغل بتسامح is not the owner either, and the municipality needs
            the same name from them — but only the *name*. Their owner is
            typically a relative abroad or deceased, and a required phone there
            yields an invented number rather than a real one, so the field is
            offered and not demanded. See `occupancyBranch`.
          */}
          {isNonOwner ? (
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field
                label={locale === 'en' ? 'Landlord Name' : 'اسم المالك'}
                htmlFor={`ln-${index}`}

                path={flagPath(index, 'landlordName')}
                required
                error={errors.landlordName}
              >
                <Input
                  id={`ln-${index}`}
                  invalid={Boolean(errors.landlordName)}
                  value={draft.landlordName ?? ''}
                  onChange={(e) => set({ landlordName: e.target.value })}
                />
              </Field>
              <Field
                label={locale === 'en' ? 'Landlord Phone' : 'رقم هاتف المالك'}
                htmlFor={`lp-${index}`}

                path={isTenant ? flagPath(index, 'landlordPhone') : undefined}
                required={isTenant}
                error={errors.landlordPhone}
                /*
                  The field most likely to hold a foreign number of any on this
                  form. A شاغل بتسامح's landlord is typically a relative abroad
                  — which is exactly why `occupancyBranch` makes this optional
                  for them — and a مستأجر's owner is often no nearer.
                */
                hint={
                  locale === 'en'
                    ? 'Lebanese numbers need no country code; for another country start with +.'
                    : 'الرقم اللبناني لا يحتاج رمز الدولة؛ لرقم من دولة أخرى ابدأ بـ +.'
                }
              >
                <Input
                  id={`lp-${index}`}
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  placeholder="03 123456 / +33 6 12 34 56 78"
                  className="text-start"
                  invalid={Boolean(errors.landlordPhone)}
                  value={draft.landlordPhone ?? ''}
                  onChange={(e) => set({ landlordPhone: e.target.value })}
                />

                {/*
                  Whether the owner being named is already on the register.

                  Staff-only for the same reason the census picker is: it reads
                  the municipality's own citizen list, and a resident filling in
                  the public wizard has no business being told which of their
                  neighbours the register holds. Gated on the identical pair, so
                  the two controls can never disagree about who is looking.
                */}
                {token && censusPicker && draft.landlordPhone ? (
                  <LandlordMatchHint
                    tenant={tenant}
                    token={token}
                    phone={draft.landlordPhone}
                    locale={locale}
                  />
                ) : null}
              </Field>
            </div>
          ) : null}

          <div className="grid gap-3.5 sm:grid-cols-2">
            {visible.includes('buildingName') ? (
              <Field
                label={
                  isBuilding
                    ? (locale === 'en' ? 'Building Name' : 'اسم المبنى')
                    : (locale === 'en' ? 'Building / House Name' : 'اسم المبنى/المنزل')
                }
                htmlFor={`bn-${index}`}

                path={flagPath(index, 'buildingName')}
                required
                error={errors.buildingName}
                /*
                  Where the register has a name, this field states it rather
                  than asks for it.

                  Two tenants of one block used to produce «بناية النور» and
                  «بنايه الن‍ور» in two rows nothing could recognise as the same
                  building, because `PropertyEntry.buildingName` and
                  `Building.name` were unrelated free-text columns with nothing
                  comparing them. Linked, the register is the single answer and
                  every card in the building shows it.

                  The lock is deliberately one-directional. A building with *no*
                  name leaves the field open, because the officer standing in
                  its stairwell is the person who learns what residents call it
                  — and what they type is promoted onto the building itself on
                  save. Locking an empty field would make the name unrecordable
                  by the only person who knows it.
                */
                hint={
                  namedByCensus
                    ? locale === 'en'
                      ? `From the census record for ${linkedBuilding!.code}. Edit it on the building itself.`
                      : `من سجل المباني (${linkedBuilding!.code}). التعديل يتم على المبنى نفسه.`
                    : undefined
                }
                // Stated by the strip while it is collapsed. An *unnamed*
                // building keeps its field visible whatever the strip says:
                // the officer in the stairwell is the person who learns the
                // name, and a fact the register does not hold cannot be
                // summarised into one.
                className={cn(namedByCensus && !showCensusDetails && 'hidden')}
              >
                <Input
                  id={`bn-${index}`}
                  invalid={Boolean(errors.buildingName)}
                  value={draft.buildingName ?? ''}
                  onChange={(e) => set({ buildingName: e.target.value })}
                  readOnly={namedByCensus}
                  aria-readonly={namedByCensus || undefined}
                  className={cn(namedByCensus && 'bg-muted text-muted-foreground')}
                />
              </Field>
            ) : null}

            {visible.includes('landType') ? (
              <Field
                label={locale === 'en' ? 'Land Type' : 'نوع الأرض'}
                htmlFor={`lt-${index}`}

                path={flagPath(index, 'landType')}
                required
                error={errors.landType}
              >
                <Select
                  value={draft.landType ?? ''}
                  onValueChange={(next) => set({ landType: next as LandType })}
                >
                  <SelectTrigger id={`lt-${index}`}>
                    <SelectValue placeholder={locale === 'en' ? 'Select…' : 'اختر…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {LAND_TYPE.map((o) => (
                      <SelectItem key={o} value={o}>
                        {labels.landType[o]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            {visible.includes('side') ? (
              <Field
                label={locale === 'en' ? 'Side / Orientation' : 'الجهة'}
                htmlFor={`sd-${index}`}

                path={flagPath(index, 'side')}
              >
                <Input
                  id={`sd-${index}`}
                  placeholder={locale === 'en' ? 'e.g. North, South, East, West' : 'مثال: شمالي، جنوبي'}
                  value={draft.side ?? ''}
                  onChange={(e) => set({ side: e.target.value })}
                />
              </Field>
            ) : null}

            {visible.includes('tentLocation') ? (
              <Field
                label={locale === 'en' ? 'Tent Location Description' : 'وصف موقع الخيمة'}
                htmlFor={`tl-${index}`}

                path={flagPath(index, 'tentLocation')}
                required
                error={errors.tentLocation}
              >
                <Input
                  id={`tl-${index}`}
                  placeholder={locale === 'en' ? 'e.g. North Camp — Plot 4' : 'مثال: المخيم الشمالي — قطعة ٤'}
                  invalid={Boolean(errors.tentLocation)}
                  value={draft.tentLocation ?? ''}
                  onChange={(e) => set({ tentLocation: e.target.value })}
                />
              </Field>
            ) : null}

            {visible.includes('unitArea') ? (
              <Field
                label={locale === 'en' ? 'Unit Area (sq. meters)' : 'مساحة الوحدة (متر مربع)'}
                htmlFor={`ua-${index}`}

                path={flagPath(index, 'unitArea')}
                required
                error={errors.unitArea}
              >
                <Input
                  id={`ua-${index}`}
                  inputMode="decimal"
                  invalid={Boolean(errors.unitArea)}
                  value={draft.unitArea ?? ''}
                  onChange={(e) => set({ unitArea: e.target.value })}
                />
              </Field>
            ) : null}

            {visible.includes('shares') ? (
              <Field
                label={locale === 'en' ? 'Shares (out of 2400)' : 'الأسهم (من أصل 2400)'}
                htmlFor={`sh-${index}`}
                path={flagPath(index, 'shares')}
                required
                error={errors.shares}
              >
                <Input
                  id={`sh-${index}`}
                  inputMode="numeric"
                  dir="ltr"
                  className="text-start"
                  placeholder={locale === 'en' ? 'e.g. 400' : 'مثال: ٤٠٠'}
                  invalid={Boolean(errors.shares)}
                  value={draft.shares ?? ''}
                  onChange={(e) => set({ shares: e.target.value })}
                />
              </Field>
            ) : null}
          </div>

          {/*
            Only a منزل asks this on the card itself — it is the one type whose
            single unit is the whole card. A مبنى asks per unit below; أرض and
            خيمة are never asked, because «is this plot vacant» has no answer
            worth storing and the question would land on every tent
            registration in a settlement.
          */}
          {asksUnitStatus && draft.propertyType === 'HOUSE' ? (
            <UnitStatusChoice
              idPrefix={`us-${index}`}
              value={draft.unitStatus}
              onChange={(unitStatus) => set({ unitStatus })}
              locale={locale}
            />
          ) : null}

          {visible.includes('sharedRights') ? (
            <SharedRightsField
              idPrefix={`sr-${index}`}
              path={flagPath(index, 'sharedRights')}
              selected={draft.sharedRights ?? []}
              onChange={(sharedRights) => set({ sharedRights })}
              locale={locale}
            />
          ) : null}

          {visible.includes('units') ? (
            <UnitsEditor
              index={index}
              units={units}
              unitCodes={unitCodes}
              censusUnits={censusUnits}
              defaultUnitType={defaultUnitType}
              asksUnitStatus={asksUnitStatus}
              errors={scopeErrors(errors, 'units')}
              onChange={(update) =>
                onChange((current) => ({ ...current, units: update(current.units ?? []) }))
              }
              locale={locale}
            />
          ) : null}
        </CardContent>
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title={locale === 'en' ? `Delete Property ${index + 1}?` : `حذف العقار ${index + 1}؟`}
        description={
          locale === 'en' ? (
            <>
              This property and all entered information
              {units.length > 0 ? ` and ${units.length} unit(s) inside it` : ''} will be removed from the form.
              Nothing is saved until you submit the form.
            </>
          ) : (
            <>
              سيُحذف هذا العقار من النموذج بكل ما أُدخل فيه
              {units.length > 0 ? ` و${units.length} وحدة داخله` : ''}. لن يُحفظ شيء حتى تُرسل
              النموذج، فيمكنك إضافته من جديد.
            </>
          )
        }
        confirmLabel={locale === 'en' ? 'Delete Property' : 'حذف العقار'}
        onConfirm={() => {
          setConfirmingRemove(false);
          onRemove();
        }}
      />
    </Card>
  );
}

/**
 * What the register already knows about this card, as a statement rather than
 * as six disabled inputs.
 *
 * ## The problem it solves
 *
 * A card reached from «تسجيل أسرة في هذه الوحدة» arrives with the parcel, the
 * structure type, the building's name and the flat's type, floor, side and area
 * already answered — by the municipality's own survey, which is more
 * authoritative than anything the officer could retype. Rendering those as
 * read-only fields was honest and unreadable: each one still costs a label, a
 * box, a grid cell and a beat of attention, and the officer has to scan past
 * all of them to reach «نوع الإشغال» — the one question they are standing at
 * the door to ask.
 *
 * Facts read as facts. Two lines, one border, no inputs.
 *
 * ## Why it is not a card
 *
 * A card inside a card is the lazy container twice over, and this is a passage
 * of *information inside* a form, not a sibling object to it. One hairline
 * border and a tinted ground place it without pretending it is a separate
 * thing — and the card it sits in keeps the only elevation on screen.
 *
 * ## Why nothing is truly hidden
 *
 * «عرض التفاصيل» renders the same fields, still read-only, still carrying the
 * hint that names where each one is corrected. An officer checking the area
 * against the flat in front of them needs the label beside the number; an
 * officer filling in the household does not. The toggle is the difference
 * between those two jobs, and it costs one tap.
 */
function CensusFacts({
  building,
  draft,
  censusUnits,
  expanded,
  onToggle,
  locale,
}: {
  building: LinkedBuildingFacts;
  draft: PropertyDraft;
  censusUnits: Record<string, CensusUnitFacts>;
  expanded: boolean;
  onToggle: () => void;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  /*
    The flats this card names that the census also knows, in card order.

    Rendered per unit rather than summarised into a count, because the count is
    not the fact an officer checks — «0001 · شقة · الأرضي · ٩٠ م²» is. A card
    naming more than a couple of flats is a landlord's, and there the list is
    the content; it wraps rather than truncating.
  */
  const units = (draft.units ?? [])
    .map((row) => (row.unitId ? censusUnits[row.unitId] : undefined))
    .filter((unit): unit is CensusUnitFacts => Boolean(unit));

  const structureLine = [
    draft.propertyType ? labels.propertyType[draft.propertyType] : null,
    draft.propertyNumber
      ? en
        ? `Parcel ${draft.propertyNumber}`
        : `العقار ${draft.propertyNumber}`
      : null,
    building.name,
  ].filter(Boolean);

  return (
    <section
      aria-label={en ? 'From the census record' : 'من سجل المباني'}
      className="rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5 sm:px-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Building2 className="size-3.5 shrink-0" aria-hidden />
          {en ? 'From the census record' : 'من سجل المباني'}
        </span>

        {/*
          The building's code, in the one typeface that makes `A-3-A-0001`
          legible — and `dir="ltr"`, because a Latin-and-digit code inside an
          RTL line is reordered by the bidi algorithm into something that is
          not the code.
        */}
        <span
          dir="ltr"
          className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary"
        >
          {building.code}
        </span>

        {/*
          `ms-auto` rather than `justify-between` on the row: the row has two
          children at narrow widths and three at wide ones, and only the toggle
          should ever be flung to the end.
        */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="ms-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {expanded
            ? en
              ? 'Hide details'
              : 'إخفاء التفاصيل'
            : en
              ? 'Show details'
              : 'عرض التفاصيل'}
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform duration-200', expanded && 'rotate-180')}
            aria-hidden
          />
        </button>
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-foreground">
        {structureLine.join(' · ')}
      </p>

      {units.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {units.map((unit) => (
            <li key={unit.id} className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-mono font-medium text-foreground/80" dir="ltr">
                {unit.unitCode}
              </span>
              {' · '}
              {[
                unit.unitType ? labels.unitType[unit.unitType as UnitType] : null,
                unit.floor,
                unit.side,
                unit.unitArea ? (en ? `${unit.unitArea} m²` : `${unit.unitArea} م²`) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function changePropertyType(draft: PropertyDraft, propertyType: PropertyType): PropertyDraft {
  const keep: PropertyDraft = {
    id: draft.id,
    occupancyType: draft.occupancyType,
    landlordName: draft.landlordName,
    landlordPhone: draft.landlordPhone,
    neighborhood: draft.neighborhood,
    propertyNumber: draft.propertyNumber,
    propertyType,
  };

  /*
    The census link survives a move between the two types that can hold one.

    `buildingId` used to be absent from every branch below, so switching a card
    from مبنى to منزل — a correction an officer makes constantly, since it is
    the same structure described differently — silently discarded the link.
    The building stayed, the card stopped pointing at it, and `Unit`'s authority
    over the row went with it, which is what a bill is computed from.

    It is dropped on أرض and خيمة, and that is not the same event: land has
    nothing standing on it and a tent stays a bare card (Q2), so `buildingId`
    has no meaning there and `branchFieldsOnly` refuses it server-side anyway.

    `units[].unitId` is deliberately *not* carried across. A منزل card has no
    units array at all, and a مبنى's flats are picked against a specific matrix
    — the building is the same, the choice of flats within it is not.
  */
  const censusLink: Pick<PropertyDraft, 'buildingId' | 'pendingBuilding'> = {
    buildingId: draft.buildingId,
    pendingBuilding: draft.pendingBuilding,
  };

  if (propertyType === 'BUILDING') {
    keep.buildingName = draft.buildingName;
    keep.units = draft.units?.length ? draft.units.map(({ unitId: _drop, ...u }) => u) : [{}];
    Object.assign(keep, censusLink);
  }
  if (propertyType === 'HOUSE') {
    keep.buildingName = draft.buildingName;
    keep.side = draft.side;
    keep.unitArea = draft.unitArea;
    keep.sharedRights = draft.sharedRights;
    keep.unitStatus = draft.unitStatus;
    Object.assign(keep, censusLink);
  }
  if (propertyType === 'LAND') {
    keep.landType = draft.landType;
    keep.unitArea = draft.unitArea;
    keep.shares = draft.shares;
  }
  if (propertyType === 'TENT') {
    keep.tentLocation = draft.tentLocation;
  }

  return keep;
}

/**
 * «٣ وحدات شاغرة» on a folded card, or nothing.
 *
 * Only the unoccupied count, and only when there is one. A summary reading
 * «١٠ وحدات — ٧ مشغولة — ٣ شاغرة» is a table, not a line; what a clerk
 * scanning collapsed cards is looking for is the exception, and the exception
 * here is the units that may be exempt from a fee.
 */
function vacancyNote(draft: PropertyDraft, locale: string): string | null {
  const statuses =
    draft.propertyType === 'BUILDING'
      ? (draft.units ?? []).map((unit) => unit.unitStatus)
      : [draft.unitStatus];

  const empty = statuses.filter((status) => isUnoccupied(status)).length;
  if (empty === 0) return null;

  return locale === 'en' ? `${empty} unoccupied` : `${empty} غير مشغولة`;
}

function summarise(draft: PropertyDraft, locale: string = 'ar'): string {
  const labels = getLabels(locale);
  const parts = [
    draft.propertyType
      ? (labels.propertyType[draft.propertyType] ?? draft.propertyType)
      : (locale === 'en' ? 'Unspecified type' : 'لم يُحدَّد النوع'),
    draft.neighborhood || null,
    draft.propertyNumber ? (locale === 'en' ? `#${draft.propertyNumber}` : `رقم ${draft.propertyNumber}`) : null,
    draft.buildingName || null,
    draft.propertyType === 'BUILDING' && draft.units?.length
      ? (locale === 'en' ? `${draft.units.length} units` : `${draft.units.length} وحدة`)
      : null,
    vacancyNote(draft, locale),
  ];
  return parts.filter(Boolean).join(' — ');
}

/**
 * حالة الوحدة, as four things to tap rather than a list to open.
 *
 * A `Select` would match the controls around it and be the wrong choice here.
 * Every other dropdown on this card holds a value the clerk arrives already
 * knowing — نوع العقار, نوع الأرض — and picks once. This one is set repeatedly,
 * unit by unit, by someone walking a building with a phone in one hand; four
 * labelled targets they can hit without reading a menu is the difference
 * between a field that gets filled in and a field that gets skipped.
 *
 * It is also the safer shape for the specific confusion this feature invites.
 * «شاغر» and «شاغل» are one dot apart, and the occupancy dropdown carrying the
 * second is a few centimetres up the same card. Laying these out flat, with an
 * icon each and the two unoccupied states tinted differently, means the choice
 * is legible at a glance instead of resolved by reading two Arabic words very
 * carefully.
 *
 * Tapping the selected option clears it, because the field is genuinely
 * optional and there is no «غير معروف» to pick: an officer who ticked وحدة
 * مؤجرة by accident has to be able to get back to having said nothing, which
 * is a different claim from any of the four.
 */
function PropertyNumberField({
  tenant,
  index,
  value,
  onChange,
  onViewParcel,
  lockedToBuilding = null,
  locale = 'ar',
}: {
  tenant: string;
  index: number;
  value: string;
  onChange: (value: string) => void;
  onViewParcel?: (propertyNumber: string) => void;
  /**
   * The code of the censused structure this card is linked to, when it is.
   *
   * Non-null means the parcel is the *building's* and not this form's to
   * change: the card is linked, the register holds the answer, and the picker
   * has already mirrored it into `value`. Editing it here produced a record
   * claiming one عقار while `buildingId` pointed at a building standing on
   * another — internally inconsistent, validated cleanly, and billed.
   *
   * The escape is the link, not the field. An officer who is on the wrong
   * structure presses «إلغاء الربط» directly below and the parcel is theirs
   * again, which is the correction they actually meant to make.
   */
  lockedToBuilding?: string | null;
  locale?: string;
}) {
  /*
    A verdict this tab already has is stated on the first frame.

    The check is debounced by half a second and fires from a mount effect, so
    re-opening a card the officer had already filled in — or opening the edit
    form on a record whose عقار was checked minutes ago — replayed «جارٍ التحقق
    من الكاداستر…» before printing the same «رقم صحيح» as last time. The parcel
    had not changed; only the component had been unmounted.
  */
  const [result, setResult] = useState<PropertyNumberCheck | null>(
    () => peekPropertyNumberCheck(tenant, value.trim()) ?? null,
  );
  const [checking, setChecking] = useState(false);

  const requestId = useRef(0);

  const verify = useCallback(
    async (candidate: string) => {
      const id = ++requestId.current;
      setChecking(true);
      try {
        const next = await checkPropertyNumber(tenant, candidate);
        if (id === requestId.current) setResult(next);
      } catch {
        if (id === requestId.current) setResult(null);
      } finally {
        if (id === requestId.current) setChecking(false);
      }
    },
    [tenant],
  );

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      requestId.current += 1;
      setResult(null);
      setChecking(false);
      return;
    }

    /*
      Only typing is debounced. A number whose verdict is already held is
      settled now — waiting half a second to re-state it is the spinner this
      field was showing on every mount.
    */
    const known = peekPropertyNumberCheck(tenant, trimmed);
    if (known) {
      requestId.current += 1;
      setResult(known);
      setChecking(false);
      return;
    }

    const timer = setTimeout(() => void verify(trimmed), CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tenant, value, verify]);

  const stale = result !== null && result.propertyNumber !== value.trim();
  const settled = result !== null && !stale && !checking;

  const unknown = settled && result.inCadastre === false;
  const confirmed = settled && result.inCadastre !== false;

  const neighbours = settled ? result.registeredCount : 0;

  return (
    <Field
      label={locale === 'en' ? 'Property Number' : 'رقم العقار'}
      htmlFor={`pn-${index}`}
      path={flagPath(index, 'propertyNumber')}
      required
      hint={
        lockedToBuilding
          ? locale === 'en'
            ? `The parcel ${lockedToBuilding} stands on. Unlink to change it.`
            : `العقار الذي تقوم عليه المنشأة ${lockedToBuilding}. لتغييره، ألغِ الربط.`
          : undefined
      }
    >
      <Input
        id={`pn-${index}`}
        inputMode="numeric"
        dir="ltr"
        placeholder={locale === 'en' ? 'e.g. 1024' : 'مثال: ١٠٢٤'}
        className={cn('text-start', lockedToBuilding && 'bg-muted text-muted-foreground')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={Boolean(lockedToBuilding)}
        aria-readonly={Boolean(lockedToBuilding) || undefined}
      />

      {checking ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {locale === 'en' ? 'Checking cadastre…' : 'جارٍ التحقق من الكاداستر…'}
        </p>
      ) : null}

      {unknown ? (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning space-y-1">
          <p className="font-medium flex items-center gap-1.5">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {locale === 'en'
              ? 'This parcel number is not currently in the municipality cadastre.'
              : 'هذا الرقم غير مدرج في السجل العقاري للبلدية حالياً.'}
          </p>
          <p className="text-[11px] text-muted-foreground leading-normal">
            {locale === 'en'
              ? 'You can save this record now and verify or edit the number during review after syncing.'
              : 'يمكنك حفظ السجل الآن وتصحيح الرقم لاحقاً عند مراجعة الطلب بعد المزامنة.'}
          </p>
        </div>
      ) : null}

      {confirmed ? (
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" aria-hidden />
          {result.location
            ? (locale === 'en' ? 'Valid parcel number — located on municipality map' : 'رقم صحيح — تم تحديد موقع العقار على خريطة البلدية')
            : (locale === 'en' ? 'Valid parcel number' : 'رقم صحيح')}
        </p>
      ) : null}

      {/*
        The neighbours line is the way in to the parcel's roster.

        A registrar who reads "3 others are registered here" immediately wants
        the next sentence — *which* three, and what do they hold — and that is
        the question the roster answers. It is a link rather than a number in
        the admin form and stays plain text in the citizen wizard, where the
        count is reassurance ("your neighbours are here too") and the identity
        of those neighbours is nobody's business.
      */}
      {confirmed && neighbours > 0 ? (
        (() => {
          const text =
            neighbours === 1
              ? (locale === 'en' ? '1 other citizen registered on this parcel — normal in shared buildings.' : 'مسجّل شخص آخر على هذا العقار — هذا طبيعي في المباني المشتركة.')
              : (locale === 'en' ? `${neighbours} other citizens registered on this parcel — normal in shared buildings.` : `مسجّل ${neighbours} أشخاص آخرين على هذا العقار — هذا طبيعي في المباني المشتركة.`);

          return onViewParcel ? (
            <button
              type="button"
              onClick={() => onViewParcel(value.trim())}
              className="flex items-center gap-2 text-start text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              <Users className="size-4 shrink-0" aria-hidden />
              {text}
            </button>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="size-4 shrink-0" aria-hidden />
              {text}
            </p>
          );
        })()
      ) : null}

      {confirmed && result.location?.approximate ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="size-4" aria-hidden />
          {locale === 'en'
            ? 'This parcel is subdivided into multiple plots — location is approximate.'
            : 'هذا العقار مقسّم إلى أكثر من قطعة — الموقع تقريبي.'}
        </p>
      ) : null}

      {unknown && result.suggestions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {locale === 'en' ? 'Nearby numbers in registry:' : 'أرقام قريبة موجودة في السجل:'}
          </p>
          <div className="flex flex-wrap gap-2">
            {result.suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                size="sm"
                dir="ltr"
                onClick={() => onChange(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </Field>
  );
}
