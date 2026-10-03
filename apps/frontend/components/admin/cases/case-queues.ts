import type { CaseType } from '@mechanization/shared-schemas';
import { param } from '@/lib/use-url-state';

/**
 * The four tabs, as groups of `CaseType` rather than one type each.
 *
 * The tab an officer wants is not "cases of type X", it is "cases I do the same
 * thing about". A locked door and a flat somebody thinks is empty are both
 * *go back and knock*; a refusal and an ownership dispute both need a person
 * with authority rather than another visit. Grouping them is what makes the
 * tabs a work queue instead of a second copy of the enum.
 *
 * `null` on the first tab is "no filter", not "no type" — every case is in it.
 */
export const CASE_TABS: ReadonlyArray<{
  id: string;
  ar: string;
  en: string;
  types: readonly CaseType[] | null;
}> = [
  { id: 'all', ar: 'الكل', en: 'All', types: null },
  {
    id: 'revisit',
    ar: 'إعادة زيارة',
    en: 'Revisit',
    types: ['UNIT_UNREACHABLE', 'VACANT_UNCONFIRMED'],
  },
  {
    id: 'disputes',
    ar: 'رفض ونزاعات',
    en: 'Refusals & disputes',
    types: ['ACCESS_REFUSED', 'OWNERSHIP_DISPUTE'],
  },
  { id: 'notes', ar: 'ملاحظات', en: 'Notes', types: ['GENERAL_NOTE'] },
];

/**
 * The queue, the census filters and an open matrix, all in the query string so
 * a reload — or a dispatch list sent to a colleague — comes back the same.
 *
 * Every value is structural: a sector, building or unit id, a parcel number, a
 * building code, a date. The table's own search box takes notes and
 * neighbourhoods, so it is kept in tab storage instead (`useTabSearch`).
 * `matrix` / `matrixUnit` reopen a drawer that only reads on open; the unit
 * actions inside it are its own state and never come back from a URL.
 */
export const CASE_FILTERS = {
  tab: param.oneOf(
    CASE_TABS.map((entry) => entry.id),
    'all',
  ),
  zone: param.id(),
  parcel: param.string(),
  building: param.string(),
  from: param.date(),
  to: param.date(),
  matrix: param.id(),
  matrixUnit: param.id(),
};

/** How long a typed parcel number or building code waits before it is written to the URL. */
export const TYPED_FILTER_DELAY_MS = 300;
