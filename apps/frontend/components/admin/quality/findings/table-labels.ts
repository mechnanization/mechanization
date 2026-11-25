import type { DataTableLabels } from '@/components/ui/data-table';

export function tableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search findings',
      searchPlaceholder: 'Search by record, reference number or officer…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'Nothing to look at.',
      emptyHint:
        'No duplicate records, copied numbers or contradictions were found in the register.',
      emptySearch: 'No finding matches your search.',
      emptySearchHint: 'Try the record’s name, its reference number, or the officer who filed it.',
      loadError: 'Failed to load the findings.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} findings',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      sortNone: 'Clear sorting',
      columns: 'Columns',
      columnsHint: 'Visible columns',
      resetColumns: 'Reset to default',
      filters: 'Filters',
      clearFilters: 'Clear filters',
    };
  }
  return {
    searchAriaLabel: 'بحث في الملاحظات',
    searchPlaceholder: 'ابحث باسم السجل أو رقمه المرجعي أو الموظف…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا ملاحظات.',
    emptyHint: 'لم يُعثر على سجلات مكرَّرة أو أرقام منقولة أو تناقضات في السجل.',
    emptySearch: 'لا ملاحظة مطابقة لبحثك.',
    emptySearchHint: 'جرّب اسم السجل أو رقمه المرجعي أو اسم الموظف الذي سجَّله.',
    loadError: 'تعذّر تحميل ملاحظات الجودة.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'صفوف في الصفحة',
    totalRows: '{count} ملاحظة',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'إعادة الافتراضي',
    filters: 'الفلاتر',
    clearFilters: 'مسح الفلاتر',
  };
}
