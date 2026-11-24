'use client';

import type { STEPS } from './constants';
import {
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The step rail: a circle per step, each reachable once the one before it is valid, and the phone's «الخطوة N من M» line.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function StepRail({
  visibleSteps,
  step,
  editing,
  goToStep,
  en,
}: {
  visibleSteps: readonly (typeof STEPS)[number][];
  step: 0 | 2 | 1;
  editing: boolean;
  goToStep: (next: 0 | 1 | 2) => void;
  en: boolean;
}): React.JSX.Element {
  return (
    <>
      {/* ── Step Indicator ── */}
      <ol className="flex items-center justify-center gap-2 sm:gap-4 max-w-sm sm:max-w-none mx-auto w-full px-1 sm:px-0">
        {visibleSteps.map((item, index) => {
          const Icon = item.icon;
          const state = index < step ? 'done' : index === step ? 'current' : 'upcoming';
          /*
            A creation unlocks its steps in order — there is nothing to see on
            the matrix of a building whose parcel has not been typed yet. A
            correction has every answer already, so all three are reachable and
            an officer opening «تعديل» to fix the floor count is one tap away
            from it rather than three.
          */
          const reachable = editing || index < step;
          return (
            <li
              key={item.en}
              className={cn(
                'flex items-center gap-2 sm:gap-3',
                index < visibleSteps.length - 1 ? 'flex-1' : 'flex-none',
              )}
            >
              <button
                type="button"
                onClick={() => reachable && goToStep(index as 0 | 1 | 2)}
                disabled={!reachable}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors sm:size-9',
                  state === 'done' && 'border-primary bg-primary text-primary-foreground cursor-pointer',
                  state === 'current' && 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30',
                  state === 'upcoming' && 'border-border bg-muted/40 text-muted-foreground',
                  state === 'upcoming' && reachable && 'cursor-pointer hover:bg-muted',
                )}
              >
                {state === 'done' ? <Check className="size-4" /> : <Icon className="size-4" />}
              </button>
              <span
                className={cn(
                  'hidden text-xs font-medium sm:inline',
                  state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {en ? item.en : item.ar}
              </span>
              {index < visibleSteps.length - 1 ? (
                <div className={cn('h-px flex-1', index < step ? 'bg-primary' : 'bg-border')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Mobile Current Step Bar */}
      <div className="sm:hidden flex items-center justify-between text-xs px-2 text-muted-foreground max-w-sm mx-auto w-full">
        <span className="font-semibold text-foreground">
          {en ? `Step ${step + 1}: ${visibleSteps[step]?.en}` : `الخطوة ${step + 1}: ${visibleSteps[step]?.ar}`}
        </span>
        <span className="font-mono text-muted-foreground">
          {step + 1} / {visibleSteps.length}
        </span>
      </div>
    </>
  );
}
