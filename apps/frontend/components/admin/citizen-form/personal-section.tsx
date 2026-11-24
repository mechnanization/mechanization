'use client';

import { useTranslations } from 'next-intl';
import { IdCard } from 'lucide-react';
import type { CitizenResidence } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { NonPersonPersonalStep, OwnerPersonalStep, PersonalStep } from '@/components/citizen/steps';
import type { CitizenFormValues } from '@/lib/citizen-form-values';
import { FormSection } from './form-section';
import { ResidenceChooser } from './residence-chooser';

/*
  Page 1 of the citizen form, «البيانات الشخصية» (GOD-22, phase 2b): the kind of
  file, the move that was applied to it, and the personal step that kind of file
  asks — an estate's or an institution's, a non-resident owner's, or a
  household's. Moved out of `citizen-form.tsx` as it was; the form still owns
  the values and says which of the three it is.
*/
export function PersonalSection({
  title,
  invalid,
  locale,
  residence,
  residenceMove,
  personal,
  errors,
  nonPerson,
  isNonResident,
  onChooseResidence,
  onUndoMove,
  onChange,
}: {
  title: string;
  invalid: boolean;
  locale: string;
  residence: CitizenResidence | undefined;
  residenceMove: CitizenFormValues['residenceMove'];
  personal: CitizenFormValues['personal'];
  errors: Record<string, string>;
  /** An estate or an institution, else null. */
  nonPerson: 'ESTATE' | 'INSTITUTION' | null;
  isNonResident: boolean;
  onChooseResidence: (residence: CitizenResidence) => void;
  onUndoMove: () => void;
  onChange: (patch: Partial<CitizenFormValues>) => void;
}) {
  const tKind = useTranslations('citizenKind');
  return (
    <FormSection
      id="personal"
      step="1"
      icon={IdCard}
      title={title}
      invalid={invalid}
    >
      <ResidenceChooser value={residence ?? 'RESIDENT'} onChange={onChooseResidence} locale={locale} />
      {residenceMove ? (
        <p className="-mt-2 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-primary/5 px-3 py-2 text-sm">
          <span>
            {tKind(residence === 'ESTATE' ? 'deathApplied' : 'moveApplied', {
              date: residenceMove.movedOn,
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0"
            onClick={onUndoMove}
          >
            {locale === 'en' ? 'Undo' : 'تراجع'}
          </Button>
        </p>
      ) : null}
      {nonPerson ? (
        <NonPersonPersonalStep
          kind={nonPerson}
          value={personal}
          errors={errors}
          onChange={(next) => onChange({ personal: next })}
          locale={locale}
        />
      ) : isNonResident ? (
        <OwnerPersonalStep value={personal} errors={errors} onChange={(next) => onChange({ personal: next })} locale={locale} />
      ) : (
        <PersonalStep value={personal} errors={errors} onChange={(next) => onChange({ personal: next })} locale={locale} />
      )}
    </FormSection>
  );
}
