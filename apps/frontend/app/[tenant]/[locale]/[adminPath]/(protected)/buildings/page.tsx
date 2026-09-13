'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import {
  Building2,
  ClipboardCheck,
  DoorOpen,
  Download,
  Filter,
  Grid3x3,
  Loader2,
  MapPinOff,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  BUILDING_LIFECYCLE,
  DAMAGE_LEVEL,
  getLabels,
  STRUCTURE_TYPE,
  SURVEY_STATUS,
  type BuildingLifecycle,
  type DamageLevel,
  type StructureType,
  type SurveyStatus,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  deleteBuilding,
  getBuildings,
  getZones,
  logApiError,
  type BuildingLedgerRow,
  type ZoneSummary,
} from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionTooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { BuildingQueueNotice } from '@/components/admin/building-queue-notice';
import { buildCsv, downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';

/**
 * سجل المباني — the census ledger.
 *
 * The register of citizens answers "who is on file". This answers the question
 * the register cannot: **what is standing, and how much of it has anyone
 * actually been inside.** Every row exists because a structure exists (D1), not
 * because somebody filed a card about it, so an unsurveyed block is a row here
 * with a number on it rather than an absence nobody can count.
 *
 * The four tiles are the dispatch decision in four numbers, and they are
 * computed by the server over the whole filtered set rather than over the page
 * on screen — a tile that quietly described the first hundred rows would read
 * as a statement about the municipality and be one about the pagination.
 *
 * The filters compose because the questions compose: "unsurveyed flats in the
 * eastern sector" and "unsafe buildings on parcel 1042" are the same query with
 * different clauses, and every one of them is optional.
 */

const PAGE_SIZE = 25;

/**
 * How many rows one export will page through before it stops.
 *
 * Not a guess: this is a municipality's *building stock*. Albazourieh has 1,825
 * parcels, and a parcel with more than a handful of structures on it is
 * remarkable — so ten thousand is roughly five times the largest honest answer,
 * and a run that hits it is reporting a data problem rather than a big town.
 * Stated as a constant so the ceiling is visible rather than implied by a loop.
 */
const EXPORT_CEILING = 10_000;

/** Read-only roles. They see the census; they do not edit it. */
const READ_ONLY_ROLES = ['AUDITOR', 'ACCOUNTANT'];

function getTableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search buildings',
      searchPlaceholder: 'Search by code, name, posted number or parcel…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'No buildings recorded yet.',
      emptySearch: 'No buildings match these filters.',
      loadError: 'Failed to load the census.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} buildings',
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
    searchAriaLabel: 'بحث في المباني',
    searchPlaceholder: 'ابحث بالرمز أو الاسم أو الرقم المكتوب أو رقم العقار…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا توجد مبانٍ مسجّلة بعد.',
    emptySearch: 'لا توجد مبانٍ مطابقة لهذه الفلاتر.',
    loadError: 'تعذّر تحميل سجل المباني.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'عدد الصفوف',
    totalRows: '{count} مبنى',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'استعادة الافتراضي',
    filters: 'الفلاتر',
    clearFilters: 'مسح الفلاتر',
  };
}

/**
 * The three levels that mean a structure's use is impaired.
 *
 * Kept in step with `DAMAGED_LEVELS` on the server, which is what the «متضرر»
 * tile counts: an assessment finding a building undamaged must not make the
 * damaged figure go up.
 */
const DAMAGED_LEVELS: readonly DamageLevel[] = [
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
];

