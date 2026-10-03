'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { DataTableLabels } from '@/components/ui/data-table';

/**
 * `DataTable`'s strings from `messages.table`, in the current locale — one
 * copy, rather than another page-local `getTableLabels` (§17 debt).
 *
 * `overrides` is for what a table says that no other table does: what it is
 * empty *of*, and what to search it by.
 */
export function useTableLabels(overrides: Partial<DataTableLabels> = {}): DataTableLabels {
  const t = useTranslations('table');
  // The overrides are literals at every call site; their text is the key.
  const key = JSON.stringify(overrides);
  return useMemo(
    () => ({
      searchAriaLabel: t('search'),
      searchPlaceholder: t('search'),
      clearSearch: t('clearSearch'),
      searchHint: 'Enter',
      empty: t('empty'),
      emptySearch: t('emptySearch'),
      loadError: t('loadError'),
      retry: t('retry'),
      previous: t('previous'),
      next: t('next'),
      pageOf: t.raw('pageOf') as string,
      rowsPerPage: t('rowsPerPage'),
      totalRows: t.raw('totalRows') as string,
      sortAscending: t('sortAsc'),
      sortDescending: t('sortDesc'),
      sortNone: t('sortNone'),
      ...overrides,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, key],
  );
}
