'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CheckCircle2,
  ClipboardList,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  TrendingUp,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { CitizenListItem } from '@/lib/api-client';
import { ApiRequestError, deleteCase, getCases, logApiError, updateCase } from '@/lib/api-client';
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

  const items = useMemo(() => query.data?.cases ?? [], [query.data]);
  const error = actionError;

  /**
   * The number this whole bridge exists to answer. Of every case ever
   * resolved — not just the ones logged today — how many actually turned
   * into a registered citizen versus closing some other way (confirmed
   * vacant, refused, duplicate).
   */
  const conversion = useMemo(() => {
    const resolved = items.filter((item) => item.status === 'RESOLVED');
    const withCitizen = resolved.filter((item) => item.resolvedCitizenId);
    return { resolvedCount: resolved.length, linkedCount: withCitizen.length };
  }, [items]);

  const queryClient = useQueryClient();
  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['cases', tenant] }),
    [queryClient, tenant],
  );

  const toggleStatus = useCallback(
    async (item: CaseSummary) => {
      if (!token) return;
      setBusyId(item.id);
      const resolving = item.status === 'OPEN';
      try {
        await updateCase(tenant, token, item.id, { status: resolving ? 'RESOLVED' : 'OPEN' });
        await load();
        toast.success(resolving ? 'تم وضع علامة محلولة' : 'تمت إعادة فتح الحالة');
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : 'تعذّر تحديث الحالة.';
        setActionError(message);
        toast.error('تعذّر تحديث الحالة', { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
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
                  {locale === 'en' ? 'Resolved' : 'محلولة'}
                </Badge>
              ) : (
                <Badge className="gap-1.5 py-1" variant="outline">
                  {locale === 'en' ? 'Open' : 'مفتوحة'}
                </Badge>
              )}
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

              <ActionTooltip
                label={
                  item.status === 'OPEN'
                    ? (locale === 'en' ? 'Mark Resolved' : 'وضع علامة محلولة')
                    : (locale === 'en' ? 'Reopen' : 'إعادة فتح')
                }
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Toggle status' : 'تغيير الحالة'}
                  disabled={busy}
                  onClick={() => void toggleStatus(item)}
                >
                  {item.status === 'OPEN' ? (
                    <CheckCircle2 className="size-4" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                </Button>
              </ActionTooltip>

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
    [busyId, canWrite, canDelete, locale, labels, toggleStatus, router, base],
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
            {locale === 'en' ? 'Log a Case' : 'تسجيل حالة'}
          </Button>
        ) : null}
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
