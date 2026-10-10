'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Archive,
  BadgeDollarSign,
  Ban,
  Banknote,
  Check,
  CheckCircle2,
  Copy,
  HandCoins,
  KeyRound,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { getLabels, STAFF_ROLE, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
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
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { CellTag } from '@/components/ui/cell-tag';
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
import { ChipGroup, SegmentedControl } from '@/components/ui/segmented-control';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { StaffForm, type StaffFormValues } from '@/components/admin/staff-form';
import { PresenceCell } from '@/components/admin/staff/presence-cell';
import { DeletedStaffSection } from '@/components/admin/staff/deleted-staff-section';
import { StaffSalaryDialog } from '@/components/admin/staff/staff-salary-dialog';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { useStaffPresence } from '@/lib/use-staff-presence';

/**
 * The directory's table labels. The archive overrides two of them from the
 * `staff.archive` messages: an empty table means "nobody has been added yet"
 * in the directory and "nobody has been disabled" in the archive, and saying
 * the first in the second told an admin their staff had vanished (STA-1).
 */
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

/** The role chips: «all», or one of the roles the server knows. */
const ROLE_FILTERS = ['all', ...STAFF_ROLE] as const;

/**
 * The two halves of the directory. An account that is disabled keeps its row,
 * its details and everything it did; what the archive changes is where that
 * row is read, so the list of people who can sign in today is only those
 * people. «الأرشيف» is the place, «معطّل» is still the state (TXT-3).
 */
const VIEWS = ['active', 'archived'] as const;

/**
 * `?view=` — the active directory or the archive; `?role=` — which role either
 * is narrowed to. Module scope: `useUrlState` memoises on it.
 */
const FILTERS = {
  view: param.oneOf(VIEWS, 'active'),
  role: param.oneOf(ROLE_FILTERS, 'all'),
};

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
  const [role, setRole] = useState<string | null>(null);
  /** A failed *write*. The read reports its own failure through the query. */
  const [actionError, setActionError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StaffSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The account whose deletion is being confirmed, or null. */
  const [pendingDelete, setPendingDelete] = useState<StaffSummary | null>(null);
  /** The staff member a salary is being paid to, or null. */
  const [paying, setPaying] = useState<StaffSummary | null>(null);
  /** The inspector a commission is being paid to, or null. */
  const [payingCommission, setPayingCommission] = useState<StaffSummary | null>(null);
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
    setRole(session.user.role ?? null);
  }, [tenant, base, router]);

  /*
    Unparameterised: the whole staff list, filtered and paged in the browser.

    That is right here and nowhere else on the portal — a municipality has a
    dozen accounts, not a register of thousands — so the search box below
    filters in TanStack and never reaches the API. It still benefits from the cache:
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
  /*
    «متصل الآن» stops being true on its own, with nothing on this page to
    invalidate it — so presence is its own light read, polled once a minute on
    the server's clock (`useStaffPresence`), and the roster above, which
    computes every inspector's earnings, is read once.
  */
  const tStaff = useTranslations('staff');
  const presence = useStaffPresence({ tenant, base, token, errorMessage: tStaff('presence.loadError') });

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
        toast.success(reactivating ? tStaff('toast.reactivated') : tStaff('toast.disabled'), {
          description: reactivating
            ? tStaff('toast.reactivatedDescription', { name: staff.fullName })
            : tStaff('toast.disabledDescription', { name: staff.fullName }),
        });
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : tStaff('toast.updateFailed');
        setActionError(message);
        toast.error(tStaff('toast.updateFailed'), { description: message });
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, tStaff],
  );

  const removeStaff = useCallback(
    async (staff: StaffSummary) => {
      if (!token) throw new Error('انتهت الجلسة.');
      setBusyId(staff.id);
      try {
        await deleteStaff(tenant, token, staff.id);
        await load();
        toast.success(tStaff('toast.deleted'), {
          description: tStaff('toast.deletedDescription', { name: staff.fullName }),
        });
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.message : tStaff('toast.deleteFailed');
        setActionError(message);
        // Rethrown so the dialog stays open with the reason in place — the
        // server refuses the last SUPER_ADMIN, and that is worth reading.
        throw new Error(message);
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, load, toast, tStaff],
  );

  const labels = getLabels(locale);
  const en = locale === 'en';
  const roleLabel = useCallback(
    (role: string) => labels.staffRole?.[role as never] ?? role,
    [labels],
  );

  /*
    The directory's view survives a reload: the role chip and the page in the
    URL, the search — a name or an email — in this tab's storage, never the URL
    (`tab-search.ts`).
  */
  const [filters, setFilters] = useUrlState(FILTERS);
  const [search, setSearch] = useTabSearch(tenant, 'staff');
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });

  const archived = filters.view === 'archived';
  /*
    The directory is the accounts that can sign in; the archive is the ones
    that cannot. Both are read from the same request — the server returns
    every account that has not been deleted — so switching views costs nothing
    and the counts on the switch are always in step with the rows under it.
  */
  const activeStaff = useMemo(() => items.filter((staff) => staff.isActive), [items]);
  const archivedStaff = useMemo(() => items.filter((staff) => !staff.isActive), [items]);
  const pool = archived ? archivedStaff : activeStaff;

  const roles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const staff of pool) counts.set(staff.role, (counts.get(staff.role) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [pool]);
  /**
   * Which role the list is narrowed to; «all» is everyone in this view.
   *
   * A role nobody holds — a stale link, the last such account deleted, or a
   * role held only in the other view — reads as «all» once the accounts are
   * in, rather than an empty table under a chip row with nothing selected.
   */
  const roleFilter =
    filters.role !== 'all' && roles.some(([role]) => role === filters.role) ? filters.role : 'all';
  const shown = useMemo(
    () => (roleFilter === 'all' ? pool : pool.filter((staff) => staff.role === roleFilter)),
    [pool, roleFilter],
  );
  const activeCount = activeStaff.length;
  /*
    Counted off the active half only, for the same reason the column refuses to
    call a disabled account present: a revoked session cannot be making
    requests. On the server's clock, recomputed on each render — which the
    presence read's one-minute poll is what drives.
  */
  const onlineCount = activeStaff.filter((staff) => presence.isOnline(staff.id)).length;
  /* Every field inspector, disabled ones included, as the «الموظفون» count beside it includes them. */
  const inspectors = items.filter((staff) => staff.role === 'FIELD_INSPECTOR');
  /*
    «صرف راتب / أجر» is a finance act on a staff page: offered to the roles that
    may record an expense, which `ExpensesController` enforces either way.
  */
  const canPaySalary = hasRole(TREASURY_WORK_ROLES, role);
  /*
    «صرف عمولة» reads the inspector's figures by id, which only the manager
    may (`StaffController.getInspectorProfile`); the payout itself is open to
    the treasury's working roles, and an accountant reaches it by the API.
  */
  const canPayCommission = role === 'SUPER_ADMIN';

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
        /*
          «الحضور» — here now, or when they last were.

          Its own column rather than another tag in «الحالة», because the two
          answer different questions: «الحالة» is whether this account *may*
          sign in, «الحضور» is whether somebody is using it. An account can be
          فعّال and away for a week, which is the normal state of most of them.

          Sorted on the raw timestamp, so «متصل الآن» sorts above «منذ ٥
          دقائق» above «لم يظهر بعد» — an administrator asking "who is on right
          now" gets them at one end of one sort.
        */
        id: 'presence',
        // The presence read's stamp, fresher than the roster's; the roster's until it arrives.
        accessorFn: (row) => {
          const seen = presence.lastSeen(row.id) ?? row.lastSeenAt ?? null;
          return seen ? new Date(seen).getTime() : 0;
        },
        header: tStaff('presence.header'),
        cell: ({ row }) => (
          <PresenceCell
            online={row.original.isActive && presence.isOnline(row.original.id)}
            lastSeenAt={presence.lastSeen(row.original.id) ?? row.original.lastSeenAt ?? null}
            now={presence.now()}
            locale={locale}
          />
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

              {/* Active accounts only: the directory is who works here now. */}
              {canPaySalary && staff.isActive ? (
                <ActionTooltip label={tStaff('payout.paySalary')}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={tStaff('payout.paySalary')}
                    disabled={busy}
                    onClick={() => setPaying(staff)}
                  >
                    <Banknote className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}

              {/* Disabled inspectors too: what was earned is owed whether or not they still work here. */}
              {canPayCommission && staff.role === 'FIELD_INSPECTOR' ? (
                <ActionTooltip label={tStaff('commission.action')}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={tStaff('commission.action')}
                    disabled={busy}
                    onClick={() => setPayingCommission(staff)}
                  >
                    <HandCoins className="size-4" aria-hidden />
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
                    staff.isActive ? tStaff('toggle.disableHint') : tStaff('toggle.reactivateHint')
                  }
                >
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={staff.isActive ? tStaff('toggle.disable') : tStaff('toggle.reactivate')}
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
    [selfId, busyId, toggleActive, en, locale, roleLabel, base, router, presence, tStaff, canPaySalary, canPayCommission],
  );

  if (!token) return null;

  const tableLabels: DataTableLabels = {
    ...getTableLabels(locale),
    ...(archived ? { searchAriaLabel: tStaff('archive.search'), empty: tStaff('archive.empty') } : {}),
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={UsersRound}
        title={en ? 'Staff' : 'الموظفون'}
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
        <StatItem value={items.length} label={tStaff('stats.staff')} />
        <StatItem value={activeCount} label={tStaff('stats.active')} />
        <StatItem value={onlineCount} label={tStaff('stats.onlineNow')} className="text-success" />
        <StatItem value={archivedStaff.length} label={tStaff('stats.inArchive')} />
        <StatItem value={inspectors.length} label={tStaff('stats.inspectors')} />
      </StatStrip>

      {/* ── The directory, and the archive beside it ────────────────── */}
      <section className="space-y-3">
        {/*
          Always rendered, both counts on it, so an archived account is always
          one press away and an empty archive says so itself rather than
          leaving an admin to wonder where a disabled account went.
        */}
        <SegmentedControl
          aria-label={tStaff('views.label')}
          value={filters.view}
          size="sm"
          fullWidth={false}
          // A role chosen in one view rarely exists in the other, and page 3
          // of the directory is not page 3 of the archive.
          onChange={(view) =>
            setFilters({ view: view as (typeof VIEWS)[number] }, { clear: ['page', 'role'] })
          }
          options={[
            {
              value: 'active',
              label: tStaff('views.active', { count: activeStaff.length }),
              icon: UsersRound,
            },
            {
              value: 'archived',
              label: tStaff('views.archived', { count: archivedStaff.length }),
              icon: Archive,
            },
          ]}
        />
        {roles.length > 1 ? (
          <ChipGroup
            aria-label={en ? 'Role' : 'الصلاحية'}
            value={roleFilter}
            // Back to page one in the same write, as the table did when its rows changed.
            onChange={(role) =>
              setFilters({ role: role as (typeof ROLE_FILTERS)[number] }, { clear: ['page'] })
            }
            options={[
              { value: 'all', label: `${en ? 'All' : 'الكل'} (${pool.length})` },
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
          pagination={pagination}
          onPaginationChange={setPagination}
          searchValue={search}
          onSearchChange={setSearch}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {archived ? tStaff('captions.archived') : tStaff('captions.active')}
        </p>
      </section>

      {/* ── Deleted staff, restorable ─────────────────────────────── */}
      <DeletedStaffSection
        tenant={tenant}
        base={base}
        token={token}
        locale={locale}
        onRestored={load}
        onError={setActionError}
      />

      {paying ? (
        <StaffSalaryDialog
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          staff={paying}
          onClose={() => setPaying(null)}
        />
      ) : null}

      <InspectorPayoutDialog
        open={payingCommission !== null}
        onOpenChange={(next) => !next && setPayingCommission(null)}
        tenant={tenant}
        base={base}
        token={token}
        locale={locale}
        staff={payingCommission ? { id: payingCommission.id, name: payingCommission.fullName } : null}
        onRecorded={load}
      />

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
        title={tStaff('delete.title')}
        description={
          pendingDelete ? (
            <>
              {tStaff.rich('delete.body', {
                name: pendingDelete.fullName,
                strong: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
              })}
              <span className="mt-2 block text-muted-foreground">{tStaff('delete.hint')}</span>
            </>
          ) : null
        }
        confirmLabel={tStaff('delete.confirm')}
        requireText={pendingDelete?.email}
        requireTextHint={tStaff('delete.requireTextHint')}
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
