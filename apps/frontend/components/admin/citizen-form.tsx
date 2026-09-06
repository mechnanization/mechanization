'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CloudOff,
  FileQuestion,
  IdCard,
  Loader2,
  Plus,
  Save,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import {
  adminCreateCitizenSubmissionSchema,
  allowedPropertyTypesFor,
  getLabels,
  PROPERTY_FIELD_MAP,
} from '@mechanization/shared-schemas';
import type { PublicTenantConfig } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ContactStep, PersonalStep } from '@/components/citizen/steps';
import {
  PropertyCard,
  type PropertyDraft,
  type UnitDraft,
} from '@/components/citizen/property-card';
import { FieldFlagProvider, flagsToArray } from '@/components/ui/field';
import { UnverifiedFieldsDialog } from './unverified-fields-dialog';
import { ParcelRosterDialog } from './parcel-roster-dialog';
import { cn, scopeErrors } from '@/lib/utils';
import { useSectionNav } from '@/lib/use-section-nav';

export interface CitizenFormValues {
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: PropertyDraft[];
  /**
   * Fields the officer recorded as «غير مؤكَّد», keyed by dot-path.
   *
   * A Map rather than the array the wire uses, because every operation this
   * form performs on them is by path: is this field flagged, flag it, drop it
   * when its card is deleted. `flagsToArray` converts at the edge.
   */
  flags: Map<string, string>;
  /**
   * The server's «بانتظار التحقق» notes on this record, keyed by dot-path.
   *
   * Not part of what the form edits and never sent back — the server derives
   * these from its own cadastre on every write. They are carried in the form's
   * values only so the fields they name can say so while the officer is
   * looking at them.
   */
  unverified: Map<string, string>;
}

/**
 * The three sections, in one list.
 *
 * Declared once and read by both the jump-link bar and the section headings
 * so the two cannot fall out of step — a nav entry pointing at an `id` no
 * heading renders is a link that silently does nothing, and it is exactly the
 * kind of drift that survives review because nothing about it looks wrong.
 *
 * The `id` is also the error-key prefix (`personal.firstName`,
 * `properties.0.neighborhood`), which is what lets the bar mark a section as
 * holding a problem without a second mapping.
 */
