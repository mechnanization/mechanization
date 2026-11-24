'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Building2,
  CheckCircle2,
  FileQuestion,
  IdCard,
  Plus,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import {
  allowedPropertyTypesFor,
  isNonPersonRecord,
  isOwnerRecord,
  type CitizenMergeResult,
  type CitizenResidence,
  type PossibleDuplicateMatch,
} from '@mechanization/shared-schemas';
import type { PublicTenantConfig } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/states';
import { DuplicateAlert, usePossibleDuplicates } from './possible-duplicates';
import { MergeCitizensDialog } from './merge-citizens-dialog';
import {
  PropertyCard,
  type CardRemovalAnswer,
  type PropertyDraft,
} from '@/components/citizen/property-card';
import { FieldFlagProvider, FieldFocusProvider } from '@/components/ui/field';
import { UnverifiedFieldsDialog } from './unverified-fields-dialog';
import { QuickSaveDialog } from './quick-save-dialog';
import type { LockedCensusTarget } from './building-unit-picker';
import { ParcelRosterDialog } from './parcel-roster-dialog';
import { ResidenceChangeDialog } from './residence-change-dialog';
import { applyResidenceMove, planResidenceMove } from '@/lib/residence-move';
import { withResidence } from '@/lib/citizen-seed';
import { carryHeldPhone } from '@/lib/citizen-contact';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import { cn, scopeErrors } from '@/lib/utils';

import type { CitizenFormValues } from '@/lib/citizen-form-values';
import { askableFields, askablePaths, isBlank, valueAtPath } from '@/lib/citizen-form-askable';
import { validate } from '@/lib/citizen-form-validation';
import {
  collapsedAfterAdd,
  collapsedAfterRemoval,
  groupProperties,
  holdsDisallowedType,
  holdsUnaskableFlag,
  phoneNoteOf,
  withAddedProperty,
  withDisallowedTypesCleared,
  withEndedRowsRemoved,
  withFlag,
  withFlagsApplied,
  withoutFlag,
  withProperty,
  withRemovedProperty,
  withUnaskableFlagsDropped,
} from '@/lib/citizen-form-state';
import { StepNotesField } from './citizen-form/step-notes-field';
import { StepBar } from './citizen-form/step-bar';
import { PersonalSection } from './citizen-form/personal-section';
import { ContactSection } from './citizen-form/contact-section';
import { PropertiesSection } from './citizen-form/properties-section';
import { NotesSection } from './citizen-form/notes-section';
import { DesktopActionBar, MobileActionBar } from './citizen-form/action-bars';

export type { CitizenFormValues } from '@/lib/citizen-form-values';
export { emptyCitizen } from '@/lib/citizen-form-values';
export { askableFields, type AskableField } from '@/lib/citizen-form-askable';
export { toPayloadProperty, toSubmission } from '@/lib/citizen-form-payload';
export { submissionFieldErrors } from '@/lib/citizen-form-validation';

/**
 * The wizard's three pages.
 *
 * The id is also the error-key prefix (`personal.firstName`,
 * `properties.0.neighborhood`), which is what lets the step bar mark a page as
 * holding a problem without a second mapping. Their titles, icons and numbers
 * are `sections` inside the component, where the locale is known.
 */
type SectionId = 'personal' | 'contact' | 'properties';

