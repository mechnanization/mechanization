'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  description?: string;
}

export interface SegmentedControlProps {
  value?: string;
  onChange: (value: string) => void;
  options: readonly SegmentedOption[] | SegmentedOption[];
  className?: string;
  size?: 'sm' | 'default' | 'lg';
  fullWidth?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  'aria-label'?: string;
}

export function SegmentedControl({
  value,
  onChange,
  options,
  className,
  size = 'default',
  fullWidth = true,
  disabled = false,
  invalid = false,
  'aria-label': ariaLabel,
}: SegmentedControlProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center rounded-lg border bg-muted/30 p-1 text-muted-foreground select-none',
        invalid && 'border-destructive/60 bg-destructive/5 ring-1 ring-destructive/30',
        fullWidth && 'w-full',
        className,
      )}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              /*
                `min-w-0` is what makes `truncate` below work at all. A flex
                item's `min-width` is `auto`, so a button refuses to shrink
                past its icon, padding and full label — four segments of
                «ملاحظات الجودة» length then push the page itself sideways on a
                390px screen, which is the width of the phones this is used on.
              */
              fullWidth ? 'min-w-0 flex-1' : 'shrink-0',
              size === 'sm' && 'min-h-[34px] px-2.5 py-1 text-xs',
              size === 'default' && 'min-h-[40px] px-3 py-1.5 text-xs sm:text-sm',
              size === 'lg' && 'min-h-[46px] px-4 py-2 text-sm',
              isSelected
                ? 'bg-primary text-primary-foreground shadow-xs font-semibold'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {Icon ? (
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
                aria-hidden
              />
            ) : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Chip-style selectable pills for lists of 3+ options (e.g. resident status, blood type).
 */
export function ChipGroup({
  value,
  onChange,
  options,
  className,
  size = 'default',
  invalid = false,
  'aria-label': ariaLabel,
}: {
  value?: string;
  onChange: (value: string) => void;
  options: readonly SegmentedOption[] | SegmentedOption[];
  className?: string;
  size?: 'sm' | 'default';
  invalid?: boolean;
  'aria-label'?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-all select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              size === 'sm' && 'min-h-[34px] px-3 py-1 text-xs',
              size === 'default' && 'min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm',
              isSelected
                ? 'border-primary bg-primary text-primary-foreground font-semibold shadow-xs'
                : 'border-border/80 bg-card text-foreground/80 hover:border-border hover:bg-muted/50',
              invalid && !isSelected && 'border-destructive/40',
            )}
          >
            {Icon ? (
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
                aria-hidden
              />
            ) : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
