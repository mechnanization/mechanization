'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * An amount with its currency in a segment of its own.
 *
 * Never laid over the number, which is what put «ل.ل» on top of the «0» in an
 * LTR field on an RTL page. The digits are LTR and tabular; the unit segment
 * sits at the field's inline start. Formatting while typing is the caller's
 * (`formatTypedAmount` in `lib/currency`), so one rule spells every amount.
 *
 * Use it inside `Field` like any input — `id` ties the label to it.
 */
export function CurrencyInput({
  id,
  unit,
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  className,
  inputClassName,
  'aria-describedby': describedBy,
}: {
  id: string;
  /** «ل.ل», «$», «€» — shown, and read as part of the field's name. */
  unit: string;
  value: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  /**
   * The digits themselves — for the one screen where the figure *is* the task.
   *
   * The cash counter sets the received amount in `text-xl font-bold`, because a
   * clerk reads it back to the person paying before pressing the button. Every
   * other field leaves this alone and takes the field size the kit gives it.
   */
  inputClassName?: string;
  'aria-describedby'?: string;
}) {
  const unitId = `${id}-unit`;
  return (
    <div
      className={cn(
        'flex h-10 overflow-hidden rounded-md border border-input bg-background coarse:h-12',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
        invalid && 'border-destructive',
        disabled && 'opacity-50',
        className,
      )}
    >
      <span
        id={unitId}
        className="flex min-w-12 shrink-0 items-center justify-center border-e bg-muted px-3 text-sm font-medium text-muted-foreground"
      >
        {unit}
      </span>
      <Input
        id={id}
        inputMode="decimal"
        dir="ltr"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        invalid={invalid}
        aria-describedby={[unitId, describedBy].filter(Boolean).join(' ')}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-full flex-1 rounded-none border-0 bg-transparent tabular-nums shadow-none focus-visible:ring-0 focus-visible:ring-offset-0',
          inputClassName,
        )}
      />
    </div>
  );
}
