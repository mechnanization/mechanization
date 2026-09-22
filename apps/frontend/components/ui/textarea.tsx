import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform's shadcn/ui textarea, with the sibling
 * Solar system's `shadow-sm` lift so a field reads as a well rather than as an
 * outlined rectangle.
 *
 * `text-base sm:text-sm` matches `Input` and exists for the same reason: Safari
 * zooms the whole page in on any focused field under 16px and does not zoom
 * back out. The desktop breakpoint takes the reference's density; the phone
 * keeps the 16px floor.
 *
 * `min-h-[120px]` is kept over the reference's 60px — the fields using this are
 * case notes and audit remarks, and a two-line box invites a two-line answer.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm shadow-sm transition-colors ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
