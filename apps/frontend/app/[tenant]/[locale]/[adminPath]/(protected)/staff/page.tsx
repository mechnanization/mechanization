'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  BadgeDollarSign,
  Ban,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Home,
  KeyRound,
  Loader2,
  Mail,
  Pencil,
  RotateCcw,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  createStaff,
  deleteStaff,
  getStaff,
  logApiError,
  setStaffActive,
  updateStaff,
} from '@/lib/api-client';
import type { StaffSummary } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate } from '@/lib/dates';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { CellTag } from '@/components/ui/cell-tag';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { StaffForm, type StaffFormValues } from '@/components/admin/staff-form';

function getTableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search staff',
      searchPlaceholder: 'Search by name or email…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'No staff accounts yet.',
      emptySearch: 'No results match your search.',
      loadError: 'Failed to load staff accounts.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} staff members',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      sortNone: 'Clear sorting',
      columns: 'Columns',
      columnsHint: 'Visible columns',
      resetColumns: 'Reset to default',
    };
  }
  return {
    searchAriaLabel: 'بحث في الموظفين',
    searchPlaceholder: 'ابحث بالاسم أو البريد الإلكتروني…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا يوجد موظفون بعد.',
    emptySearch: 'لا نتائج مطابقة لبحثك.',
    loadError: 'تعذّر تحميل الموظفين.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'عدد الصفوف',
    totalRows: '{count} موظف',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'استعادة الافتراضي',
  };
}

/**
 * Staff account administration — SUPER_ADMIN only.
 *
 * The role check here is a courtesy, not the protection: every `/staff` route
 * is `@Roles('SUPER_ADMIN')` on the server. Redirecting rather than rendering
 * a permission error keeps a page that can only ever say "no" out of an
 * auditor's way.
 */
