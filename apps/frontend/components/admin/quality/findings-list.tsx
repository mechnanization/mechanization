'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { CircleCheck, ShieldQuestion } from 'lucide-react';
import { qualityLabels, type QualityFindingKind } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import {
  dismissFinding,
  getFindings,
  restoreFinding,
  type QualityFinding,
} from '@/lib/quality-api';
import { formatRelative } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  FindingActions,
  FindingDetail,
  ResolveDialog,
  SeverityMark,
  subjectHref,
} from './finding-parts';
import { FindingCompare } from './finding-compare';
import { FindingDetails } from './finding-details';

/**
 * «ملاحظات الجودة» — what the register itself can tell is probably wrong.
 *
 * ## The three screens behind one route
 *
 * A reviewer's work here is three steps and the screen is three views:
 *
 *  1. **The queue** — one row per finding, every row saying the same six things
 *     in the same six places, with the same three controls at the end of it.
 *     A queue is read down a column; that only works if there *are* columns,
 *     which is why this is a table and not a stack of cards.
 *  2. **«عرض التفاصيل»** — the finding, its records, and every other finding
 *     against those same records. See `FindingDetails` for why the last part is
 *     the point rather than a nicety.
 *  3. **«الإجراء»** — the two conflicting records side by side, on one grid, with
 *     the three fields a duplicate is decided on correctable in place. See
 *     `FindingCompare`.
 *
 * They are views rather than routes deliberately. The queue's filters, its
 * search and its page are a reviewer's working position in a list of a hundred
 * findings, and a route change throws all three away — so the way back from a
 * comparison lands exactly where the way in left.
 *
 * ## What is stored, and what is not
 *
 * Nothing on this screen is a record of a finding: findings are recomputed from
 * the register on every read, so one that gets fixed disappears by itself. The
 * only thing written is «تم الحل» and the reason somebody gave for it — and the
 * dialog that writes it says so, because a reviewer who presses it on a record
 * they mean to fix later has silenced a reminder rather than fixed anything.
 */

type View =
  | { mode: 'list' }
  | { mode: 'details'; key: string }
  | { mode: 'compare'; key: string };

const keyOf = (finding: QualityFinding) => `${finding.kind}|${finding.subjectKey}`;

/**
 * The roles that may write to a citizen's file at all.
 *
 * The intersection of two lists that are not the same: `QUALITY_REVIEWER_ROLES`
 * opens this screen (and includes an auditor), while `PATCH /citizens/:id` is
 * for the roles that register households. An auditor comparing two files is
 * doing their job; offering them an «تعديل» button that the endpoint answers
 * with 403 is the portal handing somebody a control it knows will fail.
 */
const CITIZEN_EDIT_ROLES: readonly string[] = ['SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER'];

function tableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search findings',
      searchPlaceholder: 'Search by record, reference number or officer…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'Nothing to look at.',
      emptyHint:
        'No duplicate records, copied numbers or contradictions were found in the register.',
      emptySearch: 'No finding matches your search.',
      emptySearchHint: 'Try the record’s name, its reference number, or the officer who filed it.',
      loadError: 'Failed to load the findings.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} findings',
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
    searchAriaLabel: 'بحث في الملاحظات',
    searchPlaceholder: 'ابحث باسم السجل أو رقمه المرجعي أو الموظف…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا ملاحظات.',
    emptyHint: 'لم يُعثر على سجلات مكرَّرة أو أرقام منقولة أو تناقضات في السجل.',
    emptySearch: 'لا ملاحظة مطابقة لبحثك.',
    emptySearchHint: 'جرّب اسم السجل أو رقمه المرجعي أو اسم الموظف الذي سجَّله.',
    loadError: 'تعذّر تحميل ملاحظات الجودة.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'صفوف في الصفحة',
    totalRows: '{count} ملاحظة',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'إعادة الافتراضي',
    filters: 'الفلاتر',
    clearFilters: 'مسح الفلاتر',
  };
}

