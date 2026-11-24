'use client';

import type { ReactNode } from 'react';
import { UsersRound } from 'lucide-react';
import { ContactStep, NonPersonContactStep, OwnerContactStep } from '@/components/citizen/steps';
import type { CitizenFormValues } from '@/lib/citizen-form-values';
import { FormSection } from './form-section';

/*
  Page 2 of the citizen form, «التواصل والأسرة» (GOD-22, phase 2b): the contact
  step that kind of file asks. Moved out of `citizen-form.tsx` as it was.
  `onChangeHousehold` is the form's `updateContact`, which a household's step
  uses because it corrects a number on the officer's behalf; the other two take
  the plain update.
*/
export function ContactSection({
  title,
  invalid,
  locale,
  contact,
  errors,
  nonPerson,
  isNonResident,
  phoneNote,
  onChange,
  onChangeHousehold,
}: {
  title: string;
  invalid: boolean;
  locale: string;
  contact: CitizenFormValues['contact'];
  errors: Record<string, string>;
  /** An estate or an institution, else null. */
  nonPerson: 'ESTATE' | 'INSTITUTION' | null;
  isNonResident: boolean;
  /** What is said under the phone box, or null. */
  phoneNote: ReactNode;
  onChange: (patch: Partial<CitizenFormValues>) => void;
  onChangeHousehold: (contact: CitizenFormValues['contact']) => void;
}) {
  return (
    <FormSection
      id="contact"
      step="2"
      icon={UsersRound}
      title={title}
      invalid={invalid}
    >
      {nonPerson ? (
        <NonPersonContactStep
          kind={nonPerson}
          value={contact}
          errors={errors}
          onChange={(next) => onChange({ contact: next })}
          afterPhone={phoneNote}
        />
      ) : isNonResident ? (
        <OwnerContactStep value={contact} errors={errors} onChange={(next) => onChange({ contact: next })} locale={locale} afterPhone={phoneNote} />
      ) : (
        <ContactStep value={contact} errors={errors} onChange={onChangeHousehold} locale={locale} afterPhone={phoneNote} />
      )}
    </FormSection>
  );
}
