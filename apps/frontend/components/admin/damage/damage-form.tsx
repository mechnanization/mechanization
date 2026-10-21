'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  DAMAGE_LEVEL,
  DAMAGE_SOURCE,
  getLabels,
  habitabilityFor,
  type DamageLevel,
  type DamageSource,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { today, type DamageFormValues } from '@/lib/damage-reading';

/**
 * One damage observation, appended to the log. There is no edit and no
 * delete: a building that was unsafe in 2024 and repaired in 2026 is two facts
 * (D3).
 *
 * Two answers, never one folded into the other (decision, 2026-10-05): the
 * structural level on UN-Habitat's scale, verbatim (D4), and «صالحة للسكن؟».
 * The level prefills the second where it decides it (`habitabilityFor`): a
 * collapse or an evacuation is locked to «غير صالحة»; no or minor damage starts
 * at «صالحة» and can be changed — a sound flat with no water or windows is not
 * fit to live in; restricted use starts unanswered and must be answered. A
 * reading that says nobody can live there may carry the day of the visit after
 * repair, and exempts the flat from every fee until a later reading says it is
 * habitable (decisions of 2026-10-05 and 2026-10-07).
 */
export function DamageForm({
  busy,
  locale,
  target,
  onSubmit,
}: {
  busy: boolean;
  locale: string;
  /** What is being assessed, named in the button so the two cannot be confused. */
  target: { kind: 'unit' | 'building'; code: string };
  onSubmit: (values: DamageFormValues) => void;
}) {
  const t = useTranslations('damage');
  const labels = getLabels(locale);
  const pickerLocale = locale === 'en' ? 'en' : 'ar';

  const [level, setLevel] = useState<DamageLevel>('SAFE_MINOR_DAMAGE');
  const [habitable, setHabitable] = useState<boolean | null>(habitabilityFor('SAFE_MINOR_DAMAGE').value);
  const [reinspectAt, setReinspectAt] = useState('');
  const [source, setSource] = useState<DamageSource>('FIELD_VISIT');
  const [observations, setObservations] = useState('');
  const [assessedAt, setAssessedAt] = useState('');

  const rule = habitabilityFor(level);
  const unanswered = rule.required && habitable === null;
  const earliest = today();

  /* A new level brings its own starting answer; whatever the old one was does not carry over. */
  const chooseLevel = (next: DamageLevel) => {
    setLevel(next);
    setHabitable(habitabilityFor(next).value);
  };

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="grid gap-3">
        <Field label={t('level')} htmlFor="damage-level" required>
          <Select value={level} onValueChange={(value) => chooseLevel(value as DamageLevel)}>
            <SelectTrigger id="damage-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAMAGE_LEVEL.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.damageLevel[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={t('habitable.label')}
          htmlFor="damage-habitable"
          required={rule.required}
          caution={rule.locked ? t('habitable.locked') : unanswered ? t('habitable.choose') : undefined}
        >
          <SegmentedControl
            aria-label={t('habitable.label')}
            value={habitable === null ? undefined : habitable ? 'yes' : 'no'}
            onChange={(value) => setHabitable(value === 'yes')}
            disabled={rule.locked}
            invalid={unanswered}
            size="field"
            options={[
              { value: 'yes', label: t('habitable.yes') },
              { value: 'no', label: t('habitable.no') },
            ]}
          />
        </Field>

        {habitable === false ? (
          <Field
            label={t('reinspect.label')}
            htmlFor="damage-reinspect"
            optionalLabel={t('reinspect.optional')}
            caution={t('reinspect.feeHeld')}
          >
            <DatePicker
              id="damage-reinspect"
              value={reinspectAt}
              onChange={setReinspectAt}
              min={earliest}
              placeholder={t('reinspect.placeholder')}
              locale={pickerLocale}
            />
          </Field>
        ) : null}

        <Field label={t('source')} htmlFor="damage-source" required>
          <Select value={source} onValueChange={(value) => setSource(value as DamageSource)}>
            <SelectTrigger id="damage-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAMAGE_SOURCE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.damageSource[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Back-dating is allowed and forward-dating is not: an assessment typed
            up a week late describes the visit, not the paperwork. */}
        <Field label={t('inspectedOn')} htmlFor="damage-date" optionalLabel={t('inspectedOnToday')}>
          <DatePicker
            id="damage-date"
            value={assessedAt}
            onChange={setAssessedAt}
            max={earliest}
            placeholder={t('inspectedOnPlaceholder')}
            locale={pickerLocale}
          />
        </Field>
      </div>

      <Field label={t('observations')} htmlFor="damage-observations">
        <Textarea
          id="damage-observations"
          rows={2}
          value={observations}
          onChange={(event) => setObservations(event.target.value)}
          placeholder={t('observationsPlaceholder')}
        />
      </Field>

      <Button
        size="sm"
        disabled={busy || unanswered}
        onClick={() =>
          onSubmit({
            level,
            source,
            observations,
            assessedAt,
            habitable,
            reinspectAt: habitable === false ? reinspectAt : '',
          })
        }
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {target.kind === 'unit' ? t('submitUnit', { code: target.code }) : t('submitBuilding', { code: target.code })}
      </Button>
    </div>
  );
}
