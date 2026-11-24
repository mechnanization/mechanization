import { useCallback, useMemo, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import { Building2, FileQuestion, IdCard, UsersRound } from 'lucide-react';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import type { CitizenFormValues } from '@/lib/citizen-form-values';

/**
 * The wizard's three pages.
 *
 * The id is also the error-key prefix (`personal.firstName`,
 * `properties.0.neighborhood`), which is what lets the step bar mark a page as
 * holding a problem without a second mapping. Their titles, icons and numbers
 * are `sections` inside the component, where the locale is known.
 */
export type SectionId = 'personal' | 'contact' | 'properties';

/**
 * Where the officer is in the wizard (GOD-22, phase 2c): which page, whether the
 * fourth step «خانات غير مؤكَّدة» is open in place of the pages, the paths it
 * lists, the step bar's four steps and «السابق» / «التالي».
 *
 * Moved out of `CitizenForm` with its text unchanged. `handleSubmit` still
 * decides which page an error lands the officer on, so `setStep` and
 * `setReviewing` are returned with the rest.
 */
export function useCitizenFormWizard({
  values,
  locale,
  nonPerson,
  isNonResident,
  tKind,
  sectionInvalid,
}: {
  values: CitizenFormValues;
  locale: string;
  nonPerson: 'ESTATE' | 'INSTITUTION' | null;
  isNonResident: boolean;
  tKind: ReturnType<typeof useTranslations<'citizenKind'>>;
  sectionInvalid: (prefix: string) => boolean;
}) {
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

  return {
    sections,
    step,
    setStep,
    reviewing,
    setReviewing,
    formRootRef,
    focus,
    goToNextStep,
    goToPrevStep,
    wizardSteps,
    wizardIndex,
  };
}