const SECTIONS = [
  { id: 'personal', step: '١', icon: IdCard, title: 'البيانات الشخصية' },
  { id: 'contact', step: '٢', icon: UsersRound, title: 'التواصل والأسرة' },
  { id: 'properties', step: '٣', icon: Building2, title: 'العقارات' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** Stable identity for the nav hook's observer dependency. */
const SECTION_IDS = SECTIONS.map((section) => section.id) as readonly SectionId[];

/**
 * A brand new record — one blank property card, Lebanese by default.
 *
 * A factory rather than a shared constant. The old constant handed every form
 * that opened it the *same* `Map` and the same property array; nothing mutates
 * them today, because every update in this file copies before it writes, but
 * one `flags.set(...)` written in the ordinary imperative style would have
 * leaked one officer's «غير مؤكَّد» flags into the next blank form on that
 * device — and it would have looked completely reasonable in review.
 */
export function emptyCitizen(): CitizenFormValues {
  return {
    personal: { isLebanese: true },
    contact: { whatsappSameAsPhone: true },
    properties: [{}],
    flags: new Map(),
    unverified: new Map(),
  };
}

/**
 * One field this form is currently asking about, in the order it is asked.
 *
 * The section and the leaf are carried alongside the path because both of this
 * list's consumers need them and neither should be re-deriving them by string
 * surgery: the leaf is the label key, and the section is what the manager
 * dialog groups by.
 */
export interface AskableField {
  path: string;
  /** The leaf name — `civilRecordNumber`, `landlordPhone`. Also the label key. */
  field: string;
  section: 'personal' | 'contact' | 'properties';
  /** Which card, for a property field. */
  propertyIndex?: number;
}

/**
 * Every dot-path this form is currently *asking about*.
 *
 * The form is branchy — رقم السجل exists only for a Lebanese citizen, a
 * landlord block only for a tenant, وحدات المبنى only for a building — and an
 * officer who flags a field and then changes the branch above it leaves a flag
 * pointing at an input nobody can see. Stored, that flag would hold the record
 * at «يتطلب مراجعة» over a question the form has stopped asking, and nothing on
 * screen would explain why.
 *
 * So flags are pruned to this set. It is derived from the same
 * `PROPERTY_FIELD_MAP` the cards render from, which is what keeps "what is on
 * screen" and "what may be flagged" the same list.
 *
 * This is also the *only* statement of that list. The «خانات غير مؤكَّدة»
 * dialog used to carry its own copy of these branches, which meant two places
 * had to agree on what a non-Lebanese citizen is asked or what a خيمة card
 * shows — and the failure mode was quiet in the worst way: the dialog offering
 * a field the form would prune the moment it was confirmed, so the officer
 * ticked six boxes and came back to five. One list, read by both.
 */
export function askableFields(values: CitizenFormValues): AskableField[] {
  const fields: AskableField[] = [
    { path: 'personal.firstName', field: 'firstName', section: 'personal' },
    { path: 'personal.middleName', field: 'middleName', section: 'personal' },
    { path: 'personal.lastName', field: 'lastName', section: 'personal' },
    { path: 'personal.gender', field: 'gender', section: 'personal' },
    { path: 'personal.bloodType', field: 'bloodType', section: 'personal' },
    { path: 'personal.residentStatus', field: 'residentStatus', section: 'personal' },
  ];

  if (values.personal.isLebanese !== false) {
    fields.push(
      { path: 'personal.identityDocType', field: 'identityDocType', section: 'personal' },
      { path: 'personal.identityDocNumber', field: 'identityDocNumber', section: 'personal' },
      { path: 'personal.civilRecordNumber', field: 'civilRecordNumber', section: 'personal' },
    );
  } else {
    fields.push(
      { path: 'personal.nationality', field: 'nationality', section: 'personal' },
      { path: 'personal.identityDocNumber', field: 'identityDocNumber', section: 'personal' },
      { path: 'personal.residencyNumber', field: 'residencyNumber', section: 'personal' },
    );
  }

  fields.push(
    { path: 'contact.phone', field: 'phone', section: 'contact' },
    { path: 'contact.maritalStatus', field: 'maritalStatus', section: 'contact' },
    { path: 'contact.actualHouseholdMembers', field: 'actualHouseholdMembers', section: 'contact' },
  );

  if (values.contact.whatsappSameAsPhone === false) {
    fields.push({ path: 'contact.whatsapp', field: 'whatsapp', section: 'contact' });
  }

  values.properties.forEach((property, propertyIndex) => {
    const branch = PROPERTY_FIELD_MAP[property.propertyType as keyof typeof PROPERTY_FIELD_MAP];

    for (const field of branch ?? []) {
      fields.push({
        path: `properties.${propertyIndex}.${field}`,
        field,
        section: 'properties',
        propertyIndex,
      });
    }

    /*
      The landlord block, asked of both non-owner occupancies and flaggable
      unevenly between them.

      A tenant's landlord phone is required, so it can be the reason a record
      is incomplete and therefore something an officer needs to be able to
      excuse. A free occupant's is optional — there is nothing to excuse, and
      offering the flag anyway would put a «غير مؤكَّد» box under a field that
      was never going to fail, which is how a flag list stops meaning
      "this record is missing something".

      حالة الوحدة is absent here for the same reason and more strongly: it is
      optional on every card that shows it, so it can never hold a record up.
    */
    const nonOwnerFields =
      property.occupancyType === 'TENANT'
        ? (['landlordName', 'landlordPhone'] as const)
        : property.occupancyType === 'FREE_OCCUPANT'
          ? (['landlordName'] as const)
          : [];

    for (const field of nonOwnerFields) {
      fields.push({
        path: `properties.${propertyIndex}.${field}`,
        field,
        section: 'properties',
        propertyIndex,
      });
    }
  });

  return fields;
}

/** The same list as a set, for the "is this still being asked?" question. */
function askablePaths(values: CitizenFormValues): Set<string> {
  return new Set(askableFields(values).map((entry) => entry.path));
}

/**
 * Renumbers a path-keyed map of property annotations after the card at
 * `removed` is deleted — the officer's flags, and the server's notes alike.
 *
 * Drops that card's own flags and shifts every higher index down by one, which
 * is the same correction `removeProperty` applies to the collapsed set — for
 * the same reason, and with worse consequences if it is skipped: a stale
 * collapsed index folds the wrong card, a stale flag index misattributes a
 * missing field to the wrong property.
 */
function reindexFlags(flags: ReadonlyMap<string, string>, removed: number): Map<string, string> {
  const next = new Map<string, string>();

  for (const [path, reason] of flags) {
    const match = /^properties\.(\d+)\.(.+)$/.exec(path);
    if (!match) {
      next.set(path, reason);
      continue;
    }

    const index = Number(match[1]);
    if (index === removed) continue;
    next.set(`properties.${index > removed ? index - 1 : index}.${match[2]}`, reason);
  }

  return next;
}

/** Drops UI-only fields and coerces the numeric strings the inputs produce. */
export function toPayloadProperty(property: PropertyDraft): Record<string, unknown> {
  const { unitArea, units, id, ...rest } = property;

  return {
    // Present only when this card is editing a stored row; the create endpoint
    // never sees it, and the update endpoint reads it as "this one, changed".
    ...(id ? { id } : {}),
    ...rest,
    ...(unitArea !== undefined && unitArea !== '' ? { unitArea: Number(unitArea) } : {}),
    ...(units ? { units: units.map(toPayloadUnit) } : {}),
  };
}

/** Coerces one building unit's numeric strings for the wire. */
function toPayloadUnit(unit: UnitDraft): Record<string, unknown> {
  const { unitArea, ...rest } = unit;
  return {
    ...rest,
    ...(unitArea !== undefined && unitArea !== '' ? { unitArea: Number(unitArea) } : {}),
  };
}

/** The submission exactly as the server will receive it. */
export function toSubmission(values: CitizenFormValues) {
  return {
    personal: values.personal,
    contact: values.contact,
    properties: values.properties.map(toPayloadProperty),
    flags: flagsToArray(values.flags),
  };
}

/**
 * Validates the whole record at once, against the same schema the server
 * validates against.
 *
 * Not "the same rules" — the same object. `adminCreateCitizenSubmissionSchema`
 * is what the controller's validation pipe runs, so what this form accepts and
 * what the server accepts cannot drift, and neither can the subtler half: which
 * complaints a «غير مؤكَّد» flag is allowed to excuse. That matters most in the
 * case this feature exists for, where the officer is offline and the server is
 * hours away from seeing the record — a browser that were more permissive would
 * queue registrations that fail on arrival, in a settlement nobody is going
 * back to.
 *
 * The wizard checked one step per «التالي» because that was the only moment it
 * could. A single page has no such moment, so everything is checked on save —
 * and the caller gets one flat error map covering all three sections, which is
 * what lets a mistake in البيانات الشخصية surface while the clerk is looking
 * at العقارات.
 */
function validate(values: CitizenFormValues): Record<string, string> {
  const result = adminCreateCitizenSubmissionSchema.safeParse(toSubmission(values));
  if (result.success) return {};

  const flagPaths = [...values.flags.keys()];
  const out: Record<string, string> = {};

  for (const issue of result.error.issues) {
    /*
      A complaint about a flag is shown on the field it excuses.

      Zod reports it at `flags.3.reason`, which names nothing on screen — the
      officer sees a reason box under رقم العقار, not a numbered list of flags.
      Resolving the index back to the path is what puts "يرجى ذكر سبب…"
      underneath the box it is about.
    */
    if (issue.path[0] === 'flags') {
      const key = flagPaths[Number(issue.path[1])];
      if (key && !(key in out)) out[key] = issue.message;
      continue;
    }

    const key = issue.path.join('.');
    if (!(key in out)) out[key] = issue.message;
  }

  return out;
}

/**
 * Create or correct one citizen record — the citizen wizard's six steps as a
 * single page.
 *
 * The step-by-step shape existed for a citizen filling this in on a phone,
 * alone, once: it broke an intimidating form into answerable pieces and
 * refused to let them past a piece they had got wrong. A clerk at a counter is
 * the opposite case — they do this all day, they are working from papers laid
 * out in front of them, and the person is waiting. Sections they can jump
 * between and a single «حفظ» beat six «التالي» presses and a review screen.
 *
 * The section *contents* are the wizard's own components, not copies:
 * `PersonalStep`, `ContactStep` and `PropertyCard` render here exactly as they
 * render for a citizen, so the conditional fields (رقم السجل only for a
 * Lebanese citizen, a landlord block only for a tenant, a units editor only
 * for a building) cannot drift between the two entry points.
 *
 * The two steps that are *not* here are deliberate: المستندات, because a clerk
 * has paper rather than files to attach, and الإقرار, because a declaration
 * ticked on someone else's behalf is not a declaration.
 */
export function CitizenForm({
  tenant,
  token,
  config,
  mode,
  initial,
  submitting,
  error,
  offline = false,
  onSubmit,
  onCancel,
  locale = 'ar',
}: {
  tenant: string;
  /**
   * The staff session's token, for the parcel roster lookup.
   *
   * Optional because this form is also the citizen-facing wizard's admin twin
   * and the roster is staff-only — without it the neighbours line stays the
   * plain count it always was.
   */
  token?: string | null;
  config: PublicTenantConfig;
  mode: 'create' | 'edit';
  initial: CitizenFormValues;
  submitting: boolean;
  /** Server-side failure, shown above the actions. */
  error: string | null;
  /**
   * The browser has no connection, so «حفظ» will queue rather than send.
   *
   * Said on the button rather than discovered after pressing it: an officer
   * who does not know a record was stored locally has no reason to keep the
   * portal open until it syncs, and closing it is how a queue is forgotten.
   */
  offline?: boolean;
  onSubmit: (values: CitizenFormValues) => void;
  onCancel: () => void;
  locale?: string;
}) {
  const [values, setValues] = useState<CitizenFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [unverifiedDialogOpen, setUnverifiedDialogOpen] = useState(false);
  /** Which رقم العقار's roster is open, if any. */
  const [rosterParcel, setRosterParcel] = useState<string | null>(null);
  /** Which property cards are folded shut. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  /**
   * The jump bar's highlight and scroll handler.
   *
   * Re-observed when a property card is added or removed: the sections keep
   * their ids, but the page height under them changes enough that a stale
   * observer would highlight against the old layout.
   */
  const { active, jumpTo } = useSectionNav(SECTION_IDS, [values.properties.length]);

  // Re-seeds when the record finishes loading. Keyed on the object identity,
  // so a parent that fetches once does not clobber what has been typed since.
  useEffect(() => {
    setValues(initial);
    // An existing record opens with its cards folded — a clerk fixing a phone
    // number should not have to scroll past four properties to reach «حفظ».
    setCollapsed(
      new Set(initial.properties.length > 1 ? initial.properties.map((_, i) => i) : []),
    );
  }, [initial]);

  const update = useCallback((patch: Partial<CitizenFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * Raise or amend a «غير مؤكَّد» flag — and empty the field it covers.
   *
   * Clearing the value is the substantive half. A flag says the value was
   * never established; leaving a half-typed number underneath it would make
   * the record contradict itself, and — because the server strips flagged
   * fields before it validates anything — would be discarded on arrival
   * anyway. Doing it here means what the officer sees is what gets stored.
   *
   * Amending an existing flag (typing in its reason box) does not re-clear,
   * because there is nothing left to clear; the same code path handles both
   * since clearing an already-empty field is a no-op.
   */
  const setFlag = useCallback((path: string, reason: string) => {
    setValues((current) => {
      const flags = new Map(current.flags);
      flags.set(path, reason);

      const [section, ...rest] = path.split('.');

      if (section === 'personal' || section === 'contact') {
        const field = rest[0];
        const next = { ...current[section] };
        delete next[field];
        return { ...current, [section]: next, flags };
      }

      // properties.<index>.<field>
      const index = Number(rest[0]);
      const field = rest[1];
      return {
        ...current,
        properties: current.properties.map((property, i) => {
          if (i !== index) return property;
          const next = { ...property } as Record<string, unknown>;
          delete next[field];
          return next as PropertyDraft;
        }),
        flags,
      };
    });
  }, []);

  /** Withdraws a flag. The field comes back empty, which is where it was. */
  const clearFlag = useCallback((path: string) => {
    setValues((current) => {
      const flags = new Map(current.flags);
      flags.delete(path);
      return { ...current, flags };
    });
  }, []);

  const flagging = useMemo(
    () => ({
      flags: values.flags,
      unverified: values.unverified,
      set: setFlag,
      clear: clearFlag,
      locale,
    }),
    [values.flags, values.unverified, setFlag, clearFlag, locale],
  );

  const setProperty = useCallback((index: number, next: PropertyDraft) => {
    setValues((current) => ({
      ...current,
      properties: current.properties.map((p, i) => (i === index ? next : p)),
    }));
  }, []);

  /**
   * A new card.
   *
   * `sameParcelAs` carries the parcel's own identity across — رقم العقار and
   * الحي — for the case this form could not express at all until now: one deed
   * carrying a building, the house behind it and a shop on the street. Those
   * are three structures that are typed, inspected and taxed differently, so
   * they are three cards; what they are *not* is three different pieces of
   * land, and making the clerk retype the number that says so invites the
   * transposed digit that puts the shop on someone else's parcel.
   *
   * The owner is not copied because the owner was never on the card. It is the
   * citizen this whole form is about, typed once at the top — which is why
   * adding a fifth structure costs one tap and no re-entry.
   */
  const addProperty = useCallback((sameParcelAs?: number) => {
    setValues((current) => {
      const source = sameParcelAs === undefined ? undefined : current.properties[sameParcelAs];

      const properties = [
        ...current.properties,
        {
          // A clerk entering several properties for one household fills the same
          // shape repeatedly, so a new card inherits the last one's occupancy.
          occupancyType: (source ?? current.properties.at(-1))?.occupancyType,
          ...(source
            ? { propertyNumber: source.propertyNumber, neighborhood: source.neighborhood }
            : {}),
        },
      ];
      setCollapsed(new Set(properties.slice(0, -1).map((_, i) => i)));
      return { ...current, properties };
    });
  }, []);

  /**
   * Property cards grouped by shared رقم العقار.
   *
   * A parcel with a building, the house behind it and a shop on the street is
   * one عقار holding three cards — array position doesn't say that, matching
   * رقم العقار values do. Grouping here is what lets the form show them as one
   * parcel with several ملكيات instead of three unrelated-looking top-level
   * cards that merely happen to repeat the same number in their subtitle.
   *
   * A group of one (the ordinary case: no other card shares its number) still
   * renders as a single plain card — the grouping header only earns its place
   * once there is something to group.
   */
  const propertyGroups = useMemo(() => {
    const groups: { propertyNumber: string | null; indices: number[] }[] = [];
    const groupByNumber = new Map<string, number>();
    values.properties.forEach((property, index) => {
      const propertyNumber = property.propertyNumber?.trim() || null;
      const groupIndex = propertyNumber ? groupByNumber.get(propertyNumber) : undefined;
      if (groupIndex !== undefined) {
        groups[groupIndex].indices.push(index);
        return;
      }
      if (propertyNumber) groupByNumber.set(propertyNumber, groups.length);
      groups.push({ propertyNumber, indices: [index] });
    });
    return groups;
  }, [values.properties]);

  /**
   * Renders `propertyGroups` as cards — a lone card per single-property parcel,
   * or a headed cluster of «الملكية N» cards plus one shared add-button for a
   * parcel carrying several. Called once per layout (mobile stepper, desktop
   * sequential view) rather than duplicated, so the grouping logic is stated
   * once.
   */
  const renderPropertyGroups = () =>
    propertyGroups.map((group) => {
      if (group.indices.length === 1) {
        const index = group.indices[0];
        const property = values.properties[index];
        return (
          <PropertyCard
            key={property.id ?? index}
            tenant={tenant}
            index={index}
            draft={property}
            allowedTypes={allowedTypes}
            collapsed={collapsed.has(index)}
            onToggleCollapse={() => toggleCollapsed(index)}
            onChange={(next) => setProperty(index, next)}
            onAddOnSameParcel={() => addProperty(index)}
            onViewParcel={token ? setRosterParcel : undefined}
            onRemove={() => removeProperty(index)}
            canRemove={values.properties.length > 1}
            errors={scopeErrors(shown, `properties.${index}`)}
            locale={locale}
          />
        );
      }

      return (
        <div
          key={group.propertyNumber}
          className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <div className="flex items-center gap-2 px-1 text-primary">
            <Building2 className="size-4 shrink-0" aria-hidden />
            <span className="text-sm font-semibold">
              {locale === 'en'
                ? `Parcel ${group.propertyNumber} — ${group.indices.length} properties`
                : `العقار رقم ${group.propertyNumber} — ${group.indices.length} ملكيات`}
            </span>
          </div>

          {group.indices.map((index, unitPosition) => {
            const property = values.properties[index];
            return (
              <PropertyCard
                key={property.id ?? index}
                tenant={tenant}
                index={index}
                draft={property}
                allowedTypes={allowedTypes}
                collapsed={collapsed.has(index)}
                onToggleCollapse={() => toggleCollapsed(index)}
                onChange={(next) => setProperty(index, next)}
                onViewParcel={token ? setRosterParcel : undefined}
                onRemove={() => removeProperty(index)}
                canRemove={values.properties.length > 1}
                errors={scopeErrors(shown, `properties.${index}`)}
                locale={locale}
                title={locale === 'en' ? `Unit ${unitPosition + 1}` : `الملكية ${unitPosition + 1}`}
              />
            );
          })}

          <button
            type="button"
            onClick={() => addProperty(group.indices[0])}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <Plus className="size-3.5 shrink-0" aria-hidden />
            {locale === 'en'
              ? 'Add another property on this parcel'
              : 'إضافة ملكية أخرى على هذا العقار'}
          </button>
        </div>
      );
    });

  const removeProperty = useCallback((index: number) => {
    setValues((current) => ({
      ...current,
      properties: current.properties.filter((_, i) => i !== index),
      /*
        Flags are addressed by card index, so deleting a card renumbers them.

        Left alone, a flag on `properties.2.propertyNumber` would silently
        become a flag on whatever card slid into position 2 — excusing a field
        nobody said anything about, and holding that card's real gap against
        the officer. The removed card's own flags go with it.

        The server's «بانتظار التحقق» notes are addressed the same way and are
        renumbered with them: a note reading "this parcel number is not in the
        cadastre" parked on the wrong card sends someone to re-check a number
        that was never in question.
      */
      flags: reindexFlags(current.flags, index),
      unverified: reindexFlags(current.unverified, index),
    }));
    // Indices above the removed card shift down by one; rebuilding the set
    // rather than deleting from it keeps the wrong card from folding shut.
    setCollapsed((current) => {
      const next = new Set<number>();
      for (const i of current) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((index: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /**
   * Which نوع العقار is offered: the municipality's enabled types, minus خيمة
   * for anyone who is not a لاجئ. Re-checked on the server, where صفة الإقامة
   * and the property list are both in hand.
   */
  const allowedTypes = useMemo(() => {
    const enabled = new Set(config.enabledPropertyTypes);
    return allowedPropertyTypesFor(values.personal.residentStatus as string | undefined).filter(
      (type) => enabled.has(type),
    );
  }, [config.enabledPropertyTypes, values.personal.residentStatus]);

  /**
   * A property left holding a type the current صفة الإقامة no longer permits
   * has it cleared, rather than failing validation on save against a control
   * the form has stopped offering.
   */
  useEffect(() => {
    const permitted = new Set(allowedTypes);
    if (values.properties.every((p) => !p.propertyType || permitted.has(p.propertyType))) return;

    setValues((current) => ({
      ...current,
      properties: current.properties.map((p) =>
        p.propertyType && !permitted.has(p.propertyType)
          ? { ...p, propertyType: undefined, tentLocation: undefined }
          : p,
      ),
    }));
  }, [allowedTypes, values.properties]);

  /**
   * A flag whose field the form has stopped asking about is withdrawn.
   *
   * Switching a card from خيمة to أرض, or a citizen from أجنبي to لبناني,
   * retires whole groups of inputs. A flag left behind on one of them would
   * hold the record at «يتطلب مراجعة» over a question nothing on screen is
   * asking — the officer would see a complete form and an unexplained status.
   */
  useEffect(() => {
    const askable = askablePaths(values);
    if ([...values.flags.keys()].every((path) => askable.has(path))) return;

    setValues((current) => {
      const kept = new Map<string, string>();
      for (const [path, reason] of current.flags) {
        if (askable.has(path)) kept.set(path, reason);
      }
      return { ...current, flags: kept };
    });
  }, [values]);

  const shown = useMemo(() => (showErrors ? fieldErrors : {}), [showErrors, fieldErrors]);
  const messages = [...new Set(Object.values(shown))];

  const sectionInvalid = useCallback(
    (prefix: string) => Object.keys(shown).some((key) => key.startsWith(`${prefix}.`)),
    [shown],
  );

  /**
   * The «غير مؤكَّد» fields, named, above the save button.
   *
   * A flag is a per-field control, so a form with six of them scattered across
   * three sections gives no sense of how much of the record is actually
   * missing. This is the whole list in one place, read at the moment it
   * matters: the officer is about to file the person, and this is what the
   * record will say about itself when someone opens it next month.
   */
  const flagSummary = useMemo(() => {
    const labels = getLabels(locale);
    return [...values.flags].map(([path, reason]) => {
      const segments = path.split('.');
      const field = labels.citizenField[segments.at(-1) ?? ''] ?? segments.at(-1) ?? path;
      const card = segments[0] === 'properties' ? Number(segments[1]) + 1 : null;
      return {
        path,
        reason,
        label:
          card === null
            ? field
            : locale === 'en'
              ? `${field} — property ${card}`
              : `${field} — العقار ${card}`,
      };
    });
  }, [values.flags, locale]);

  const sections = useMemo(
    () => [
      {
        id: 'personal',
        step: locale === 'en' ? '1' : '١',
        icon: IdCard,
        title: locale === 'en' ? 'Personal Info' : 'البيانات الشخصية',
        description:
          locale === 'en'
            ? 'Name as written on ID document, nationality, and residency status'
            : 'الاسم كما هو مدوّن على وثيقة الإثبات، والجنسية وصفة الإقامة',
      },
      {
        id: 'contact',
        step: locale === 'en' ? '2' : '٢',
        icon: UsersRound,
        title: locale === 'en' ? 'Contact & Family' : 'التواصل والأسرة',
        description:
          locale === 'en'
            ? 'Phone number used by citizen for login and tracking submissions'
            : 'رقم الهاتف الذي يستخدمه المواطن للدخول ومتابعة طلبه',
      },
      {
        id: 'properties',
        step: locale === 'en' ? '3' : '٣',
        icon: Building2,
        title: locale === 'en' ? 'Properties' : 'العقارات',
        description:
          locale === 'en'
            ? 'Property parcel number verified against municipality records'
            : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة',
      },
    ],
    [locale],
  );

  const [mobileStep, setMobileStep] = useState<SectionId>('personal');

  const stepIndex = useMemo(
    () => sections.findIndex((s) => s.id === mobileStep),
    [sections, mobileStep],
  );

  const goToNextStep = useCallback(() => {
    const nextIdx = stepIndex + 1;
    if (nextIdx < sections.length) {
      setMobileStep(sections[nextIdx].id as SectionId);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [stepIndex, sections]);

  const goToPrevStep = useCallback(() => {
    const prevIdx = stepIndex - 1;
    if (prevIdx >= 0) {
      setMobileStep(sections[prevIdx].id as SectionId);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [stepIndex, sections]);

  function handleSubmit() {
    const errors = validate(values);
    setFieldErrors(errors);
    setShowErrors(true);

    if (Object.keys(errors).length > 0) {
      const firstInvalidSection = sections.find((s) => sectionInvalid(s.id));
      if (firstInvalidSection) {
        setMobileStep(firstInvalidSection.id as SectionId);
      }
      setTimeout(() => {
        document
          .querySelector('[data-section-invalid="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return;
    }

    onSubmit(values);
  }

  return (
    <FieldFlagProvider value={flagging}>
    <div className="space-y-4 pb-20 sm:space-y-5 sm:pb-0">
      {/* ── Desktop Section Nav (hidden on mobile) ── */}
      <nav
        aria-label={locale === 'en' ? 'Form sections' : 'أقسام النموذج'}
        className="sticky top-0 z-20 hidden sm:flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-background/95 p-1.5 shadow-2xs backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <ul className="flex flex-wrap items-center gap-1.5">
          {sections.map((section) => {
            const Icon = section.icon;
            const invalid = sectionInvalid(section.id);
            const isActive = active === section.id;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => jumpTo(section.id as SectionId)}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors select-none',
                    isActive
                      ? 'bg-primary text-primary-foreground shadow-2xs'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    invalid &&
                      !isActive &&
                      'border border-destructive/30 bg-destructive/10 text-destructive',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'rounded px-1 text-[10px] font-semibold',
                      isActive ? 'bg-primary-foreground/20' : 'bg-muted-foreground/10',
                    )}
                  >
                    {section.step}
                  </span>
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="whitespace-nowrap">
                    {section.id === 'properties'
                      ? `${section.title} (${values.properties.length})`
                      : section.title}
                  </span>
                  {invalid ? (
                    <TriangleAlert
                      className={cn(
                        'size-3 shrink-0',
                        isActive ? 'text-primary-foreground' : 'text-destructive',
                      )}
                      aria-hidden
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setUnverifiedDialogOpen(true)}
          className={cn(
            'h-8 gap-1.5 px-2 sm:px-3 text-xs font-medium transition-colors shrink-0',
            values.flags.size > 0
              ? 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20'
              : 'text-muted-foreground hover:text-foreground',
          )}
          title={locale === 'en' ? 'Unverified Fields' : 'خانات غير مؤكَّدة'}
        >
          <FileQuestion className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden sm:inline">
            {locale === 'en' ? 'Unverified Fields' : 'خانات غير مؤكَّدة'}
          </span>
          {values.flags.size > 0 ? (
            <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold text-warning">
              {values.flags.size}
            </span>
          ) : null}
        </Button>
      </nav>

      {/* ── Mobile Step Header (visible on mobile only) ── */}
      <div className="sm:hidden space-y-2 sticky top-0 z-20 rounded-xl border border-border/80 bg-background/95 p-2 shadow-xs backdrop-blur">
        <div className="flex items-center justify-between text-xs font-semibold px-1">
          <span className="text-muted-foreground">
            {locale === 'en' ? `Step ${stepIndex + 1} of 3` : `الخطوة ${sections[stepIndex].step} من ٣`}
          </span>
          <span className="text-primary font-bold">{sections[stepIndex].title}</span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {sections.map((section, idx) => {
            const isCurrent = mobileStep === section.id;
            const isCompleted = stepIndex > idx;
            const invalid = sectionInvalid(section.id);

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setMobileStep(section.id as SectionId)}
                className={cn(
                  'flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition-all select-none',
                  isCurrent
                    ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                    : isCompleted
                      ? 'bg-muted/70 text-foreground'
                      : 'bg-muted/30 text-muted-foreground',
                  invalid && !isCurrent && 'border border-destructive/40 text-destructive',
                )}
              >
                <span>{section.step}.</span>
                <span className="truncate">{section.title}</span>
                {invalid ? (
                  <TriangleAlert className="size-3 shrink-0 text-destructive" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Mobile View: Active Step Only ── */}
      <div className="block sm:hidden">
        {mobileStep === 'personal' && (
          <FormSection
            id="personal"
            step={locale === 'en' ? '1' : '١'}
            icon={IdCard}
            title={locale === 'en' ? 'Personal Information' : 'البيانات الشخصية'}
            description={
              locale === 'en'
                ? 'Name as written on ID document, nationality, and residency status'
                : 'الاسم كما هو مدوّن على وثيقة الإثبات، والجنسية وصفة الإقامة'
            }
            invalid={sectionInvalid('personal')}
          >
            <PersonalStep
              value={values.personal}
              errors={shown}
              onChange={(personal) => update({ personal })}
              locale={locale}
            />
          </FormSection>
        )}

        {mobileStep === 'contact' && (
          <FormSection
            id="contact"
            step={locale === 'en' ? '2' : '٢'}
            icon={UsersRound}
            title={locale === 'en' ? 'Contact & Household' : 'التواصل والأسرة'}
            description={
              locale === 'en'
                ? 'Phone number used by citizen for login and tracking submissions'
                : 'رقم الهاتف الذي يستخدمه المواطن للدخول ومتابعة طلبه'
            }
            invalid={sectionInvalid('contact')}
          >
            <ContactStep
              value={values.contact}
              errors={shown}
              onChange={(contact) => update({ contact })}
              locale={locale}
            />
          </FormSection>
        )}

        {mobileStep === 'properties' && (
          <FormSection
            id="properties"
            step={locale === 'en' ? '3' : '٣'}
            icon={Building2}
            title={
              locale === 'en'
                ? `Properties (${values.properties.length})`
                : `العقارات (${values.properties.length})`
            }
            description={
              locale === 'en'
                ? 'Property parcel number verified against municipality records'
                : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة'
            }
            invalid={sectionInvalid('properties')}
          >
            <div className="space-y-4">
              {renderPropertyGroups()}

              {mode === 'edit' && values.properties.some((property) => property.id) ? (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                  {locale === 'en'
                    ? 'Deleting a registered property will also delete associated attachments (title deed or lease).'
                    : 'حذف عقار مسجّل يحذف معه المستندات المرفقة به (سند الملكية أو عقد الإيجار).'}
                </p>
              ) : null}

              <Button
                variant="outline"
                size="sm"
                onClick={() => addProperty()}
                className="w-full border-dashed border-primary/60 text-primary hover:bg-primary/5 h-9 text-xs sm:text-sm font-medium"
              >
                <Plus className="size-4" aria-hidden />
                {locale === 'en' ? 'Add Another Property' : 'إضافة عقار آخر'}
              </Button>
            </div>
          </FormSection>
        )}
      </div>

      {/* ── Desktop View: All Sections Sequentially ── */}
      <div className="hidden sm:block space-y-5">
        <FormSection
          id="personal"
          step={locale === 'en' ? '1' : '١'}
          icon={IdCard}
          title={locale === 'en' ? 'Personal Information' : 'البيانات الشخصية'}
          description={
            locale === 'en'
              ? 'Name as written on ID document, nationality, and residency status'
              : 'الاسم كما هو مدوّن على وثيقة الإثبات، والجنسية وصفة الإقامة'
          }
          invalid={sectionInvalid('personal')}
        >
          <PersonalStep
            value={values.personal}
            errors={shown}
            onChange={(personal) => update({ personal })}
            locale={locale}
          />
        </FormSection>

        <FormSection
          id="contact"
          step={locale === 'en' ? '2' : '٢'}
          icon={UsersRound}
          title={locale === 'en' ? 'Contact & Household' : 'التواصل والأسرة'}
          description={
            locale === 'en'
              ? 'Phone number used by citizen for login and tracking submissions'
              : 'رقم الهاتف الذي يستخدمه المواطن للدخول ومتابعة طلبه'
          }
          invalid={sectionInvalid('contact')}
        >
          <ContactStep
            value={values.contact}
            errors={shown}
            onChange={(contact) => update({ contact })}
            locale={locale}
          />
        </FormSection>

        <FormSection
          id="properties"
          step={locale === 'en' ? '3' : '٣'}
          icon={Building2}
          title={
            locale === 'en'
              ? `Properties (${values.properties.length})`
              : `العقارات (${values.properties.length})`
          }
          description={
            locale === 'en'
              ? 'Property parcel number verified against municipality records'
              : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة'
          }
          invalid={sectionInvalid('properties')}
        >
          <div className="space-y-4">
            {renderPropertyGroups()}

            {mode === 'edit' && values.properties.some((property) => property.id) ? (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                {locale === 'en'
                  ? 'Deleting a registered property will also delete associated attachments (title deed or lease).'
                  : 'حذف عقار مسجّل يحذف معه المستندات المرفقة به (سند الملكية أو عقد الإيجار).'}
              </p>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={() => addProperty()}
              className="w-full border-dashed border-primary/60 text-primary hover:bg-primary/5 h-9 text-xs sm:text-sm font-medium"
            >
              <Plus className="size-4" aria-hidden />
              {locale === 'en' ? 'Add Another Property' : 'إضافة عقار آخر'}
            </Button>
          </div>
        </FormSection>
      </div>

      {/* ── Mobile Sticky Bottom Action Bar ── */}
      <div className="fixed bottom-0 left-0 right-0 z-40 block sm:hidden border-t border-border/80 bg-background/95 p-2.5 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/90">
        <div className="flex items-center justify-between gap-2">
          {stepIndex > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={goToPrevStep}
              className="h-10 px-3 text-xs font-semibold gap-1 shrink-0"
            >
              <ArrowRight className="size-4 rtl:rotate-180" />
              <span>{locale === 'en' ? 'Back' : 'السابق'}</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-10 px-3 text-xs text-muted-foreground shrink-0"
            >
              {locale === 'en' ? 'Cancel' : 'إلغاء'}
            </Button>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setUnverifiedDialogOpen(true)}
            className={cn(
              'h-10 px-2.5 text-xs font-medium gap-1 flex-1 max-w-[150px] truncate',
              values.flags.size > 0 && 'border-warning/50 bg-warning/10 text-warning',
            )}
          >
            <FileQuestion className="size-3.5 shrink-0" />
            <span className="truncate">{locale === 'en' ? 'Unverified' : 'غير مؤكَّد'}</span>
            {values.flags.size > 0 ? (
              <span className="rounded-full bg-warning/20 px-1.5 py-0.2 text-[10px] font-bold text-warning">
                {values.flags.size}
              </span>
            ) : null}
          </Button>

          {stepIndex < sections.length - 1 ? (
            <Button
              type="button"
              size="sm"
              onClick={goToNextStep}
              className="h-10 px-4 text-xs font-semibold gap-1 bg-primary text-primary-foreground shadow-sm shrink-0"
            >
              <span>{locale === 'en' ? 'Next' : 'التالي'}</span>
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="h-10 px-4 text-xs font-semibold gap-1.5 bg-primary text-primary-foreground shadow-sm shrink-0"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : offline ? (
                <CloudOff className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              <span>
                {offline
                  ? locale === 'en'
                    ? 'Save'
                    : 'حفظ'
                  : locale === 'en'
                    ? 'Save & Create'
                    : 'حفظ وإنشاء'}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* ── Desktop Fixed Bottom Actions Bar ── */}
      <div className="sticky bottom-0 z-30 hidden sm:block -mx-4 -mb-6 mt-8 border-t border-border/80 bg-background/95 px-4 py-3 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {error ? (
          <p
            role="alert"
            className="mb-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        {messages.length > 0 ? (
          <div
            role="alert"
            className="mb-2.5 space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {locale === 'en'
                ? 'Please correct the following fields before saving:'
                : 'يرجى إكمال وتصحيح الحقول التالية قبل الحفظ:'}
            </p>
            <ul className="list-inside list-disc ps-1 grid gap-0.5 sm:grid-cols-2">
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {flagSummary.length > 0 ? (
          <div className="mb-2.5 space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 font-semibold text-warning">
                <FileQuestion className="size-3.5 shrink-0" aria-hidden />
                {locale === 'en'
                  ? `Saving with ${flagSummary.length} unverified field(s) — marked "Requires Review".`
                  : `سيُحفظ السجل مع ${flagSummary.length} خانة غير مؤكَّدة بحالة «يتطلب مراجعة».`}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setUnverifiedDialogOpen(true)}
                className="h-6 px-2 text-[11px] text-warning hover:bg-warning/15 hover:text-warning"
              >
                {locale === 'en' ? 'Manage' : 'تعديل الخانات'}
              </Button>
            </div>
            <ul className="grid gap-0.5 ps-1 sm:grid-cols-2">
              {flagSummary.map((flag) => (
                <li key={flag.path} className="truncate text-muted-foreground">
                  <span className="font-medium text-foreground">{flag.label}</span>
                  {flag.reason ? ` — ${flag.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                offline ? 'bg-warning' : 'bg-primary/60',
              )}
            />
            <span>
              {offline
                ? locale === 'en'
                  ? 'Offline — this record will be stored on this device and synced automatically'
                  : 'بدون اتصال — سيُحفظ السجل على هذا الجهاز ويُرسل تلقائياً عند عودة الشبكة'
                : mode === 'edit'
                  ? (locale === 'en' ? 'Editing citizen record' : 'تعديل بيانات المواطن')
                  : (locale === 'en' ? 'New citizen registration' : 'تسجيل مواطن جديد')}
            </span>
          </div>

          <div className="flex items-center gap-2.5 ms-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={submitting}
              className="h-8 px-4 text-xs font-medium rounded-lg hover:bg-muted"
            >
              {locale === 'en' ? 'Cancel' : 'إلغاء'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="h-8 px-4 text-xs font-medium rounded-lg shadow-2xs gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : offline ? (
                <CloudOff className="size-3.5" aria-hidden />
              ) : (
                <Save className="size-3.5" aria-hidden />
              )}
              {offline
                ? (locale === 'en' ? 'Save on This Device' : 'حفظ على الجهاز')
                : mode === 'edit'
                  ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
                  : (locale === 'en' ? 'Save & Create' : 'حفظ وإنشاء')}
            </Button>
          </div>
        </div>
      </div>
    </div>

    {token && rosterParcel ? (
      <ParcelRosterDialog
        open
        onOpenChange={(next) => setRosterParcel(next ? rosterParcel : null)}
        tenant={tenant}
        token={token}
        propertyNumber={rosterParcel}
        locale={locale}
      />
    ) : null}

    <UnverifiedFieldsDialog
      open={unverifiedDialogOpen}
      onOpenChange={setUnverifiedDialogOpen}
      values={values}
      onSaveFlags={(newFlags) => {
        // Also prune fields from values if they are newly flagged
        setValues((current) => {
          let updated = { ...current, flags: newFlags };
          // If a field is newly flagged, clear its value in current state
          for (const path of newFlags.keys()) {
            const [section, ...rest] = path.split('.');
            if (section === 'personal' || section === 'contact') {
              const field = rest[0];
              const nextSec = { ...updated[section] };
              delete nextSec[field];
              updated = { ...updated, [section]: nextSec };
            } else if (section === 'properties') {
              const idx = Number(rest[0]);
              const field = rest[1];
              updated = {
                ...updated,
                properties: updated.properties.map((p, i) => {
                  if (i !== idx) return p;
                  const nextP = { ...p } as Record<string, unknown>;
                  delete nextP[field];
                  return nextP as PropertyDraft;
                }),
              };
            }
          }
          return updated;
        });
      }}
      locale={locale}
    />
    </FieldFlagProvider>
  );
}

/**
 * One titled section of the form.
 */
function FormSection({
  id,
  step,
  icon: Icon,
  title,
  description,
  invalid,
  children,
}: {
  id: string;
  step: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      data-section-invalid={invalid || undefined}
      className={cn(
        'scroll-mt-24 rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden',
        invalid && 'border-destructive/50 ring-1 ring-destructive/20',
      )}
    >
      <CardHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 bg-muted/10 px-4 py-3 sm:px-5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <span
              aria-hidden
              className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground font-mono"
            >
              {step}
            </span>
            {title}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-5">{children}</CardContent>
    </Card>
  );
}
