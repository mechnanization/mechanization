'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The three settings, in the order they are offered.
 *
 * «النظام» sits last rather than first even though it is the default: the two
 * explicit choices are what someone opening this control is reaching for, and
 * "follow the device" reads as the escape hatch back to not having decided.
 */
const OPTIONS = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

type ThemeValue = (typeof OPTIONS)[number]['value'];

/**
 * Light / داكن / النظام, as a segmented control.
 *
 * A three-option dropdown would hide two thirds of its own state behind a
 * click — and the question this answers ("which mode am I in, and is it
 * following the device?") is exactly the part a closed menu does not show.
 * Three segments answer it without being opened, and cost no extra dependency:
 * there is no `DropdownMenu` in this design system, and adding Radix's for one
 * control of three items would be the larger change.
 *
 * `collapsed` renders the icon-rail form instead — one button that cycles —
 * because the folded sidebar is 72px wide and a segmented control is not.
 */
export function ThemeToggle({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const t = useTranslations('themeToggle');
  /** A setting's name in the page's language: «Light», «فاتح». */
  const nameOf = (value: ThemeValue): string => t(value);

  /**
   * Nothing theme-dependent renders until after hydration.
   *
   * The server has no way to know the visitor's stored choice, so any markup
   * derived from `theme` differs between the HTML and the first client render
   * — React's definition of a hydration mismatch. The placeholders below hold
   * the exact final size, so this costs a frame of blank control rather than
   * the layout shift the usual `return null` causes.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (collapsed) {
    // Cycles rather than jumping straight to the opposite: with three settings
    // there is no "the other one", and a folded rail has no room to say which
    // of the three you would land on.
    const order: ThemeValue[] = ['light', 'dark', 'system'];
    const current = (theme ?? 'system') as ThemeValue;
    const next = order[(order.indexOf(current) + 1) % order.length];
    const active = OPTIONS.find((option) => option.value === current) ?? OPTIONS[2];
    const Icon = active.icon;

    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        disabled={!mounted}
        title={mounted ? t('cycleTitle', { mode: nameOf(active.value) }) : t('theme')}
        className={cn(
          'flex w-full items-center justify-center rounded-lg px-0 py-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
          className,
        )}
      >
        {mounted ? <Icon className="size-5 shrink-0" aria-hidden /> : <span className="size-5" />}
        <span className="sr-only">
          {mounted ? t('cycle', { mode: nameOf(active.value) }) : t('theme')}
        </span>
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('group')}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5',
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = mounted && (theme ?? 'system') === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            disabled={!mounted}
            aria-pressed={selected}
            // Spelled out because the icon alone is ambiguous for «النظام»,
            // and because the resolved mode is the part a screen reader user
            // cannot infer from a sun glyph at all.
            title={
              option.value === 'system' && mounted && resolvedTheme
                ? t('systemResolved', { mode: nameOf(resolvedTheme === 'dark' ? 'dark' : 'light') })
                : nameOf(option.value)
            }
            className={cn(
              'flex flex-1 items-center justify-center rounded-md px-2.5 py-1.5 transition-colors',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="sr-only">{nameOf(option.value)}</span>
          </button>
        );
      })}
    </div>
  );
}