export default function StaffPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [token, setToken] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  /** A failed *write*. The read reports its own failure through the query. */
  const [actionError, setActionError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StaffSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The account whose deletion is being confirmed, or null. */
  const [pendingDelete, setPendingDelete] = useState<StaffSummary | null>(null);
  const toast = useToast();

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    if (session.user.role !== 'SUPER_ADMIN') {
      router.replace(`${base}/dashboard`);
      return;
    }
    setToken(session.accessToken);
    setSelfId(session.user.id);
  }, [tenant, base, router]);

  /*
    Unparameterised: the whole staff list, filtered and paged in the browser.

    That is right here and nowhere else on the portal — a municipality has a
    dozen accounts, not a register of thousands — so the search box below is
    TanStack's own and never reaches the API. It still benefits from the cache:
    coming back to this screen shows the accounts immediately and re-reads
    behind them.
  */
  const query = useStaffQuery({
    queryKey: ['staff', tenant],
    queryFn: (accessToken, signal) => getStaff(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل الموظفين.',
  });

  const items = query.data?.items ?? [];
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

  /** Re-reads the accounts after a create, an edit, a deactivation or a reset. */
  const queryClient = useQueryClient();
  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['staff', tenant] }),
    [queryClient, tenant],
  );

  const [createdTotp, setCreatedTotp] = useState<{
    email: string;
    name: string;
    secret: string;
    keyUri: string;
  } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const submitForm = useCallback(
    async (values: StaffFormValues) => {
      if (!token) return;
      setSubmitting(true);
      setFormError(null);
      try {
        if (editing) {
          await updateStaff(tenant, token, editing.id, {
            firstName: values.firstName.trim(),
            lastName: values.lastName.trim(),
            email: values.email.trim(),
            role: values.role,
            // Absent means "keep the current one" — the server treats an
            // omitted password as no change rather than a reset.
            ...(values.password ? { password: values.password } : {}),
          });
        } else {
          const result = await createStaff(tenant, token, {
            firstName: values.firstName.trim(),
            lastName: values.lastName.trim(),
            email: values.email.trim(),
            password: values.password,
            role: values.role,
          });

          if (result.totp) {
            setCreatedTotp({
              email: values.email.trim(),
              name: `${values.firstName.trim()} ${values.lastName.trim()}`,
              secret: result.totp.secret,
              keyUri: result.totp.keyUri,
            });
          }
        }
        setFormOpen(false);
        setEditing(null);
        await load();
      } catch (caught) {
        logApiError(caught);
        setFormError(
          caught instanceof ApiRequestError ? caught.message : 'تعذّر حفظ الحساب.',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [tenant, token, editing, load],
  );

  const toggleActive = useCallback(
    async (staff: StaffSummary) => {
      if (!token) return;
      setBusyId(staff.id);
      const reactivating = !staff.isActive;
      try {
        await setStaffActive(tenant, token, staff.id, reactivating);
        await load();
        toast.success(reactivating ? 'تمت إعادة تفعيل الحساب' : 'تم تعطيل الحساب', {
          description: reactivating
            ? `${staff.fullName} — يستطيع تسجيل الدخول من جديد.`
            : `${staff.fullName} — لن يستطيع تسجيل الدخول. الحساب وسجل نشاطه محفوظان.`,
        });
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

  const removeStaff = useCallback(
    async (staff: StaffSummary) => {
      if (!token) throw new Error('انتهت الجلسة.');
      setBusyId(staff.id);
      try {
        await deleteStaff(tenant, token, staff.id);
        await load();
        toast.success('تم حذف الحساب', { description: staff.fullName });
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError ? caught.message : 'تعذّر حذف الحساب.';
        setActionError(message);
        // Rethrown so the dialog stays open with the reason in place — the
        // server refuses the last SUPER_ADMIN, and that is worth reading.
        throw new Error(message);
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
  );

  const labels = getLabels(locale);

  const columns = useMemo<ColumnDef<StaffSummary>[]>(
    () => [
      {
        accessorKey: 'fullName',
        header: locale === 'en' ? 'Name' : 'الاسم',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.fullName}</span>
            {row.original.id === selfId ? (
              <CellTag tone="muted">{locale === 'en' ? 'You' : 'أنت'}</CellTag>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'email',
        header: locale === 'en' ? 'Email' : 'البريد الإلكتروني',
        cell: ({ row }) => (
          <a
            href={`mailto:${row.original.email}`}
            dir="ltr"
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
          >
            <Mail className="size-3.5 shrink-0" aria-hidden />
            {row.original.email}
          </a>
        ),
      },
      {
        accessorKey: 'role',
        header: locale === 'en' ? 'Role' : 'الصلاحية',
        cell: ({ row }) => (
          <CellTag tone={row.original.role === 'SUPER_ADMIN' ? 'primary' : 'neutral'}>
            {labels.staffRole?.[row.original.role as never] ?? row.original.role}
          </CellTag>
        ),
      },
      {
        accessorKey: 'isActive',
        header: locale === 'en' ? 'Status' : 'الحالة',
        cell: ({ row }) =>
          row.original.isActive ? (
            <CellTag tone="success">
              <CheckCircle2 className="size-3.5" aria-hidden />
              {locale === 'en' ? 'Active' : 'فعّال'}
            </CellTag>
          ) : (
            <CellTag tone="muted">
              <Ban className="size-3.5" aria-hidden />
              {locale === 'en' ? 'Disabled' : 'معطّل'}
            </CellTag>
          ),
      },
      {
        id: 'fieldStats',
        header: locale === 'en' ? 'Field Registrations' : 'المسح الميداني والعقارات',
        cell: ({ row }) => {
          const staff = row.original;
          if (staff.role !== 'FIELD_INSPECTOR') {
            return <span className="text-muted-foreground text-xs">—</span>;
          }
          const citizens = staff.registeredCitizensCount ?? 0;
          const properties = staff.registeredPropertiesCount ?? 0;
          const earnings = staff.totalEarnings ?? 0;

          return (
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold">
                <span className="text-success">
                  {citizens} {locale === 'en' ? 'citizens' : 'مواطن'}
                </span>
                <span className="text-muted-foreground">•</span>
                <span className="text-info">
                  {properties} {locale === 'en' ? 'properties' : 'عقار'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground font-medium">
                <bdi dir="ltr">${earnings.toFixed(2)} USD</bdi>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'lastLoginAt',
        header: locale === 'en' ? 'Last Login' : 'آخر دخول',
        cell: ({ row }) =>
          row.original.lastLoginAt
            ? formatDate(row.original.lastLoginAt)
            : '—',
      },
      {
        id: 'actions',
        header: locale === 'en' ? 'Actions' : 'إجراء',
        enableSorting: false,
        meta: { mobile: 'actions' },
        cell: ({ row }) => {
          const staff = row.original;
          const isSelf = staff.id === selfId;
          const busy = busyId === staff.id;
          const deletable = staff.historyCount === 0 && !isSelf;

          return (
            <div className="flex items-center gap-1.5">
              {staff.role === 'FIELD_INSPECTOR' ? (
                <ActionTooltip label={locale === 'en' ? 'Performance & Earnings Dashboard' : 'لوحة الأداء والعمولات ($1/عقار)'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="border-success/30 text-success bg-success/5 hover:bg-success/15"
                    aria-label={locale === 'en' ? 'Performance & Earnings' : 'لوحة الأداء والعمولات'}
                    onClick={() => router.push(`${base}/inspector/profile/${staff.id}`)}
                  >
                    <BadgeDollarSign className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}

              <ActionTooltip label={locale === 'en' ? 'Edit' : 'تعديل'}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Edit' : 'تعديل'}
                  disabled={busy}
                  onClick={() => {
                    setEditing(staff);
                    setFormError(null);
                    setFormOpen(true);
                  }}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>

              {!isSelf ? (
                <ActionTooltip
                  label={
                    staff.isActive
                      ? (locale === 'en' ? 'Disable Account' : 'إلغاء التفعيل')
                      : (locale === 'en' ? 'Re-activate Account' : 'إعادة التفعيل')
                  }
                >
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={
                      staff.isActive
                        ? (locale === 'en' ? 'Disable' : 'إلغاء التفعيل')
                        : (locale === 'en' ? 'Re-activate' : 'إعادة التفعيل')
                    }
                    disabled={busy}
                    onClick={() => void toggleActive(staff)}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : staff.isActive ? (
                      <Ban className="size-4" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )}
                  </Button>
                </ActionTooltip>
              ) : null}

              {deletable ? (
                <ActionTooltip label={locale === 'en' ? 'Delete permanently' : 'حذف نهائي — لا سجل نشاطات لهذا الحساب'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Delete permanently' : 'حذف نهائي'}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    onClick={() => setPendingDelete(staff)}
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
    [selfId, busyId, toggleActive, locale, labels, base, router],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={UsersRound}
        title={locale === 'en' ? 'Staff Members' : 'الموظفون'}
        subtitle={
          locale === 'en'
            ? 'Manage municipal staff accounts and roles'
            : 'إنشاء حسابات موظفي البلدية وتعديل صلاحياتها'
        }
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormError(null);
              setFormOpen(true);
            }}
          >
            <UserPlus className="size-4" aria-hidden />
            {locale === 'en' ? 'Add Staff Member' : 'إضافة موظف'}
          </Button>
        }
      />

      {error ? (
        <Alert tone="error">
          {error}
        </Alert>
      ) : null}

      {/* Field Inspectors Individual Performance Overview */}
      {(() => {
        const inspectors = items.filter((s) => s.role === 'FIELD_INSPECTOR');
        if (inspectors.length === 0) return null;

        return (
          <Card className="border-border/70 overflow-hidden">
            <CardHeader className="border-b pb-4 bg-muted/20">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base font-bold">
                    <BadgeDollarSign className="size-5 text-primary" />
                    {locale === 'en'
                      ? 'Field Inspectors Performance & Commissions ($1/Property)'
                      : 'أداء المفتشين الميدانيين وإحصاءات المسح والعمولات (1$ لكل عقار)'}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {locale === 'en'
                      ? 'Individual counts of registered citizens and properties per inspector'
                      : 'عدد المواطنين والعقارات المسجلة لكل مفتش ميداني على حدة مع تفاصيل العمولات المستحقة'}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4 sm:p-6">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {inspectors.map((insp) => {
                  const citizens = insp.registeredCitizensCount ?? 0;
                  const properties = insp.registeredPropertiesCount ?? 0;
                  const earnings = insp.totalEarnings ?? 0;
                  const pending = insp.pendingBalance ?? 0;

                  return (
                    <div
                      key={insp.id}
                      className="flex flex-col justify-between rounded-xl border bg-card p-4 hover:shadow-sm transition-shadow space-y-3"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold">
                            {insp.firstName.charAt(0)}
                          </div>
                          <div>
                            <h3 className="font-bold text-sm">{insp.fullName}</h3>
                            <p className="text-xs text-muted-foreground" dir="ltr">
                              {insp.email}
                            </p>
                          </div>
                        </div>
                        {insp.isActive ? (
                          <Badge variant="outline" className="text-xs border-success/30 text-success bg-success/10">
                            {locale === 'en' ? 'Active' : 'فعّال'}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-destructive">
                            {locale === 'en' ? 'Disabled' : 'معطّل'}
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t text-xs">
                        <div className="flex flex-col bg-muted/30 p-2 rounded-lg">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Users className="size-3 text-success" />
                            {locale === 'en' ? 'Citizens' : 'المواطنون'}
                          </span>
                          <span className="font-bold text-sm text-success mt-0.5">
                            {citizens} {locale === 'en' ? 'cit.' : 'مواطن'}
                          </span>
                        </div>

                        <div className="flex flex-col bg-muted/30 p-2 rounded-lg">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Home className="size-3 text-info" />
                            {locale === 'en' ? 'Properties' : 'العقارات'}
                          </span>
                          <span className="font-bold text-sm text-info mt-0.5">
                            {properties} {locale === 'en' ? 'prop.' : 'عقار'}
                          </span>
                        </div>

                        <div className="flex flex-col bg-muted/30 p-2 rounded-lg">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <TrendingUp className="size-3 text-purple-600" />
                            {locale === 'en' ? 'Earnings' : 'الأرباح'}
                          </span>
                          <span className="font-bold text-xs mt-0.5" dir="ltr">
                            ${earnings.toFixed(2)}
                          </span>
                        </div>

                        <div className="flex flex-col bg-muted/30 p-2 rounded-lg">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="size-3 text-warning" />
                            {locale === 'en' ? 'Pending' : 'المتبقي'}
                          </span>
                          <span className="font-bold text-xs text-warning mt-0.5" dir="ltr">
                            ${pending.toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <div className="pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full text-xs gap-1.5 border-primary/20 hover:bg-primary/5 text-primary"
                          onClick={() => router.push(`${base}/inspector/profile/${insp.id}`)}
                        >
                          <BadgeDollarSign className="size-3.5" />
                          {locale === 'en' ? 'View Dashboard & Payouts' : 'عرض لوحة الأرباح والدفعات'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg">
            <UsersRound className="size-5" aria-hidden />
            {locale === 'en' ? 'Staff Directory' : 'حسابات الموظفين'}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {locale === 'en'
              ? 'Disabling prevents login while preserving historical action logs. Permanent delete is only allowed for accounts with no prior actions.'
              : 'إلغاء التفعيل يمنع الدخول ويُبقي سجل نشاطات الموظف كما هو. الحذف النهائي متاح فقط لحساب لم يقم بأي إجراء.'}
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <DataTable
            columns={columns}
            data={items}
            labels={tableLabels}
            columnStorageKey="staff"
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
          />
        </CardContent>
      </Card>

      <StaffForm
        open={formOpen}
        editing={editing}
        submitting={submitting}
        error={formError}
        onOpenChange={(next) => {
          setFormOpen(next);
          if (!next) setEditing(null);
        }}
        onSubmit={(values) => void submitForm(values)}
        locale={locale}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={locale === 'en' ? 'Permanently Delete Account' : 'حذف الحساب نهائياً'}
        description={
          pendingDelete ? (
            locale === 'en' ? (
              <>
                Account for <span className="font-semibold text-foreground">{pendingDelete.fullName}</span> will be deleted and will no longer be able to log in. Their activity remains in the audit log.
                <span className="mt-2 block text-muted-foreground">
                  If the goal is to temporarily revoke access, &quot;Disable&quot; is sufficient and reversible.
                </span>
              </>
            ) : (
              <>
                سيُحذف حساب{' '}
                <span className="font-semibold text-foreground">{pendingDelete.fullName}</span> ولن
                يستطيع تسجيل الدخول. سجل نشاطه في «سجل النشاطات» يبقى كما هو.
                <span className="mt-2 block text-muted-foreground">
                  إن كان الهدف منع الدخول مؤقتاً، «التعطيل» يكفي ويمكن التراجع عنه.
                </span>
              </>
            )
          ) : null
        }
        confirmLabel={locale === 'en' ? 'Delete Permanently' : 'حذف نهائي'}
        requireText={pendingDelete?.email}
        requireTextHint={locale === 'en' ? 'Type the account email address to confirm' : 'اكتب البريد الإلكتروني للحساب للتأكيد'}
        onConfirm={async () => {
          if (pendingDelete) await removeStaff(pendingDelete);
        }}
      />

      <Dialog
        open={createdTotp !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedTotp(null);
            setCopiedSecret(false);
          }
        }}
      >
        <DialogContent className="max-w-md" closeLabel={locale === 'en' ? 'Close' : 'إغلاق'}>
          <DialogHeader>
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-warning/10 text-warning ring-1 ring-warning/20">
              <KeyRound className="size-6" />
            </div>
            <DialogTitle className="text-center text-xl font-bold">
              {locale === 'en' ? 'Two-Factor Authentication (2FA)' : 'رمز التحقق بخطوتين (2FA)'}
            </DialogTitle>
            <DialogDescription className="text-center text-sm leading-relaxed">
              {locale === 'en' ? (
                <>
                  Admin account <span className="font-semibold text-foreground">{createdTotp?.name}</span> created successfully. Provide this setup key to the administrator to enter into their authenticator app (Google Authenticator).
                </>
              ) : (
                <>
                  تم إنشاء حساب المسؤول <span className="font-semibold text-foreground">{createdTotp?.name}</span> بنجاح. سلّم هذا المفتاح للمسؤول لإدخاله في تطبيق المصادقة (Google Authenticator).
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="rounded-xl border border-border/80 bg-muted/40 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{locale === 'en' ? 'Setup Key:' : 'مفتاح الإعداد (Setup Key):'}</span>
                <span className="font-mono">{createdTotp?.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg border bg-background px-3 py-2.5 text-center font-mono text-base font-bold tracking-widest text-primary selection:bg-primary/20">
                  {createdTotp?.secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  className="shrink-0 gap-1.5"
                  onClick={() => {
                    if (createdTotp) {
                      void navigator.clipboard.writeText(createdTotp.secret);
                      setCopiedSecret(true);
                      setTimeout(() => setCopiedSecret(false), 2000);
                    }
                  }}
                >
                  {copiedSecret ? (
                    <>
                      <Check className="size-4 text-success" />
                      <span className="text-xs">{locale === 'en' ? 'Copied' : 'تم النسخ'}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" />
                      <span className="text-xs">{locale === 'en' ? 'Copy' : 'نسخ'}</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="rounded-lg bg-warning/5 p-3 border border-warning/20 text-xs text-warning leading-relaxed">
              {locale === 'en' ? (
                <>⚠️ <strong>Notice:</strong> This key is displayed <strong>only once</strong> now and cannot be retrieved later from the site. If lost, it can be reset via the CLI.</>
              ) : (
                <>⚠️ <strong>تنبيه:</strong> هذا المفتاح يُعرض <strong>لمرة واحدة فقط</strong> الآن ولن يمكن استرجاعه لاحقاً من الموقع. في حال فقدانه يمكن إعادة تعيينه عبر موجه الأوامر (CLI).</>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              className="w-full"
              onClick={() => {
                setCreatedTotp(null);
                setCopiedSecret(false);
              }}
            >
              {locale === 'en' ? 'Saved & Close' : 'تم الحفظ والإغلاق'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
