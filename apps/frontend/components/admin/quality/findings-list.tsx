'use client';

import { useMemo, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { qualityLabels } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, settleAllUnitStatuses } from '@/lib/api-client';
import { useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import {
  dismissFinding,
  getFindings,
  restoreFinding,
  type QualityFinding,
} from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { readView } from '@/lib/read-view';
import { CITIZEN_RECORD_EDIT_ROLES, hasRole } from '@/lib/staff-roles';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { DataTable } from '@/components/ui/data-table';
import { useToast } from '@/components/ui/toast';
import { ResolveDialog } from './resolve-dialog';
import { FindingCompare } from './finding-compare';
import { FindingDetails } from './finding-details';
import { FINDING_KEY, FINDINGS_URL, keyOf, type View } from './findings/finding-address';
import { FindingFilters } from './findings/finding-filters';
import { FindingGone } from './findings/finding-gone';
import { useFindingTableLabels } from './findings/table-labels';
import { UnitStatusReview } from './findings/unit-status-review';
import { useFindingColumns } from './findings/use-finding-columns';

export { FINDINGS_URL } from './findings/finding-address';

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
 * findings, and the way back from a comparison has to land exactly where the
 * way in left. The filters, the page and the open detail view are in the query
 * string and the search in tab storage (`useTabSearch`), so a reload keeps that
 * position too; the comparison is not, because it writes (see `FINDING`).
 *
 * ## What is stored, and what is not
 *
 * Nothing on this screen is a record of a finding: findings are recomputed from
 * the register on every read, so one that gets fixed disappears by itself. The
 * only thing written is «تم الحل» and the reason somebody gave for it — and the
 * dialog that writes it says so, because a reviewer who presses it on a record
 * they mean to fix later has silenced a reminder rather than fixed anything.
 */

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
  const t = useTranslations('qualityFindings');
  const tableLabels = useFindingTableLabels();
  // Memoised because the column definitions below hang off it: `qualityLabels`
  // returns a fresh object per call, which would rebuild every column on every
  // keystroke in the table's own search box.
  const quality = useMemo(() => qualityLabels(locale), [locale]);
  const toast = useToast();

  const [queue, setQueue] = useUrlState(FINDINGS_URL);
  const { kind, dismissed: includeDismissed } = queue;
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });
  const [search, setSearch] = useTabSearch(tenant, 'quality-findings');
  /** The writes on the wire, by finding (`keyOf`), and `settle-all`: their controls are held. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // SUBMIT-04: `busy` is React state, set asynchronously, so a double-click can pass
  // its stale read. The ref is checked and set first, and released when the write settles.
  // By finding, so a write on one never swallows a write on another.
  const inFlight = useRef(new Set<string>());
  const hold = (key: string) => {
    inFlight.current.add(key);
    setBusy(new Set(inFlight.current));
  };
  const release = (key: string) => {
    inFlight.current.delete(key);
    setBusy(new Set(inFlight.current));
  };
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<QualityFinding | null>(null);
  /**
   * A view the address must not hold: the comparison, or a detail view whose
   * key `FINDING` refuses. Wins over `?finding=` while set.
   */
  const [transient, setTransient] = useState<View>({ mode: 'list' });

  const view: View =
    transient.mode !== 'list'
      ? transient
      : queue.finding
        ? { mode: 'details', key: queue.finding }
        : { mode: 'list' };

  const setView = (next: View) => {
    const addressable = next.mode !== 'list' && FINDING_KEY.test(next.key);
    setTransient(next.mode === 'details' && addressable ? { mode: 'list' } : next);
    setQueue({ finding: addressable ? next.key : '' });
  };

  const query = useStaffQuery({
    queryKey: ['quality-findings', tenant, includeDismissed],
    queryFn: (tok, signal) => getFindings(tenant, tok, { includeDismissed }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadFailed'),
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

  /* What a write here changes: every page of findings, and what «حسب الموظف» counts. */
  const reread = (): Promise<unknown> => {
    void queryClient.invalidateQueries({ queryKey: ['quality-officers', tenant] });
    return queryClient.invalidateQueries({ queryKey: ['quality-findings', tenant] });
  };

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
    if (!token || inFlight.current.has(key)) return;
    hold(key);
    try {
      await work();
    } catch (caught) {
      release(key);
      logApiError(caught);
      if (!quiet) {
        toast.error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
      }
      throw caught;
    }
    toast.success(done);
    // Not awaited: the dialog that asked closes now, and the finding's controls stay held until the list is read.
    void reread().finally(() => release(key));
  };

  const reopen = (finding: QualityFinding) =>
    void run(
      keyOf(finding),
      () =>
        restoreFinding(tenant, token!, { kind: finding.kind, subjectKey: finding.subjectKey }),
      t('reopened'),
    ).catch(() => undefined);

  const columns = useFindingColumns({ tenant, token, base, locale, quality, busy, setView, setResolving, reopen });

  // Each filter returns to page one in the same write. The table used to do
  // that by itself whenever its rows changed; with the page in the URL it does
  // not, so a reload of `?page=3` survives the rows arriving.
  const filterBar = (
    <FindingFilters
      quality={quality}
      total={all.length}
      kinds={kinds}
      kind={kind}
      includeDismissed={includeDismissed}
      setQueue={setQueue}
    />
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
          t('markedResolved'),
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

  const read = readView(query.data, query.error);
  /** A re-read that failed: what is on screen stays, with this above it (STA-1). */
  const refreshAlert =
    read.state === 'ready' && read.refreshFailed ? (
      <RefreshFailedAlert message={read.refreshFailed} onRetry={query.refetch} />
    ) : null;

  /*
    A sub-view whose finding is gone.

    Reachable the ordinary way: a reviewer opens a comparison, corrects the name
    that made the two records look alike, and the finding stops existing on the
    next read — which is the system working. Saying so beats an empty grid.

    Only once the findings are in: a reload on `?finding=` renders before the
    session token arrives, when nothing is loading and nothing is loaded yet.
  */
  if (view.mode !== 'list' && !selected && query.data && !query.loading) {
    return <FindingGone onBack={() => setView({ mode: 'list' })} />;
  }

  if (view.mode === 'compare' && selected) {
    return (
      <>
        {refreshAlert}
        <FindingCompare
          finding={selected}
          tenant={tenant}
          base={base}
          locale={locale}
          token={token}
          canEdit={hasRole(CITIZEN_RECORD_EDIT_ROLES, role)}
          canMerge={role === 'SUPER_ADMIN'}
          onBack={() => setView({ mode: 'list' })}
          onChanged={() => {
            // A corrected file is «عُدِّل بعد الاعتماد» in the review queue too.
            void queryClient.invalidateQueries({ queryKey: ['quality-reviews', tenant] });
            void reread();
          }}
        />
        {resolveDialog}
      </>
    );
  }

  if (view.mode === 'details' && selected) {
    return (
      <>
        {refreshAlert}
        <FindingDetails
          finding={selected}
          related={related}
          locale={locale}
          base={base}
          busy={busy}
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

  const settleAll = async () => {
    if (!token || inFlight.current.has('settle-all')) return;
    hold('settle-all');
    try {
      const res = await settleAllUnitStatuses(tenant, token);
      toast.success(
        t('unitReview.done', {
          checked: res.unitsChecked,
          changed: res.statusesChanged,
          opened: res.casesOpened,
          closed: res.casesResolved,
          pending: res.stillUnderReview,
        }),
      );
      // Statuses were corrected and review cases opened or closed across the register.
      void queryClient.invalidateQueries({ queryKey: ['buildings', tenant] });
      void queryClient.invalidateQueries({ queryKey: ['cases', tenant] });
      await reread();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : t('unitReview.failed'));
    } finally {
      release('settle-all');
    }
  };

  return (
    <div className="space-y-4">
      {refreshAlert}
      {role === 'SUPER_ADMIN' ? (
        <UnitStatusReview
          running={busy.has('settle-all')}
          ready={Boolean(token)}
          onRun={() => void settleAll()}
        />
      ) : null}
      <DataTable
        columns={columns}
        data={items}
        labels={tableLabels}
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
        onClearFilters={() => setQueue({ kind: '', dismissed: false }, { clear: ['page'] })}
        searchValue={search}
        onSearchChange={setSearch}
        pagination={pagination}
        onPaginationChange={setPagination}
        loading={query.loading}
        error={read.state === 'failed' ? read.error : null}
        onRetry={query.refetch}
        emptyIcon={<CircleCheck className="size-8 text-success" aria-hidden />}
      />
      {resolveDialog}
    </div>
  );
}
