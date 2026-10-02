'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArchiveRestore,
  BadgeDollarSign,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  createStaff,
  deleteStaff,
  getDeletedStaff,
  getStaff,
  restoreStaff,
  logApiError,
  setStaffActive,
  updateStaff,
} from '@/lib/api-client';
import type { DeletedStaffSummary, StaffSummary } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate } from '@/lib/dates';
import { formatForeign } from '@/lib/currency';
import { CellTag } from '@/components/ui/cell-tag';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
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
import { ChipGroup } from '@/components/ui/segmented-control';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { cn } from '@/lib/utils';
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

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
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

  /*
    «الموظفون المحذوفون» — deleted accounts, kept with their history and
    restorable. Read beside the list and refreshed with it, folded shut below
    the directory: rarely wanted, but the only way back for an account (and
    for its email) once it has been deleted.
  */
  const deletedQuery = useStaffQuery({
    queryKey: ['staff', tenant, 'deleted'],
    queryFn: (accessToken, signal) => getDeletedStaff(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل الموظفين المحذوفين.',
  });
  const deletedStaff: DeletedStaffSummary[] = deletedQuery.data?.items ?? [];

  const restore = useCallback(
    async (staff: DeletedStaffSummary) => {
      if (!token) return;
      setBusyId(staff.id);
      try {
        await restoreStaff(tenant, token, staff.id);
        await load();
        toast.success('تمت استعادة الحساب', {
          description: `${staff.fullName} — عاد إلى القائمة معطّلاً؛ فعّله ليتمكّن من الدخول.`,
        });
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : 'تعذّر استعادة الحساب.';
        setActionError(message);
        toast.error('تعذّر استعادة الحساب', { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast],
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
        toast.success('تم حذف الموظف', {
          description: `${staff.fullName} — أُزيل من القائمة، وبقي سجلّه محفوظاً. يمكن استعادته من «الموظفون المحذوفون».`,
        });
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
  const en = locale === 'en';
  const roleLabel = useCallback(
    (role: string) => labels.staffRole?.[role as never] ?? role,
    [labels],
  );

  /** Which role the list is narrowed to; «all» is everyone. */
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const roles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const staff of items) counts.set(staff.role, (counts.get(staff.role) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = useMemo(
    () => (roleFilter === 'all' ? items : items.filter((staff) => staff.role === roleFilter)),
    [items, roleFilter],
  );
  const activeCount = items.filter((staff) => staff.isActive).length;
  const inspectors = items.filter((staff) => staff.role === 'FIELD_INSPECTOR');

  const columns = useMemo<ColumnDef<StaffSummary>[]>(
    () => [
      {
        // Name and email in one searchable value — the search box promises both.
        id: 'fullName',
        accessorFn: (row) => `${row.fullName} ${row.email}`,
        header: en ? 'Staff member' : 'الموظف',
        cell: ({ row }) => {
          const staff = row.original;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                  staff.isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {initials(staff)}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate font-medium">
                  <span className="truncate">{staff.fullName}</span>
                  {staff.id === selfId ? <CellTag tone="muted">{en ? 'You' : 'أنت'}</CellTag> : null}
                </p>
                <a
                  href={`mailto:${staff.email}`}
                  dir="ltr"
                  className="block truncate text-xs text-muted-foreground hover:text-primary hover:underline"
                >
                  {staff.email}
                </a>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'role',
        header: en ? 'Role' : 'الصلاحية',
        cell: ({ row }) => (
          <CellTag tone={row.original.role === 'SUPER_ADMIN' ? 'primary' : 'neutral'}>
            {roleLabel(row.original.role)}
          </CellTag>
        ),
      },
      {
        accessorKey: 'isActive',
        header: en ? 'Status' : 'الحالة',
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            {row.original.isActive ? (
              <CellTag tone="success">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {en ? 'Active' : 'فعّال'}
              </CellTag>
            ) : (
              <CellTag tone="muted">
                <Ban className="size-3.5" aria-hidden />
                {en ? 'Disabled' : 'معطّل'}
              </CellTag>
            )}
            {row.original.hasConfirmedTotp ? (
              <ActionTooltip label={en ? 'Two-factor sign-in set up' : 'التحقق بخطوتين مفعّل'}>
                <span className="text-muted-foreground">
                  <ShieldCheck className="size-4" aria-label={en ? '2FA on' : 'تحقق ثنائي'} />
                </span>
              </ActionTooltip>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'lastLoginAt',
        header: en ? 'Last login' : 'آخر دخول',
        cell: ({ row }) =>
          row.original.lastLoginAt ? (
            <span className="tabular-nums">{formatDate(row.original.lastLoginAt)}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{en ? 'Never' : 'لم يدخل بعد'}</span>
          ),
      },
      {
        id: 'actions',
        header: en ? 'Actions' : 'إجراءات',
        enableSorting: false,
        meta: { mobile: 'actions' },
        cell: ({ row }) => {
          const staff = row.original;
          const isSelf = staff.id === selfId;
          const busy = busyId === staff.id;
          return (
            <div className="flex items-center gap-1.5">
              {staff.role === 'FIELD_INSPECTOR' ? (
                <ActionTooltip label={en ? 'Performance & earnings' : 'الأداء والعمولات'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={en ? 'Performance & earnings' : 'الأداء والعمولات'}
                    onClick={() => router.push(`${base}/inspector/profile/${staff.id}`)}
                  >
                    <BadgeDollarSign className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}

              <ActionTooltip label={en ? 'Edit' : 'تعديل'}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={en ? 'Edit' : 'تعديل'}
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
                      ? en
                        ? 'Disable — blocks sign-in, reversible'
                        : 'تعطيل — يمنع الدخول ويمكن التراجع'
                      : en
                        ? 'Re-activate'
                        : 'إعادة التفعيل'
                  }
                >
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={staff.isActive ? (en ? 'Disable' : 'تعطيل') : en ? 'Re-activate' : 'إعادة التفعيل'}
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

              {!isSelf ? (
                <ActionTooltip label={en ? 'Delete' : 'حذف'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={en ? 'Delete' : 'حذف'}
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
    [selfId, busyId, toggleActive, en, roleLabel, base, router],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={UsersRound}
        title={en ? 'Staff' : 'الموظفون'}
        subtitle={en ? 'Municipal staff accounts and what each may do' : 'حسابات موظفي البلدية وصلاحياتهم'}
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormError(null);
              setFormOpen(true);
            }}
          >
            <UserPlus className="size-4" aria-hidden />
            {en ? 'Add staff member' : 'إضافة موظف'}
          </Button>
        }
      />

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive">
          {error}
        </p>
      ) : null}

      {/* ── At a glance ─────────────────────────────────────────────── */}
      <StatStrip>
        <StatItem value={items.length} label={en ? 'Staff' : 'الموظفون'} />
        <StatItem value={activeCount} label={en ? 'Active' : 'فعّالون'} className="text-success" />
        <StatItem value={items.length - activeCount} label={en ? 'Disabled' : 'معطّلون'} />
        <StatItem value={inspectors.length} label={en ? 'Field inspectors' : 'مفتشون ميدانيون'} />
      </StatStrip>

      {/* ── The directory ───────────────────────────────────────────── */}
      <section className="space-y-3">
        {roles.length > 1 ? (
          <ChipGroup
            aria-label={en ? 'Role' : 'الصلاحية'}
            value={roleFilter}
            onChange={setRoleFilter}
            options={[
              { value: 'all', label: `${en ? 'All' : 'الكل'} (${items.length})` },
              ...roles.map(([role, count]) => ({ value: role, label: `${roleLabel(role)} (${count})` })),
            ]}
          />
        ) : null}
        {/* The table draws its own frame; a card around it was a second one (BAN-4). */}
        <DataTable
          columns={columns}
          data={shown}
          labels={tableLabels}
          columnStorageKey="staff"
          getRowId={(row) => row.id}
          loading={query.loading}
          error={query.error}
          onRetry={query.refetch}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {en
            ? 'Disabling blocks sign-in and can be undone. Deleting hides the account from this list and blocks sign-in; their details and everything they did stay on record, and it can be restored from «Deleted staff».'
            : 'التعطيل يمنع الدخول ويمكن التراجع عنه. الحذف يُخفي الحساب من هذه القائمة ويمنع الدخول، وتبقى بياناته وكل ما قام به محفوظة في السجلات، ويمكن استعادته من «الموظفون المحذوفون».'}
        </p>
      </section>

      {/*
        ── Deleted staff, restorable ───────────────────────────────
        Shown whenever there is something to say — accounts to restore, a read
        still loading, or a read that failed — because a failed read here hides
        the only way back for a deleted account (STA-1).
      */}
      {deletedStaff.length > 0 || deletedQuery.loading || deletedQuery.error ? (
        <CollapsibleSection
          title={en ? 'Deleted staff' : 'الموظفون المحذوفون'}
          icon={Trash2}
          summary={deletedStaff.length > 0 ? <span className="tabular-nums">({deletedStaff.length})</span> : undefined}
          defaultOpen={false}
        >
          {deletedQuery.loading ? (
            <LoadingState compact label={en ? 'Loading deleted staff…' : 'جارٍ تحميل الموظفين المحذوفين…'} />
          ) : deletedQuery.error ? (
            <ErrorState
              compact
              description={deletedQuery.error}
              onRetry={() => void deletedQuery.refetch()}
              retryLabel={en ? 'Try again' : 'إعادة المحاولة'}
            />
          ) : (
            <ul className="divide-y">
              {deletedStaff.map((staff) => (
                <li key={staff.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{staff.fullName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <bdi dir="ltr">{staff.email}</bdi>
                      {' · '}
                      {roleLabel(staff.role)}
                      {' · '}
                      {en ? 'deleted ' : 'حُذف '}
                      {formatDate(staff.deletedAt)}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" disabled={busyId === staff.id} onClick={() => void restore(staff)}>
                    {busyId === staff.id ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <ArchiveRestore className="size-4" aria-hidden />
                    )}
                    {en ? 'Restore' : 'استعادة'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleSection>
      ) : null}

      {/* ── Field inspectors ────────────────────────────────────────── */}
      {inspectors.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <BadgeDollarSign className="size-5 text-primary" aria-hidden />
              {en ? 'Field inspectors' : 'المفتشون الميدانيون'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {en
                ? 'What each inspector has registered, and what they are owed ($1 per billable unit).'
                : 'ما سجّله كل مفتش، وما يستحقه من عمولات (1$ لكل وحدة محتسبة).'}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {inspectors.map((inspector) => (
              <article key={inspector.id} className="flex flex-col gap-4 rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary"
                  >
                    {initials(inspector)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{inspector.fullName}</p>
                    <p dir="ltr" className="truncate text-xs text-muted-foreground">
                      {inspector.email}
                    </p>
                  </div>
                  {inspector.isActive ? (
                    <CellTag tone="success">{en ? 'Active' : 'فعّال'}</CellTag>
                  ) : (
                    <CellTag tone="muted">{en ? 'Disabled' : 'معطّل'}</CellTag>
                  )}
                </div>
                <StatStrip>
                  <StatItem value={inspector.registeredCitizensCount ?? 0} label={en ? 'Citizens' : 'مواطن'} />
                  <StatItem
                    value={inspector.registeredPropertiesCount ?? 0}
                    label={en ? 'Billable units' : 'الوحدات المحتسبة'}
                  />
                  {/* To the cent: the server refuses a delete over $0.40 owed, so the page must not show «0». */}
                  <StatItem value={formatForeign(inspector.totalEarnings ?? 0, 'USD')} label={en ? 'Earned' : 'الأرباح'} />
                  <StatItem
                    value={formatForeign(inspector.pendingBalance ?? 0, 'USD')}
                    label={en ? 'Owed' : 'المتبقي'}
                    className={(inspector.pendingBalance ?? 0) > 0 ? 'text-warning' : undefined}
                  />
                </StatStrip>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-auto w-full"
                  onClick={() => router.push(`${base}/inspector/profile/${inspector.id}`)}
                >
                  <BadgeDollarSign className="size-4" aria-hidden />
                  {en ? 'Earnings & payouts' : 'الأرباح والدفعات'}
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

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

      {/*
        «حذف» hides the account: it leaves this list and cannot sign in, and its
        row, its details and everything it did stay on record; it can be
        restored. Confirmed by typing the account's email — unique, where two
        staff can share a name (DES-3).
      */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={en ? 'Delete staff member' : 'حذف الموظف'}
        description={
          pendingDelete ? (
            en ? (
              <>
                <span className="font-semibold text-foreground">{pendingDelete.fullName}</span> will be hidden from
                the staff list and cannot sign in. Their details and everything they did stay on record, and the
                account can be restored from «Deleted staff» — it comes back disabled.
                <span className="mt-2 block text-muted-foreground">To block sign-in for a while instead, use «Disable».</span>
              </>
            ) : (
              <>
                سيُخفى <span className="font-semibold text-foreground">{pendingDelete.fullName}</span> من قائمة
                الموظفين ولن يستطيع الدخول. تبقى بياناته وكل ما قام به محفوظة في السجلات، ويمكن استعادته من
                «الموظفون المحذوفون» — يعود معطّلاً.
                <span className="mt-2 block text-muted-foreground">لمنع الدخول مؤقتاً فقط، استخدم «التعطيل».</span>
              </>
            )
          ) : null
        }
        confirmLabel={en ? 'Delete account' : 'احذف الحساب'}
        requireText={pendingDelete?.email}
        requireTextHint={en ? "Type the account's email to confirm" : 'اكتب البريد الإلكتروني للحساب للتأكيد'}
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

/** Two letters for a staff member's avatar: their first and last initials. */
function initials(staff: StaffSummary): string {
  return `${staff.firstName.trim().charAt(0)}${staff.lastName.trim().charAt(0)}`.toUpperCase();
}
