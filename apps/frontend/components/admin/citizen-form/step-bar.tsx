import type { ReactNode } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
  The wizard's step bar (GOD-22, phase 2a): a circle per step, its label, a line
  to the next, and on a phone the open step said in words under it. Moved out of
  `citizen-form.tsx` as it was; `children` is what sits at the bottom of the
  sticky bar, the «قد يكون مسجَّلاً مسبقاً» alert.
*/

/** One step as the bar draws it: the three pages, then the unverified list with its count. */
export interface WizardStep {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** The number beside the title, or 0 for none. */
  count: number;
  /** A page holding an error says so on its circle. */
  invalid: boolean;
  go: () => void;
}

export function StepBar({
  locale,
  steps,
  current,
  children,
}: {
  locale: string;
  steps: WizardStep[];
  /** The open step: a page's position, or the last one while the unverified list is open. */
  current: number;
  children?: ReactNode;
}) {
  return (
    <nav
      aria-label={locale === 'en' ? 'Form steps' : 'خطوات النموذج'}
      className="sticky top-0 z-20 space-y-2 bg-background/95 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <ol className="flex w-full items-center gap-2 sm:gap-4">
        {steps.map((item, index) => {
          const Icon = item.icon;
          const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
          const last = index === steps.length - 1;
          return (
            <li
              key={item.id}
              className={cn('flex min-w-0 items-center gap-2 sm:gap-3', last ? 'flex-none' : 'flex-1')}
            >
              <button
                type="button"
                onClick={item.go}
                aria-current={state === 'current' ? 'step' : undefined}
                aria-label={item.title}
                className={cn(
                  'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border text-xs font-semibold transition-colors sm:size-9',
                  state === 'done' && 'border-primary bg-primary text-primary-foreground',
                  state === 'current' && 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30',
                  state === 'upcoming' && 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
                  // A page holding an error says so on its circle, whatever its state.
                  item.invalid && 'border-destructive bg-destructive/10 text-destructive ring-destructive/30',
                )}
              >
                {item.invalid ? (
                  <TriangleAlert className="size-4" />
                ) : state === 'done' ? (
                  <Check className="size-4" />
                ) : (
                  <Icon className="size-4" />
                )}
              </button>
              <button
                type="button"
                onClick={item.go}
                tabIndex={-1}
                /*
                  From `md`, and allowed to shrink: four labels beside four
                  circles do not fit a phone, and on a laptop with the
                  sidebar open the form is narrower than on a tablet — so a
                  label gives way to «…» rather than pushing the bar off the
                  edge. Below `md` the current step is named under the bar.
                */
                className={cn(
                  'hidden min-w-0 items-center gap-1.5 text-xs font-medium md:inline-flex',
                  item.invalid
                    ? 'text-destructive'
                    : state === 'upcoming'
                      ? 'text-muted-foreground'
                      : 'text-foreground',
                )}
              >
                <span className="truncate">{item.title}</span>
                {item.count ? (
                  <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-bold text-warning">
                    {item.count}
                  </span>
                ) : null}
              </button>
              {!last ? (
                <div className={cn('h-px min-w-3 flex-1', index < current ? 'bg-primary' : 'bg-border')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* On a phone the labels do not fit beside the circles: the current one is said here. */}
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground md:hidden">
        <span className="font-semibold text-foreground">
          {locale === 'en'
            ? `Step ${current + 1}: ${steps[current]?.title}`
            : `الخطوة ${current + 1}: ${steps[current]?.title}`}
          {steps[current]?.count ? ` (${steps[current]?.count})` : ''}
        </span>
        <span className="font-mono" dir="ltr">
          {current + 1} / {steps.length}
        </span>
      </div>

      {children}
    </nav>
  );
}
