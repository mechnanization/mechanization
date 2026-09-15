import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform, with one deviation: an `invalid` prop
 * instead of callers hand-rolling a red border. A wrong رقم العقار is the
 * single most common error in this form, and it needs to look the same
 * everywhere it appears. The base classes are the reference's verbatim —
 * `invalid` only ever adds to them.
 *
 * Dropdowns live in ./select (the reference platform's Radix select). There was
 * a second, native `<select>` here styled to Input's h-12 box; it was the one
 * control in this codebase that did not match the reference, so it is gone.
 */
export interface InputProps extends React.ComponentProps<'input'> {
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        // 16px on a phone, 14px from `sm` up. Safari zooms the whole page in
        // whenever a focused field is under 16px, and it does not zoom back
        // out — so every tap into a field on the registration form left the
        // clerk pinching the page back to size. The desktop density is
        // unchanged.
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        invalid && 'border-destructive focus-visible:ring-destructive',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
