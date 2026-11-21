'use client';

import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * A day and a time on the municipality's clock, for a News article's schedule
 * and its «featured until». Two controls rather than one: the kit's calendar
 * takes a day, and a time is typed as `HH:MM`. `scheduleInstant`
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
        <Input
          id={`${idPrefix}-time`}
          type="time"
          dir="ltr"
          value={time}
          disabled={disabled}
          invalid={Boolean(error)}
          onChange={(event) => onTime(event.target.value)}
        />
      </Field>
    </div>
  );
}
