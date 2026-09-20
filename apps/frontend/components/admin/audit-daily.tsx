'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, History, User } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getAuditDaily, getAuditLog, type AuditDaySummary, type AuditEntry } from '@/lib/api-client';
import { auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
import { describeAudit } from '@/lib/audit-describe';
import { formatMonth } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
  const en = locale === 'en';
  const [page, setPage] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const actionsKey = filter.actions?.join(',') ?? '';

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
    errorMessage: en ? 'Failed to load the daily report.' : 'تعذّر تحميل التقرير اليومي.',
    keepPrevious: true,
  });

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  const todayKey = isoDay(new Date());
  const yesterdayKey = isoDay(new Date(Date.now() - 86_400_000));

  if (query.error) {
    return (
      <ErrorState
        description={query.error}
        onRetry={query.refetch}
        retryLabel={en ? 'Retry' : 'إعادة المحاولة'}
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
        title={en ? 'Nothing in this range' : 'لا نشاط في هذا النطاق'}
        description={
          en
            ? 'Widen the date range or clear a filter.'
            : 'وسِّع نطاق التاريخ أو امسح أحد الفلاتر.'
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/*
        A real table, and every column aligned to the same edge down the page:
        these rows are read by scanning one column at a time — whose day, how
        many — and a stack of cards makes that a search rather than a glance.
      */}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{en ? 'Day' : 'اليوم'}</TableHead>
              <TableHead>{en ? 'Staff member' : 'الموظف'}</TableHead>
              <TableHead>{en ? 'What they did' : 'ما قام به'}</TableHead>
              <TableHead className="text-center">{en ? 'Actions' : 'عدد الإجراءات'}</TableHead>
              <TableHead className="text-center">{en ? 'Last' : 'آخر إجراء'}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const key = `${row.day}|${row.actor.id ?? 'system'}`;
              const open = openKey === key;
              return (
                <RowPair
                  key={key}
                  row={row}
                  open={open}
                  onToggle={() => setOpenKey(open ? null : key)}
                  tenant={tenant}
                  base={base}
                  locale={locale}
                  token={token}
                  filter={filter}
                  todayKey={todayKey}
                  yesterdayKey={yesterdayKey}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>

      {pages > 1 ? (
        <nav className="flex items-center justify-center gap-2" aria-label={en ? 'Pages' : 'الصفحات'}>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || query.fetching}
            onClick={() => {
              setOpenKey(null);
              setPage((current) => current - 1);
            }}
          >
            <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
            {en ? 'Newer' : 'الأحدث'}
          </Button>
          <span className="px-2 text-sm tabular-nums text-muted-foreground">
            {page + 1} / {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pages || query.fetching}
            onClick={() => {
              setOpenKey(null);
              setPage((current) => current + 1);
            }}
          >
            {en ? 'Older' : 'الأقدم'}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The summary row, and the drill-down row that follows it.
 *
 * Two `<tr>`s rather than a nested table: the detail belongs to the day above
 * it, and a table inside a cell loses the alignment that made the summary
 * readable in the first place.
 */
function RowPair({
  row,
  open,
  onToggle,
  tenant,
  base,
  locale,
  token,
  filter,
  todayKey,
  yesterdayKey,
}: {
  row: AuditDaySummary;
  open: boolean;
  onToggle: () => void;
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  filter: AuditFilter;
  todayKey: string;
  yesterdayKey: string;
}): React.JSX.Element {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const when =
    row.day === todayKey
      ? en
        ? 'Today'
        : 'اليوم'
      : row.day === yesterdayKey
        ? en
          ? 'Yesterday'
          : 'أمس'
        : null;

  const actorName =
    row.actor.name ??
    (row.actor.kind === 'SYSTEM' ? (en ? 'System' : 'النظام') : en ? 'Unknown' : 'غير معروف');

  /*
    The headline: the three commonest acts of the day with their counts, which
    is what «Staff X created a building» means once a day holds more than one
    thing. The remainder is a count, not an ellipsis — «و٤ أخرى» tells the
    reader whether opening the row is worth it.
  */
  const headline = row.actions.slice(0, 3);
  const rest = row.actions.length - headline.length;

  return (
    <>
      <TableRow className={open ? 'bg-muted/40' : undefined}>
        <TableCell className="align-top">
          <div className="font-medium">
            {when ?? formatMonth(new Date(`${row.day}T12:00:00`), { day: 'numeric', month: 'long' }, locale)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums" dir="ltr">
            {row.day}
          </div>
        </TableCell>

        <TableCell className="align-top">
          <div className="flex items-start gap-2">
            <span
              aria-hidden
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
            >
              <User className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium">{actorName}</div>
              {row.actor.role ? (
                <div className="truncate text-xs text-muted-foreground">
                  {(labels.staffRole as Record<string, string>)[row.actor.role] ?? row.actor.role}
                </div>
              ) : null}
            </div>
          </div>
        </TableCell>

        {/*
          Plain text, not pills.

          These were filled badges, which put three rounded blocks on every row
          of a table whose other columns are bare text — the eye landed on the
          shapes instead of the words inside them. A count is data; it needs a
          number beside it, not a container around it.
        */}
        <TableCell className="max-w-md whitespace-normal align-top">
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
                {en ? ` · +${rest} more` : ` · و${rest} أخرى`}
              </span>
            ) : null}
          </span>
        </TableCell>

        <TableCell className="text-center align-top font-semibold tabular-nums">{row.total}</TableCell>

        <TableCell className="text-center align-top text-xs tabular-nums text-muted-foreground" dir="ltr">
          {new Date(row.lastAt).toLocaleTimeString(en ? 'en-GB' : 'ar-LB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </TableCell>

        <TableCell className="align-top text-end">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onToggle} aria-expanded={open}>
            {en ? 'View details' : 'عرض التفاصيل'}
            <ChevronDown
              className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </Button>
        </TableCell>
      </TableRow>

      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="whitespace-normal bg-muted/20 p-0">
            <DayDetail
              tenant={tenant}
              base={base}
              locale={locale}
              token={token}
              filter={filter}
              day={row.day}
              actorId={row.actor.id}
              expected={row.total}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
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
  const en = locale === 'en';

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
      actorId ?? 'system',
      filter.entityType ?? '',
      filter.actions?.join(',') ?? '',
    ],
    queryFn: (tok, signal) =>
      getAuditLog(
        tenant,
        tok,
        {
          actorId: actorId ?? undefined,
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
    errorMessage: en ? 'Could not load this day.' : 'تعذّر تحميل تفاصيل هذا اليوم.',
  });

  if (query.error) {
    return (
      <div className="p-4">
        <ErrorState compact description={query.error} onRetry={query.refetch} />
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
    <div className="overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-20">{en ? 'Time' : 'الوقت'}</TableHead>
            <TableHead className="w-48">{en ? 'Action' : 'الإجراء'}</TableHead>
            <TableHead className="w-56">{en ? 'Record' : 'السجل'}</TableHead>
            <TableHead>{en ? 'What changed' : 'ما الذي تغيّر'}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <DetailRow key={entry.id} entry={entry} locale={locale} />
          ))}
        </TableBody>
      </Table>

      {/*
        Said plainly rather than paged. A single person's single day past two
        hundred entries is an import or a bulk job, and the honest thing is to
        name the cut and point at the detailed view, which pages properly.
      */}
      {expected > entries.length ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {en
            ? `Showing the first ${entries.length} of ${expected}. Use the detailed view for the rest.`
            : `تُعرض أول ${entries.length} من ${expected}. افتح العرض المفصّل لبقيتها.`}
        </p>
      ) : null}
    </div>
  );
}

function DetailRow({ entry, locale }: { entry: AuditEntry; locale: string }): React.JSX.Element {
  const en = locale === 'en';
  const description = describeAudit(entry, locale);

  /*
    Changes first, then the facts an action recorded instead of a diff — a
    login and an export have no before/after and would otherwise be a blank
    cell in a table whose every other row says something.
  */
  const lines = [
    ...description.changes.map((change) => ({
      label: change.label,
      value: `${change.before} ${en ? '→' : '←'} ${change.after}`,
    })),
    ...description.facts,
    ...description.quotes,
  ].slice(0, 4);

  return (
    <TableRow>
      <TableCell className="align-top text-xs tabular-nums text-muted-foreground" dir="ltr">
        {new Date(entry.createdAt).toLocaleTimeString(en ? 'en-GB' : 'ar-LB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </TableCell>

      <TableCell className="align-top">
        <span className="font-medium">{auditActionLabel(entry.action, locale)}</span>
        <div className="text-xs text-muted-foreground">
          {auditEntityLabel(entry.target?.type ?? entry.entityType, locale)}
        </div>
      </TableCell>

      <TableCell className="max-w-56 align-top">
        {entry.target?.label ? (
          <>
            <div className="truncate" title={entry.target.label}>
              {entry.target.label}
            </div>
            {entry.target.secondary ? (
              <div className="truncate text-xs text-muted-foreground">{entry.target.secondary}</div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/*
        Label on top, value directly under it, pairs beside each other — the
        same reading as the column headings above this table.

        Stacked as rows they were aligned but tall: an entry with four changed
        fields made a four-line cell in a table whose other three columns are
        one or two, so a day's ten actions scrolled like thirty.
      */}
      <TableCell className="whitespace-normal align-top text-xs">
        {lines.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <FactRow className="gap-x-6 gap-y-2">
            {lines.map((line, index) => (
              <FactCell key={`${line.label}-${index}`} label={line.label} value={line.value} />
            ))}
          </FactRow>
        )}
      </TableCell>
    </TableRow>
  );
}

/** `YYYY-MM-DD` in the browser's own zone — the key the server bucketed on. */
function isoDay(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
