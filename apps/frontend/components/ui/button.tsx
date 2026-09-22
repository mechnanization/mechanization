import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform so the two systems' buttons are the same
 * button — same variants, same sizes, same `asChild` escape hatch.
 *
 * `xl` is what the citizen wizard uses: 80px tall, because the primary action on
 * a government form should be unmissable to someone holding a phone at arm's
 * length.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      /**
       * Every size carries a `coarse:` floor of 48px (`h-12`).
       *
       * Staff work these screens on phones and tablets in the field, where 40px
       * is a miss waiting to happen — and the smaller sizes below were well
       * under even that. On a coarse pointer the distinction between `default`,
       * `sm` and the two icon sizes deliberately collapses: they are all one
       * fingertip, and a toolbar button being visually smaller than a primary
       * one is a desk affordance, not a field one. With a mouse, every size
       * keeps its dense desktop height.
       */
      size: {
        default: 'h-10 coarse:h-12 px-4 py-2',
        sm: 'h-9 coarse:h-12 rounded-md px-3',
        lg: 'h-14 rounded-lg px-8 text-lg',
        xl: 'h-20 rounded-xl px-8 text-xl',
        icon: 'h-10 w-10 coarse:h-12 coarse:w-12',
        /** Icon-only control inside a table row, where `icon`'s 40px is
         *  taller than the row's own text line. Rows get taller on a tablet,
         *  which is the correct trade when the row is being tapped. */
        'icon-sm': 'h-8 w-8 coarse:h-12 coarse:w-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        // Defaulting to "button": these live inside a multi-step wizard, where a
        // stray submit type turns "next" into "file the incomplete form". Only
        // applied to a real <button> — `asChild` may render an anchor, which has
        // no `type`.
        {...(asChild ? {} : { type: type ?? 'button' })}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