// Pure, so the lib tests can reach them: switching نوع الملف and seeding from a search.
export { phoneFromSearchTerm, withResidence, withSeededSearch } from '@/lib/citizen-seed';

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
  citizenId,
  config,
  mode,
  initial,
  submitting,
  error,
  offline = false,
  onSubmit,
  onCancel,
  onValuesChange,
  locale = 'ar',
  lockedCensusTarget,
  onDeactivated,
  canMerge = false,
  canOverrideDuplicates = false,
  onMerged,
  canAnswerLandlord,
}: {
  /**
   * Whether this session may answer an owner claim (`LANDLORD_LINK_ANSWER_ROLES`),
   * for each card's «نعم، هو». Required: a default would fail open (task S17).
   */
  canAnswerLandlord: boolean;
  tenant: string;
  /**
   * The staff session's token, for the parcel roster lookup.
   *
   * Optional because this form is also the citizen-facing wizard's admin twin
   * and the roster is staff-only — without it the neighbours line stays the
   * plain count it always was.
   */
  token?: string | null;
  /**
   * The citizen being edited, when there is one.
   *
   * Passed through to the census picker's unit chips and used for one
   * question only: is the occupancy already recorded in this flat *theirs*, or
   * somebody else's. Undefined on a create, and on the citizen-facing wizard,
   * which is the safe direction — a record that does not exist yet cannot be
   * the one already in the unit.
   */
  citizenId?: string;
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
  /**
   * Every change to what is on screen, so the parent can persist a draft.
   *
   * Reported rather than lifted: `values` stays this component's state. The
   * form is edited on nearly every keystroke and hoisting it would re-render
   * the editor — which owns the token, the tenant config and the offline queue
   * — on each one. The parent is expected to debounce; see `CitizenEditor`.
   *
   * Fires once on mount with whatever the form opened with, which is what lets
   * a restored draft be written straight back and keep its timestamp fresh.
   */
  onValuesChange?: (values: CitizenFormValues) => void;
  locale?: string;
  /**
   * Launched from a building's unit matrix — the structure, and possibly the
   * flat, is already decided.
   *
   * Applied to the first property card only. It arrives as a URL parameter, so
   * this form does not have to know anything about the matrix that sent it.
   */
  lockedCensusTarget?: LockedCensusTarget | null;
  /** «تغيير الإقامة» deactivated the file: the person holds nothing here any more. */
  onDeactivated?: () => void;
  /**
   * An administrator editing a saved file: each «قد يكون مسجَّلاً مسبقاً» match
   * gets «دمج», which opens `MergeCitizensDialog` for this file and that one.
   */
  canMerge?: boolean;
  /**
   * SUPER_ADMIN: a new file for somebody certainly on file is asked about with
   * a reason, not refused — so the save stays open for them.
   */
  canOverrideDuplicates?: boolean;
  /** The merge went through — the form's file may no longer be the one that stays. */
  onMerged?: (result: CitizenMergeResult) => void;
}) {
  const [values, setValues] = useState<CitizenFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [unverifiedDialogOpen, setUnverifiedDialogOpen] = useState(false);
  const [quickSaveOpen, setQuickSaveOpen] = useState(false);
  /** Which رقم العقار's roster is open, if any. */
  const [rosterParcel, setRosterParcel] = useState<string | null>(null);
  /** Which property cards are folded shut. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());

  // Re-seeds when the record finishes loading. Keyed on the object identity,
  // so a parent that fetches once does not clobber what has been typed since.
  useEffect(() => {
    setValues(initial);
    /*
      Saved properties open folded; a card not yet saved opens expanded.

      On the wizard's own «العقارات» page, each property is a heading the
      officer opens — and opened, it leads with its building's matrix, their
      flats lit. The earlier worry about folding («a field an officer cannot
      see is a field they do not check») is met elsewhere now: a folded card
      opens on its own on «خانات غير مؤكَّدة» when a field inside it is still
      open, and an error lands the officer on the page that holds it.

      A card with no id is the blank one a new filing starts with, or one just
      added — folding that would hide the very thing the page is for.
    */
    setCollapsed(
      new Set(
        initial.properties.flatMap((property, index) => (property.id ? [index] : [])),
      ),
    );
  }, [initial]);

  /*
    Tell the parent what the form now holds, so it can keep a draft.

    Depends on `values` alone. Including `onValuesChange` would re-fire this on
    every render of a parent that passes an inline arrow — which is every
    parent — and the handler writes to localStorage, so that is a synchronous
    disk write per render rather than per edit. The callback is invoked through
    a ref so the one that runs is always the latest, without being a dependency.
  */
  const notifyChange = useRef(onValuesChange);
  notifyChange.current = onValuesChange;
  useEffect(() => {
    notifyChange.current?.(values);
  }, [values]);

  const update = useCallback((patch: Partial<CitizenFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * The contact section, with one correction made on the officer's behalf:
   * «لا يملك رقم هاتف» carries the number already on the file into «رقم
   * للتواصل» instead of throwing it away (`carryHeldPhone`, which says when).
   *
   * Called here rather than in `ContactStep` because it is a correction rule
   * rather than a rendering one — the same place the «غير مؤكَّد» flags and
   * the نوع الملف switch are decided — and because it needs the file as it
   * stood, which the step does not own.
   */
  const updateContact = useCallback((next: CitizenFormValues['contact']) => {
    setValues((current) => ({ ...current, contact: carryHeldPhone(current.contact, next) }));
  }, []);

  /** Raise or amend a «غير مؤكَّد» flag and empty the field it covers (`withFlag`). */
  const setFlag = useCallback((path: string, reason: string) => {
    setValues((current) => withFlag(current, path, reason));
  }, []);

  /** Withdraws a flag. The field comes back empty, which is where it was. */
  const clearFlag = useCallback((path: string) => {
    setValues((current) => withoutFlag(current, path));
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

  /** One card, updated from whatever it currently is (`withProperty`: an updater, so two writes compose). */
  const setProperty = useCallback(
    (index: number, update: (current: PropertyDraft) => PropertyDraft) => {
      setValues((current) => withProperty(current, index, update));
    },
    [],
  );

  /** A new card; `sameParcelAs` carries the parcel's number and الحي across (`withAddedProperty`). */
  const addProperty = useCallback((sameParcelAs?: number) => {
    setValues((current) => {
      const next = withAddedProperty(current, sameParcelAs);
      setCollapsed(collapsedAfterAdd(next.properties));
      return next;
    });
  }, []);

  /** Property cards grouped by shared رقم العقار (`groupProperties`). */
  const propertyGroups = useMemo(() => groupProperties(values.properties), [values.properties]);

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
            citizenId={citizenId}
            allowedTypes={allowedTypes}
            collapsed={!reviewing && collapsed.has(index)}
            onToggleCollapse={() => toggleCollapsed(index)}
            onChange={(update) => setProperty(index, update)}
            onAddOnSameParcel={() => addProperty(index)}
            onViewParcel={token ? setRosterParcel : undefined}
            onRemove={(answer) => removeProperty(index, answer)}
            // Ended on the server, kept there as history — no longer this form's.
            // A partial end leaves the card here without the rows that ended.
            onEnded={(result, cardEnded) =>
              cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
            }
            // Zero properties is a valid registration, so the last remaining
            // card is removable too — not just every card after the first.
            canRemove
            errors={scopeErrors(shown, `properties.${index}`)}
            locale={locale}
            token={token}
            censusPicker
            canAnswerLandlord={canAnswerLandlord}
            nonResident={ownerRecord}
            recordKind={values.residence}
            // Only the first card inherits a matrix launch: the officer opened
            // one flat, and pinning every card they go on to add to it would
            // link properties they never said were in that building.
            lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
          />
        );
      }

      return (
        <div key={group.propertyNumber} className="review-body review-group space-y-3">
          <div className="flex items-center gap-2 border-b-2 border-primary/30 pb-2 text-primary">
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
                citizenId={citizenId}
                allowedTypes={allowedTypes}
                collapsed={!reviewing && collapsed.has(index)}
                onToggleCollapse={() => toggleCollapsed(index)}
                onChange={(update) => setProperty(index, update)}
                onViewParcel={token ? setRosterParcel : undefined}
                onRemove={(answer) => removeProperty(index, answer)}
                onEnded={(result, cardEnded) =>
                  cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
                }
                canRemove
                errors={scopeErrors(shown, `properties.${index}`)}
                locale={locale}
                token={token}
                censusPicker
                canAnswerLandlord={canAnswerLandlord}
                nonResident={ownerRecord}
                recordKind={values.residence}
                lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
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

  const removeProperty = useCallback((index: number, answer?: CardRemovalAnswer) => {
    setValues((current) => withRemovedProperty(current, index, answer));
    setCollapsed((current) => collapsedAfterRemoval(current, index));
  }, []);

  /** Rows of card `index` that «إنهاء الإيجار» just ended while the card goes on (`withEndedRowsRemoved`). */
  const removeEndedRows = useCallback((index: number, rowIds: readonly string[]) => {
    if (rowIds.length === 0) return;
    setValues((current) => withEndedRowsRemoved(current, index, rowIds));
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

  /** A card holding a type the current صفة الإقامة no longer permits has it cleared (`withDisallowedTypesCleared`). */
  useEffect(() => {
    const permitted = new Set<string>(allowedTypes);
    if (!holdsDisallowedType(values.properties, permitted)) return;

    setValues((current) => withDisallowedTypesCleared(current, permitted));
  }, [allowedTypes, values.properties]);

  /** A flag whose field the form has stopped asking about is withdrawn (`withUnaskableFlagsDropped`). */
  useEffect(() => {
    const askable = askablePaths(values);
    if (!holdsUnaskableFlag(values.flags, askable)) return;

    setValues((current) => withUnaskableFlagsDropped(current, askable));
  }, [values]);

  const shown = useMemo(() => (showErrors ? fieldErrors : {}), [showErrors, fieldErrors]);

  const sectionInvalid = useCallback(
    (prefix: string) => Object.keys(shown).some((key) => key.startsWith(`${prefix}.`)),
    [shown],
  );

  /** «غير مقيم في البلدة» — the stored value still reads OWNER; see `CITIZEN_RESIDENCE`. */
  const isNonResident = values.residence === 'NON_RESIDENT_OWNER';
  /** «تركة» or «جهة أو وقف» (0076) — not a living person, so neither household nor non-resident. */
  const nonPerson = isNonPersonRecord(values.residence) ? (values.residence as 'ESTATE' | 'INSTITUTION') : null;
  /** Any record that is not a household: none of them lives in a dwelling here. */
  const ownerRecord = isOwnerRecord(values.residence);
  const tKind = useTranslations('citizenKind');

  /** Switching نوع الملف. See `withResidence`. */
  const setResidence = useCallback((residence: CitizenResidence) => {
    setValues((current) => withResidence(current, residence));
  }, []);

  /**
   * «تغيير الإقامة» on a saved file.
   *
   * Changing the answer on a saved file opens the guide rather than flipping
   * it: a real move has tenancies to end and homes to re-describe
   * (`planResidenceMove`), and the guide also offers the plain switch for a
   * residence recorded wrongly. A new filing just answers the question.
   *
   * Changing it back while a move is applied here undoes that move — the form
   * as it was the moment the move was applied. Tenancies the guide ended stay
   * ended: they were saved, on their day, as facts.
   */
  const [residenceGuide, setResidenceGuide] = useState<CitizenResidence | null>(null);
  const beforeMove = useRef<CitizenFormValues | null>(null);
  const chooseResidence = useCallback(
    (next: CitizenResidence) => {
      if (next === (values.residence ?? 'RESIDENT')) return;
      if (values.residenceMove) {
        const snapshot = beforeMove.current;
        beforeMove.current = null;
        setValues(snapshot ?? { ...withResidence(values, next), residenceMove: undefined });
        return;
      }
      /*
        The guide is for what happened to a person: a move into or out of the
        town, or a death (→ «تركة»). Anything else — a file that was always an
        institution, or an estate recorded by mistake — is a correction, and
        the form's own checks say what it leaves to settle.
      */
      const current = values.residence ?? 'RESIDENT';
      const guided =
        (current === 'RESIDENT' && next === 'NON_RESIDENT_OWNER') ||
        (current === 'NON_RESIDENT_OWNER' && next === 'RESIDENT') ||
        (!isNonPersonRecord(current) && next === 'ESTATE');
      if (mode === 'edit' && citizenId && guided) {
        setResidenceGuide(next);
        return;
      }
      setResidence(next);
    },
    [values, mode, citizenId, setResidence],
  );

  /** Undoes the move or death applied on this form — the form as it was before it. */
  const undoMove = useCallback(() => {
    const snapshot = beforeMove.current;
    beforeMove.current = null;
    if (snapshot) setValues(snapshot);
    else setValues((current) => ({ ...current, residenceMove: undefined }));
  }, []);

  /**
   * «قد يكون مسجَّلاً مسبقاً» — looked up once, shown in one of two places.
   *
   * On a correction as well as a new filing, with the open file itself dropped
   * from its own matches (`excludeId`). It used to be creates-only, on the
   * reasoning that every match on an edit is a match with the record being
   * looked at. That is true of the record itself and of nobody else: an officer
   * correcting a surname, or adding the phone the household actually answers
   * on, is doing the very thing that turns two files into recognisable
   * duplicates, and this is the one screen where that is visible while it
   * happens.
   */
  const duplicateCheck = usePossibleDuplicates({
    tenant,
    // No lookup for an estate or an institution: it is never "the same person" (0076), and the server skips it too.
    token: isNonPersonRecord(values.residence) ? null : token,
    firstName: values.personal.firstName,
    middleName: values.personal.middleName,
    lastName: values.personal.lastName,
    motherName: values.personal.motherName,
    civilRecordNumber: values.personal.civilRecordNumber,
    residencyNumber: values.personal.residencyNumber,
    gender: values.personal.gender,
    isLebanese: values.personal.isLebanese,
    unitIds: values.properties.flatMap((card) => (card.units ?? []).map((unit) => unit.unitId)),
    phone: values.contact.phone,
    whatsapp: values.contact.whatsappSameAsPhone === false ? values.contact.whatsapp : undefined,
    excludeId: citizenId,
  });

  /**
   * On a desktop: in place, under the phone number, handed to whichever
   * contact step is rendered.
   *
   * It lives there rather than at the foot of the personal step, where it used
   * to sit. It matches on the name *and* the phone, and the phone is by far
   * the stronger of the two — so the old placement put an orange warning about
   * a number one section above the field that asks for it, reading as a
   * complaint about the name the officer had just typed.
   */
  /*
    «تغيير رقم الهاتف» on a saved file changes how the citizen signs in: the
    portal asks for their رقم مرجعي *and* this number. Said under the field, on
    every screen size, while the old number is still on screen to compare —
    not discovered when the citizen calls to say they cannot log in.

    «لا يملك رقم هاتف» is not a new number, and saying «use the new number»
    there was untrue: the payments portal and the phone-code sign-in both need
    a number of the citizen's own, and «رقم للتواصل» is never accepted in its
    place. What is left is the reference-only landing page, and that is what
    the note says. How such a citizen's family pays online is an open decision
    (docs/open-decisions.md).
  */
  const tPhone = useTranslations('citizenForm.phone');
  const ltr = (chunks: React.ReactNode) => <span dir="ltr">{chunks}</span>;
  const note = phoneNoteOf(initial.contact.phone, values.contact, values.residence, mode);
  const phoneNoteText =
    note?.kind === 'noPhone' ? (
      <>
        {tPhone('noPhoneSignIn')}
        {note.oldNumber ? <> {tPhone.rich('oldNumberStops', { number: note.oldNumber, ltr })}</> : null}
      </>
    ) : note?.kind === 'changed' ? (
      tPhone.rich('changed', { number: note.oldNumber, ltr })
    ) : null;
  const phoneNote = phoneNoteText ? (
    <p
      role="note"
      className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{phoneNoteText}</span>
    </p>
  ) : null;

  /** «دمج» on a match — only for an administrator, only on a saved file. */
  const [mergeWith, setMergeWith] = useState<string | null>(null);
  const mergeFromMatch =
    canMerge && citizenId && token && onMerged ? (match: PossibleDuplicateMatch) => setMergeWith(match.id) : undefined;

  /**
   * «قد يكون مسجَّلاً مسبقاً» — in the sticky step bar, on every step and every
   * screen size. See `DuplicateAlert` for why it is not under الهاتف any more.
   */
  const duplicatesAlert = (
    <DuplicateAlert
      check={duplicateCheck}
      locale={locale}
      mode={mode}
      canOverride={canOverrideDuplicates}
      onMerge={mergeFromMatch}
    />
  );

  /**
   * A new file for somebody the register is certain about is refused by the
   * server for an officer. The save is closed here too, with the reason beside
   * it, rather than letting them fill in three steps to be told at the end.
   */
  const refusedAsDuplicate =
    mode === 'create' && !canOverrideDuplicates && duplicateCheck.matches.some((match) => match.certain);
  const refusedReason =
    locale === 'en'
      ? 'This person is already registered — add the property to their file.'
      : 'هذا الشخص مسجَّل مسبقاً — أضف العقار إلى ملفه.';

  const sections = useMemo(
    () => [
      {
        id: 'personal',
        step: '1',
        icon: IdCard,
        title: nonPerson
          ? tKind(nonPerson === 'ESTATE' ? 'sectionPersonalEstate' : 'sectionPersonalInstitution')
          : isNonResident
            ? locale === 'en'
              ? 'Basic details'
              : 'البيانات الأساسية'
            : locale === 'en'
              ? 'Personal Info'
              : 'البيانات الشخصية',
      },
      {
        id: 'contact',
        step: '2',
        icon: UsersRound,
        title: nonPerson
          ? tKind(nonPerson === 'ESTATE' ? 'sectionContactEstate' : 'sectionContactInstitution')
          : isNonResident
            ? locale === 'en'
              ? 'Contact'
              : 'التواصل'
            : locale === 'en'
              ? 'Contact & Family'
              : 'التواصل والأسرة',
      },
      {
        id: 'properties',
        step: '3',
        icon: Building2,
        title: locale === 'en' ? 'Properties' : 'العقارات',
      },
    ],
    [locale, isNonResident, nonPerson, tKind],
  );

  /** The wizard's page — one of the three, on every screen size. */
  const [step, setStep] = useState<SectionId>('personal');
  /** Whether the fourth step, «خانات غير مؤكَّدة», is showing in place of the pages. */
  const [reviewing, setReviewing] = useState(false);
  /**
   * The flagged paths as they were when the fourth step opened.
   *
   * A field stays on the step after its flag is lifted, so the value just
   * typed into it is still there to read — it would otherwise vanish the
   * moment «إدخال القيمة» was pressed, before anything had been entered.
   */
  const [reviewPaths, setReviewPaths] = useState<ReadonlySet<string>>(new Set());

  /** The form's outermost element — what a step change scrolls back to.
   *  `window.scrollTo` was used here and did nothing: inside the admin
   *  shell the scroller is an inner `<main>`, not the document. */
  const formRootRef = useRef<HTMLDivElement | null>(null);

  const stepIndex = useMemo(
    () => sections.findIndex((s) => s.id === step),
    [sections, step],
  );

  /** Any page, from the step bar — and out of the unverified list if it was open. */
  const goToStep = useCallback((id: SectionId) => {
    setReviewing(false);
    setStep(id);
    scrollElementToTop(formRootRef.current);
  }, []);

  /** The fourth step: only the fields still marked «غير مؤكَّد». */
  const openReview = useCallback(() => {
    setReviewPaths(new Set(values.flags.keys()));
    setReviewing(true);
    scrollElementToTop(formRootRef.current);
  }, [values.flags]);

  /**
   * What the fourth step shows: every field flagged when it opened, and any
   * flagged since («تعليم خانة أخرى» on the step itself). Null on the other
   * three, which is what tells every `Field` to render normally.
   */
  const focus = useMemo(
    () => (reviewing ? { paths: new Set([...reviewPaths, ...values.flags.keys()]) } : null),
    [reviewing, reviewPaths, values.flags],
  );

  /** «التالي» from العقارات is the unverified list; from the list there is nowhere further. */
  const goToNextStep = useCallback(() => {
    if (reviewing) return;
    const nextIdx = stepIndex + 1;
    if (nextIdx < sections.length) goToStep(sections[nextIdx].id as SectionId);
    else openReview();
  }, [reviewing, stepIndex, sections, goToStep, openReview]);

  /** «السابق» from the unverified list is العقارات. */
  const goToPrevStep = useCallback(() => {
    if (reviewing) {
      goToStep(sections[sections.length - 1].id as SectionId);
      return;
    }
    const prevIdx = stepIndex - 1;
    if (prevIdx >= 0) goToStep(sections[prevIdx].id as SectionId);
  }, [reviewing, stepIndex, sections, goToStep]);

  /**
   * The four steps the bar draws: the three pages, then the unverified list,
   * which carries its count — the one number worth knowing before opening it.
   */
  const wizardSteps = useMemo(
    () => [
      ...sections.map((section) => ({
        id: section.id,
        icon: section.icon,
        title: section.title,
        count: 0,
        invalid: sectionInvalid(section.id),
        go: () => goToStep(section.id as SectionId),
      })),
      {
        id: 'unverified',
        icon: FileQuestion,
        title: locale === 'en' ? 'Unverified fields' : 'خانات غير مؤكَّدة',
        count: values.flags.size,
        invalid: false,
        go: openReview,
      },
    ],
    [sections, sectionInvalid, goToStep, openReview, locale, values.flags.size],
  );
  const wizardIndex = reviewing ? sections.length : stepIndex;

  function handleSubmit(withBlanketReason?: string) {
    const candidate = withBlanketReason
      ? { ...values, blanketFlagReason: withBlanketReason }
      : values;

    const errors = validate(candidate);
    setFieldErrors(errors);
    setShowErrors(true);

    if (Object.keys(errors).length > 0) {
      /*
        A quick save that still fails has failed for a reason the blanket
        reason is not allowed to cover — a missing surname, a discriminator, or
        a value that was entered and is wrong. The dialog closes so the officer
        can see which field the complaint landed on, because leaving it open
        over a form they cannot read is the one outcome that helps nobody.
      */
      if (withBlanketReason) setQuickSaveOpen(false);

      /*
        The page to show is read from `errors`, not from `sectionInvalid`:
        that one reads the errors of the *previous* render, which on a first
        save is none — harmless while every section was on one page, but in a
        wizard it left the officer on a page with nothing wrong on it. «ملاحظات»
        is on the last page, so an error nowhere else lands there.

        Saved from «خانات غير مؤكَّدة» with only its own fields to fix, it
        stays there: those fields are on that step, errors and all.
      */
      const erroredKeys = Object.keys(errors);
      // Saved properties open folded, so a complaint inside one would land
      // on a page with nothing wrong in sight. Every card holding one opens.
      const erroredCards = new Set(
        erroredKeys
          .filter((key) => key.startsWith('properties.'))
          .map((key) => Number(key.split('.')[1])),
      );
      if (erroredCards.size > 0) {
        setCollapsed((current) => {
          const next = new Set(current);
          for (const index of erroredCards) next.delete(index);
          return next;
        });
      }
      if (focus && erroredKeys.every((key) => focus.paths.has(key))) return;
      const firstInvalidSection =
        sections.find((s) => erroredKeys.some((key) => key.startsWith(`${s.id}.`))) ??
        sections[sections.length - 1];
      setReviewing(false);
      setStep(firstInvalidSection.id as SectionId);
      setTimeout(() => {
        document
          .querySelector('[data-section-invalid="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return;
    }

    setQuickSaveOpen(false);
    onSubmit(candidate);
  }

  /**
   * Roughly how many fields the blanket reason would be asked to cover.
   *
   * `askableFields` is the same list the «غير مؤكَّد» dialog offers, so this
   * counts the gaps a reviewer would actually see — an estimate stated as one,
   * because the authoritative answer is the server's `autoFlags` and this runs
   * on every keystroke.
   */
  const gapCount = useMemo(
    () =>
      askableFields(values).filter(
        (field) => !values.flags.has(field.path) && isBlank(valueAtPath(values, field.path)),
      ).length,
    [values],
  );

  return (
    <FieldFlagProvider value={flagging}>
    <div ref={formRootRef} className="flex flex-1 flex-col space-y-4 pb-20 sm:space-y-5 sm:pb-0">
      {/*
        ── One wizard, on every screen ─────────────────────────────────────

        Four steps, drawn the way the building editor draws its own — a circle
        per step, its label, a line to the next: البيانات الشخصية, التواصل
        والأسرة, العقارات, and last «خانات غير مؤكَّدة», which lists only the
        fields still marked unverified. One page at a time, with «السابق» and
        «التالي» in the bar below and every step clickable here. A phone used
        to get a stepper and a desktop the whole record on one scroll, which
        meant two copies of every section in the page at once; every property
        card, with its census picker and its fetches, was mounted twice.

        Every page stays mounted and the ones not shown are `hidden`. A step
        change must not unmount a property card: its census picker keeps
        «بدون ربط» and what it has fetched in its own state, and re-mounting it
        is how a card the officer deliberately left unlinked could quietly
        queue a building for creation (see the fold note in `PropertyCard`).
      */}
      <StepBar locale={locale} steps={wizardSteps} current={wizardIndex}>
        {duplicatesAlert}
      </StepBar>




      {/*
        Nothing flagged: the step says so, rather than showing an empty page
        that reads as a form that failed to load.
      */}
      {reviewing && focus && focus.paths.size === 0 ? (
        <EmptyState
          className="rounded-xl border border-border/80 bg-card"
          iconNode={<CheckCircle2 className="text-success" />}
          title={locale === 'en' ? 'No unverified fields' : 'لا توجد خانات غير مؤكَّدة'}
          description={
            locale === 'en'
              ? 'Every field in this record is answered — nothing is marked «unverified».'
              : 'كل خانات هذا السجل مُجابة — لا توجد خانة معلَّمة «غير مؤكَّد».'
          }
        />
      ) : null}

      <FieldFocusProvider value={focus}>
      {/*
        A field scrolled into view stops below the sticky step bar and its
        duplicate alert rather than under them (WCAG 2.4.11).
      */}
      <div
        data-review={reviewing ? '' : undefined}
        className="space-y-4 sm:space-y-5 [&_input]:scroll-mt-40 [&_select]:scroll-mt-40 [&_textarea]:scroll-mt-40"
      >
      {/* ── Page 1 — البيانات الشخصية ── */}
      <div className={cn(!reviewing && step !== 'personal' && 'hidden')}>
          <PersonalSection
            title={sections[0].title}
            invalid={sectionInvalid('personal')}
            locale={locale}
            residence={values.residence}
            residenceMove={values.residenceMove}
            personal={values.personal}
            errors={shown}
            nonPerson={nonPerson}
            isNonResident={isNonResident}
            onChooseResidence={chooseResidence}
            onUndoMove={undoMove}
            onChange={update}
          />
      </div>

      {/* ── Page 2 — التواصل والأسرة ── */}
      <div className={cn(!reviewing && step !== 'contact' && 'hidden')}>
          <ContactSection
            title={sections[1].title}
            invalid={sectionInvalid('contact')}
            locale={locale}
            contact={values.contact}
            errors={shown}
            nonPerson={nonPerson}
            isNonResident={isNonResident}
            phoneNote={phoneNote}
            onChange={update}
            onChangeHousehold={updateContact}
          />
      </div>

      {/* ── Page 3 — العقارات, then ملاحظات ── */}
      <div className={cn('space-y-4 sm:space-y-5', !reviewing && step !== 'properties' && 'hidden')}>
          <PropertiesSection
            count={values.properties.length}
            invalid={sectionInvalid('properties')}
            locale={locale}
            onAdd={() => addProperty()}
          >
            {renderPropertyGroups()}
          </PropertiesSection>

        <NotesSection
          locale={locale}
          value={values.notes ?? ''}
          error={shown['notes']}
          onChange={(notes) => update({ notes })}
        />
      </div>

      </div>
      </FieldFocusProvider>

      <div className={cn('sm:hidden', reviewing && 'hidden')}>
          {/*
            Outside the step switch on purpose — this is what puts «ملاحظات»
            under all three steps rather than only after the last one. One
            instance, so the three steps share a single box and a note typed in
            العقارات is still there when the officer steps back to البيانات
            الشخصية to fix a surname.
          */}
          <StepNotesField
            value={values.notes ?? ''}
            error={shown['notes']}
            onChange={(notes) => update({ notes })}
            locale={locale}
          />
      </div>

      <MobileActionBar
        locale={locale}
        mode={mode}
        offline={offline}
        submitting={submitting}
        wizardIndex={wizardIndex}
        reviewing={reviewing}
        flagCount={values.flags.size}
        refusedAsDuplicate={refusedAsDuplicate}
        refusedReason={refusedReason}
        onBack={goToPrevStep}
        onNext={goToNextStep}
        onCancel={onCancel}
        onOpenUnverified={() => setUnverifiedDialogOpen(true)}
        onQuickSave={() => setQuickSaveOpen(true)}
        onSave={() => handleSubmit()}
      />

      {/*
        Takes up whatever height the step leaves, so the bar below sits at the
        bottom of the screen on a short step — an empty «خانات غير مؤكَّدة»
        above all — rather than halfway up it. On a long step it is nothing,
        and the bar sticks to the bottom as it scrolls, as it always did.
      */}
      <div aria-hidden className="flex-1" />

      <DesktopActionBar
        locale={locale}
        mode={mode}
        offline={offline}
        submitting={submitting}
        error={error}
        wizardIndex={wizardIndex}
        reviewing={reviewing}
        refusedAsDuplicate={refusedAsDuplicate}
        refusedReason={refusedReason}
        onBack={goToPrevStep}
        onNext={goToNextStep}
        onCancel={onCancel}
        onQuickSave={() => setQuickSaveOpen(true)}
        onSave={() => handleSubmit()}
      />
    </div>

    <QuickSaveDialog
      open={quickSaveOpen}
      onOpenChange={setQuickSaveOpen}
      gapCount={gapCount}
      submitting={submitting}
      error={error}
      onConfirm={(reason) => handleSubmit(reason)}
      locale={locale}
    />

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
      onSaveFlags={(newFlags) => setValues((current) => withFlagsApplied(current, newFlags))}
      locale={locale}
    />
    {mergeWith && citizenId && token && onMerged ? (
      <MergeCitizensDialog
        open
        onOpenChange={(next) => (next ? undefined : setMergeWith(null))}
        tenant={tenant}
        token={token}
        locale={locale}
        firstId={citizenId}
        secondId={mergeWith}
        onMerged={(result) => {
          setMergeWith(null);
          onMerged(result);
        }}
      />
    ) : null}
    {residenceGuide && citizenId ? (
      <ResidenceChangeDialog
        open
        to={residenceGuide}
        values={values}
        tenant={tenant}
        token={token}
        citizenId={citizenId}
        locale={locale}
        onCancel={() => setResidenceGuide(null)}
        onCorrect={() => {
          setValues((current) => ({ ...withResidence(current, residenceGuide), residenceMove: undefined }));
          setResidenceGuide(null);
        }}
        onApply={(answers) => {
          beforeMove.current = values;
          setValues(applyResidenceMove(values, planResidenceMove(values, residenceGuide), answers));
          setResidenceGuide(null);
        }}
        onTenancyEnded={(index, result, cardEnded) =>
          cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
        }
        onRemoveUnsaved={(index) => removeProperty(index)}
        onDeactivated={() => {
          setResidenceGuide(null);
          onDeactivated?.();
        }}
      />
    ) : null}
    </FieldFlagProvider>
  );
}

