'use client';

import * as React from 'react';
import { Calendar as CalendarIcon, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

/**
 * Shadcn-styled date picker replacing native `<input type="date">`:
 * an outline-button trigger opening an anchored calendar panel. Fully
 * localized (month/weekday names via Intl, RTL-aware navigation) and
 * dependency-free — the panel is a hand-rolled month grid, closed on
 * outside click or Escape, matching the codebase's manual-overlay
 * patterns. Values travel as "YYYY-MM-DD" exactly like the native input.
 */

interface JumpOption {
  value: number;
  label: string;
}

/**
 * Jump-to-month / jump-to-year control used in the calendar header.
 * Deliberately NOT the shared `Select` (Radix, portal-rendered) — its
 * dropdown would render outside this popover's own root element and get
 * mistaken for an "outside click" by the calendar's close handler. This
 * stays an in-tree absolutely-positioned panel, styled to match Select,
 * so it never leaves the calendar's own DOM subtree.
 */
function JumpDropdown({
  value,
  options,
  onChange,
  className,
  panelClassName,
}: {
  value: number;
  options: readonly JumpOption[];
  onChange: (value: number) => void;
  className?: string;
  panelClassName?: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const selectedItemRef = React.useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value);

  React.useEffect(() => {
    if (!open) return;
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-foreground transition-colors hover:border-input hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
          open && 'border-input bg-accent',
          className,
        )}
      >
        {current?.label}
        <ChevronDown className={cn('h-3.5 w-3.5 opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          role="listbox"
          className={cn(
            'absolute start-0 top-full z-50 mt-1 max-h-52 w-32 overflow-y-auto rounded-lg border bg-card p-1 shadow-lg',
            panelClassName,
          )}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                ref={selected ? selectedItemRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                  selected && 'bg-primary/10 font-semibold text-primary',
                )}
              >
                {option.label}
                {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface DatePickerProps {
  id?: string;
  /** "YYYY-MM-DD" or empty string for no selection. */
  value: string;
  onChange: (value: string) => void;
  /** Latest selectable day, "YYYY-MM-DD" (inclusive). */
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  locale: 'ar' | 'en';
}

/** Formats a local calendar date as "YYYY-MM-DD" without UTC drift. */
function toIsoDay(year: number, monthIndex: number, day: number): string {
  const mm = String(monthIndex + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function parseIsoDay(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
}

export function DatePicker({
  id,
  value,
  onChange,
  max,
  placeholder,
  disabled = false,
  locale,
}: DatePickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // `-u-nu-latn` so the day numbers in the grid are Latin, matching the amount
  // and reference fields these calendars sit beside. See `lib/dates.ts`.
  const intlLocale = locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB';
  const selected = parseIsoDay(value);

  // The month shown in the grid — follows the selection, else today.
  const today = new Date();
  const [viewYear, setViewYear] = React.useState(
    selected?.year ?? today.getFullYear(),
  );
  const [viewMonth, setViewMonth] = React.useState(
    selected?.month ?? today.getMonth(),
  );

  // Re-anchor the grid whenever the picker opens on a (new) selection.
  React.useEffect(() => {
    if (!open) return;
    const anchor = parseIsoDay(value);
    setViewYear(anchor?.year ?? today.getFullYear());
    setViewMonth(anchor?.month ?? today.getMonth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside click / Escape close the panel.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const displayFormatter = new Intl.DateTimeFormat(intlLocale, {
    dateStyle: 'medium',
  });
  const monthNameFormatter = new Intl.DateTimeFormat(intlLocale, {
    month: 'long',
  });
  const weekdayFormatter = new Intl.DateTimeFormat(intlLocale, {
    weekday: 'narrow',
  });

  // Localized month names for the jump-to-month dropdown — a fixed
  // reference year, since month names don't vary by year.
  const monthOptions: JumpOption[] = Array.from({ length: 12 }, (_, index) => ({
    value: index,
    label: monthNameFormatter.format(new Date(2024, index, 1)),
  }));
  // Jump-to-year dropdown: a 100-year window ending at `max`'s year (or
  // this year, if no max was given), newest first.
  const maxYear = max ? (parseIsoDay(max)?.year ?? today.getFullYear()) : today.getFullYear();
  const minYear = maxYear - 100;
  const yearOptions: JumpOption[] = Array.from(
    { length: maxYear - minYear + 1 },
    (_, index) => ({ value: maxYear - index, label: String(maxYear - index) }),
  );

  // Monday-first week, mirrored automatically by the RTL grid direction.
  const WEEK_START = 1;
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    // 2024-01-01 was a Monday — a stable anchor for weekday names.
    weekdayFormatter.format(new Date(2024, 0, 1 + ((WEEK_START - 1 + index) % 7))),
  );

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  /** Blank cells before day 1 (0 = week starts on that day). */
  const leadingBlanks = (firstOfMonth.getDay() - WEEK_START + 7) % 7;

  const isDisabledDay = (day: number): boolean => {
    if (!max) return false;
    return toIsoDay(viewYear, viewMonth, day) > max;
  };

  const isSelectedDay = (day: number): boolean =>
    selected !== null &&
    selected.year === viewYear &&
    selected.month === viewMonth &&
    selected.day === day;

  const isToday = (day: number): boolean =>
    today.getFullYear() === viewYear &&
    today.getMonth() === viewMonth &&
    today.getDate() === day;

  const shiftMonth = (delta: number): void => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const pick = (day: number): void => {
    onChange(toIsoDay(viewYear, viewMonth, day));
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        id={id}
        type="button"
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'w-full justify-start text-start font-normal',
          !value && 'text-muted-foreground',
        )}
      >
        <CalendarIcon className="h-4 w-4" />
        {selected
          ? displayFormatter.format(
              new Date(selected.year, selected.month, selected.day),
            )
          : (placeholder ?? '')}
      </Button>

      {open ? (
        <div
          role="dialog"
          className="absolute z-50 mt-2 w-[300px] rounded-lg border bg-card p-3 shadow-lg"
        >
          {/* Month header — arrows step by one month; the two dropdowns jump straight to any month/year. */}
          <div className="mb-2 flex items-center justify-between gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Button>
            <div className="flex items-center gap-1">
              <JumpDropdown
                value={viewMonth}
                options={monthOptions}
                onChange={setViewMonth}
                panelClassName="w-36"
              />
              <JumpDropdown
                value={viewYear}
                options={yearOptions}
                onChange={setViewYear}
                className="tabular-nums"
                panelClassName="w-24"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 text-center">
            {weekdayLabels.map((label, index) => (
              <span
                key={`${label}-${index}`}
                className="py-1 text-xs font-medium text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {Array.from({ length: leadingBlanks }, (_, index) => (
              <span key={`blank-${index}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const dayDisabled = isDisabledDay(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={dayDisabled}
                  aria-pressed={isSelectedDay(day)}
                  onClick={() => pick(day)}
                  className={cn(
                    'mx-auto flex h-8 w-8 coarse:h-12 coarse:w-12 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                    isSelectedDay(day)
                      ? 'bg-primary font-semibold text-primary-foreground'
                      : dayDisabled
                        ? 'text-muted-foreground/40'
                        : 'hover:bg-accent hover:text-accent-foreground',
                    isToday(day) && !isSelectedDay(day) && 'border border-primary/50',
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
