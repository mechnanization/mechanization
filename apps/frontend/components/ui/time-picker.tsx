'use client';

import * as React from 'react';
import { Input } from './input';
import { completeTime, normalizeTime, stepTime, typedTime } from '@/lib/time-input';

/**
 * A time of day, `"HH:MM"` on the 24-hour clock (CTL-2, decision U-8).
 *
 * The native `<input type="time">` this replaces drew a 12-hour clock with
 * «ص»/«م» on some systems and the digits of the system's language on others, so
 * the same field looked different on the clerk's desk and on their phone. This
 * is one field everywhere: Latin digits, a colon put in as you type («930» is
 * 09:30), ArrowUp and ArrowDown stepping by `step` minutes (Shift: an hour,
 * wrapping past midnight), and the digits an Arabic keyboard types accepted.
 * The rules are in `lib/time-input.ts`.
 *
 * A typed field and not a popover: a time is four digits, and a list of
 * twenty-four hours and a list of minutes is more to scroll than to type. It
 * says what it holds through `onChange` only when that is a complete time, and
 * `''` otherwise (nothing, or half a time), which is what the native input said
 * too, so a caller's «required» check is unchanged. What is left of an unfinished
 * time is tidied when the field is left («9» becomes 09:00), and one that is not
 * a time (25:00) stays as typed, marked invalid, for its owner to see and fix.
 *
 * Never mirrored: a time reads left to right in Arabic as well (RTL-1's list of
 * what does not flip), so the field is `dir="ltr"`, as the native one was.
 */
export interface TimePickerProps {
  id?: string;
  /** `"HH:MM"`, or `''` for none. */
  value: string;
  /** A complete `"HH:MM"`, or `''` while there is none. */
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The caller's own verdict (a missing or past time), drawn as the kit's invalid look. */
  invalid?: boolean;
  /** Minutes an arrow moves by; 60 or less, and a divisor of 60 reads best. Default 5. */
  step?: number;
  /** What the first arrow press gives an empty field. Default 09:00. */
  startAt?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export const TimePicker = React.forwardRef<HTMLInputElement, TimePickerProps>(function TimePicker(
  { id, value, onChange, disabled, invalid, step = 5, startAt = '09:00', className, ...aria },
  ref,
) {
  const [draft, setDraft] = React.useState(value);
  /** The field was left holding something that is not a time. */
  const [unfinished, setUnfinished] = React.useState(false);

  // A value that arrives from outside (a form reset, an edit opened) replaces the draft, but the
  // owner's own echo of what was typed must not: `''` for half a time would erase it mid-keystroke.
  React.useEffect(() => {
    setDraft((current) => ((completeTime(current) ?? '') === value ? current : value));
  }, [value]);

  const emit = (text: string): void => {
    onChange(completeTime(text) ?? '');
  };

  return (
    <Input
      ref={ref}
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      dir="ltr"
      placeholder="HH:MM"
      maxLength={5}
      value={draft}
      disabled={disabled}
      invalid={invalid || unfinished}
      className={className}
      onChange={(event) => {
        const text = typedTime(event.target.value);
        setDraft(text);
        setUnfinished(false);
        emit(text);
      }}
      onBlur={() => {
        if (draft === '') return;
        const tidy = normalizeTime(draft);
        if (tidy === null) {
          setUnfinished(true);
          return;
        }
        setDraft(tidy);
        emit(tidy);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const next = stepTime(
          normalizeTime(draft),
          event.key === 'ArrowUp' ? 1 : -1,
          event.shiftKey ? 60 : step,
          startAt,
        );
        setDraft(next);
        setUnfinished(false);
        emit(next);
      }}
      {...aria}
    />
  );
});
