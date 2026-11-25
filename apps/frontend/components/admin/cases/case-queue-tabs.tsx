'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CASE_TABS } from './case-queues';

/**
 * The queues, as tabs over the one table under them. Each groups the
 * case types an officer does the same thing about — knock again,
 * escalate, or just read — and its count rides on it, so an empty
 * queue shows before it is opened.
 *
 * `children` is the panel: the one table, which every tab shows cut by its own
 * filter. It sits in a `TabsContent` for the open tab, so the triggers point at
 * something and a screen reader hears «tab panel» (UX-08).
 */
export function CaseQueueTabs({
  locale,
  tab,
  counts,
  onSelect,
  children,
}: {
  locale: string;
  /** The open tab's `CASE_TABS` id. */
  tab: string;
  /** How many cases each tab holds, by tab id. */
  counts: Record<string, number>;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const en = locale === 'en';
  const t = useTranslations('cases.queues');
  return (
    <Tabs value={tab} onValueChange={onSelect} dir={en ? 'ltr' : 'rtl'}>
      <TabsList variant="line" aria-label={t('label')}>
        {CASE_TABS.map((entry) => (
          <TabsTrigger key={entry.id} value={entry.id}>
            {t(entry.id)}
            <TabsCount>{counts[entry.id] ?? 0}</TabsCount>
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={tab}>{children}</TabsContent>
    </Tabs>
  );
}
