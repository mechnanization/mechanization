'use client';

import { useTranslations } from 'next-intl';
import { useTableLabels } from '@/lib/use-table-labels';
import type { DataTableLabels } from '@/components/ui/data-table';

/** The queue's table in its own words: what it is empty of, what it is searched by, and its filter drawer. */
export function useFindingTableLabels(): DataTableLabels {
  const t = useTranslations('qualityFindings.table');
  return useTableLabels(
    {
      searchAriaLabel: t('search'),
      searchPlaceholder: t('searchPlaceholder'),
      // Templates the table fills itself: read as written.
      searchApplied: t.raw('searchApplied') as string,
      totalRows: t.raw('totalRows') as string,
      empty: t('empty'),
      emptyHint: t('emptyHint'),
      emptySearch: t('emptySearch'),
      emptySearchHint: t('emptySearchHint'),
      loadError: t('loadError'),
      rowsPerPage: t('rowsPerPage'),
      resetColumns: t('resetColumns'),
      filters: t('filters'),
      clearFilters: t('clearFilters'),
    },
    { columnsMenu: true },
  );
}
