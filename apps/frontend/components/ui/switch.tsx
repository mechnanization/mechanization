'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A setting that is on or off, and takes effect as it is switched.
 *
 * ## Why this is not a checkbox
 *
 * The app had no switch at all — a census of it found no `role="switch"`
 * anywhere — so every on/off setting was a `Checkbox`, and the two mean
 * different things. A checkbox is an answer on a form that is still being
 * filled in: it commits when the form does, and unticking it before saving
 * costs nothing. A switch is a state that changes when you touch it. Rendering
 * the second as the first tells an officer their tap is provisional when it is
 * not, which is the wrong way round for anything worth switching.
 *
 * So: use `Checkbox` inside a form, and this for a setting that applies on the
 * spot.
 *
 * ## The target
 *
 * 44×24 of track with a 48px tap area around it on a coarse pointer, matching
 * the floor every control in this app keeps. These are worked with a thumb on
 * a phone in the field, where the standard 20px switch is a miss waiting to
 * happen.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  description,
  id,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * The setting's name, rendered beside the track and wired to it. Without one
   * the switch is bare, and the caller owns naming it (`aria-labelledby` on a
   * wrapper, or a visible heading).
   */
  label?: React.ReactNode;
  /** What the setting does — the line under the name, not a restatement of it. */
  description?: React.ReactNode;
  id?: string;
  className?: string;
}): React.JSX.Element {
  const generated = React.useId();
  const controlId = id ?? generated;
  const describedBy = description ? `${controlId}-description` : undefined;

  const control = (
    <button
      type="button"
      id={controlId}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      {/*
        `ltr` on the thumb's travel, deliberately. The track is a physical
        object, not a line of text: a switch whose thumb slides to the left
        when it is turned on reads as "off" to anyone who has used a switch,
        Arabic interface or not.
      */}
      <span
        aria-hidden
        dir="ltr"
        className={cn(
          'pointer-events-none block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );

  if (!label && !description) return <span className={className}>{control}</span>;

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0 space-y-0.5">
        {label ? (
          <label htmlFor={controlId} className="block text-sm font-medium leading-tight">
            {label}
          </label>
        ) : null}
        {description ? (
          <p id={describedBy} className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {/* A thumb-sized target around a 24px track, without a 48px-tall row. */}
      <span className="flex size-11 shrink-0 items-center justify-center coarse:size-12">
        {control}
      </span>
    </div>
  );
}
