'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform's shadcn/ui checkbox, with a tap target
 * that is bigger than the box it draws.
 *
 * The control is 24px because that is the right *visual* weight beside a line
 * of text — a 48px square would read as a button. But 24px is half a fingertip,
 * and staff tick these on tablets in the field. So on a coarse pointer an
 * invisible `::before` extends the hit area 12px past every edge, which lands
 * exactly on 48px while the drawn box does not move.
 *
 * The pseudo-element belongs to the Radix root (a `<button>`), so it is part of
 * the control's own hit area — no wrapper, no extra element in the tree, and
 * nothing to keep in sync. It is coarse-only so that dense desktop forms do not
 * grow invisible 48px pads that swallow clicks meant for a neighbour.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer relative h-6 w-6 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground coarse:before:absolute coarse:before:-inset-3 coarse:before:content-['']",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('flex items-center justify-center text-current')}
    >
      <Check className="h-5 w-5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
