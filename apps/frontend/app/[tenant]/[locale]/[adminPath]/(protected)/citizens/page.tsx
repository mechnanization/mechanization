'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Archive,
  Banknote,
  Building2,
  CheckCircle2,
  Clock3,
  FileQuestion,
  FileSpreadsheet,
  GitMerge,
  Loader2,
  MessageCircle,
  Pencil,
  Phone,
  RotateCcw,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import {
  ApiRequestError,
  getTenantConfig,
  importCitizens,
  listCitizens,
  logApiError,
  setCitizenActive,
} from '@/lib/api-client';
import { CitizenArchiveDialog } from '@/components/admin/citizen-archive-dialog';
import { CITIZEN_RECORD_EDIT_ROLES, REFERENCE_SEND_ROLES, hasRole } from '@/lib/staff-roles';
import { ImportCitizensDialog } from '@/components/admin/import-citizens-dialog';
import { ShellLink } from '@/components/admin/shell-nav';
import { OfflineQueuePanel } from '@/components/admin/offline-queue';
import { PageHeader } from '@/components/ui/page-header';
import type { CitizenListItem } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTabSearch, useUrlPagination } from '@/lib/use-url-state';
import { CellTag } from '@/components/ui/cell-tag';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ACTION_TINT } from '@/lib/action-tint';
import { formatDate } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
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
   *
   * Both survive a reload, by different routes. The page is in the URL
   * (`?page=` / `?limit=`), so the back button from a citizen's file returns
   * to the same page. The search is a name, a national ID or a phone number,
   * so it is kept in this tab's storage and never in the URL (`tab-search.ts`).
   */
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });
  /** The committed term — set when the clerk presses Enter, not as they type. */
  const [appliedSearch, setAppliedSearch] = useTabSearch(tenant, 'citizens');
  /** A failed *write*. The read's own failure is the table's, via `useStaffQuery`. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** The file being archived — «أرشفة الملف», with a reason and who asked; null when none. */
  const [pendingArchive, setPendingArchive] = useState<CitizenListItem | null>(null);
  const t = useTranslations('citizens');
  const toast = useToast();
  /** Prefixed with «بلدية» in the WhatsApp reference-number message below. */
  const [municipalityName, setMunicipalityName] = useState('');

  const canWrite = role ? CAN_WRITE.includes(role) : false;
  /** The WhatsApp welcome carries the رقم مرجعي, which «مشاهد فقط» is never given. */
  const canSendReference = hasRole(REFERENCE_SEND_ROLES, role);

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
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      listCitizens(
        tenant,
        accessToken,
        {
          search: appliedSearch || undefined,
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

  /*
    «إعادة من الأرشيف» — one click: bringing a file back takes nothing away, so
    it asks for nothing. Archiving goes through `CitizenArchiveDialog`, which
    asks why and who asked (decision, 2026-10-05): a citizen file is archived,
    never deleted.
  */
  const restore = useCallback(
    async (citizen: CitizenListItem) => {
      if (!token) return;
      setBusyId(citizen.id);
      try {
        await setCitizenActive(tenant, token, citizen.id, true);
        await load();
        toast.success(t('restored.title'), { description: t('restored.description', { name: citizen.fullName }) });
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : t('restored.failed');
        setActionError(message);
        toast.error(t('restored.failed'), { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, t],
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
              <p className="min-w-0 truncate font-medium">{citizen.fullName}</p>
            </div>
          );
        },
      },
      /*
        The reference number in a column of its own, beside the name rather
        than in small print under it: it is what a citizen reads out at the
        desk and what the portal logs in with, so it is looked up across rows —
        and a column is what the eye can run down.
      */
      {
        accessorKey: 'referenceNumber',
        header: locale === 'en' ? 'Reference No.' : 'الرقم المرجعي',
        meta: {
          label: locale === 'en' ? 'Reference No.' : 'الرقم المرجعي',
          cellClassName: 'whitespace-nowrap',
        },
        enableSorting: false,
        cell: ({ row }) =>
          row.original.referenceNumber ? (
            <span className="font-mono text-sm">
              <bdi dir="ltr">{row.original.referenceNumber}</bdi>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      /*
        الحالة — what used to ride on the name as badges, now a column, and
        still never hideable: an incomplete record is a fact about the person,
        not a statistic about them, and it has to reach whoever opens their file
        to bill them — including the desk that turned every optional column off
        months ago.

        Plain coloured text, no chips. «غير مقيم في البلدة» is what stops a
        clerk reading a short record's empty household fields as unfinished;
        «يتطلب مراجعة» carries how many fields are still unestablished.
      */
      {
        id: 'status',
        header: locale === 'en' ? 'Status' : 'الحالة',
        enableHiding: false,
        enableSorting: false,
        meta: { label: locale === 'en' ? 'Status' : 'الحالة' },
        cell: ({ row }) => {
          const citizen = row.original;
          const nonResident = citizen.residence === 'NON_RESIDENT_OWNER';
          const review = citizen.latestStatus === 'REQUIRES_REVIEW';
          /*
            Nothing to flag is itself the answer: an active file with no review
            outstanding. Said as «نشط» — the counterpart of «معطّل», and true of
            every row that reaches here — in the same quiet shape as «لا
            متأخرات» beside it, so the flagged rows are the ones that stand out.
          */
          if (!nonResident && citizen.isActive && !review) {
            return (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
                {locale === 'en' ? 'Active' : 'نشط'}
              </span>
            );
          }
          return (
            <div className="space-y-0.5 text-sm font-medium">
              {review ? (
                <p className="flex items-center gap-1.5 text-warning">
                  <FileQuestion className="size-3.5 shrink-0" aria-hidden />
                  {locale === 'en'
                    ? `Requires review (${citizen.unestablishedFieldCount})`
                    : `يتطلب مراجعة (${citizen.unestablishedFieldCount})`}
                </p>
              ) : null}
              {citizen.mergedIntoId ? (
                <Link
                  href={`${base}/citizens/${encodeURIComponent(citizen.mergedIntoId)}`}
                  className="flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"
                >
                  <GitMerge className="size-3.5 shrink-0" aria-hidden />
                  {locale === 'en' ? 'Merged into another file' : 'مدموج في ملف آخر'}
                </Link>
              ) : !citizen.isActive ? (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Archive className="size-3.5 shrink-0" aria-hidden />
                  {t('archived')}
                </p>
              ) : null}
              {nonResident ? (
                <p className="text-info">
                  {labels.citizenResidence.NON_RESIDENT_OWNER}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'phone',
        header: t('phoneColumn'),
        meta: { label: t('phoneColumn') },
        enableSorting: false,
        cell: ({ row }) => {
          const { phone, hasNoPhone, contactPhone, matchedOnContactPhone } = row.original;
          /*
            The relative's number is shown as a relative's — never as the
            citizen's own: always on a file with no number of its own, and on
            any row the search found through it, with the tag that says so. A
            clerk who searched a number then sees it on the row it found,
            whatever else the file holds.
          */
          const relative =
            contactPhone && (!phone || matchedOnContactPhone) ? (
              <a href={`tel:${contactPhone}`} className="block text-xs text-primary hover:underline">
                {t('contactPhone')} <bdi dir="ltr">{formatPhone(contactPhone)}</bdi>
              </a>
            ) : null;
          const found = matchedOnContactPhone ? (
            <CellTag tone="primary">{t('foundByContactPhone')}</CellTag>
          ) : null;
          if (!phone && !hasNoPhone && !relative && !found) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <div className="space-y-0.5 text-sm">
              {phone ? (
                <a
                  href={`tel:${phone}`}
                  dir="ltr"
                  className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                >
                  <Phone className="size-3.5 shrink-0" aria-hidden />
                  {formatPhone(phone)}
                </a>
              ) : (
                // «لا يملك رقم هاتف» is an answer, not a gap.
                <p className="text-muted-foreground">{hasNoPhone ? t('noPhone') : '—'}</p>
              )}
              {relative}
              {found}
            </div>
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
              {formatPhone(whatsapp)}
              {whatsapp === phone ? (
                <span className="text-xs text-muted-foreground">
                  {locale === 'en' ? '(same)' : '(نفس الهاتف)'}
                </span>
              ) : null}
            </a>
          );
        },
      },
      /*
        اسم الأم وشهرتها — the column a clerk turns on to tell two namesakes apart.

        Off by default like the other four: this table already shows eleven
        columns and the question it answers is asked on a specific row, not on
        every page. On when somebody is looking at «محمد خليل» twice and has to
        decide which one the visitor is.

        «—» on a household filed before migration 0044. Nobody was asked, and a
        dash is the only honest thing to print for that.
      */
      {
        accessorKey: 'motherName',
        header: locale === 'en' ? "Mother's Name" : 'اسم الأم',
        meta: { label: locale === 'en' ? "Mother's Name" : 'اسم الأم وشهرتها', mobile: 'hide' },
        enableSorting: false,
        cell: ({ row }) =>
          row.original.motherName ? (
            <span className="text-sm">{row.original.motherName}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
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
              <p className="font-mono text-sm">
                <bdi dir="ltr">{identityDocNumber}</bdi>
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
            <CellTag>
              {labels.residentStatus?.[residentStatus as never] ?? residentStatus}
            </CellTag>
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
            <p className="font-medium tabular-nums">
              {citizen.propertyCount} {locale === 'en' ? 'properties' : 'عقار'}
            </p>
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
                <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
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
                  <CellTag tone="warning" className="gap-1 text-xs">
                    <Clock3 className="size-3" aria-hidden />
                    {citizen.pendingReviewCount} {locale === 'en' ? 'under review' : 'قيد التحقق'}
                  </CellTag>
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
          const waHref = canSendReference ? buildWhatsappHref(citizen.whatsapp || citizen.phone, waMessage) : null;

          return (
            <div className="flex items-center gap-1.5">
              <ActionTooltip label={locale === 'en' ? 'View details & invoices' : 'عرض التفاصيل والفواتير'}>
                <Link
                  href={`${base}/citizens/${citizen.id}`}
                  aria-label={locale === 'en' ? 'View details' : 'عرض التفاصيل'}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), ACTION_TINT.view)}
                >
                  <UserRound className="size-4" aria-hidden />
                </Link>
              </ActionTooltip>

              <ActionTooltip label={locale === 'en' ? 'Properties & units' : 'العقارات والوحدات'}>
                <Link
                  href={`${base}/citizens/${citizen.id}/properties`}
                  aria-label={locale === 'en' ? 'Properties & units' : 'العقارات والوحدات'}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), ACTION_TINT.properties)}
                >
                  <Building2 className="size-4" aria-hidden />
                </Link>
              </ActionTooltip>

              {waHref ? (
                <ActionTooltip label={locale === 'en' ? 'Send reference number via WhatsApp' : 'إرسال الرقم المرجعي عبر واتساب'}>
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={locale === 'en' ? 'Send via WhatsApp' : 'إرسال عبر واتساب'}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), ACTION_TINT.whatsapp)}
                  >
                    <MessageCircle className="size-4" aria-hidden />
                  </a>
                </ActionTooltip>
              ) : null}

              {canWrite && !citizen.mergedIntoId ? (
                <ActionTooltip label={locale === 'en' ? 'Edit information' : 'تعديل البيانات'}>
                  <Link
                    href={`${base}/citizens/${citizen.id}/edit`}
                    aria-label={locale === 'en' ? 'Edit' : 'تعديل'}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), ACTION_TINT.edit)}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Link>
                </ActionTooltip>
              ) : null}

              {/* A merged file comes back through «التراجع عن الدمج», never by reactivation. */}
              {canWrite && !citizen.mergedIntoId ? (
                <ActionTooltip label={citizen.isActive ? t('archiveAction') : t('restoreAction')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={citizen.isActive ? ACTION_TINT.disable : ACTION_TINT.enable}
                    aria-label={citizen.isActive ? t('archiveLabel', { name: citizen.fullName }) : t('restoreLabel', { name: citizen.fullName })}
                    disabled={busy}
                    onClick={() => (citizen.isActive ? setPendingArchive(citizen) : void restore(citizen))}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : citizen.isActive ? (
                      <Archive className="size-4" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )}
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
          );
        },
      },
    ],
    [base, busyId, canWrite, canSendReference, restore, locale, labels, municipalityName, t],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Users}
        title={locale === 'en' ? 'Citizen register' : 'سجل المواطنين'}

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
        {/*
          «إجمالي الأسر» — live household files over the whole register (the
          server's `totals.families`): not a non-resident owner's record, not an
          archived or merged-away file, and not narrowed by the search. A
          server that predates it sends none, and the matching count stands in.
        */}
        <MetricCard
          label={t('families')}
          value={(totals.families ?? total).toLocaleString('en-US')}
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
      <OfflineQueuePanel tenant={tenant} base={base} canSend={hasRole(CITIZEN_RECORD_EDIT_ROLES, role)} />

      {/*
        The review queue, offered only when there is one.

        A permanent link reading «يتطلب مراجعة (٠)» is a standing invitation to
        check something that is never there. It appears when a record needs
        finishing, and leads to the queue's own page (`/citizens/review`, also
        a row of the «المواطنون» group), which lists just those records with a «فحص
        الملف» for each.
      */}
      {totals.requiringReview > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`${base}/citizens/review`}
            className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'h-8 gap-1.5 px-3 text-xs')}
          >
            <FileQuestion className="size-3.5" aria-hidden />
            {locale === 'en'
              ? `Requires review (${totals.requiringReview})`
              : `يتطلب مراجعة (${totals.requiringReview})`}
          </Link>
          <p className="text-xs text-muted-foreground">
            {locale === 'en'
              ? 'Records filed with fields the officer could not establish. Review each file to complete it.'
              : 'سجلات حُفظت بحقول لم يتمكّن الموظف من التثبّت منها. افحص كل ملف لاستكماله.'}
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
              these five are the ones a clerk turns on for a specific job — the
              identity document when verifying papers, صفة الإقامة when
              reporting, تاريخ التسجيل when auditing intake, اسم الأم when two
              rows carry the same three names and one of them is the visitor.
              واتساب starts hidden because it usually repeats the landline, and
              the pair is only worth two columns when a municipality actually
              works over it.
            */
            initialHiddenColumns={[
              'whatsapp',
              'motherName',
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

      <CitizenArchiveDialog
        tenant={tenant}
        token={token}
        citizen={pendingArchive}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        onArchived={(citizen) => {
          setPendingArchive(null);
          void load();
          toast.success(t('archivedToast.title'), { description: t('archivedToast.description', { name: citizen.fullName }) });
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
