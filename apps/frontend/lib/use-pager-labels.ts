'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { PagerLabels } from '@/components/ui/pager';

/**
 * `Pager`'s words from `messages.pager`, in the current locale (UX-11) — the
 * pager's counterpart to `useTableLabels`, so no screen words a page footer
 * inline. `nav` is the landmark's name; a screen that pages something
 * particular («صفحات الرسوم») passes its own as the Pager's `label`.
 */
export function usePagerLabels(): PagerLabels {
  const t = useTranslations('pager');
  return useMemo(
    () => ({
      nav: t('pages'),
      previous: t('previous'),
      next: t('next'),
      position: (current, total) => t('position', { current, total }),
      range: (first, last, total) => t('range', { first, last, total }),
    }),
    [t],
  );
}