export default function BuildingsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();

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

  const canWrite = role !== null && !READ_ONLY_ROLES.includes(role);
  const canDelete = role === 'SUPER_ADMIN';

  // ── Filters ───────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [parcelNumber, setParcelNumber] = useState('');
  const [parcelInput, setParcelInput] = useState('');
  const [structureType, setStructureType] = useState('');
  const [lifecycleStatus, setLifecycleStatus] = useState('');
  const [surveyStatus, setSurveyStatus] = useState('');
  const [damageLevel, setDamageLevel] = useState('');
  /**
   * «بلا مدخل مُثبت», as a filter rather than a select.
   *
   * Only one direction of it is worth offering. "Structures that *do* have a
   * pin" is not a question anybody asks; "the ones that do not" is a morning's
   * dispatch list, so this is a toggle the tile turns on.
   */
  const [withoutEntrance, setWithoutEntrance] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const activeFilters =
    [
      zoneId,
      parcelInput,
      structureType,
      lifecycleStatus,
      surveyStatus,
      damageLevel,
      search,
      withoutEntrance,
    ].filter(Boolean).length;

  /**
   * The parcel box is debounced; every other filter is not.
   *
   * A select fires once per decision, so it queries once. A text field fires
   * per keystroke, and «1042» typed at speed is four queries of which three are
   * about parcels 1, 10 and 104 — each a real answer to a question nobody
   * asked, and on a field connection each one delays the one that matters.
   */
  useEffect(() => {
    const next = parcelInput.trim();
    if (next === parcelNumber) return;
    const timer = setTimeout(() => {
      setParcelNumber(next);
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
    }, 350);
    return () => clearTimeout(timer);
  }, [parcelInput, parcelNumber]);

  /**
   * Any filter change is a different question, so it starts at page one.
   *
   * Without this, narrowing a 300-row census to four unsafe buildings while on
   * page five shows an empty table and a pager that says there is nothing —
   * which reads as "no results" rather than "you are past the end".
   */
  const setFilter = useCallback((apply: () => void) => {
    apply();
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, []);

  const clearFilters = () =>
    setFilter(() => {
      setSearch('');
      setZoneId('');
      setParcelInput('');
      setParcelNumber('');
      setStructureType('');
      setSurveyStatus('');
      setDamageLevel('');
      setWithoutEntrance(false);
      // `lifecycleStatus` is deliberately absent here, as it was before —
      // clearing it is not part of what «مسح الفلاتر» has ever meant on this
      // page. Left alone rather than quietly changed alongside a new filter.
    });

  // ── Data ──────────────────────────────────────────────────────────
  const zonesQuery = useStaffQuery({
    queryKey: ['zones', tenant],
    queryFn: (accessToken) => getZones(tenant, accessToken),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the sectors.' : 'تعذّر تحميل القطاعات.',
  });
  const zones: ZoneSummary[] = useMemo(() => zonesQuery.data?.zones ?? [], [zonesQuery.data]);

  const query = useStaffQuery({
    queryKey: [
      'buildings',
      tenant,
      search,
      zoneId,
      parcelNumber,
      structureType,
      lifecycleStatus,
      surveyStatus,
      damageLevel,
      withoutEntrance,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      getBuildings(
        tenant,
        accessToken,
        {
          search: search || undefined,
          zoneId: zoneId || undefined,
          parcelNumber: parcelNumber || undefined,
          structureType: (structureType as StructureType) || undefined,
          lifecycleStatus: (lifecycleStatus as BuildingLifecycle) || undefined,
          surveyStatus: (surveyStatus as SurveyStatus) || undefined,
          damageLevel: (damageLevel as DamageLevel) || undefined,
          // `false` is the whole point of the filter, so it cannot be `||`-ed
          // away like the string selects above.
          hasEntrance: withoutEntrance ? false : undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the census.' : 'تعذّر تحميل سجل المباني.',
    keepPrevious: true,
  });

  const rows = useMemo(() => query.data?.buildings ?? [], [query.data]);
  const summary = query.data?.summary;
  const total = query.data?.total ?? 0;

  const reload = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['buildings', tenant] }),
    [queryClient, tenant],
  );

  const [pendingDelete, setPendingDelete] = useState<BuildingLedgerRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const removeBuilding = useCallback(
    async (row: BuildingLedgerRow) => {
      if (!token) throw new Error(en ? 'The session has ended.' : 'انتهت الجلسة.');
      try {
        await deleteBuilding(tenant, token, row.id);
        await reload();
        toast.success(en ? 'Building deleted' : 'تم حذف المبنى');
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError
            ? caught.payload.message
            : en
              ? 'Could not delete the building.'
              : 'تعذّر حذف المبنى.';
        toast.error(en ? 'Could not delete the building' : 'تعذّر حذف المبنى', {
          description: message,
        });
        throw new Error(message);
      }
    },
    [tenant, token, reload, toast, en],
  );

  /**
   * The census ledger as a spreadsheet (P4-T3).
   *
   * Exports **what the filters currently select**, not the page on screen and
   * not the whole register: the officer has already said which slice they mean,
   * and an export that quietly ignored that would either be the wrong answer or
   * a very large one. It pages the same endpoint the table reads, so the two
   * cannot disagree about what matches.
   *
   * Client-side rather than a server route, and that is the plan's own call
   * (P4-T3 says to reuse `lib/csv.ts`). The ceiling is real and stated below:
   * this is a municipality's building stock, in the low thousands, not a
   * warehouse of transactions.
   */
  const exportCsv = useCallback(async () => {
    if (!token) return;
    setExporting(true);
    try {
      const filter = {
        search: search || undefined,
        zoneId: zoneId || undefined,
        parcelNumber: parcelNumber || undefined,
        structureType: (structureType as StructureType) || undefined,
        lifecycleStatus: (lifecycleStatus as BuildingLifecycle) || undefined,
        surveyStatus: (surveyStatus as SurveyStatus) || undefined,
        damageLevel: (damageLevel as DamageLevel) || undefined,
        // The export follows the filters exactly — see the note above; a CSV
        // that quietly ignored one of them is how two people read the same
        // screen and disagree about what it said.
        hasEntrance: withoutEntrance ? false : undefined,
      };

      const collected: BuildingLedgerRow[] = [];
      // 500 is the schema's own ceiling on `limit`; paging at it is the fewest
      // round trips the API allows.
      const pageSize = 500;
      for (let offset = 0; offset < EXPORT_CEILING; offset += pageSize) {
        const page = await getBuildings(tenant, token, { ...filter, limit: pageSize, offset });
        collected.push(...page.buildings);
        if (collected.length >= page.total || page.buildings.length < pageSize) break;
      }

      const header = en
        ? [
            'Code',
            'Name',
            'Posted number',
            'Parcel',
            'Sector',
            'Structure',
            'Construction status',
            'Floors',
            'Units',
            'Surveyed',
            'Unsurveyed',
            'Condition',
            'Latitude',
            'Longitude',
            'Notes',
          ]
        : [
            'الرمز',
            'الاسم',
            'الرقم المكتوب',
            'رقم العقار',
            'القطاع',
            'نوع المنشأة',
            'الحالة الإنشائية',
            'عدد الطوابق',
            'عدد الوحدات',
            'الممسوحة',
            'غير الممسوحة',
            /*
              «حالة الضرر», not «الحالة الإنشائية».

              This column holds the UN-Habitat damage level and the Arabic
              header had said "construction status" — a mistranslation of the
              English «Condition» that was merely loose until a real
              construction status existed, and is now a column heading that
              names a different column.
            */
            'حالة الضرر',
            'خط العرض',
            'خط الطول',
            'ملاحظات',
          ];

      const rows = collected.map((row) => [
        row.code,
        row.name ?? '',
        row.postedNumber ?? '',
        row.parcelNumber,
        row.zoneName ?? '',
        labels.structureType[row.structureType] ?? row.structureType,
        labels.buildingLifecycle[row.lifecycleStatus] ?? row.lifecycleStatus,
        row.floorsCount,
        row.unitsTotal,
        row.unitsSurveyed,
        Math.max(0, row.unitsTotal - row.unitsSurveyed),
        row.damageLevel ? (labels.damageLevel[row.damageLevel] ?? row.damageLevel) : '',
        row.latitude ?? '',
        row.longitude ?? '',
        row.notes ?? '',
      ]);

      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`building-census-${tenant}-${stamp}.csv`, buildCsv(header, rows));

      toast.success(
        en ? 'Census exported' : 'تم تصدير سجل المباني',
        {
          description: en
            ? `${rows.length} building(s), matching the current filters.`
            : `${rows.length} مبنى، وفق الفلاتر المطبّقة.`,
        },
      );
    } catch (caught) {
      logApiError(caught);
      toast.error(en ? 'Could not export the census' : 'تعذّر تصدير سجل المباني', {
        description:
          caught instanceof ApiRequestError ? caught.payload.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  }, [
    tenant,
    token,
    search,
    zoneId,
    parcelNumber,
    structureType,
    lifecycleStatus,
    surveyStatus,
    damageLevel,
    withoutEntrance,
    labels,
    toast,
    en,
  ]);

  // ── Columns ───────────────────────────────────────────────────────
  const columns = useMemo<ColumnDef<BuildingLedgerRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: en ? 'Code' : 'الرمز',
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <span dir="ltr" className="block font-mono text-sm font-bold">
              {row.original.code}
            </span>
            {row.original.postedNumber ? (
              <span className="block text-[11px] text-muted-foreground">
                {en ? 'Door: ' : 'مكتوب: '}
                <span dir="ltr">{row.original.postedNumber}</span>
              </span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'name',
        header: en ? 'Name' : 'الاسم',
        cell: ({ row }) =>
          row.original.name ?? <span className="text-xs text-muted-foreground">—</span>,
      },
      {
        accessorKey: 'parcelNumber',
        header: en ? 'Parcel' : 'العقار',
        cell: ({ row }) => (
          <span dir="ltr" className="font-mono text-xs">
            {row.original.parcelNumber}
          </span>
        ),
      },
      {
        accessorKey: 'zoneName',
        header: en ? 'Sector' : 'القطاع',
        cell: ({ row }) =>
          row.original.zoneName ? (
            <span className="text-xs">{row.original.zoneName}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {en ? 'Unassigned' : 'بلا قطاع'}
            </span>
          ),
      },
      {
        accessorKey: 'structureType',
        header: en ? 'Structure' : 'المنشأة',
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="soft-muted">{labels.structureType[row.original.structureType]}</Badge>
            {/*
              Beside the type rather than in a column of its own, and only when
              it is not the ordinary answer.

              «قائم ومستعمل» is nineteen rows in twenty; printing it on all of
              them would add a column of noise to hide the one row that says
              «قيد الإنشاء». The exception is what the reader is scanning for.
            */}
            {row.original.lifecycleStatus !== 'IN_USE' ? (
              <Badge variant="soft-warning">
                {labels.buildingLifecycle[row.original.lifecycleStatus]}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: 'survey',
        header: en ? 'Surveyed' : 'المسح',
        cell: ({ row }) => {
          const { unitsSurveyed, unitsTotal } = row.original;
          const percent = unitsTotal > 0 ? Math.round((unitsSurveyed / unitsTotal) * 100) : 0;
          return (
            <div className="min-w-24 space-y-1">
              <p className="text-xs font-medium">
                <span dir="ltr">
                  {unitsSurveyed}/{unitsTotal}
                </span>
                {unitsTotal > 0 ? (
                  <span className="ms-1 text-muted-foreground">({percent}%)</span>
                ) : null}
              </p>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="presentation"
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    percent === 100 ? 'bg-success' : percent > 0 ? 'bg-primary' : 'bg-transparent',
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
              {unitsTotal === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {en ? 'No matrix yet' : 'لا مصفوفة بعد'}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'damageLevel',
        header: en ? 'Condition' : 'الحالة الإنشائية',
        cell: ({ row }) => {
          const level = row.original.damageLevel;
          if (!level) {
            return (
              <span className="text-xs text-muted-foreground">
                {en ? 'Not assessed' : 'لم يُكشف عليه'}
              </span>
            );
          }
          return (
            <Badge
              variant={DAMAGED_LEVELS.includes(level) ? 'soft-destructive' : 'soft-success'}
            >
              {labels.damageLevel[level]}
            </Badge>
          );
        },
      },
      {
        id: 'actions',
        header: en ? 'Actions' : 'إجراء',
        enableSorting: false,
        meta: { mobile: 'actions' },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <ActionTooltip label={en ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={en ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}
                onClick={() => router.push(`${base}/buildings/${row.original.id}/matrix`)}
              >
                <Grid3x3 className="size-4" aria-hidden />
              </Button>
            </ActionTooltip>

            {canWrite ? (
              <ActionTooltip label={en ? 'Edit' : 'تعديل'}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={en ? 'Edit' : 'تعديل'}
                  onClick={() => router.push(`${base}/buildings/${row.original.id}/edit`)}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>
            ) : null}

            {canDelete ? (
              <ActionTooltip label={en ? 'Delete' : 'حذف'}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={en ? 'Delete' : 'حذف'}
                  onClick={() => setPendingDelete(row.original)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>
            ) : null}
          </div>
        ),
      },
    ],
    [en, labels, canWrite, canDelete, base, router],
  );

  if (!token) return null;

  const surveyPercent =
    summary && summary.unitsTotal > 0
      ? Math.round((summary.unitsSurveyed / summary.unitsTotal) * 100)
      : 0;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Building2}
        title={en ? 'Building Census' : 'سجل المباني'}
        subtitle={
          en
            ? 'Every structure standing on a parcel, and how much of it has been surveyed. A building exists here before anyone inside it is registered.'
            : 'كل منشأة قائمة على عقار، وما أُنجز من مسحها. المبنى مسجَّل هنا قبل أن يُسجَّل أحد من ساكنيه.'
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void exportCsv()}
              disabled={exporting || total === 0}
            >
              {exporting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              {en ? 'Export CSV' : 'تصدير CSV'}
            </Button>
            {canWrite ? (
              <Button onClick={() => router.push(`${base}/buildings/new`)}>
                <Plus className="size-4" aria-hidden />
                {en ? 'New Building' : 'مبنى جديد'}
              </Button>
            ) : null}
          </>
        }
      />

      {/*
        Buildings still on this device, and any code that changed on the way in.

        Above the tiles because it is about records that are *not* in them yet:
        a provisional code an officer is still quoting is the one thing on this
        screen that can be wrong in a way nothing else would reveal.
      */}
      <BuildingQueueNotice tenant={tenant} locale={locale} />

      {/* ── The dispatch decision, in four numbers ─────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label={en ? 'Buildings' : 'عدد المباني'}
          value={(summary?.buildings ?? 0).toLocaleString('en-US')}
          subtext={
            activeFilters > 0
              ? en
                ? 'Matching the current filters'
                : 'ضمن الفلاتر المطبّقة'
              : en
                ? 'Across the whole municipality'
                : 'في كامل نطاق البلدية'
          }
          loading={query.loading}
          icon={<Building2 className="size-6 text-primary" />}
        />
        <MetricCard
          label={en ? 'Units surveyed' : 'نسبة المسح'}
          value={`${surveyPercent}%`}
          subtext={
            summary
              ? en
                ? `${summary.unitsSurveyed.toLocaleString('en-US')} of ${summary.unitsTotal.toLocaleString('en-US')} units`
                : `${summary.unitsSurveyed.toLocaleString('en-US')} من ${summary.unitsTotal.toLocaleString('en-US')} وحدة`
              : undefined
          }
          loading={query.loading}
          icon={<ClipboardCheck className="size-6 text-success" />}
          accent="bg-success/10"
        />
        <MetricCard
          label={en ? 'Damaged buildings' : 'مبانٍ متضررة'}
          value={(summary?.damaged ?? 0).toLocaleString('en-US')}
          subtext={
            en
              ? 'Restricted use, unsafe or collapsed'
              : 'استخدام مقيّد أو غير آمن أو منهار'
          }
          loading={query.loading}
          icon={<ShieldAlert className="size-6 text-destructive" />}
          accent="bg-destructive/10"
        />
        <MetricCard
          label={en ? 'Unsurveyed units' : 'وحدات غير ممسوحة'}
          value={(summary?.unitsUnsurveyed ?? 0).toLocaleString('en-US')}
          /*
            Says why the number is smaller than the matrix totals suggest.

            Units in structures nobody can be inside — permitted, going up,
            demolished, never built — are out of these figures, and a coverage
            percentage that improved because somebody marked a block demolished
            has to be explainable on the screen showing it rather than only in
            the audit log.
          */
          subtext={
            summary && summary.unitsOutOfScope > 0
              ? en
                ? `Doors still to be knocked on · ${summary.unitsOutOfScope.toLocaleString('en-US')} excluded (not standing)`
                : `أبواب لم يُطرق عليها بعد · ${summary.unitsOutOfScope.toLocaleString('en-US')} مستثناة (منشآت غير قائمة)`
              : en
                ? 'Doors still to be knocked on'
                : 'أبواب لم يُطرق عليها بعد'
          }
          loading={query.loading}
          icon={<DoorOpen className="size-6 text-warning" />}
          accent="bg-warning/10"
        />
        {/*
          «بلا مدخل مُثبت» — the doors nobody has stood at.

          No entrance is ever guessed for a building (D19): the parcel centroid
          is the middle of a plot where no structure stands, it is the same
          point for every structure on that plot, and stored in the column that
          means "the entrance" a guess is indistinguishable from a surveyed
          fact. So a building created from a desk — or from the registration
          form, which always creates one this way — has no pin until a person
          places it.

          That is honest and it is also invisible, which is what this tile
          fixes. Tapping it filters the ledger to exactly those structures, so
          the gap is a morning's work rather than a number nobody can act on.
        */}
        <MetricCard
          label={en ? 'No entrance placed' : 'بلا مدخل مُثبت'}
          value={(summary?.withoutEntrance ?? 0).toLocaleString('en-US')}
          subtext={
            en
              ? 'Not on the map until someone pins the door'
              : 'لا تظهر على الخريطة حتى يُحدَّد بابها'
          }
          loading={query.loading}
          icon={<MapPinOff className="size-6 text-muted-foreground" />}
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Building2 className="size-5 text-primary" aria-hidden />
              {en ? 'Census Ledger' : 'سجل المباني'}
            </CardTitle>
            {activeFilters > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                <X className="size-3.5" aria-hidden />
                {en
                  ? `Clear ${activeFilters} filter(s)`
                  : `مسح ${activeFilters} فلتر`}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={rows}
            labels={getTableLabels(locale)}
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<Building2 className="h-10 w-10 text-muted-foreground/60" />}
            columnStorageKey="buildings"
            /*
              The whole census can run to thousands of rows, so the page, the
              search and every filter belong to the server. Sorting stays off
              rather than re-ordering the twenty-five rows in hand and calling it
              sorted; the server returns them newest first, so the building an
              officer has just filed is the first one they see.
            */
            manualPagination
            manualFiltering
            sortable={false}
            searchValue={search}
            onSearchChange={(value) => setFilter(() => setSearch(value))}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            activeFiltersCount={activeFilters}
            onClearFilters={clearFilters}
            filterBar={
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:flex-wrap md:items-center">
                  <div className="hidden items-center gap-1.5 text-xs font-medium text-muted-foreground xl:flex pe-1">
                    <Filter className="size-3.5 text-muted-foreground" aria-hidden />
                    <span>{en ? 'Filter:' : 'تصفية:'}</span>
                  </div>

                  <FilterSelect
                    label={en ? 'Sector' : 'القطاع'}
                    value={zoneId}
                    onChange={(value) => setFilter(() => setZoneId(value))}
                    options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                    allLabel={en ? 'All sectors' : 'كل القطاعات'}
                  />
                  <FilterSelect
                    label={en ? 'Structure' : 'المنشأة'}
                    value={structureType}
                    onChange={(value) => setFilter(() => setStructureType(value))}
                    options={STRUCTURE_TYPE.map((value) => ({
                      value,
                      label: labels.structureType[value],
                    }))}
                    allLabel={en ? 'All structures' : 'كل الأنواع'}
                  />
                  <FilterSelect
                    label={en ? 'Construction' : 'الحالة الإنشائية'}
                    value={lifecycleStatus}
                    onChange={(value) => setFilter(() => setLifecycleStatus(value))}
                    options={BUILDING_LIFECYCLE.map((value) => ({
                      value,
                      label: labels.buildingLifecycle[value],
                    }))}
                    allLabel={en ? 'Any construction status' : 'كل الحالات الإنشائية'}
                  />
                  <FilterSelect
                    label={en ? 'Survey' : 'المسح'}
                    value={surveyStatus}
                    onChange={(value) => setFilter(() => setSurveyStatus(value))}
                    options={SURVEY_STATUS.map((value) => ({
                      value,
                      label: labels.surveyStatus[value],
                    }))}
                    allLabel={en ? 'Any survey status' : 'كل حالات المسح'}
                  />
                  <FilterSelect
                    label={en ? 'Condition' : 'الضرر'}
                    value={damageLevel}
                    onChange={(value) => setFilter(() => setDamageLevel(value))}
                    options={DAMAGE_LEVEL.map((value) => ({
                      value,
                      label: labels.damageLevel[value],
                    }))}
                    allLabel={en ? 'Any condition' : 'كل مستويات الضرر'}
                  />

                  {/* Parcel input with clear button */}
                  <div className="relative w-full sm:w-32">
                    <input
                      value={parcelInput}
                      onChange={(event) => setParcelInput(event.target.value)}
                      dir="ltr"
                      inputMode="numeric"
                      aria-label={en ? 'Filter by parcel number' : 'تصفية حسب رقم العقار'}
                      placeholder={en ? 'Parcel #' : 'رقم العقار'}
                      className={cn(
                        'h-9 w-full rounded-md border bg-background px-3 text-start text-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors',
                        parcelInput
                          ? 'border-primary/60 bg-primary/5 text-primary font-medium pe-7'
                          : 'border-input hover:bg-accent/50',
                      )}
                    />
                    {parcelInput ? (
                      <button
                        type="button"
                        onClick={() => setParcelInput('')}
                        aria-label={en ? 'Clear parcel number' : 'مسح رقم العقار'}
                        className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>

                  {/* Without entrance toggle */}
                  <button
                    type="button"
                    onClick={() => setFilter(() => setWithoutEntrance((on) => !on))}
                    aria-pressed={withoutEntrance}
                    className={cn(
                      'flex h-9 w-full sm:w-auto items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors',
                      withoutEntrance
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-input bg-background hover:bg-accent/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <MapPinOff className="size-3.5" aria-hidden />
                    {en ? 'No entrance' : 'بلا مدخل'}
                  </button>

                  {/* Reset filters shortcut button right inside filterBar */}
                  {activeFilters > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFilters}
                      className="h-9 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="size-3.5" aria-hidden />
                      {en ? 'Reset' : 'مسح الفلاتر'}
                    </Button>
                  ) : null}
                </div>
              </div>
            }
          />
        </CardContent>
      </Card>

      {/*
        A survey filter narrows to buildings with *at least one* unit in that
        state, not to buildings entirely in it — one unanswered flat is what
        sends an officer back, and it must not hide behind eleven surveyed ones
        (D11). Said here because the alternative reading is the natural one.
      */}
      {surveyStatus ? (
        <p className="text-xs text-muted-foreground">
          {en
            ? 'A survey filter shows every building with at least one unit in that state — one unsurveyed flat is enough.'
            : 'فلتر المسح يعرض كل مبنى فيه وحدة واحدة على الأقل بهذه الحالة — وحدة واحدة غير ممسوحة تكفي.'}
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={en ? 'Delete Building' : 'حذف المبنى'}
        description={
          pendingDelete ? (
            en ? (
              <>
                Building <span className="font-semibold text-foreground">{pendingDelete.code}</span>{' '}
                and its {pendingDelete.unitsTotal} unit(s) will be deleted. This is refused if
                anyone is recorded as living in it.
              </>
            ) : (
              <>
                سيُحذف المبنى{' '}
                <span className="font-semibold text-foreground">{pendingDelete.code}</span> مع{' '}
                {pendingDelete.unitsTotal} وحدة تابعة له. يُرفض الحذف إذا كان أحد مسجَّلاً كساكن
                فيه.
              </>
            )
          ) : null
        }
        confirmLabel={en ? 'Delete' : 'حذف'}
        cancelLabel={en ? 'Cancel' : 'إلغاء'}
        onConfirm={async () => {
          if (pendingDelete) await removeBuilding(pendingDelete);
        }}
      />
    </div>
  );
}

/** One filter select, with its own «الكل» option carrying the empty value. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
}) {
  /*
    Radix refuses an empty-string `SelectItem` value, because that is how it
    spells "nothing selected". So «الكل» carries a sentinel and is translated at
    the boundary — the filter state stays an empty string, which is what the
    query builder already treats as absent.
  */
  const ALL = '__all__';
  return (
    <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? '' : next)}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          'h-9 w-full sm:w-auto min-w-[130px] flex-1 sm:flex-initial gap-2 text-xs transition-colors',
          value
            ? 'border-primary/60 bg-primary/5 text-primary font-medium'
            : 'border-input bg-background hover:bg-accent/50',
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MetricCard({
  label,
  value,
  subtext,
  loading,
  icon,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  subtext?: string;
  loading: boolean;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-7 w-20" />
          ) : (
            <div className="text-xl font-bold tracking-tight text-foreground">{value}</div>
          )}
          {subtext && !loading ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{subtext}</p>
          ) : null}
        </div>
        <div
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10',
            accent,
          )}
        >
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}
