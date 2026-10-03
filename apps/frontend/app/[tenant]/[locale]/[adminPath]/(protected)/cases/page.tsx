'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Filter,
  Grid3x3,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  TrendingUp,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { getLabels, type CaseStatus, type CaseType } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  deleteCase,
  getCases,
  getZoneParcelIndex,
  logApiError,
  recordOccupancy,
  updateCase,
} from '@/lib/api-client';
import { caseResidents, type CaseSummary } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { formatDate } from '@/lib/dates';
import { CellTag } from '@/components/ui/cell-tag';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { FilterInput, FilterSelect } from '@/components/ui/filter-controls';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import {
  LinkCaseCitizenDialog,
  type CaseLinkPerson,
  type CaseLinkSubmission,
} from '@/components/admin/link-case-citizen-dialog';
import { cn } from '@/lib/utils';
import { BuildingUnitMatrixDrawer } from '@/components/admin/building-unit-matrix-drawer';

function getTableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search cases',
      searchPlaceholder: 'Search by property number, neighborhood, or notes…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'No cases logged yet.',
      emptySearch: 'No results match your search.',
      loadError: 'Failed to load cases.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} cases',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      sortNone: 'Clear sorting',
      columns: 'Columns',
      columnsHint: 'Visible columns',
      resetColumns: 'Reset to default',
    };
  }
  return {
    searchAriaLabel: 'بحث في الحالات',
    searchPlaceholder: 'ابحث برقم العقار أو الحي أو الملاحظات…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا توجد حالات مسجّلة بعد.',
    emptySearch: 'لا نتائج مطابقة لبحثك.',
    loadError: 'تعذّر تحميل الحالات.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'عدد الصفوف',
    totalRows: '{count} حالة',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'استعادة الافتراضي',
  };
}

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
const CASE_TABS: ReadonlyArray<{
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
const CASE_FILTERS = {
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
const TYPED_FILTER_DELAY_MS = 300;

/**
 * The next state a quick tap moves a case to — `OPEN → SCHEDULED → RESOLVED`,
 * and from `RESOLVED` back to `OPEN`.
 *
 * A cycle rather than three buttons, because it is one control in a table row
 * and the order is the order a case actually travels: somebody agrees to a
 * revisit before the revisit happens. Reopening from the end is the correction
 * path — a case closed in error, or a household that moved out again.
 */
function nextStatus(status: CaseStatus): CaseStatus {
  if (status === 'OPEN') return 'SCHEDULED';
  if (status === 'SCHEDULED') return 'RESOLVED';
  return 'OPEN';
}

/**
 * حالات — field visits that could not become a citizen registration.
 *
 * Nobody home, the gate was locked, access was refused: this is where whatever
 * staff could observe about the property gets kept instead of lost before the
 * next visit. Not a citizen record on its own, but `resolvedCitizenId` bridges
 * to one once someone does register the resident — see `LinkCaseCitizenDialog`
 * and the "Register Citizen" action below, which are the two ways that link
 * gets made.
 *
 * Logging and editing happen on their own pages (`cases/new`, `cases/[id]/edit`)
 * rather than in a dialog here — see `CaseEditor` for why.
 */
export default function CasesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const toast = useToast();

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role ?? null);
  }, [tenant, base, router]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CaseSummary | null>(null);
  const [linking, setLinking] = useState<CaseSummary | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // ── Tabs and census filters (P3-T7) ────────────────────────────────
  const [filters, setFilters] = useUrlState(CASE_FILTERS);
  const { tab, zone: zoneId } = filters;
  /*
    Every filter narrows the rows, and a narrower list starts again from its
    first page — `{ clear: ['page'] }` on each write. The table used to get that
    for free from TanStack resetting on new data; with the page owned by the URL
    that reset is off, so a reload of `?page=3` stays on page three.
  */
  const narrow = useCallback(
    (patch: Parameters<typeof setFilters>[0]) => setFilters(patch, { clear: ['page'] }),
    [setFilters],
  );
  const setTab = (id: string) => narrow({ tab: id });
  const setZoneId = (id: string) => narrow({ zone: id });
  /*
    The two typed boxes filter on every keystroke from local state, as they
    always have; the URL catches up once typing pauses. An input bound to
    `useSearchParams` directly can lag a write behind and drop a character
    typed quickly.
  */
  const [parcelNumber, setParcelDraft] = useState(filters.parcel);
  const [buildingCode, setBuildingDraft] = useState(filters.building);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setFilters({ parcel: parcelNumber, building: buildingCode }),
      TYPED_FILTER_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [parcelNumber, buildingCode, setFilters]);
  const setParcelNumber = (value: string) => {
    setParcelDraft(value);
    narrow({});
  };
  const setBuildingCode = (value: string) => {
    setBuildingDraft(value);
    narrow({});
  };
  /**
   * When the case was opened — «ماذا ورد هذا الأسبوع».
   *
   * `createdAt`, not `scheduledRevisitAt`: a revisit date is set on only some
   * types, so it would silently drop every other row from a range that asked
   * an innocent question. `YYYY-MM-DD`, both ends inclusive.
   */
  const { from: openedFrom, to: openedTo } = filters;
  const setOpenedFrom = (value: string) => narrow({ from: value });
  const setOpenedTo = (value: string) => narrow({ to: value });
  /** Which building's matrix is open from a case row, if any (`?matrix=&matrixUnit=`). */
  const matrix = filters.matrix
    ? { buildingId: filters.matrix, unitId: filters.matrixUnit || null }
    : null;
  const setMatrix = useCallback(
    (next: { buildingId: string; unitId: string | null } | null) =>
      setFilters({ matrix: next?.buildingId ?? '', matrixUnit: next?.unitId ?? '' }),
    [setFilters],
  );

  /** The table's page in the URL; its search in tab storage, never the URL. */
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });
  const [search, setSearch] = useTabSearch(tenant, 'cases');

  const canWrite = role !== 'AUDITOR' && role !== 'ACCOUNTANT';
  const canDelete = role === 'SUPER_ADMIN';

  const query = useStaffQuery({
    queryKey: ['cases', tenant],
    queryFn: (accessToken, signal) => getCases(tenant, accessToken, {}, signal),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل الحالات.',
  });

  const allItems = useMemo(() => query.data?.cases ?? [], [query.data]);
  const error = actionError;

  /**
   * Parcel → sector, for the zone filter.
   *
   * A case carries a `propertyNumber`, never a sector: membership lives in
   * `Zone.parcelNumbers` and nowhere else (D13). Resolving it here is the same
   * index the building editor uses, cached for five minutes.
   */
  const [zoneOfParcel, setZoneOfParcel] = useState<Record<string, { id: string; name: string }>>({});
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    getZoneParcelIndex(tenant, token)
      .then((index) => {
        if (cancelled) return;
        setZoneOfParcel(index);
        const seen = new Map<string, string>();
        for (const zone of Object.values(index)) seen.set(zone.id, zone.name);
        setZones([...seen.entries()].map(([id, name]) => ({ id, name })));
      })
      // The sector filter is an enrichment; every other filter still works.
      .catch(logApiError);

    return () => {
      cancelled = true;
    };
  }, [tenant, token]);

  /**
   * Filtering is client-side, and deliberately.
   *
   * `GET /cases` returns the whole list — it has no pagination — and the
   * conversion strip above the table is computed over *every* resolved case
   * ever. Narrowing the request would quietly change what that number means
   * from "the register's conversion rate" to "this tab's", which is a different
   * claim in the same words.
   */
  const items = useMemo(() => {
    const types = CASE_TABS.find((entry) => entry.id === tab)?.types ?? null;
    const parcel = parcelNumber.trim();
    const code = buildingCode.trim().toLowerCase();
    /*
      Local midnight to local end-of-day, so a range typed as «من ١٥ إلى ١٥»
      holds everything logged on the 15th as the officer who logged it would
      count it. `GET /cases` takes the same range as ISO instants for callers
      that want the server to narrow; this page filters in the browser to keep
      the conversion strip above computed over every case, as it documents.
    */
    const after = openedFrom ? new Date(`${openedFrom}T00:00:00`).getTime() : null;
    const before = openedTo ? new Date(`${openedTo}T23:59:59.999`).getTime() : null;

    return allItems.filter((item) => {
      if (types && !types.includes(item.caseType)) return false;
      if (parcel && item.propertyNumber !== parcel) return false;
      if (code && !(item.buildingCode ?? '').toLowerCase().includes(code)) return false;
      if (after !== null || before !== null) {
        const opened = new Date(item.createdAt).getTime();
        if (after !== null && opened < after) return false;
        if (before !== null && opened > before) return false;
      }
      if (zoneId) {
        const zone = item.propertyNumber ? zoneOfParcel[item.propertyNumber] : undefined;
        if (zone?.id !== zoneId) return false;
      }
      return true;
    });
  }, [allItems, tab, parcelNumber, buildingCode, openedFrom, openedTo, zoneId, zoneOfParcel]);

  /** How many cases each tab holds, so an empty queue is visible before it is opened. */
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of CASE_TABS) {
      counts[entry.id] = entry.types
        ? allItems.filter((item) => entry.types!.includes(item.caseType)).length
        : allItems.length;
    }
    return counts;
  }, [allItems]);

  const activeFilters = [zoneId, parcelNumber, buildingCode, openedFrom, openedTo].filter(Boolean).length;

  /**
   * The number this whole bridge exists to answer. Of every case ever
   * resolved — not just the ones logged today — how many actually turned
   * into a registered citizen versus closing some other way (confirmed
   * vacant, refused, duplicate).
   */
  const conversion = useMemo(() => {
    // `allItems`, not the filtered set: this line is a statement about the
    // register, and recomputing it per tab would silently change what it
    // claims while the sentence around it stayed the same.
    const resolved = allItems.filter((item) => item.status === 'RESOLVED');
    const withCitizen = resolved.filter((item) => item.resolvedCitizenId);
    return { resolvedCount: resolved.length, linkedCount: withCitizen.length };
  }, [allItems]);

  const queryClient = useQueryClient();
  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['cases', tenant] }),
    [queryClient, tenant],
  );

  /**
   * One tap moves a case one step: `OPEN → SCHEDULED → RESOLVED`, and back to
   * `OPEN` from the end.
   *
   * The middle state is the one worth having. «زيارة مجدولة» says somebody has
   * agreed to a time, which is different from both "still to do" and "done",
   * and it is the difference between a dispatch list that can be planned and
   * one that can only be counted.
   */
  const advanceStatus = useCallback(
    async (item: CaseSummary) => {
      if (!token) return;
      const next = nextStatus(item.status);
      setBusyId(item.id);
      try {
        await updateCase(tenant, token, item.id, { status: next });
        await load();
        toast.success(
          next === 'RESOLVED'
            ? locale === 'en'
              ? 'Marked resolved'
              : 'تم وضع علامة مُعالجة'
            : next === 'SCHEDULED'
              ? locale === 'en'
                ? 'Marked as a scheduled revisit'
                : 'تم وضعها كزيارة مجدولة'
              : locale === 'en'
                ? 'Case reopened'
                : 'تمت إعادة فتح الحالة',
        );
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : 'تعذّر تحديث الحالة.';
        setActionError(message);
        toast.error('تعذّر تحديث الحالة', { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, locale],
  );

  const removeCase = useCallback(
    async (item: CaseSummary) => {
      if (!token) throw new Error('انتهت الجلسة.');
      setBusyId(item.id);
      try {
        await deleteCase(tenant, token, item.id);
        await load();
        toast.success('تم حذف الحالة');
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : 'تعذّر حذف الحالة.';
        setActionError(message);
        throw new Error(message);
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
  );

  /*
    «ربط»: whoever is not on the case's unit yet is recorded on it in the
    capacity chosen — owners first, so a tenant can be linked to an owner
    recorded in the same step (the server refuses an owner recorded after
    the tenant) — and then the case is resolved by the one marked as its own.
    Each occupancy is its own request; if one is refused, the ones before it
    stand, and the error says which were recorded and which was not.
  */
  const linkCitizen = useCallback(
    async (submission: CaseLinkSubmission) => {
      if (!token || !linking) return;
      const en = locale === 'en';
      setLinkSubmitting(true);
      setLinkError(null);
      const recorded: string[] = [];
      const toRecord = linking.unitId
        ? [
            ...submission.people.filter((person) => !person.onUnit && person.role === 'OWNER'),
            ...submission.people.filter((person) => !person.onUnit && person.role !== 'OWNER'),
          ]
        : [];
      let current: CaseLinkPerson | null = null;
      try {
        for (const person of toRecord) {
          current = person;
          await recordOccupancy(tenant, token, {
            unitId: linking.unitId!,
            citizenId: person.citizenId,
            role: person.role,
            ...(person.role === 'OWNER' && submission.ownerUnitStatus
              ? { unitStatus: submission.ownerUnitStatus }
              : {}),
            ...(person.role !== 'OWNER' && person.landlordCitizenId
              ? { landlordCitizenId: person.landlordCitizenId }
              : {}),
          });
          recorded.push(person.name);
        }
        current = null;
        await updateCase(tenant, token, linking.id, { resolvedCitizenId: submission.primaryId });
        await load();
        const primary = submission.people.find((person) => person.citizenId === submission.primaryId);
        toast.success(en ? 'Case linked and resolved' : 'تم ربط الحالة ووضعها محلولة', {
          description:
            recorded.length > 0
              ? en
                ? `${primary?.name ?? ''} — recorded on the unit: ${recorded.join(', ')}`
                : `${primary?.name ?? ''} — سُجِّل على الوحدة: ${recorded.join('، ')}`
              : primary?.name,
        });
        setLinking(null);
      } catch (caught) {
        logApiError(caught);
        const reason = caught instanceof ApiRequestError ? caught.message : en ? 'The request failed.' : 'تعذّر الطلب.';
        const failed: CaseLinkPerson | null = current;
        setLinkError(
          failed
            ? [
                recorded.length > 0
                  ? en
                    ? `Recorded on the unit: ${recorded.join(', ')}.`
                    : `سُجِّل على الوحدة: ${recorded.join('، ')}.`
                  : null,
                en
                  ? `Could not record ${failed.name}: ${reason} The case was not linked.`
                  : `تعذّر تسجيل ${failed.name}: ${reason} لم تُربط الحالة.`,
              ]
                .filter(Boolean)
                .join(' ')
            : en
              ? `Could not link the case: ${reason}`
              : `تعذّر ربط الحالة: ${reason}`,
        );
        // What was recorded stands; the list shows it.
        if (recorded.length > 0) void load();
      } finally {
        setLinkSubmitting(false);
      }
    },
    [tenant, token, linking, load, toast, locale],
  );

  const unlinkCitizen = useCallback(async () => {
    if (!token || !linking) return;
    setLinkSubmitting(true);
    setLinkError(null);
    try {
      await updateCase(tenant, token, linking.id, { resolvedCitizenId: null });
      await load();
      toast.success(locale === 'en' ? 'Link removed' : 'أُزيل الربط');
      setLinking(null);
    } catch (caught) {
      logApiError(caught);
      setLinkError(caught instanceof ApiRequestError ? caught.message : 'تعذّر إلغاء الربط.');
    } finally {
      setLinkSubmitting(false);
    }
  }, [tenant, token, linking, load, toast, locale]);

  const labels = getLabels(locale);

  const clearFilters = () => {
    setZoneId('');
    setParcelNumber('');
    setBuildingCode('');
    setOpenedFrom('');
    setOpenedTo('');
  };

  const columns = useMemo<ColumnDef<CaseSummary>[]>(
    () => [
      {
        accessorKey: 'notes',
        header: locale === 'en' ? 'What happened' : 'ماذا حصل',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate" title={row.original.notes}>
            {row.original.notes}
          </span>
        ),
      },
      {
        // The property's identifier — the census code and the flat when the
        // case is pinned to them, else the number the officer wrote at the door.
        accessorKey: 'propertyNumber',
        header: locale === 'en' ? 'Property ID' : 'رقم العقار',
        cell: ({ row }) => {
          const item = row.original;
          const id = item.buildingCode
            ? item.unitCode
              ? `${item.buildingCode} · ${item.unitCode}`
              : item.buildingCode
            : item.propertyNumber;
          return id ? (
            <CellTag className="font-mono" dir="ltr" title={item.neighborhood ?? undefined}>
              {id}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          );
        },
      },
      {
        accessorKey: 'status',
        header: locale === 'en' ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-1">
              {item.status === 'RESOLVED' ? (
                <CellTag tone="success">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {labels.caseStatus.RESOLVED}
                </CellTag>
              ) : item.status === 'SCHEDULED' ? (
                <CellTag tone="warning">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {labels.caseStatus.SCHEDULED}
                </CellTag>
              ) : (
                <CellTag>{labels.caseStatus.OPEN}</CellTag>
              )}
              {/* The date is what «مجدولة» means; a status without it is a
                  promise nobody can plan around. */}
              {item.scheduledRevisitAt ? (
                <p className="text-xs text-muted-foreground">
                  {locale === 'en' ? 'Revisit ' : 'العودة '}
                  {formatDate(item.scheduledRevisitAt)}
                </p>
              ) : null}
              {item.resolvedCitizenName ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(`${base}/citizens/${item.resolvedCitizenId}`)
                  }
                  className="flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                >
                  <Link2 className="size-3 shrink-0" aria-hidden />
                  {item.resolvedCitizenName}
                </button>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'createdByName',
        header: locale === 'en' ? 'Logged By' : 'سجّلها',
        cell: ({ row }) => row.original.createdByName ?? <span className="text-muted-foreground text-xs">—</span>,
      },
      {
        accessorKey: 'createdAt',
        header: locale === 'en' ? 'Date' : 'التاريخ',
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: 'actions',
        header: locale === 'en' ? 'Actions' : 'إجراء',
        enableSorting: false,
        meta: { mobile: 'actions' },
        cell: ({ row }) => {
          const item = row.original;
          const busy = busyId === item.id;
          const residents = caseResidents(item);
          const occupied = residents.length > 0;
          const who = residents
            .map((person) => `${person.name} (${labels.occupancyType[person.role as never] ?? person.role})`)
            .join(locale === 'en' ? ', ' : '، ');
          const registerBlocked =
            locale === 'en'
              ? `Someone already lives on this unit, registered: ${who} — link the case to them instead.`
              : `الوحدة مسكونة ومسجَّلة: ${who} — اربط الحالة به بدلاً من تسجيل مواطن جديد.`;

          if (!canWrite) return null;

          return (
            <div className="flex items-center gap-1.5">
              {item.status === 'OPEN' ? (
                occupied ? (
                  /*
                    The flat is already owned, rented or lent to a registered
                    citizen: registering somebody new from the case would file a
                    second household on it. Closed, and the tooltip says who is
                    there and what to do instead. A focusable wrapper, because a
                    disabled button shows no tooltip and takes no focus.
                  */
                  <ActionTooltip label={registerBlocked}>
                    <span tabIndex={0} aria-label={registerBlocked} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-hidden
                        tabIndex={-1}
                        disabled
                        className="pointer-events-none"
                      >
                        <UserPlus className="size-4" aria-hidden />
                      </Button>
                    </span>
                  </ActionTooltip>
                ) : (
                <ActionTooltip label={locale === 'en' ? 'Register Citizen' : 'تسجيل المواطن'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="border-primary/40 text-primary hover:bg-primary/5"
                    aria-label={locale === 'en' ? 'Register Citizen' : 'تسجيل المواطن'}
                    disabled={busy}
                    onClick={() => router.push(`${base}/citizens/new?fromCaseId=${item.id}`)}
                  >
                    <UserPlus className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
                )
              ) : null}

              <ActionTooltip
                label={
                  occupied
                    ? locale === 'en'
                      ? `Link to a citizen — on this unit: ${who}`
                      : `ربط بمواطن — على الوحدة: ${who}`
                    : locale === 'en'
                      ? 'Link to Citizen'
                      : 'ربط بمواطن'
                }
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Link to Citizen' : 'ربط بمواطن'}
                  disabled={busy}
                  onClick={() => {
                    setLinkError(null);
                    setLinking(item);
                  }}
                >
                  <Link2 className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>

              {/* One tap, one step along OPEN → SCHEDULED → RESOLVED. The
                  label names where it goes, never where it is. */}
              <ActionTooltip
                label={
                  item.status === 'OPEN'
                    ? locale === 'en'
                      ? 'Schedule a revisit'
                      : 'جدولة زيارة'
                    : item.status === 'SCHEDULED'
                      ? locale === 'en'
                        ? 'Mark resolved'
                        : 'وضع علامة مُعالجة'
                      : locale === 'en'
                        ? 'Reopen'
                        : 'إعادة فتح'
                }
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Advance status' : 'تقديم حالة المعاملة'}
                  disabled={busy}
                  onClick={() => void advanceStatus(item)}
                >
                  {item.status === 'OPEN' ? (
                    <CalendarClock className="size-4" aria-hidden />
                  ) : item.status === 'SCHEDULED' ? (
                    <CheckCircle2 className="size-4" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                </Button>
              </ActionTooltip>

              {/* A case pinned to a censused structure opens its matrix — the
                  fastest route from "somebody should go back" to the flat. */}
              {item.buildingId ? (
                <ActionTooltip label={locale === 'en' ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}
                    disabled={busy}
                    onClick={() => setMatrix({ buildingId: item.buildingId!, unitId: item.unitId })}
                  >
                    <Grid3x3 className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}

              <ActionTooltip label={locale === 'en' ? 'Edit' : 'تعديل'}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Edit' : 'تعديل'}
                  disabled={busy}
                  onClick={() => router.push(`${base}/cases/${item.id}/edit`)}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>

              {canDelete ? (
                <ActionTooltip label={locale === 'en' ? 'Delete' : 'حذف'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Delete' : 'حذف'}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
          );
        },
      },
    ],
    [busyId, canWrite, canDelete, locale, labels, advanceStatus, router, base, setMatrix],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={ClipboardList}
        title={locale === 'en' ? 'Cases' : 'الحالات'}
        subtitle={
          locale === 'en'
            ? 'Visits that did not become a citizen registration — nobody home, access refused. Log what was observed for the next visit.'
            : 'زيارات لم تنتهِ بتسجيل مواطن — لا أحد في المنزل، أو تعذّر الدخول. سجّل ما أمكن ملاحظته للزيارة القادمة.'
        }
        actions={
          canWrite ? (
            <Button onClick={() => router.push(`${base}/cases/new`)}>
              <Plus className="size-4" aria-hidden />
              {locale === 'en' ? 'Open a follow-up case' : 'فتح حالة متابعة'}
            </Button>
          ) : null
        }
      />

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/*
        One frame for the work: what the list is, how much of it turned into a
        registration, the queues, the filters and the rows — the order a
        dispatcher reads it in. The queues and the filters used to float above
        the card as a strip of chips and a row of bare inputs, each drawn its own
        way; now they sit in the frame they act on.
      */}
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-2 space-y-0 border-b px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <ClipboardList className="size-5 text-primary" aria-hidden />
            {locale === 'en' ? 'Logged cases' : 'الحالات المسجّلة'}
            {/* Shown / all, so a narrowed list never reads as the whole register. */}
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {items.length === allItems.length
                ? `(${allItems.length})`
                : locale === 'en'
                  ? `(${items.length} of ${allItems.length})`
                  : `(${items.length} من ${allItems.length})`}
            </span>
          </CardTitle>
          {/*
            How many resolved cases ended in a registration — context for the
            work, stated as one figure and its sentence, not a banner.
          */}
          {conversion.resolvedCount > 0 ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <TrendingUp className="size-4 shrink-0 text-primary" aria-hidden />
              <span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {Math.round((conversion.linkedCount / conversion.resolvedCount) * 100)}٪
                </span>{' '}
                {locale === 'en'
                  ? `conversion — ${conversion.linkedCount} of ${conversion.resolvedCount} resolved cases led to a registered citizen`
                  : `نسبة التحويل — ${conversion.linkedCount} من ${conversion.resolvedCount} حالة محلولة انتهت بتسجيل مواطن`}
              </span>
            </p>
          ) : null}
        </CardHeader>

        {/*
          The queues, as tabs over the one table under them. Each groups the
          case types an officer does the same thing about — knock again,
          escalate, or just read — and its count rides on it, so an empty
          queue shows before it is opened.
        */}
        <div
          role="tablist"
          aria-label={locale === 'en' ? 'Case queues' : 'قوائم الحالات'}
          className="flex gap-1 overflow-x-auto border-b px-2 sm:px-4"
        >
          {CASE_TABS.map((entry) => {
            const active = entry.id === tab;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                className={cn(
                  'relative flex min-h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:duration-150',
                  active
                    ? 'text-primary after:bg-primary'
                    : 'text-muted-foreground after:bg-transparent hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {locale === 'en' ? entry.en : entry.ar}
                <span
                  className={cn(
                    'min-w-6 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
                    active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {tabCounts[entry.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <CardContent className="p-0">
          {/* One frame: the card's (BAN-4). */}
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            columnStorageKey="cases"
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            searchValue={search}
            onSearchChange={setSearch}
            pagination={pagination}
            onPaginationChange={setPagination}
            activeFiltersCount={activeFilters}
            onClearFilters={clearFilters}
            filterBar={
              // Sector, parcel and building — the three ways a dispatch list is cut — and the day it was opened.
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:flex-wrap md:items-center">
                <span className="hidden items-center gap-1.5 pe-1 text-xs font-medium text-muted-foreground xl:flex">
                  <Filter className="size-3.5" aria-hidden />
                  {locale === 'en' ? 'Filter:' : 'تصفية:'}
                </span>
                <FilterSelect
                  label={locale === 'en' ? 'Sector' : 'القطاع'}
                  value={zoneId}
                  onChange={setZoneId}
                  options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                  allLabel={locale === 'en' ? 'All sectors' : 'كل القطاعات'}
                />
                <FilterInput
                  label={locale === 'en' ? 'Filter by parcel number' : 'تصفية حسب رقم العقار'}
                  value={parcelNumber}
                  onChange={setParcelNumber}
                  placeholder={locale === 'en' ? 'Parcel #' : 'رقم العقار'}
                  clearLabel={locale === 'en' ? 'Clear parcel number' : 'مسح رقم العقار'}
                  inputMode="numeric"
                  dir="ltr"
                />
                <FilterInput
                  label={locale === 'en' ? 'Filter by building code' : 'تصفية حسب رمز المبنى'}
                  value={buildingCode}
                  onChange={setBuildingCode}
                  placeholder={locale === 'en' ? 'Building code' : 'رمز المبنى'}
                  clearLabel={locale === 'en' ? 'Clear building code' : 'مسح رمز المبنى'}
                  dir="ltr"
                  className="sm:w-36"
                />
                {/* «من» / «إلى» on the day the case was opened. */}
                <div className="flex items-center gap-1.5 sm:col-span-2 md:col-span-1">
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {locale === 'en' ? 'Opened' : 'فُتحت'}
                  </span>
                  <DatePicker
                    id="cases-from"
                    value={openedFrom}
                    onChange={setOpenedFrom}
                    max={openedTo || undefined}
                    placeholder={locale === 'en' ? 'From' : 'من'}
                    locale={locale === 'en' ? 'en' : 'ar'}
                  />
                  <DatePicker
                    id="cases-to"
                    value={openedTo}
                    onChange={setOpenedTo}
                    placeholder={locale === 'en' ? 'To' : 'إلى'}
                    locale={locale === 'en' ? 'en' : 'ar'}
                  />
                </div>
                {activeFilters > 0 ? (
                  <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 gap-1.5 text-xs md:ms-auto">
                    <X className="size-3.5" aria-hidden />
                    {locale === 'en' ? `Clear ${activeFilters} filter(s)` : `مسح ${activeFilters} فلتر`}
                  </Button>
                ) : null}
              </div>
            }
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={locale === 'en' ? 'Delete Case' : 'حذف الحالة'}
        description={
          locale === 'en'
            ? 'This case will be removed permanently. This does not affect any citizen record.'
            : 'ستُحذف هذه الحالة نهائياً. هذا لا يؤثر على أي سجل مواطن.'
        }
        confirmLabel={locale === 'en' ? 'Delete' : 'حذف'}
        onConfirm={async () => {
          if (pendingDelete) await removeCase(pendingDelete);
        }}
      />

      {token ? (
        <BuildingUnitMatrixDrawer
          open={matrix !== null}
          onClose={() => setMatrix(null)}
          tenant={tenant}
          token={token}
          buildingId={matrix?.buildingId ?? null}
          // Opened from a case on a flat: the drawer opens on that flat.
          focusUnitId={matrix?.unitId ?? null}
          canWrite={canWrite}
          // A visit or an occupancy logged from here can auto-resolve the very
          // case the drawer was opened from, so the list is re-read on close.
          onChanged={() => void load()}
          registerHref={(buildingId, unitId, residence) =>
            `${base}/citizens/new?buildingId=${encodeURIComponent(buildingId)}&unitId=${encodeURIComponent(unitId)}&residence=${residence}`
          }
          citizenHref={(citizenId) => `${base}/citizens/${citizenId}`}
          locale={locale}
        />
      ) : null}

      {token ? (
        <LinkCaseCitizenDialog
          open={linking !== null}
          onOpenChange={(open) => {
            if (!open) setLinking(null);
          }}
          tenant={tenant}
          token={token}
          currentCitizenName={linking?.resolvedCitizenName}
          submitting={linkSubmitting}
          error={linkError}
          onSubmit={(submission) => void linkCitizen(submission)}
          unitLabel={
            linking?.unitId && linking.buildingCode
              ? `${linking.buildingCode} · ${linking.unitCode ?? ''}`
              : null
          }
          onUnlink={() => void unlinkCitizen()}
          suggested={linking?.unitOccupants ?? []}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
