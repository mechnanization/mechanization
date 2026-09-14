'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
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
import type { CitizenListItem } from '@/lib/api-client';
import {
  ApiRequestError,
  deleteCase,
  getCases,
  getZoneParcelIndex,
  logApiError,
  updateCase,
} from '@/lib/api-client';
import type { CaseSummary } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { LinkCaseCitizenDialog } from '@/components/admin/link-case-citizen-dialog';
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
  const [tab, setTab] = useState('all');
  const [zoneId, setZoneId] = useState('');
  const [parcelNumber, setParcelNumber] = useState('');
  const [buildingCode, setBuildingCode] = useState('');
  /** Which building's matrix is open from a case row, if any. */
  const [matrixId, setMatrixId] = useState<string | null>(null);

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

    return allItems.filter((item) => {
      if (types && !types.includes(item.caseType)) return false;
      if (parcel && item.propertyNumber !== parcel) return false;
      if (code && !(item.buildingCode ?? '').toLowerCase().includes(code)) return false;
      if (zoneId) {
        const zone = item.propertyNumber ? zoneOfParcel[item.propertyNumber] : undefined;
        if (zone?.id !== zoneId) return false;
      }
      return true;
    });
  }, [allItems, tab, parcelNumber, buildingCode, zoneId, zoneOfParcel]);

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

  const activeFilters = [zoneId, parcelNumber, buildingCode].filter(Boolean).length;

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

  const linkCitizen = useCallback(
    async (citizen: CitizenListItem) => {
      if (!token || !linking) return;
      setLinkSubmitting(true);
      setLinkError(null);
      try {
        await updateCase(tenant, token, linking.id, { resolvedCitizenId: citizen.id });
        await load();
        toast.success(locale === 'en' ? 'Case linked and resolved' : 'تم ربط الحالة ووضعها محلولة', {
          description: citizen.fullName,
        });
        setLinking(null);
      } catch (caught) {
        logApiError(caught);
        setLinkError(caught instanceof ApiRequestError ? caught.message : 'تعذّر ربط الحالة.');
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
        accessorKey: 'propertyNumber',
        header: locale === 'en' ? 'Property' : 'العقار',
        cell: ({ row }) => {
          const item = row.original;
          const parts = [
            item.propertyNumber ? (locale === 'en' ? `#${item.propertyNumber}` : `رقم ${item.propertyNumber}`) : null,
            item.neighborhood,
          ].filter(Boolean);
          return parts.length > 0 ? (
            <span dir="auto">{parts.join(' — ')}</span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          );
        },
      },
      {
        accessorKey: 'propertyType',
        header: locale === 'en' ? 'Type' : 'النوع',
        cell: ({ row }) =>
          row.original.propertyType ? (
            labels.propertyType[row.original.propertyType as never] ?? row.original.propertyType
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      {
        accessorKey: 'status',
        header: locale === 'en' ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-1">
              {item.status === 'RESOLVED' ? (
                <Badge className="gap-1.5 border-emerald-600/30 bg-emerald-600/10 py-1 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" variant="outline">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {labels.caseStatus.RESOLVED}
                </Badge>
              ) : item.status === 'SCHEDULED' ? (
                <Badge className="gap-1.5 py-1" variant="soft-warning">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {labels.caseStatus.SCHEDULED}
                </Badge>
              ) : (
                <Badge className="gap-1.5 py-1" variant="outline">
                  {labels.caseStatus.OPEN}
                </Badge>
              )}
              {/* The date is what «مجدولة» means; a status without it is a
                  promise nobody can plan around. */}
              {item.scheduledRevisitAt ? (
                <p className="text-[11px] text-muted-foreground">
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
                  className="flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
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

          if (!canWrite) return null;

          return (
            <div className="flex items-center gap-1.5">
              {item.status === 'OPEN' ? (
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
              ) : null}

              <ActionTooltip label={locale === 'en' ? 'Link to Citizen' : 'ربط بمواطن'}>
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
                    onClick={() => setMatrixId(item.buildingId)}
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
    [busyId, canWrite, canDelete, locale, labels, advanceStatus, router, base],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col items-start justify-between gap-4 border-b pb-6 md:flex-row md:items-center">
        <div className="space-y-2">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight">
            <ClipboardList className="size-7 text-primary" aria-hidden />
            {locale === 'en' ? 'Cases' : 'الحالات'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {locale === 'en'
              ? 'Visits that did not become a citizen registration — nobody home, access refused. Log what was observed for the next visit.'
              : 'زيارات لم تنتهِ بتسجيل مواطن — لا أحد في المنزل، أو تعذّر الدخول. سجّل ما أمكن ملاحظته للزيارة القادمة.'}
          </p>
        </div>
        {canWrite ? (
          <Button onClick={() => router.push(`${base}/cases/new`)}>
            <Plus className="size-4" aria-hidden />
            {locale === 'en' ? 'Open a follow-up case' : 'فتح حالة متابعة'}
          </Button>
        ) : null}
      </div>

      {/*
        Tabs as a work queue, not a copy of the enum.

        Each one groups the case types an officer does the same thing about —
        knock again, escalate to a person with authority, or just read. The
        count rides on the tab so an empty queue is visible before it is opened.
      */}
      <div
        role="tablist"
        aria-label={locale === 'en' ? 'Case queues' : 'قوائم الحالات'}
        className="flex flex-wrap gap-1.5 border-b pb-2"
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
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent',
              )}
            >
              {locale === 'en' ? entry.en : entry.ar}
              <span
                className={cn(
                  'rounded-full px-1.5 text-[10px] font-bold',
                  active ? 'bg-primary/20' : 'bg-muted text-muted-foreground',
                )}
              >
                {tabCounts[entry.id] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Zone, parcel and building — the three ways a dispatch list is cut. */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={zoneId}
          onChange={(event) => setZoneId(event.target.value)}
          aria-label={locale === 'en' ? 'Filter by sector' : 'تصفية حسب القطاع'}
          className={cn(
            'h-9 rounded-md border border-input bg-background px-3 text-xs ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring',
            zoneId && 'border-primary text-primary',
          )}
        >
          <option value="">{locale === 'en' ? 'All sectors' : 'كل القطاعات'}</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.name}
            </option>
          ))}
        </select>

        <input
          value={parcelNumber}
          onChange={(event) => setParcelNumber(event.target.value)}
          dir="ltr"
          inputMode="numeric"
          aria-label={locale === 'en' ? 'Filter by parcel number' : 'تصفية حسب رقم العقار'}
          placeholder={locale === 'en' ? 'Parcel #' : 'رقم العقار'}
          className="h-9 w-28 rounded-md border border-input bg-background px-3 text-start text-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />

        <input
          value={buildingCode}
          onChange={(event) => setBuildingCode(event.target.value)}
          dir="ltr"
          aria-label={locale === 'en' ? 'Filter by building code' : 'تصفية حسب رمز المبنى'}
          placeholder={locale === 'en' ? 'Building code' : 'رمز المبنى'}
          className="h-9 w-36 rounded-md border border-input bg-background px-3 text-start text-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />

        {activeFilters > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoneId('');
              setParcelNumber('');
              setBuildingCode('');
            }}
          >
            <X className="size-4" aria-hidden />
            {locale === 'en' ? `Clear ${activeFilters} filter(s)` : `مسح ${activeFilters} فلتر`}
          </Button>
        ) : null}

        <span className="ms-auto text-xs text-muted-foreground">
          {locale === 'en'
            ? `${items.length} of ${allItems.length} cases`
            : `${items.length} من ${allItems.length} حالة`}
        </span>
      </div>

      {conversion.resolvedCount > 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-muted/20 px-3.5 py-2.5 text-sm">
          <TrendingUp className="size-4 shrink-0 text-primary" aria-hidden />
          <span>
            {locale === 'en' ? (
              <>
                <strong>{conversion.linkedCount}</strong> of <strong>{conversion.resolvedCount}</strong> resolved
                cases led to a registered citizen (
                {Math.round((conversion.linkedCount / conversion.resolvedCount) * 100)}%
                conversion).
              </>
            ) : (
              <>
                <strong>{conversion.linkedCount}</strong> من <strong>{conversion.resolvedCount}</strong> حالة محلولة
                انتهت بتسجيل مواطن (نسبة التحويل{' '}
                {Math.round((conversion.linkedCount / conversion.resolvedCount) * 100)}٪).
              </>
            )}
          </span>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ClipboardList className="size-5" aria-hidden />
            {locale === 'en' ? 'Logged Cases' : 'الحالات المسجّلة'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <DataTable
            columns={columns}
            data={items}
            labels={tableLabels}
            columnStorageKey="cases"
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
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
          open={matrixId !== null}
          onClose={() => setMatrixId(null)}
          tenant={tenant}
          token={token}
          buildingId={matrixId}
          canWrite={canWrite}
          // A visit or an occupancy logged from here can auto-resolve the very
          // case the drawer was opened from, so the list is re-read on close.
          onChanged={() => void load()}
          registerHref={(buildingId, unitId, residence, name) =>
            `${base}/citizens/new?buildingId=${encodeURIComponent(buildingId)}&unitId=${encodeURIComponent(unitId)}&residence=${residence}${
              name ? `&name=${encodeURIComponent(name)}` : ''
            }`
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
          onLink={(citizen) => void linkCitizen(citizen)}
          onUnlink={() => void unlinkCitizen()}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
