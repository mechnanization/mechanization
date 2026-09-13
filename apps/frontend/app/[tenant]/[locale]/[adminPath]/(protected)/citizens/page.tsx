'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Ban,
  Banknote,
  CheckCircle2,
  Clock3,
  FileQuestion,
  FileSpreadsheet,
  Loader2,
  MessageCircle,
  Pencil,
  Phone,
  RotateCcw,
  Trash2,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import {
  ApiRequestError,
  deleteCitizen,
  getTenantConfig,
  importCitizens,
  listCitizens,
  logApiError,
  setCitizenActive,
} from '@/lib/api-client';
import { ImportCitizensDialog } from '@/components/admin/import-citizens-dialog';
import { ShellLink } from '@/components/admin/shell-nav';
import { OfflineQueuePanel } from '@/components/admin/offline-queue';
import { PageHeader } from '@/components/ui/page-header';
import type { CitizenListItem } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { buildCitizenWelcomeMessage, buildWhatsappHref } from '@/lib/whatsapp';
import { getLabels } from '@mechanization/shared-schemas';

/** Roles allowed to write. Mirrors the server; the server is the enforcement. */
const CAN_WRITE = ['SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'];

function getTableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search citizens',
      searchPlaceholder: 'Search by name, phone, reference code, or ID…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'No citizens registered yet.',
      emptyHint: 'Add your first citizen, or import records from an Excel spreadsheet.',
      emptySearch: 'No results match your search.',
      emptySearchHint: 'Try the first name alone, the reference number, or the phone number without leading zeros.',
      loadError: 'Failed to load citizens registry.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} citizens',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      sortNone: 'Clear sorting',
      columns: 'Columns',
      columnsHint: 'Visible columns',
      resetColumns: 'Reset to default',
    };
  }
  return {
    searchAriaLabel: 'بحث في المواطنين',
    searchPlaceholder: 'ابحث بالاسم، رقم الهاتف، الرقم المرجعي، أو رقم الهوية…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا يوجد مواطنون مسجّلون بعد.',
    emptyHint: 'أضف أول مواطن، أو استورد سجلاً من ملف Excel.',
    emptySearch: 'لا نتائج مطابقة لبحثك.',
    emptySearchHint: 'جرّب الاسم الأول وحده، أو الرقم المرجعي، أو رقم الهاتف بدون صفر البداية.',
    loadError: 'تعذّر تحميل سجل المواطنين.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'عدد الصفوف',
    totalRows: '{count} مواطن',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'استعادة الافتراضي',
  };
}

/**
 * The citizen registry — the municipality's own record of who is registered,
 * what they registered, and what they owe.
 *
 * This screen exists because the public wizard no longer does. A claim is now
 * entered here by a clerk from the papers a citizen brings in, which makes
 * this the place the registry is created and corrected rather than a read-only
 * view of what arrived overnight. The dashboard remains the *review* queue —
 * one row per طلب, ordered by what needs deciding; this is one row per person,
 * ordered by who they are, and it is the only screen that shows a citizen's
 * claims and their money side by side.
 */
