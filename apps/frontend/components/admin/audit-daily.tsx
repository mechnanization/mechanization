'use client';

import { useMemo, useRef, useState } from 'react';
import { ChevronDown, History, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { AUDIT_SYSTEM_ACTOR, getLabels } from '@mechanization/shared-schemas';
import { getAuditDaily, getAuditLog, type AuditDaySummary, type AuditEntry } from '@/lib/api-client';
import { auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
import { describeAudit } from '@/lib/audit-describe';
import { formatMonth } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { usePagerLabels } from '@/lib/use-pager-labels';
import { useTableLabels } from '@/lib/use-table-labels';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Pager } from '@/components/ui/pager';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

const PAGE_SIZE = 50;

/** How many rows a drill-down will show before it stops asking for more. */
const DETAIL_LIMIT = 200;

export interface AuditFilter {
  actorId?: string;
  entityType?: string;
  actions?: string[];
  from?: string;
  to?: string;
}

/**
 * «التقرير اليومي» — one row per staff member per day, and the day itself
 * underneath when asked.
 *
 * The detailed trail answers «what happened»; this answers «who was working,
 * and on what» — the question somebody actually opens a log with at the end of
 * a week. A row is a summary record: «جواد — ٩ إجراءات · أنشأ مبنى ×١، أضاف
 * وحدة ×٦», with «عرض التفاصيل» opening every one of those nine as a table.
 *
 * The roll-up is the server's, not this component's. Grouping the fifty rows a
 * page happens to hold would split a day across a page boundary and count a
 * busy officer's work as whatever fell on screen — see `AuditRepository.daily`.
 */
export function AuditDaily({
  tenant,
  base,
  locale,
  token,
  filter,
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}` — what a record link hangs off. */
  base: string;
  locale: string;
  token: string | null;
  /** The page's filter bar, applied to the summary and to every drill-down. */
  filter: AuditFilter;
}): React.JSX.Element {
  const t = useTranslations('audit.daily');
  const tCommon = useTranslations('common');
  const [page, setPage] = useState(0);
  /** The top of the table, which the pager brings back into view after a page change. */
  const tableTop = useRef<HTMLDivElement>(null);

  const actionsKey = filter.actions?.join(',') ?? '';

  const pagerLabels = usePagerLabels();
  const tableLabels = useTableLabels();
  const query = useStaffQuery<{ items: AuditDaySummary[]; total: number }>({
    queryKey: [
      'audit-daily',
      tenant,
      filter.actorId ?? '',
      filter.entityType ?? '',
      actionsKey,
      filter.from ?? '',
      filter.to ?? '',
      page,
    ],
    queryFn: (tok, signal) =>
      getAuditDaily(
        tenant,
        tok,
        { ...filter, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('loadFailed'),
    keepPrevious: true,
  });

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;

  const todayKey = isoDay(new Date());
  const yesterdayKey = isoDay(new Date(Date.now() - 86_400_000));

  const columns = useMemo<ColumnDef<AuditDaySummary>[]>(() => {
    const en = locale === 'en';
    const labels = getLabels(locale);
    return [
      {
        id: 'day',
        header: t('colDay'),
        meta: { mobile: 'primary', cellClassName: 'align-top' },
        cell: ({ row }) => {
          const when = row.original.day === todayKey ? t('today') : row.original.day === yesterdayKey ? t('yesterday') : null;
          return (
            <>
              <div className="font-medium">
                {when ?? formatMonth(new Date(`${row.original.day}T12:00:00`), { day: 'numeric', month: 'long' }, locale)}
              </div>
              <div className="text-xs text-muted-foreground tabular-nums" dir="ltr">
                {row.original.day}
              </div>
            </>
          );
        },
      },
      {
        id: 'staff',
        header: t('colStaff'),
        meta: { cellClassName: 'align-top' },
        cell: ({ row }) => {
          const { actor } = row.original;
          const actorName = actor.name ?? (actor.kind === 'SYSTEM' ? t('system') : t('unknown'));
          return (
            <div className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
              >
                <User className="size-3.5" />
              </span>
              <div className="min-w-0">
                <div className="truncate font-medium">{actorName}</div>
                {actor.role ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {(labels.staffRole as Record<string, string>)[actor.role] ?? actor.role}
                  </div>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        /*
          Plain text, not pills.

          These were filled badges, which put three rounded blocks on every row
          of a table whose other columns are bare text — the eye landed on the
          shapes instead of the words inside them. A count is data; it needs a
          number beside it, not a container around it.
        */
        id: 'what',
        header: t('colWhat'),
        meta: { cellClassName: 'max-w-md whitespace-normal align-top' },
        cell: ({ row }) => {
          /*
            The headline: the three commonest acts of the day with their counts,
            which is what «Staff X created a building» means once a day holds
            more than one thing. The remainder is a count, not an ellipsis —
            «و٤ أخرى» tells the reader whether opening the row is worth it.
          */
          const headline = row.original.actions.slice(0, 3);
          const rest = row.original.actions.length - headline.length;
          return (
            <span className="text-foreground">
              {headline.map((item, index) => (
                <span key={item.action}>
                  {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
                  {auditActionLabel(item.action, locale)}
                  {item.count > 1 ? (
                    <span className="ms-1 tabular-nums text-muted-foreground">×{item.count}</span>
                  ) : null}
                </span>
              ))}
              {rest > 0 ? (
                <span className="text-muted-foreground">
                  {' · '}
                  {t('more', { count: rest })}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'count',
        header: t('colCount'),
        meta: { align: 'center', cellClassName: 'align-top font-semibold tabular-nums' },
        cell: ({ row }) => row.original.total,
      },
      {
        id: 'last',
        header: t('colLast'),
        meta: { align: 'center', cellClassName: 'align-top text-xs tabular-nums text-muted-foreground' },
        cell: ({ row }) => (
          <span dir="ltr">
            {new Date(row.original.lastAt).toLocaleTimeString(en ? 'en-GB' : 'ar-LB-u-nu-latn', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
        ),
      },
      {
        /*
          «عرض التفاصيل». One day is open at a time, as before: opening another
          closes the first, so a long page does not become fifty open trails.
          `DataTable` draws the open row's `renderSubRow` under the row, and at
          the foot of its card on a phone.
        */
        id: 'details',
        header: '',
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions', cellClassName: 'align-top' },
        cell: ({ row, table }) => {
          const open = row.getIsExpanded();
          return (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              aria-expanded={open}
              onClick={() => {
                table.resetExpanded(true);
                if (!open) row.toggleExpanded(true);
              }}
            >
              {t('viewDetails')}
              <ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
            </Button>
          );
        },
      },
    ];
  }, [t, locale, todayKey, yesterdayKey]);

  if (query.error) {
    return (
      <ErrorState
        description={query.error} offline={query.offline}
        onRetry={query.refetch}
        retryLabel={tCommon('retry')}
      />
    );
  }

  if (query.loading && !query.data) {
    return (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('emptyTitle')}
        description={t('emptyBody')}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/*
        A real table, and every column aligned to the same edge down the page:
        these rows are read by scanning one column at a time — whose day, how
        many — and a stack of cards makes that a search rather than a glance.
        Below `sm` it is cards, as every table is. The page is the server's
        (`Pager` below), so the table neither pages nor sorts what it holds.
      */}
      <div ref={tableTop}>
        <DataTable
          columns={columns}
          data={rows}
          labels={tableLabels}
          getRowId={(row) => `${row.day}|${row.actor.id ?? 'system'}`}
          searchable={false}
          sortable={false}
          paginated={false}
          getRowCanExpand={() => true}
          renderSubRow={(row) => (
            <DayDetail
              tenant={tenant}
              base={base}
              locale={locale}
              token={token}
              filter={filter}
              day={row.original.day}
              actorId={row.original.actor.id}
              expected={row.original.total}
            />
          )}
        />
      </div>

      {/* Newest first: the previous page is the newer one. Renders nothing on a single page. */}
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        labels={pagerLabels}
        disabled={query.fetching}
        scrollTarget={tableTop}
      />
    </div>
  );
}

/**
 * Every action one staff member took on one day, as a table.
 *
 * Fetched only once the row is opened — a page of fifty summaries would
 * otherwise be fifty trails nobody asked for. The filters come down from the
 * page unchanged, so a drill-down holds exactly the rows its summary counted.
 */
function DayDetail({
  tenant,
  base,
  locale,
  token,
  filter,
  day,
  actorId,
  expected,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  filter: AuditFilter;
  day: string;
  actorId: string | null;
  expected: number;
}): React.JSX.Element {
  const t = useTranslations('audit.daily');
  const tableLabels = useTableLabels();

  /*
    The day's own bounds, in the reader's zone — `new Date('2026-09-20T00:00:00')`
    with no `Z` is local midnight, which is the boundary the server bucketed on
    when it was handed this browser's zone.
  */
  const from = new Date(`${day}T00:00:00`).toISOString();
  const to = new Date(`${day}T23:59:59.999`).toISOString();

  const query = useStaffQuery<{ items: AuditEntry[]; total: number }>({
    queryKey: [
      'audit-day-detail',
      tenant,
      day,
      actorId ?? AUDIT_SYSTEM_ACTOR,
      filter.entityType ?? '',
      filter.actions?.join(',') ?? '',
    ],
    queryFn: (tok, signal) =>
      getAuditLog(
        tenant,
        tok,
        {
          /*
            «النظام» has no id: its entries are the ones with none. Sent as
            undefined, the filter fell away and the row drilled into every
            actor's entries for the day — and «first N of M» compared them
            with the system row's own total.
          */
          actorId: actorId ?? AUDIT_SYSTEM_ACTOR,
          entityType: filter.entityType,
          actions: filter.actions,
          from,
          to,
          limit: DETAIL_LIMIT,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('dayLoadFailed'),
  });

  const columns = useMemo<ColumnDef<AuditEntry>[]>(() => {
    const en = locale === 'en';
    return [
      {
        id: 'time',
        header: t('colTime'),
        meta: { headerClassName: 'w-20', cellClassName: 'align-top text-xs tabular-nums text-muted-foreground' },
        cell: ({ row }) => (
          <bdi dir="ltr">
            {new Date(row.original.createdAt).toLocaleTimeString(en ? 'en-GB' : 'ar-LB-u-nu-latn', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </bdi>
        ),
      },
      {
        id: 'action',
        header: t('colAction'),
        meta: { mobile: 'primary', headerClassName: 'w-48', cellClassName: 'align-top' },
        cell: ({ row }) => (
          <>
            <span className="font-medium">{auditActionLabel(row.original.action, locale)}</span>
            <div className="text-xs text-muted-foreground">
              {auditEntityLabel(row.original.target?.type ?? row.original.entityType, locale)}
            </div>
          </>
        ),
      },
      {
        id: 'record',
        header: t('colRecord'),
        meta: { headerClassName: 'w-56', cellClassName: 'max-w-56 align-top' },
        cell: ({ row }) =>
          row.original.target?.label ? (
            <>
              <div className="truncate" title={row.original.target.label}>
                {row.original.target.label}
              </div>
              {row.original.target.secondary ? (
                <div className="truncate text-xs text-muted-foreground">{row.original.target.secondary}</div>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        /*
          Label on top, value directly under it, pairs beside each other — the
          same reading as the column headings above this table.

          Stacked as rows they were aligned but tall: an entry with four changed
          fields made a four-line cell in a table whose other three columns are
          one or two, so a day's ten actions scrolled like thirty.

          Changes first, then the facts an action recorded instead of a diff — a
          login and an export have no before/after and would otherwise be a blank
          cell in a table whose every other row says something.
        */
        id: 'changes',
        header: t('colChanges'),
        meta: { cellClassName: 'whitespace-normal align-top text-xs' },
        cell: ({ row }) => {
          const description = describeAudit(row.original, locale);
          const lines = [
            ...description.changes.map((change) => ({
              label: change.label,
              value: `${change.before} ${en ? '→' : '←'} ${change.after}`,
            })),
            ...description.facts,
            ...description.quotes,
          ].slice(0, 4);
          return lines.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <FactRow>
              {lines.map((line, index) => (
                <FactCell key={`${line.label}-${index}`} label={line.label} value={line.value} />
              ))}
            </FactRow>
          );
        },
      },
    ];
  }, [t, locale]);

  if (query.error) {
    return (
      <div className="p-4">
        <ErrorState compact description={query.error} offline={query.offline} onRetry={query.refetch} />
      </div>
    );
  }

  if (query.loading) {
    return (
      <div className="space-y-2 p-4" aria-busy>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }

  const entries = query.data?.items ?? [];

  return (
    <div>
      <DataTable
        className="rounded-none border-0 shadow-none"
        columns={columns}
        data={entries}
        labels={tableLabels}
        getRowId={(entry) => entry.id}
        searchable={false}
        sortable={false}
        paginated={false}
      />

      {/*
        Said plainly rather than paged. A single person's single day past two
        hundred entries is an import or a bulk job, and the honest thing is to
        name the cut and point at the detailed view, which pages properly.
      */}
      {expected > entries.length ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t('truncated', { shown: entries.length, expected })}
        </p>
      ) : null}
    </div>
  );
}

/** `YYYY-MM-DD` in the browser's own zone — the key the server bucketed on. */
function isoDay(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
