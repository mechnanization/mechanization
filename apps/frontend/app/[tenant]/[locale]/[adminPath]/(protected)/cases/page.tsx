'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ClipboardList, Filter, Plus, TrendingUp, X } from 'lucide-react';
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
import { useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { FilterInput, FilterSelect } from '@/components/ui/filter-controls';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { BuildingUnitMatrixDrawer } from '@/components/admin/building-unit-matrix-drawer';
import { CASE_FILTERS, CASE_TABS, TYPED_FILTER_DELAY_MS } from '@/components/admin/cases/case-queues';
import { nextStatus } from '@/components/admin/cases/case-status';
import { getCaseTableLabels } from '@/components/admin/cases/case-table-labels';
import { useCaseColumns } from '@/components/admin/cases/use-case-columns';
import { useCaseLinking } from '@/components/admin/cases/use-case-linking';
import { CaseLinkDialog, CaseUnlinkDialog } from '@/components/admin/cases/case-link-dialogs';
import { CaseQueueTabs } from '@/components/admin/cases/case-queue-tabs';
import { CASE_WRITE_ROLES, hasRole } from '@/lib/staff-roles';

/**
 * حالات — field visits that could not become a citizen registration.
 *
 * Nobody home, the gate was locked, access was refused: this is where whatever
 * staff could observe about the property gets kept instead of lost before the
 * next visit. Not a citizen record on its own, but `resolvedCitizenId` bridges
 * to one once someone does register the resident — see `LinkCaseCitizenDialog`
 * and the "Register Citizen" action in `useCaseColumns`, which are the two ways
 * that link gets made.
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

  // An allow-list (`CASE_WRITE_ROLES`, as `CasesController` writes): an undefined role on first paint writes nothing.
  const canWrite = hasRole(CASE_WRITE_ROLES, role);
  const canDelete = role === 'SUPER_ADMIN';

  const query = useStaffQuery({
    queryKey: ['cases', tenant],
    queryFn: (accessToken, signal) => getCases(tenant, accessToken, {}, signal),
    tenant,
    base,
    token,
    errorMessage: locale === 'en' ? 'Failed to load cases.' : 'تعذّر تحميل الحالات.',
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

  const linkage = useCaseLinking({ tenant, token, locale, load });
  const { openLink } = linkage;

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
        const message =
          caught instanceof ApiRequestError
            ? caught.message
            : locale === 'en'
              ? 'Could not update the case.'
              : 'تعذّر تحديث الحالة.';
        setActionError(message);
        toast.error(locale === 'en' ? 'Could not update the case' : 'تعذّر تحديث الحالة', {
          description: message,
        });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, locale],
  );

  const removeCase = useCallback(
    async (item: CaseSummary) => {
      if (!token) throw new Error(locale === 'en' ? 'Your session has ended.' : 'انتهت الجلسة.');
      setBusyId(item.id);
      try {
        await deleteCase(tenant, token, item.id);
        await load();
        toast.success(locale === 'en' ? 'Case deleted' : 'تم حذف الحالة');
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError
            ? caught.message
            : locale === 'en'
              ? 'Could not delete the case.'
              : 'تعذّر حذف الحالة.';
        setActionError(message);
        throw new Error(message);
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, locale],
  );

  const clearFilters = () => {
    setZoneId('');
    setParcelNumber('');
    setBuildingCode('');
    setOpenedFrom('');
    setOpenedTo('');
  };

  const columns = useCaseColumns({
    locale,
    base,
    busyId,
    canWrite,
    canDelete,
    advanceStatus,
    openLink,
    setMatrix,
    setPendingDelete,
  });

  if (!token) return null;

  const tableLabels = getCaseTableLabels(locale);

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
                  {Math.round((conversion.linkedCount / conversion.resolvedCount) * 100)}
                  {locale === 'en' ? '%' : '٪'}
                </span>{' '}
                {locale === 'en'
                  ? `conversion — ${conversion.linkedCount} of ${conversion.resolvedCount} resolved cases led to a registered citizen`
                  : `نسبة التحويل — ${conversion.linkedCount} من ${conversion.resolvedCount} حالة محلولة انتهت بتسجيل مواطن`}
              </span>
            </p>
          ) : null}
        </CardHeader>

        <CaseQueueTabs locale={locale} tab={tab} counts={tabCounts} onSelect={setTab} />

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
        cancelLabel={locale === 'en' ? 'Cancel' : 'إلغاء'}
        busyLabel={locale === 'en' ? 'Working…' : 'جارٍ التنفيذ…'}
        onConfirm={async () => {
          if (pendingDelete) await removeCase(pendingDelete);
        }}
      />

      <CaseUnlinkDialog linkage={linkage} locale={locale} onOpenUnit={setMatrix} />

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

      {token ? <CaseLinkDialog linkage={linkage} tenant={tenant} token={token} locale={locale} /> : null}
    </div>
  );
}
