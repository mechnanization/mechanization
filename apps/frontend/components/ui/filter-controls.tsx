'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The controls a register's filter bar is built from (DataTable `filterBar`).
 *
 * They were page-local: the buildings register had its own `FilterSelect` and
 * a hand-styled parcel box, and the cases register a native `<select>` and two
 * bare `<input>`s — the same bar drawn three ways. Here once, so a filter that
 * is set looks set the same way everywhere: the primary tint on the control
 * itself, which is what the reader scans the bar for.
 */

/** One filter select, with its own «الكل» option carrying the empty value. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  className?: string;
}) {
  /*
    Radix refuses an empty-string `SelectItem` value, because that is how it
    spells "nothing selected". So «الكل» carries a sentinel and is translated at
    the boundary — the filter state stays an empty string, which is what the
    query builder already treats as absent.
  */
  const ALL = '__all__';
  /*
    Nothing to choose between.

    The options are the values the register holds, so an empty list is a real
    statement — or the list is still loading, which is the same thing from the
    reader's side. A select that opens onto «الكل» and nothing else is a
    control that cannot change the answer.
  */
  const empty = options.length === 0;
  return (
    <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? '' : next)} disabled={empty}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          'h-9 w-full min-w-32 flex-1 gap-2 text-xs transition-colors sm:w-auto sm:flex-initial',
          value
            ? 'border-primary/60 bg-primary/5 font-medium text-primary'
            : 'border-input bg-background hover:bg-accent/50',
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A typed filter — a parcel number, a building code — with a clear button
 * once something is in it. Codes and numbers read left to right whatever the
 * page direction, so it takes `dir`.
 */
export function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  clearLabel,
  inputMode,
  dir,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  dir?: 'ltr' | 'rtl' | 'auto';
  className?: string;
}) {
  return (
    <div className={cn('relative w-full sm:w-32', className)}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir={dir}
        inputMode={inputMode}
        aria-label={label}
        placeholder={placeholder}
        className={cn(
          'h-9 w-full rounded-md border bg-background px-3 text-start text-xs ring-offset-background transition-colors placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
          value ? 'border-primary/60 bg-primary/5 pe-7 font-medium text-primary' : 'border-input hover:bg-accent/50',
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={clearLabel}
          className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
