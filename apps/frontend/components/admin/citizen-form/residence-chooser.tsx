'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getLabels, isNonPersonRecord, type CitizenResidence } from '@mechanization/shared-schemas';
import { Field } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';

/**
 * «صاحب الملف» — a person, or an owner that is not one; then which.
 *
 * A person is asked **where they live most of the year**, never about محل
 * القيد: plenty of people registered in the town live in Beirut, and an
 * expatriate whose family is on the civil register here still lives abroad.
 * Somebody who lives in someone else's property is always a household — the
 * non-resident record holds what they own, and what they rent or occupy that
 * nobody lives in (`nonResidentCardIssues`).
 *
 * Not a person (0076): «تركة (ورثة المرحوم)» — a deceased owner's file, in his
 * heirs' name — or «جهة أو وقف». Two choices of two rather than one of four,
 * so each still fits a phone in a stairwell; the first only opens the second,
 * and nothing changes until the second is answered.
 */
export function ResidenceChooser({
  value,
  onChange,
  locale,
}: {
  value: CitizenResidence;
  onChange: (next: CitizenResidence) => void;
  locale: string;
}) {
  const labels = getLabels(locale);
  const t = useTranslations('citizenKind');
  const isBody = isNonPersonRecord(value);
  /** The first answer, given and not yet followed by the second. */
  const [pending, setPending] = useState<'PERSON' | 'BODY' | null>(null);
  const group = pending ?? (isBody ? 'BODY' : 'PERSON');
  const settled = pending === null;

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3">
      <Field label={t('question')} htmlFor="record-kind" required>
        <SegmentedControl
          value={group}
          aria-label={t('question')}
          onChange={(next) => setPending(next === (isBody ? 'BODY' : 'PERSON') ? null : (next as 'PERSON' | 'BODY'))}
          options={[
            { value: 'PERSON', label: t('person') },
            { value: 'BODY', label: t('nonPerson') },
          ]}
        />
      </Field>
      {group === 'BODY' ? (
        <Field label={t('whichBody')} htmlFor="residence" required>
          <SegmentedControl
            value={settled ? value : ''}
            aria-label={t('whichBody')}
            onChange={(next) => {
              setPending(null);
              onChange(next as CitizenResidence);
            }}
            options={[
              { value: 'ESTATE', label: labels.citizenResidence.ESTATE },
              { value: 'INSTITUTION', label: labels.citizenResidence.INSTITUTION },
            ]}
          />
        </Field>
      ) : (
        <Field
          label={t('livesHere')}
          htmlFor="residence"
          required
        >
          <SegmentedControl
            value={settled ? value : ''}
            aria-label={t('livesHere')}
            onChange={(next) => {
              setPending(null);
              onChange(next as CitizenResidence);
            }}
            options={[
              { value: 'RESIDENT', label: labels.citizenResidence.RESIDENT },
              { value: 'NON_RESIDENT_OWNER', label: labels.citizenResidence.NON_RESIDENT_OWNER },
            ]}
          />
        </Field>
      )}
    </div>
  );
}