export default function CitizensPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();
  /**
   * The page and the search are request parameters now.
   *
   * The registry endpoint has always taken `limit`/`offset` and returned a
   * `total`; the page ignored all three, fetched the first 200 rows and then
   * paginated *those* in the browser. A municipality with more than 200
   * registered citizens was shown a page counter that described a slice, with
   * no way to reach the rest.
   */
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  /** The committed term — set when the clerk presses Enter, not as they type. */
  const [appliedSearch, setAppliedSearch] = useState('');
  /**
   * Whether the table is narrowed to records still needing to be finished.
   *
   * A toggle rather than a saved filter or a page of its own: «يتطلب مراجعة»
   * is a slice of the register, not a different register, and someone working
   * through it needs to be able to drop back to the whole thing in one tap
   * when a name they are looking for is not in the queue.
   */
  const [reviewOnly, setReviewOnly] = useState(false);
  /** A failed *write*. The read's own failure is the table's, via `useStaffQuery`. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** The row whose deletion is being confirmed, or null. */
  const [pendingDelete, setPendingDelete] = useState<CitizenListItem | null>(null);
  const toast = useToast();
  /** Prefixed with «بلدية» in the WhatsApp reference-number message below. */
  const [municipalityName, setMunicipalityName] = useState('');

  const canWrite = role ? CAN_WRITE.includes(role) : false;
  const canDelete = role === 'SUPER_ADMIN';

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role);

    // Public endpoint, and non-blocking: the registry renders fine without it,
    // the WhatsApp message just falls back to a generic «البلدية».
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(config.nameAr || config.name))
      .catch(() => setMunicipalityName(tenant));
  }, [tenant, base, router]);

  /*
    Every parameter that changes the answer is in the key, and nothing else is.

    That is what makes the read correct as well as cached: React Query cancels
    the outgoing request the moment the key changes, so the two-requests-in-
    flight race this page used to have — a filter change fired one read at the
    old offset and the page reset fired another at zero, and the slower reply
    won — cannot happen. The `useEffect` that reset the page here is gone with
    it; `DataTable` already returns to page one when a search is committed, and
    doing it twice was what opened the race in the first place.
  */
  const query = useStaffQuery({
    queryKey: [
      'citizens',
      tenant,
      appliedSearch,
      reviewOnly,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      listCitizens(
        tenant,
        accessToken,
        {
          search: appliedSearch || undefined,
          status: reviewOnly ? 'REQUIRES_REVIEW' : undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل سجل المواطنين.',
    keepPrevious: true,
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totals = query.data?.totals ?? {
    outstanding: 0,
    overdue: 0,
    inArrears: 0,
    requiringReview: 0,
  };
  /*
    The banner above the page and the state inside the table say different
    things, and used to say the same one twice.

    A failed *read* belongs to the table: it is the table that has no rows to
    show, it is the table that needs the retry button, and a table rendering
    «لا توجد نتائج» after a request failed is telling the reader the register is
    empty when it is only unreachable. A failed *write* has no such home — the
    rows are fine, an action was refused — so that is what the banner is for.
  */
  const error = actionError;

  /**
   * Re-reads the registry after a write.
   *
   * Keyed on the tenant rather than on the exact page, so a deletion made while
   * a search is applied also refreshes the unfiltered list behind it — the two
   * are the same register, and leaving one of them holding the deleted row is
   * how a clerk ends up looking at a citizen who is not there.
   */
  const queryClient = useQueryClient();
  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['citizens', tenant] }),
    [queryClient, tenant],
  );

  const toggleActive = useCallback(
    async (citizen: CitizenListItem) => {
      if (!token) return;
      setBusyId(citizen.id);
      const reactivating = !citizen.isActive;
      try {
        await setCitizenActive(tenant, token, citizen.id, reactivating);
        await load();
        toast.success(
          reactivating ? 'تمت إعادة تفعيل الملف' : 'تم تعطيل الملف',
          {
            description: reactivating
              ? `${citizen.fullName} — يمكن الآن إصدار رسوم جديدة على هذا الملف.`
              : `${citizen.fullName} — لن تُصدر رسوم جديدة. السجل والفواتير القائمة كما هي.`,
          },
        );
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError ? caught.message : 'تعذّر تحديث الحساب.';
        setActionError(message);
        toast.error('تعذّر تحديث الحساب', { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
  );

  /*
   * Deletion is confirmed in a dialog rather than `confirm()`.
   *
   * The browser's prompt is unstyled, LTR whatever the page direction, and
   * renders "\n\n" as literal characters in some browsers — so the sentence
   * naming what is about to be destroyed arrived as one run-on line. It also
   * offers a Cancel/OK pair that gives no clue which button is the
   * irreversible one. This asks for the citizen's own name to be typed, which
   * is the one confirmation muscle memory cannot dismiss.
   */
  const removeCitizen = useCallback(
    async (citizen: CitizenListItem) => {
      if (!token) throw new Error('انتهت الجلسة.');
      setBusyId(citizen.id);
      try {
        await deleteCitizen(tenant, token, citizen.id);
        await load();
        toast.success('تم حذف الملف نهائياً', { description: citizen.fullName });
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError ? caught.message : 'تعذّر حذف الملف.';
        setActionError(message);
        // Rethrown so ConfirmDialog stays open and shows the reason in place:
        // a refusal usually names something the clerk must deal with first.
        throw new Error(message);
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
  );

  const labels = getLabels(locale);

  const columns = useMemo<ColumnDef<CitizenListItem>[]>(
    () => [
      {
        accessorKey: 'fullName',
        header: locale === 'en' ? 'Citizen' : 'المواطن',
        enableHiding: false,
        meta: { label: locale === 'en' ? 'Citizen' : 'المواطن' },
        cell: ({ row }) => {
          const citizen = row.original;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
              >
                <UserRound className="size-4" />
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{citizen.fullName}</span>
                  {/*
                    «مالك غير مقيم» on the name, like «معطّل»: an owner record
                    is short by design, and the badge is what stops a clerk
                    reading its empty household fields as a record left
                    unfinished.
                  */}
                  {citizen.residence === 'NON_RESIDENT_OWNER' ? (
                    <Badge variant="soft-info" className="shrink-0 py-0">
                      {locale === 'en' ? 'Owner, lives elsewhere' : 'مالك غير مقيم'}
                    </Badge>
                  ) : null}
                  {!citizen.isActive ? (
                    <Badge variant="outline" className="shrink-0 gap-1 py-0">
                      <Ban className="size-3" aria-hidden />
                      {locale === 'en' ? 'Disabled' : 'معطّل'}
                    </Badge>
                  ) : null}
                  {/*
                    On the name rather than in a column of its own, and never
                    hideable: an incomplete record is a fact about the person,
                    not a statistic about them, and it has to reach whoever
                    opens their file to bill them — including the desk that
                    turned every optional column off months ago.
                  */}
                  {citizen.latestStatus === 'REQUIRES_REVIEW' ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 gap-1 border-warning/40 bg-warning/10 py-0 text-warning"
                    >
                      <FileQuestion className="size-3" aria-hidden />
                      {locale === 'en'
                        ? `Requires review (${citizen.unestablishedFieldCount})`
                        : `يتطلب مراجعة (${citizen.unestablishedFieldCount})`}
                    </Badge>
                  ) : null}
                </p>
                {citizen.referenceNumber ? (
                  <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                    {citizen.referenceNumber}
                  </p>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'phone',
        header: locale === 'en' ? 'Phone' : 'الهاتف',
        meta: { label: locale === 'en' ? 'Phone' : 'الهاتف' },
        enableSorting: false,
        cell: ({ row }) => {
          const { phone } = row.original;
          if (!phone) return <span className="text-muted-foreground">—</span>;
          return (
            <a
              href={`tel:${phone}`}
              dir="ltr"
              className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
            >
              <Phone className="size-3.5 shrink-0" aria-hidden />
              {phone}
            </a>
          );
        },
      },
      {
        accessorKey: 'whatsapp',
        header: locale === 'en' ? 'WhatsApp' : 'واتساب',
        meta: { label: locale === 'en' ? 'WhatsApp' : 'واتساب' },
        enableSorting: false,
        cell: ({ row }) => {
          const { phone, whatsapp } = row.original;
          if (!whatsapp) return <span className="text-muted-foreground">—</span>;
          return (
            <a
              href={`https://wa.me/${whatsapp.replace(/\D/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
            >
              <MessageCircle className="size-3.5 shrink-0" aria-hidden />
              {whatsapp}
              {whatsapp === phone ? (
                <span className="text-xs text-muted-foreground">
                  {locale === 'en' ? '(same)' : '(نفس الهاتف)'}
                </span>
              ) : null}
            </a>
          );
        },
      },
      {
        accessorKey: 'identityDocNumber',
        header: locale === 'en' ? 'ID Document' : 'وثيقة الهوية',
        meta: { label: locale === 'en' ? 'ID Document' : 'وثيقة الهوية', mobile: 'hide' },
        enableSorting: false,
        cell: ({ row }) => {
          const { identityDocType, identityDocNumber } = row.original;
          if (!identityDocNumber) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="space-y-0.5">
              <p className="font-mono text-sm" dir="ltr">
                {identityDocNumber}
              </p>
              {identityDocType ? (
                <p className="text-xs text-muted-foreground">
                  {labels.identityDocType?.[identityDocType as never] ?? identityDocType}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'residentStatus',
        header: locale === 'en' ? 'Residency Status' : 'صفة الإقامة',
        meta: { label: locale === 'en' ? 'Residency Status' : 'صفة الإقامة', mobile: 'hide' },
        enableSorting: false,
        cell: ({ row }) => {
          const { residentStatus } = row.original;
          if (!residentStatus) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge variant="soft-muted">
              {labels.residentStatus?.[residentStatus as never] ?? residentStatus}
            </Badge>
          );
        },
      },
      {
        accessorKey: 'registeredAt',
        header: locale === 'en' ? 'Registration Date' : 'تاريخ التسجيل',
        meta: {
          label: locale === 'en' ? 'Registration Date' : 'تاريخ التسجيل',
          cellClassName: 'whitespace-nowrap',
          mobile: 'hide',
        },
        cell: ({ row }) => (
          <span className="text-sm">{formatDate(row.original.registeredAt)}</span>
        ),
      },
      {
        accessorKey: 'propertyCount',
        header: locale === 'en' ? 'Properties' : 'العقارات',
        meta: { label: locale === 'en' ? 'Properties' : 'العقارات' },
        cell: ({ row }) => {
          const citizen = row.original;
          if (citizen.propertyCount === 0) {
            return (
              <span className="text-sm text-muted-foreground">
                {locale === 'en' ? 'No properties' : 'لا توجد عقارات'}
              </span>
            );
          }
          return (
            <div className="space-y-0.5">
              <p className="font-medium tabular-nums">
                {citizen.propertyCount} {locale === 'en' ? 'properties' : 'عقار'}
              </p>
              {citizen.latestSubmittedAt ? (
                <p className="whitespace-nowrap text-xs text-muted-foreground">
                  {locale === 'en' ? 'Last registered ' : 'آخر تسجيل '}
                  {formatDate(citizen.latestSubmittedAt)}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'feesTotal',
        header: locale === 'en' ? 'Fees' : 'الرسوم',
        meta: {
          label: locale === 'en' ? 'Fees' : 'الرسوم',
          cellClassName: 'whitespace-nowrap',
        },
        cell: ({ row }) => {
          const citizen = row.original;
          if (citizen.feesTotal === 0) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <div className="space-y-0.5">
              <Money amount={citizen.feesTotal} className="block font-medium" />
              <p className="text-xs text-muted-foreground">
                {locale === 'en' ? 'Paid ' : 'مسدّد '}
                <Money amount={citizen.paidTotal} />
              </p>
            </div>
          );
        },
      },
      {
        accessorKey: 'overdueTotal',
        header: locale === 'en' ? 'Overdue' : 'المتأخرات',
        meta: {
          label: locale === 'en' ? 'Overdue' : 'المتأخرات',
          cellClassName: 'whitespace-nowrap',
        },
        cell: ({ row }) => {
          const citizen = row.original;
          if (citizen.outstandingTotal === 0) {
            return (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                {locale === 'en' ? 'No arrears' : 'لا متأخرات'}
              </span>
            );
          }

          return (
            <div className="space-y-1">
              <p
                className={cn(
                  'inline-flex items-center gap-1.5 font-semibold',
                  citizen.overdueTotal > 0 ? 'text-destructive' : 'text-foreground',
                )}
              >
                {citizen.overdueTotal > 0 ? (
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                ) : null}
                <Money
                  amount={
                    citizen.overdueTotal > 0 ? citizen.overdueTotal : citizen.outstandingTotal
                  }
                />
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {citizen.overdueTotal > 0 ? (
                  <span>
                    {citizen.overdueCount} {locale === 'en' ? 'overdue bills' : 'فاتورة متأخرة'}
                  </span>
                ) : (
                  <span>{locale === 'en' ? 'Not yet due' : 'غير مستحقة بعد'}</span>
                )}
                {citizen.pendingReviewCount > 0 ? (
                  <Badge variant="outline" className="gap-1 py-0 text-[0.7rem]">
                    <Clock3 className="size-3" aria-hidden />
                    {citizen.pendingReviewCount} {locale === 'en' ? 'under review' : 'قيد التحقق'}
                  </Badge>
                ) : null}
              </p>
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: locale === 'en' ? 'Actions' : 'إجراء',
        enableHiding: false,
        enableSorting: false,
        meta: { label: locale === 'en' ? 'Actions' : 'إجراء', mobile: 'actions' },
        cell: ({ row }) => {
          const citizen = row.original;
          const busy = busyId === citizen.id;
          const waMessage = buildCitizenWelcomeMessage({
            fullName: citizen.fullName,
            gender: citizen.gender,
            referenceNumber: citizen.referenceNumber,
            municipalityName,
          });
          const waHref = buildWhatsappHref(citizen.whatsapp || citizen.phone, waMessage);

          return (
            <div className="flex items-center gap-1.5">
              <ActionTooltip label={locale === 'en' ? 'View details & invoices' : 'عرض التفاصيل والفواتير'}>
                <Link
                  href={`${base}/citizens/${citizen.id}`}
                  aria-label={locale === 'en' ? 'View details' : 'عرض التفاصيل'}
                  className={buttonVariants({ variant: 'secondary', size: 'icon-sm' })}
                >
                  <UserRound className="size-4" aria-hidden />
                </Link>
              </ActionTooltip>

              {waHref ? (
                <ActionTooltip label={locale === 'en' ? 'Send reference number via WhatsApp' : 'إرسال الرقم المرجعي عبر واتساب'}>
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={locale === 'en' ? 'Send via WhatsApp' : 'إرسال عبر واتساب'}
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'icon-sm',
                      className:
                        'border-emerald-600/30 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70',
                    })}
                  >
                    <MessageCircle className="size-4" aria-hidden />
                  </a>
                </ActionTooltip>
              ) : null}

              {canWrite ? (
                <ActionTooltip label={locale === 'en' ? 'Edit information' : 'تعديل البيانات'}>
                  <Link
                    href={`${base}/citizens/${citizen.id}/edit`}
                    aria-label={locale === 'en' ? 'Edit' : 'تعديل'}
                    className={buttonVariants({ variant: 'outline', size: 'icon-sm' })}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Link>
                </ActionTooltip>
              ) : null}

              {canWrite ? (
                <ActionTooltip
                  label={
                    citizen.isActive
                      ? (locale === 'en' ? 'Disable — halts new fees' : 'تعطيل — يوقف إصدار الرسوم')
                      : (locale === 'en' ? 'Re-activate' : 'إعادة التفعيل')
                  }
                >
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={citizen.isActive ? (locale === 'en' ? 'Disable' : 'تعطيل') : (locale === 'en' ? 'Re-activate' : 'إعادة التفعيل')}
                    disabled={busy}
                    onClick={() => void toggleActive(citizen)}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : citizen.isActive ? (
                      <Ban className="size-4" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )}
                  </Button>
                </ActionTooltip>
              ) : null}

              {canDelete && citizen.registrationCount === 0 ? (
                <ActionTooltip label={locale === 'en' ? 'Permanent delete — no applications on file' : 'حذف نهائي — لا طلبات على هذا الملف'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Permanent delete' : 'حذف نهائي'}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    onClick={() => setPendingDelete(citizen)}
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
    [base, busyId, canWrite, canDelete, toggleActive, locale, labels, municipalityName],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Users}
        title={locale === 'en' ? 'Citizens' : 'المواطنون'}

        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <FileSpreadsheet className="size-4" aria-hidden />
                {locale === 'en' ? 'Import from file' : 'استيراد من ملف'}
              </Button>
              <ShellLink href={`${base}/citizens/new`} className={buttonVariants()}>
                <UserPlus className="size-4" aria-hidden />
                {locale === 'en' ? 'Register new citizen' : 'تسجيل مواطن جديد'}
              </ShellLink>
            </>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={locale === 'en' ? 'Total Citizens' : 'إجمالي المواطنين'}
          value={total.toLocaleString('en-US')}
          loading={query.loading}
          icon={<Users className="size-6 text-primary" aria-hidden />}
        />
        <MetricCard
          label={locale === 'en' ? 'Unpaid Fees' : 'رسوم غير مسدّدة'}
          value={<Money amount={totals.outstanding} />}
          loading={query.loading}
          icon={<Wallet className="size-6 text-primary" aria-hidden />}
        />
        <MetricCard
          label={locale === 'en' ? 'Overdue Arrears' : 'متأخرات مستحقة'}
          value={<Money amount={totals.overdue} />}
          loading={query.loading}
          icon={<Banknote className="size-6 text-destructive" aria-hidden />}
          accent="bg-destructive/10"
        />
        <MetricCard
          label={locale === 'en' ? 'Citizens in Arrears' : 'مواطنون متأخرون'}
          value={totals.inArrears.toLocaleString('en-US')}
          loading={query.loading}
          icon={<TriangleAlert className="size-6 text-warning" aria-hidden />}
          accent="bg-warning/10"
        />
      </div>

      {/*
        Records this device is still holding, above the table rather than
        beside it. As far as the officer is concerned these people *are*
        registered — putting the queue anywhere else invites reading the table
        below as the complete register when it is not yet.
      */}
      <OfflineQueuePanel tenant={tenant} base={base} locale={locale} />

      {/*
        The review queue, offered only when there is one.

        A permanent tab reading «يتطلب مراجعة (٠)» is a standing invitation to
        check something that is never there. It appears when a record needs
        finishing — and stays visible while the filter is on, so the way back
        out is where the way in was.
      */}
      {totals.requiringReview > 0 || reviewOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={reviewOnly ? 'default' : 'outline'}
            onClick={() => {
              setReviewOnly((current) => !current);
              setPagination((current) => ({ ...current, pageIndex: 0 }));
            }}
            className="h-8 gap-1.5 px-3 text-xs"
          >
            <FileQuestion className="size-3.5" aria-hidden />
            {locale === 'en'
              ? `Requires review (${totals.requiringReview})`
              : `يتطلب مراجعة (${totals.requiringReview})`}
          </Button>
          <p className="text-xs text-muted-foreground">
            {locale === 'en'
              ? 'Records filed with fields the officer could not establish. Open one to see the reason given for each.'
              : 'سجلات حُفظت بحقول لم يتمكّن الموظف من التثبّت منها. افتح السجل لقراءة سبب كل حقل.'}
          </p>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="size-5" aria-hidden />
            {locale === 'en' ? 'Citizens Registry' : 'سجل المواطنين'}
          </CardTitle>

        </CardHeader>
        <CardContent className="p-6">
          <DataTable
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<Users className="h-10 w-10 text-muted-foreground/60" />}
            /*
              The column layout is a per-desk preference, remembered here.
              A clerk chasing arrears wants المتأخرات and no identity document;
              the one entering records wants the reverse — and re-picking it on
              every page load is what stops people using the feature at all.
            */
            columnStorageKey="citizens"
            /*
              Off by default. Eleven columns at once is a table nobody can read;
              these four are the ones a clerk turns on for a specific job — the
              identity document when verifying papers, صفة الإقامة when
              reporting, تاريخ التسجيل when auditing intake. واتساب starts
              hidden because it usually repeats the landline, and the pair is
              only worth two columns when a municipality actually works over it.
            */
            initialHiddenColumns={[
              'whatsapp',
              'identityDocNumber',
              'residentStatus',
              'registeredAt',
            ]}
            /*
              The registry can run to thousands of rows, so the page and the
              search both belong to the server. Sorting stays off rather than
              re-ordering the twenty-five rows in hand and calling it sorted;
              the server returns newest-registered first.
            */
            manualPagination
            manualFiltering
            sortable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            /* The box holds its own draft; this fires once, on Enter. */
            searchValue={appliedSearch}
            onSearchChange={setAppliedSearch}
          />
        </CardContent>
      </Card>

      <ImportCitizensDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={(input) => {
          // `token` is non-null past the guard above; the dialog never renders
          // before it is set.
          if (!token) return Promise.reject(new Error('انتهت الجلسة.'));
          return importCitizens(tenant, token, input);
        }}
        onDone={() => void load()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={locale === 'en' ? 'Delete Record Permanently' : 'حذف الملف نهائياً'}
        description={
          pendingDelete ? (
            locale === 'en' ? (
              <>
                The record for{' '}
                <span className="font-semibold text-foreground">{pendingDelete.fullName}</span>{' '}
                will be deleted permanently. This cannot be undone.
                <span className="mt-2 block text-muted-foreground">
                  If the goal is to remove them from active use, &quot;Disable&quot; is sufficient and
                  reversible.
                </span>
              </>
            ) : (
              <>
                سيُحذف ملف <span className="font-semibold text-foreground">{pendingDelete.fullName}</span>{' '}
                نهائياً. لا يمكن التراجع.
                <span className="mt-2 block text-muted-foreground">
                  إن كان الهدف إخراجه من الاستخدام الفعلي فقط، «التعطيل» يكفي ويمكن التراجع عنه.
                </span>
              </>
            )
          ) : null
        }
        confirmLabel={locale === 'en' ? 'Delete Permanently' : 'حذف نهائي'}
        cancelLabel={locale === 'en' ? 'Cancel' : 'إلغاء'}
        requireText={pendingDelete?.fullName}
        requireTextHint={
          locale === 'en'
            ? 'Type the full citizen name to confirm'
            : 'اكتب اسم المواطن بالكامل للتأكيد'
        }
        onConfirm={async () => {
          if (pendingDelete) await removeCitizen(pendingDelete);
        }}
      />
    </div>
  );
}

/**
 * A single KPI widget: label, value, and an accent icon chip.
 *
 * The value block takes `value` as a node rather than a string so a money
 * tile can hand it a `<Money>` — compacted, with the exact figure on hover.
 * It also carries no `truncate`: clipping "1,250,000,000 ل.ل" to
 * "1,250,000,0…" is strictly worse than the shorthand, and with `Money`
 * doing the shortening there is nothing left to clip. The icon chip is the
 * part that yields (`shrink-0` on the chip, `min-w-0` on the text) so a long
 * figure never pushes it out of the card.
 */
function MetricCard({
  label,
  value,
  loading,
  icon,
  accent = 'bg-accent',
}: {
  label: string;
  value: React.ReactNode;
  loading: boolean;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <div className="text-2xl font-bold tabular-nums">{loading ? '—' : value}</div>
        </div>
        <div className={`shrink-0 rounded-lg p-3 ${accent}`}>{icon}</div>
      </CardContent>
    </Card>
  );
}
