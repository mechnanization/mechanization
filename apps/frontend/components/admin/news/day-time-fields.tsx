'use client';

import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { TimePicker } from '@/components/ui/time-picker';

/**
 * A day and a time on the municipality's clock, for a News article's schedule
 * and its «featured until». Two controls rather than one: the kit's calendar
 * takes a day, and its time field a time of day, `HH:MM` on the 24-hour clock. `scheduleInstant`
 * (`lib/news-article-form.ts`) turns the pair into the instant Day3ati takes.
 */
export function DayTimeFields({
  idPrefix,
  locale,
  day,
  time,
  dayLabel,
  timeLabel,
  error,
  minDay,
  disabled,
  onDay,
  onTime,
}: {
  idPrefix: string;
  locale: 'ar' | 'en';
  day: string;
  time: string;
  dayLabel: string;
  timeLabel: string;
  /** Shown under the pair: a missing half, or a time that has passed. */
  error?: string;
  /** The earliest day offered. */
  minDay?: string;
  disabled?: boolean;
  onDay: (day: string) => void;
  onTime: (time: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field htmlFor={`${idPrefix}-day`} label={dayLabel} error={error} required>
        <DatePicker id={`${idPrefix}-day`} locale={locale} value={day} min={minDay} disabled={disabled} onChange={onDay} />
      </Field>
      <Field htmlFor={`${idPrefix}-time`} label={timeLabel} required>
        <TimePicker id={`${idPrefix}-time`} value={time} disabled={disabled} invalid={Boolean(error)} onChange={onTime} />
      </Field>
    </div>
  );
}
