'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

/**
 * Tabs: one of several panels shown at a time, picked from a row of triggers
 * (CTL-9, UX-08).
 *
 * Radix gives the semantics a hand-rolled `role="tablist"` row had to remember:
 * the triggers are `role="tab"` with `aria-selected`, each `aria-controls` its
 * panel, the panel is `aria-labelledby` its trigger, and the arrow keys, Home and
 * End move between triggers (A11Y-3). Two looks, because the two screens that
 * built their own wanted different ones:
 *
 *  - `line` — an underline under the open tab, on a bar that scrolls sideways
 *    on a phone. The case queues.
 *  - `pill` — a bordered segment with the open tab filled. A state filter.
 *
 * A panel is `TabsContent`. A screen whose tabs all show the *same* table, cut by
 * a filter, still renders one `TabsContent value={tab}` around it: the open tab's
 * panel is then the table, and the triggers have something to point at.
 *
 * Radix reads the direction from a `dir` prop or a `DirectionProvider`, and
 * defaults to left-to-right, which would send ArrowLeft to the previous tab on an
 * Arabic page: pass `dir` from the page's locale. Every string is the caller's
 * (KIT-6); nothing here is translated.
 */
type TabsVariant = 'line' | 'pill';

const VariantContext = React.createContext<TabsVariant>('line');

const Tabs = TabsPrimitive.Root;

const LIST: Record<TabsVariant, string> = {
  line: 'flex gap-1 overflow-x-auto border-b px-2 sm:px-4',
  pill: 'inline-flex rounded-lg border p-0.5',
};

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = 'line', ...props }, ref) => (
  <VariantContext.Provider value={variant}>
    <TabsPrimitive.List ref={ref} className={cn(LIST[variant], className)} {...props} />
  </VariantContext.Provider>
));
TabsList.displayName = 'TabsList';

const TRIGGER: Record<TabsVariant, string> = {
  line: cn(
    'relative flex min-h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-sm font-medium transition-colors duration-150 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
    'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:duration-150',
    'data-[state=active]:text-primary data-[state=active]:after:bg-primary',
    'data-[state=inactive]:text-muted-foreground data-[state=inactive]:after:bg-transparent data-[state=inactive]:hover:bg-accent/50 data-[state=inactive]:hover:text-foreground',
  ),
  pill: cn(
    'flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground',
    'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-accent',
  ),
};

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(VariantContext);
  return <TabsPrimitive.Trigger ref={ref} className={cn('group', TRIGGER[variant], className)} {...props} />;
});
TabsTrigger.displayName = 'TabsTrigger';

const COUNT: Record<TabsVariant, string> = {
  line: cn(
    'min-w-6 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
    'group-data-[state=active]:bg-primary/15 group-data-[state=active]:text-primary',
    'group-data-[state=inactive]:bg-muted group-data-[state=inactive]:text-muted-foreground',
  ),
  pill: cn(
    'tabular-nums',
    'group-data-[state=active]:opacity-90 group-data-[state=inactive]:text-muted-foreground',
  ),
};

/** The number that rides on a trigger, restyled by whether its tab is the open one. */
function TabsCount({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  const variant = React.useContext(VariantContext);
  return <span className={cn(COUNT[variant], className)} {...props} />;
}

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsCount, TabsContent };
