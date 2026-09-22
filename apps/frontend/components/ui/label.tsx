'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform's shadcn/ui label, stepped down to the
 * sibling Solar system's `text-sm` from the `sm` breakpoint up.
 *
 * A 16px label above a 14px field inverts the hierarchy — the name of the thing
 * outweighs the thing itself, and on a dense admin form that reads as a wall of
 * bold. The phone keeps 16px, matching the field it labels.
 */
const labelVariants = cva(
  'text-base sm:text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
