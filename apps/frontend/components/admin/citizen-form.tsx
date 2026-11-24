'use client';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  Building2,
  CheckCircle2,
  FileQuestion,
  IdCard,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import {
  isNonPersonRecord,
  isOwnerRecord,
  type CitizenMergeResult,
  type PossibleDuplicateMatch,
} from '@mechanization/shared-schemas';
import type { PublicTenantConfig } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/states';
import { DuplicateAlert, usePossibleDuplicates } from './possible-duplicates';
import { FieldFlagProvider, FieldFocusProvider } from '@/components/ui/field';
import type { LockedCensusTarget } from './building-unit-picker';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import { cn } from '@/lib/utils';

import type { CitizenFormValues } from '@/lib/citizen-form-values';
import { askableFields, isBlank, valueAtPath } from '@/lib/citizen-form-askable';
import { validate } from '@/lib/citizen-form-validation';
import {
  phoneNoteOf,
} from '@/lib/citizen-form-state';
import { StepNotesField } from './citizen-form/step-notes-field';
import { StepBar } from './citizen-form/step-bar';
import { PersonalSection } from './citizen-form/personal-section';
import { ContactSection } from './citizen-form/contact-section';
import { PropertiesSection } from './citizen-form/properties-section';
import { NotesSection } from './citizen-form/notes-section';
import { PropertyCards } from './citizen-form/property-cards';
import { useCitizenFormRecord } from './citizen-form/use-citizen-form-record';
import { useResidenceChange } from './citizen-form/use-residence-change';
import { CitizenFormDialogs } from './citizen-form/citizen-form-dialogs';
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [unverifiedDialogOpen, setUnverifiedDialogOpen] = useState(false);
  const [quickSaveOpen, setQuickSaveOpen] = useState(false);
  /** Which رقم العقار's roster is open, if any. */
  const [rosterParcel, setRosterParcel] = useState<string | null>(null);
  const {
    values,
    setValues,
    collapsed,
    setCollapsed,
    update,
    updateContact,
    flagging,
    setProperty,
    addProperty,
    propertyGroups,
    removeProperty,
    removeEndedRows,
    toggleCollapsed,
    allowedTypes,
  } = useCitizenFormRecord({ initial, onValuesChange, config, locale });

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

  const { residenceGuide, setResidenceGuide, chooseResidence, undoMove, correctResidence, applyMove } = useResidenceChange({
    values,
    setValues,
    mode,
    citizenId,
  });

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
            <PropertyCards
              tenant={tenant}
              token={token}
              citizenId={citizenId}
              locale={locale}
              properties={values.properties}
              groups={propertyGroups}
              allowedTypes={allowedTypes}
              collapsed={collapsed}
              reviewing={reviewing}
              shown={shown}
              canAnswerLandlord={canAnswerLandlord}
              ownerRecord={ownerRecord}
              residence={values.residence}
              lockedCensusTarget={lockedCensusTarget}
              toggleCollapsed={toggleCollapsed}
              setProperty={setProperty}
              addProperty={addProperty}
              removeProperty={removeProperty}
              removeEndedRows={removeEndedRows}
              setRosterParcel={setRosterParcel}
            />
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

    <CitizenFormDialogs
      tenant={tenant}
      token={token}
      citizenId={citizenId}
      locale={locale}
      values={values}
      setValues={setValues}
      submitting={submitting}
      error={error}
      quickSaveOpen={quickSaveOpen}
      setQuickSaveOpen={setQuickSaveOpen}
      gapCount={gapCount}
      handleSubmit={handleSubmit}
      rosterParcel={rosterParcel}
      setRosterParcel={setRosterParcel}
      unverifiedDialogOpen={unverifiedDialogOpen}
      setUnverifiedDialogOpen={setUnverifiedDialogOpen}
      mergeWith={mergeWith}
      setMergeWith={setMergeWith}
      onMerged={onMerged}
      residenceGuide={residenceGuide}
      setResidenceGuide={setResidenceGuide}
      correctResidence={correctResidence}
      applyMove={applyMove}
      removeProperty={removeProperty}
      removeEndedRows={removeEndedRows}
      onDeactivated={onDeactivated}
    />
    </FieldFlagProvider>
  );
}