export function FindingsList({
  tenant,
  base,
  locale,
  token,
  role,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  /** The viewer's role — decides whether a correction can be offered at all. */
  role?: string;
}): React.JSX.Element {
  const en = locale === 'en';
  // Memoised because the column definitions below hang off it: `qualityLabels`
  // returns a fresh object per call, which would rebuild every column on every
  // keystroke in the table's own search box.
  const quality = useMemo(() => qualityLabels(locale), [locale]);
  const toast = useToast();

  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [kind, setKind] = useState<QualityFindingKind | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [resolving, setResolving] = useState<QualityFinding | null>(null);
  const [view, setView] = useState<View>({ mode: 'list' });

  const query = useStaffQuery({
    queryKey: ['quality-findings', tenant, includeDismissed],
    queryFn: (tok, signal) => getFindings(tenant, tok, { includeDismissed }, signal),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the findings.' : 'تعذّر تحميل ملاحظات الجودة.',
    keepPrevious: true,
  });

  const all = useMemo(() => query.data?.items ?? [], [query.data]);
  const items = useMemo(
    () => all.filter((finding) => !kind || finding.kind === kind),
    [all, kind],
  );

  const counts = query.data?.counts ?? {};
  const kinds = Object.entries(counts)
    .filter(([, value]) => (value?.open ?? 0) > 0 || includeDismissed)
    .sort((a, b) => (b[1]?.open ?? 0) - (a[1]?.open ?? 0));

  /** The finding a sub-view is about, looked up fresh so a refetch flows through. */
  const selected =
    view.mode === 'list' ? null : (all.find((finding) => keyOf(finding) === view.key) ?? null);

  /**
   * Everything else open against the same records.
   *
   * Matched on the records themselves rather than on the subject key: the key is
   * a pair for a duplicate and a single id for a missing pin, so two findings
   * about one building share no key at all — which is precisely the case this
   * list exists to surface.
   */
  const related = useMemo(() => {
    if (!selected) return [];
    const ids = new Set(selected.subjects.map((subject) => `${subject.kind}:${subject.id}`));
    if (ids.size === 0) return [];
    return all.filter(
      (finding) =>
        keyOf(finding) !== keyOf(selected) &&
        finding.subjects.some((subject) => ids.has(`${subject.kind}:${subject.id}`)),
    );
  }, [all, selected]);

  /**
   * One write, reported once.
   *
   * `quiet` is for a caller that shows the failure itself — the «تم الحل» dialog
   * keeps the reason on screen and prints the server's sentence under it, and a
   * toast saying the same thing behind a modal is the same news twice. The
   * error is rethrown either way, so nobody has to guess whether it worked.
   */
  const run = async (
    key: string,
    work: () => Promise<unknown>,
    done: string,
    quiet = false,
  ) => {
    if (!token) return;
    setBusy(key);
    try {
      await work();
      toast.success(done);
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      if (!quiet) {
        toast.error(
          caught instanceof ApiRequestError ? caught.message : en ? 'Not saved.' : 'لم يُحفظ.',
        );
      }
      throw caught;
    } finally {
      setBusy(null);
    }
  };

  const reopen = (finding: QualityFinding) =>
    void run(
      keyOf(finding),
      () =>
        restoreFinding(tenant, token!, { kind: finding.kind, subjectKey: finding.subjectKey }),
      en ? 'Reopened' : 'أُعيد فتح الملاحظة',
    ).catch(() => undefined);

  const columns = useMemo<ColumnDef<QualityFinding>[]>(
    () => [
      {
        id: 'finding',
        accessorFn: (finding) => quality.findingKind[finding.kind] ?? finding.kind,
        header: en ? 'Finding' : 'الملاحظة',
        meta: {
          mobile: 'primary',
          label: en ? 'Finding' : 'الملاحظة',
          headerClassName: 'w-px',
        },
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <SeverityMark severity={row.original.severity} locale={locale} withText={false} />
            <span className="font-medium">
              {quality.findingKind[row.original.kind] ?? row.original.kind}
            </span>
            {/*
              The state rides on the name rather than holding a column of its
              own: with «إظهار المحلولة» off every row is open, so a column that
              says «مفتوحة» eleven times says nothing.
            */}
            {row.original.dismissal ? (
              <Badge variant="soft-muted">{en ? 'Resolved' : 'تم الحل'}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'detail',
        accessorFn: (finding) => finding.detail,
        header: en ? 'What was found' : 'ما الذي وُجد',
        /*
          The one column that takes the leftover width, and the reason the row
          has no gap in the middle of it.

          Every other column asks for exactly what its content needs (`w-px`),
          so whatever the window has to spare lands here instead of pooling
          between two columns. `max-w-0` on the cell is what makes the clipping
          work: a table column grows to its widest unbreakable content, and this
          sentence never wraps — without it the column would size itself to the
          longest finding in the register and the ellipsis would never appear.
        */
        meta: {
          label: en ? 'What was found' : 'ما الذي وُجد',
          headerClassName: 'w-full min-w-[12rem]',
          cellClassName: 'max-w-0',
        },
        // One line, clipped, with the whole sentence on hover. The row's job is
        // to be recognised at a glance; reading it is what «عرض التفاصيل» is for.
        cell: ({ row }) => (
          <FindingDetail
            detail={row.original.detail}
            locale={locale}
            tail={false}
            className="text-sm"
          />
        ),
      },
      {
        id: 'records',
        accessorFn: (finding) =>
          finding.subjects
            .map((subject) => `${subject.label} ${subject.secondary ?? ''}`)
            .join(' '),
        header: en ? 'Records' : 'السجلات',
        enableSorting: false,
        meta: {
          label: en ? 'Records' : 'السجلات',
          headerClassName: 'w-px',
        },
        cell: ({ row }) =>
          row.original.subjects.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            /*
              Names only, on one line. The reference number, the parcel and the
              second record's own numbers are all on the detail view — a queue
              row that carries every identifier a record has is four lines tall
              and still not enough to act on.
            */
            <span
              className="block max-w-[16rem] truncate"
              title={row.original.subjects
                .map((subject) =>
                  subject.secondary ? `${subject.label} — ${subject.secondary}` : subject.label,
                )
                .join(' • ')}
            >
              {row.original.subjects.map((subject, index) => (
                <span key={`${subject.kind}-${subject.id}`}>
                  {index > 0 ? <span className="text-muted-foreground"> • </span> : null}
                  <Link
                    href={subjectHref(subject, base)}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{subject.label}</bdi>
                  </Link>
                </span>
              ))}
            </span>
          ),
      },
      {
        id: 'officers',
        accessorFn: (finding) => finding.officers.map((officer) => officer.name).join('، '),
        header: en ? 'Filed by' : 'سجَّلها',
        enableSorting: false,
        meta: { label: en ? 'Filed by' : 'سجَّلها', headerClassName: 'w-px' },
        cell: ({ getValue }) => {
          const names = (getValue() as string) || '—';
          // Capped: a finding about two officers' filings carries both names,
          // and a shrink-to-fit column would hand the pair a third of the row.
          return (
            <span className="block max-w-[12rem] truncate text-muted-foreground" title={names}>
              {names}
            </span>
          );
        },
      },
      {
        id: 'at',
        accessorFn: (finding) => finding.at ?? '',
        header: en ? 'Last change' : 'آخر تغيير',
        meta: { label: en ? 'Last change' : 'آخر تغيير', headerClassName: 'w-px' },
        cell: ({ row }) =>
          row.original.at ? (
            <span className="text-muted-foreground">{formatRelative(row.original.at, locale)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: en ? 'Action' : 'الإجراء',
        enableSorting: false,
        enableHiding: false,
        meta: {
          mobile: 'actions',
          align: 'end',
          label: en ? 'Action' : 'الإجراء',
          // Shrink-to-fit: with the controls on one nowrap line, `w-px` makes
          // the column ask for exactly their width and leaves the rest of the
          // table to the values.
          headerClassName: 'w-px',
        },
        cell: ({ row }) => (
          <FindingActions
            finding={row.original}
            base={base}
            locale={locale}
            compact
            busy={busy === keyOf(row.original)}
            onDetails={() => setView({ mode: 'details', key: keyOf(row.original) })}
            onResolve={() => setResolving(row.original)}
            onReopen={() => reopen(row.original)}
            onCompare={() => setView({ mode: 'compare', key: keyOf(row.original) })}
            // End-aligned in the table, where the column sits against that
            // edge; left alone in the phone card, where the row is full width.
            className="sm:justify-end"
          />
        ),
      },
    ],
    /*
      `reopen` is left out on purpose — it is rebuilt every render and listing
      it would make this memo do nothing. What it closes over is listed instead:
      the tenant and the token it writes with, and `busy`, which is the only
      part of a row's controls that changes while the screen is open.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, busy, en, locale, quality, tenant, token],
  );

  const filterBar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-pressed={kind === ''}
        onClick={() => setKind('')}
        className={cn(
          'min-h-9 rounded-md border px-3 text-sm transition-colors',
          kind === '' ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
        )}
      >
        {en ? 'All' : 'الكل'}
        <span className="ms-1.5 tabular-nums text-muted-foreground">{all.length}</span>
      </button>
      {kinds.map(([key, value]) => (
        <button
          key={key}
          type="button"
          aria-pressed={kind === key}
          onClick={() => setKind(key as QualityFindingKind)}
          className={cn(
            'min-h-9 rounded-md border px-3 text-sm transition-colors',
            kind === key
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'hover:bg-accent',
          )}
        >
          {quality.findingKind[key as QualityFindingKind] ?? key}
          <span className="ms-1.5 tabular-nums text-muted-foreground">{value?.open ?? 0}</span>
        </button>
      ))}
      <Button
        variant={includeDismissed ? 'default' : 'ghost'}
        size="sm"
        className="ms-auto h-9 gap-1.5"
        aria-pressed={includeDismissed}
        onClick={() => setIncludeDismissed((current) => !current)}
      >
        <ShieldQuestion className="size-3.5" aria-hidden />
        {en ? 'Show resolved' : 'إظهار المحلولة'}
      </Button>
    </div>
  );

  /**
   * One dialog for all three views.
   *
   * Built once and rendered by whichever view is on screen: the queue, the
   * detail view and the comparison all carry a «تم الحل» control, and a copy of
   * this per view is three places for the wording — and the sentence about what
   * «تم الحل» actually stores — to drift apart.
   */
  const resolveDialog = (
    <ResolveDialog
      finding={resolving}
      title={resolving ? (quality.findingKind[resolving.kind] ?? resolving.kind) : ''}
      locale={locale}
      open={resolving !== null}
      onOpenChange={(open) => {
        if (!open) setResolving(null);
      }}
      onConfirm={async (reason) => {
        const finding = resolving;
        if (!finding) return;
        await run(
          keyOf(finding),
          () =>
            dismissFinding(tenant, token!, {
              kind: finding.kind,
              subjectKey: finding.subjectKey,
              reason,
            }),
          en ? 'Marked resolved' : 'عُلِّمت «تم الحل»',
          true,
        );
        // Closing a finding from inside its own detail or comparison view
        // leaves nothing behind to look at.
        if (view.mode !== 'list' && view.key === keyOf(finding) && !includeDismissed) {
          setView({ mode: 'list' });
        }
      }}
    />
  );

  /*
    A sub-view whose finding is gone.

    Reachable the ordinary way: a reviewer opens a comparison, corrects the name
    that made the two records look alike, and the finding stops existing on the
    next read — which is the system working. Saying so beats an empty grid.
  */
  if (view.mode !== 'list' && !selected && !query.loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border bg-card p-6 text-center">
          <CircleCheck className="mx-auto size-8 text-success" aria-hidden />
          <p className="mt-3 text-sm font-medium">
            {en ? 'This finding is no longer in the queue.' : 'لم تعد هذه الملاحظة في القائمة.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {en
              ? 'Either the record was corrected, or somebody marked it resolved.'
              : 'إمّا أن السجل صُحِّح، وإمّا أن أحدهم علَّمها «تم الحل».'}
          </p>
          <Button className="mt-4" onClick={() => setView({ mode: 'list' })}>
            {en ? 'Back to quality findings' : 'رجوع إلى ملاحظات الجودة'}
          </Button>
        </div>
      </div>
    );
  }

  if (view.mode === 'compare' && selected) {
    return (
      <>
        <FindingCompare
          finding={selected}
          tenant={tenant}
          base={base}
          locale={locale}
          token={token}
          canEdit={CITIZEN_EDIT_ROLES.includes(role ?? '')}
          onBack={() => setView({ mode: 'list' })}
          onChanged={() => query.refetch()}
        />
        {resolveDialog}
      </>
    );
  }

  if (view.mode === 'details' && selected) {
    return (
      <>
        <FindingDetails
          finding={selected}
          related={related}
          locale={locale}
          base={base}
          busyKey={busy}
          onBack={() => setView({ mode: 'list' })}
          onOpen={(finding) => setView({ mode: 'details', key: keyOf(finding) })}
          onResolve={(finding) => setResolving(finding)}
          onReopen={reopen}
          onCompare={(finding) => setView({ mode: 'compare', key: keyOf(finding) })}
        />
        {resolveDialog}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={items}
        labels={tableLabels(locale)}
        getRowId={(finding) => keyOf(finding)}
        columnStorageKey="quality-findings"
        /*
          The default is four columns: what was found, on which record, who
          filed it, and what to do about it.

          «السجلات» and «آخر تغيير» start off. Both are on the detail view in
          full — the records with their reference and parcel numbers, the
          timestamp both as «قبل ٨ أيام» and to the minute — and a queue is read
          to decide *which* finding to open, not to answer it. Hidden is not
          gone: they are one click away in the columns menu, that choice is
          remembered per browser, and a hidden column is still searched, because
          the table filters on every column's value rather than on the ones
          currently drawn.
        */
        initialHiddenColumns={['records', 'at']}
        filterBar={filterBar}
        activeFiltersCount={(kind ? 1 : 0) + (includeDismissed ? 1 : 0)}
        onClearFilters={() => {
          setKind('');
          setIncludeDismissed(false);
        }}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        emptyIcon={<CircleCheck className="size-8 text-success" aria-hidden />}
      />
      {resolveDialog}
    </div>
  );
}
