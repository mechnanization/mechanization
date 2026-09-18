'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, History, ShieldCheck, X } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getAuditFacets, getAuditLog, type AuditEntry, type Session } from '@/lib/api-client';
import { auditEntityLabel } from '@/lib/audit-labels';
import { AUDIT_FAMILIES, auditFamilyOf } from '@/lib/audit-describe';
import { formatMonth } from '@/lib/dates';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { AuditEntryItem } from '@/components/admin/audit-entry';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

const PAGE_SIZE = 50;
const ANY = 'ANY';

/**
 * «سجل النشاطات» — who did what, to which record, and when.
 *
 * A day-grouped trail rather than a table. The question an auditor brings is a
 * story — «what happened to parcel 56 on the 15th», «what did this officer do
 * yesterday» — and a story reads down a timeline, with each entry saying its
 * own subject, author and change. The filters are the four ways that question
 * is actually narrowed: a person, a kind of act, a kind of record, a date range.
 */
export default function AuditTrailPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);

  const [session, setSession] = useState<Session | null>(null);
  const [actorId, setActorId] = useState('');
  const [family, setFamily] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const existing = loadSession(tenant);
    if (!existing || existing.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    if (existing.user.role !== 'SUPER_ADMIN' && existing.user.role !== 'AUDITOR') {
      router.replace(`${base}/dashboard`);
      return;
    }
    setSession(existing);
  }, [tenant, base, router]);

  const facets = useStaffQuery({
    queryKey: ['audit-facets', tenant],
    queryFn: (token, signal) => getAuditFacets(tenant, token, signal),
    tenant,
    base,
    token: session?.accessToken ?? null,
    errorMessage: en ? 'Could not load the filters.' : 'تعذّر تحميل خيارات التصفية.',
  });

  /** A family is sent as the action codes the log actually holds for it. */
  const familyActions = useMemo(() => {
    if (!family) return undefined;
    const matched = (facets.data?.actions ?? []).filter((action) => auditFamilyOf(action).key === family);
    return matched.length ? matched : ['__NONE__'];
  }, [family, facets.data]);

  const familiesPresent = useMemo(
    () =>
      AUDIT_FAMILIES.filter((candidate) =>
        (facets.data?.actions ?? []).some((action) => auditFamilyOf(action).key === candidate.key),
      ),
    [facets.data],
  );

  const query = useStaffQuery({
    queryKey: ['audit', tenant, actorId, family, entityType, from, to, page, familyActions?.join(',')],
    queryFn: (token, signal) =>
      getAuditLog(
        tenant,
        token,
        {
          actorId: actorId || undefined,
          entityType: entityType || undefined,
          actions: familyActions,
          from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
          to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        signal,
      ),
    tenant,
    base,
    token: session?.accessToken ?? null,
    errorMessage: en ? 'Failed to load the audit trail.' : 'تعذّر تحميل سجل النشاطات.',
    keepPrevious: true,
  });

  const entries = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const filtered = Boolean(actorId || family || entityType || from || to);

  const resetTo = useCallback(<T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(0);
  }, []);

  const clearFilters = () => {
    setActorId('');
    setFamily('');
    setEntityType('');
    setFrom('');
    setTo('');
    setPage(0);
  };

  const days = useMemo(() => groupByDay(entries), [entries]);
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));

  if (!session) return null;

  const me = session.user.id;
  const actors = facets.data?.actors ?? [];

  return (
    <div className="w-full space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={ShieldCheck}
        title={en ? 'Audit trail' : 'سجل النشاطات'}
        subtitle={
          en
            ? 'Who did what, to which record, and when. Entries cannot be edited or deleted.'
            : 'من فعل ماذا، وعلى أي سجل، ومتى. لا يمكن تعديل هذه القيود أو حذفها.'
        }
      />

      <section
        aria-label={en ? 'Filters' : 'التصفية'}
        className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto_auto_auto] lg:items-end"
      >
        <FilterField id="audit-actor" label={en ? 'Staff member' : 'الموظف'}>
          <Select value={actorId || ANY} onValueChange={(value) => resetTo(setActorId)(value === ANY ? '' : value)}>
            <SelectTrigger id="audit-actor" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{en ? 'Everyone' : 'الجميع'}</SelectItem>
              <SelectItem value={me}>{en ? `Me — ${session.user.name}` : `أنا — ${session.user.name}`}</SelectItem>
              {actors
                .filter((actor) => actor.id !== me)
                .map((actor) => (
                  <SelectItem key={actor.id} value={actor.id}>
                    {actor.name}
                    {actor.role ? ` · ${(labels.staffRole as Record<string, string>)[actor.role] ?? actor.role}` : ''}
                    {actor.isActive ? '' : en ? ' (inactive)' : ' (معطَّل)'}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField id="audit-family" label={en ? 'Kind of activity' : 'نوع النشاط'}>
          <Select value={family || ANY} onValueChange={(value) => resetTo(setFamily)(value === ANY ? '' : value)}>
            <SelectTrigger id="audit-family" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{en ? 'All activity' : 'كل الأنشطة'}</SelectItem>
              {familiesPresent.map((candidate) => (
                <SelectItem key={candidate.key} value={candidate.key}>
                  {en ? candidate.label[1] : candidate.label[0]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField id="audit-entity" label={en ? 'Record type' : 'نوع السجل'}>
          <Select
            value={entityType || ANY}
            onValueChange={(value) => resetTo(setEntityType)(value === ANY ? '' : value)}
          >
            <SelectTrigger id="audit-entity" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{en ? 'All records' : 'كل السجلات'}</SelectItem>
              {(facets.data?.entityTypes ?? []).map((type) => (
                <SelectItem key={type} value={type}>
                  {auditEntityLabel(type, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField id="audit-from" label={en ? 'From' : 'من تاريخ'}>
          <DatePicker id="audit-from" value={from} onChange={resetTo(setFrom)} max={to || undefined} locale={en ? 'en' : 'ar'} />
        </FilterField>

        <FilterField id="audit-to" label={en ? 'To' : 'إلى تاريخ'}>
          <DatePicker id="audit-to" value={to} onChange={resetTo(setTo)} locale={en ? 'en' : 'ar'} />
        </FilterField>

        <Button variant="ghost" className="h-10 gap-1.5" onClick={clearFilters} disabled={!filtered}>
          <X className="size-4" aria-hidden />
          {en ? 'Clear' : 'مسح'}
        </Button>
      </section>

      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground" aria-live="polite">
        <span className="flex items-center gap-1.5">
          <History className="size-4" aria-hidden />
          {query.data
            ? en
              ? `${total.toLocaleString('en')} ${total === 1 ? 'entry' : 'entries'}`
              : `${total.toLocaleString('ar')} نشاط`
            : null}
        </span>
        {pages > 1 ? (
          <span className="tabular-nums">
            {en ? `Page ${page + 1} of ${pages}` : `صفحة ${page + 1} من ${pages}`}
          </span>
        ) : null}
      </div>

      {query.error ? (
        <ErrorState description={query.error} onRetry={query.refetch} retryLabel={en ? 'Retry' : 'إعادة المحاولة'} />
      ) : query.loading && !query.data ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex gap-3 rounded-xl border bg-card p-4">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={History}
          title={filtered ? (en ? 'Nothing matches these filters' : 'لا نشاطات تطابق هذه التصفية') : en ? 'No activity recorded yet' : 'لم يُسجَّل أي نشاط بعد'}
          description={
            filtered
              ? en
                ? 'Widen the date range or clear a filter.'
                : 'وسِّع نطاق التاريخ أو امسح أحد الفلاتر.'
              : undefined
          }
          action={
            filtered ? (
              <Button variant="outline" onClick={clearFilters}>
                {en ? 'Clear filters' : 'مسح التصفية'}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={query.fetching ? 'space-y-5 opacity-70 transition-opacity' : 'space-y-5 transition-opacity'}>
          {days.map((day) => (
            <section key={day.key} aria-labelledby={`day-${day.key}`}>
              <h2
                id={`day-${day.key}`}
                className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground"
              >
                {day.key === today ? (en ? 'Today' : 'اليوم') : day.key === yesterday ? (en ? 'Yesterday' : 'أمس') : null}
                <span className={day.key === today || day.key === yesterday ? 'font-normal text-muted-foreground' : ''}>
                  {formatMonth(day.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale)}
                </span>
                <span className="ms-auto text-xs font-normal tabular-nums text-muted-foreground">
                  {en ? `${day.entries.length} entries` : `${day.entries.length} نشاط`}
                </span>
              </h2>
              <ol className="divide-y rounded-xl border bg-card px-4">
                {day.entries.map((entry) => (
                  <AuditEntryItem key={entry.id} entry={entry} locale={locale} base={base} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {pages > 1 ? (
        <nav className="flex items-center justify-center gap-2" aria-label={en ? 'Pages' : 'الصفحات'}>
          <Button variant="outline" size="sm" disabled={page === 0 || query.fetching} onClick={() => setPage((current) => current - 1)}>
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
            onClick={() => setPage((current) => current + 1)}
          >
            {en ? 'Older' : 'الأقدم'}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function FilterField({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupByDay(entries: readonly AuditEntry[]) {
  const groups: Array<{ key: string; date: Date; entries: AuditEntry[] }> = [];
  for (const entry of entries) {
    const date = new Date(entry.createdAt);
    const key = dayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, date, entries: [entry] });
  }
  return groups;
}
