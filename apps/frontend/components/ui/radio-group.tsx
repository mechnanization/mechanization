'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One question, a handful of answers, and no default.
 *
 * ## What it unifies
 *
 * Four places wrote the same fieldset by hand: «ما حال الوحدة الآن؟», the two
 * landlord-match prompts and `ChoiceCard`'s own group. Each had its own
 * rounded card, its own selected treatment, and its own way of saying why an
 * option could not be taken — one greyed it with an explanation, one hid it,
 * one left it live and let the server refuse.
 *
 * ## An option that cannot be taken is shown, not hidden
 *
 * That is the rule this component carries, because it is the one that was
 * decided the hard way: an officer who sees no way to record what they came to
 * record reaches for the nearest option that *is* live, and the nearest option
 * is usually the destructive one. `disabledReason` greys the option and puts
 * the reason where the description goes, so the answer is "not you" rather
 * than "not possible".
 *
 * ## No default selection
 *
 * `value` may be null and nothing is pre-selected, on purpose: a pre-selected
 * answer is exactly what muscle memory confirms without reading. Callers that
 * genuinely have a default pass it.
 */
export interface RadioOption<Value extends string = string> {
  value: Value;
  title: React.ReactNode;
  /** What this answer means or does — not a restatement of the title. */
  description?: React.ReactNode;
  /** Why it cannot be chosen. Greys the option and replaces the description. */
  disabledReason?: React.ReactNode;
}

export function RadioGroup<Value extends string>({
  name,
  legend,
  required = false,
  options,
  value,
  onChange,
  columns = 1,
  className,
}: {
  /** Groups the inputs; also the `id` stem, so keep it unique on the page. */
  name: string;
  /** The question. Rendered as the fieldset's legend, so it is announced with each option. */
  legend?: React.ReactNode;
  required?: boolean;
  options: readonly RadioOption<Value>[];
  value: Value | null;
  onChange: (next: Value) => void;
  /** How the cards lay out from `sm` up. One column on a phone either way. */
  columns?: 1 | 2;
  className?: string;
}): React.JSX.Element {
  return (
    <fieldset className={cn('space-y-2', className)}>
      {legend ? (
        <legend className="mb-1 text-sm font-medium">
          {legend}
          {required ? <span className="text-destructive"> *</span> : null}
        </legend>
      ) : null}

      <div className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2')}>
        {options.map((option) => {
          const selected = value === option.value;
          const off = Boolean(option.disabledReason);
          return (
            <label
              key={option.value}
              className={cn(
                // 44px floor: these are answered with a thumb at a door.
                'flex min-h-11 items-start gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors duration-150',
                off
                  ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-60'
                  : selected
                    ? 'cursor-pointer border-primary bg-primary/10'
                    : 'cursor-pointer hover:bg-accent',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={off}
                onChange={() => onChange(option.value)}
                className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
              />
              <span className="min-w-0 space-y-0.5">
                <span className={cn('block font-medium', selected && !off && 'text-primary')}>
                  {option.title}
                </span>
                {option.disabledReason ?? option.description ? (
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    {option.disabledReason ?? option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
