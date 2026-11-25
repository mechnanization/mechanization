'use client';

import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** One tab: what its trigger says, and the panel under it. */
export interface PageTab {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * A page of several screens, one at a time (NAV-03, NAV-04): the row of tabs
 * under the page's header, and the open tab's panel under the row.
 *
 * The open tab is the caller's (`tab`, usually `?tab=`), because a tab is an
 * address: «الجودة» opens on the one a link names. Only the open tab's panel is
 * mounted (Radix drops the others), so a closed tab asks the server for nothing.
 * What a panel keeps in the URL is its own business: a page whose panels use
 * different names leaves them alone when the tab changes (the field worklists),
 * and one whose panels share a name clears them in `onSelect` (the quality tabs).
 *
 * `locale` sets the direction, which Radix would otherwise take as left to
 * right and send ArrowLeft to the previous tab on an Arabic page.
 */
export function PageTabs({
  tab,
  onSelect,
  locale,
  label,
  tabs,
}: {
  /** The open tab's `id`. */
  tab: string;
  onSelect: (id: string) => void;
  locale: string;
  /** What the row of tabs is, for a screen reader. */
  label: string;
  tabs: readonly PageTab[];
}): React.JSX.Element {
  return (
    <Tabs value={tab} onValueChange={onSelect} dir={locale === 'en' ? 'ltr' : 'rtl'}>
      <TabsList variant="line" aria-label={label}>
        {tabs.map((entry) => (
          <TabsTrigger key={entry.id} value={entry.id}>
            {entry.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((entry) => (
        <TabsContent key={entry.id} value={entry.id} className="mt-6 space-y-6">
          {entry.panel}
        </TabsContent>
      ))}
    </Tabs>
  );
}
