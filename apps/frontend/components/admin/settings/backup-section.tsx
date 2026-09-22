'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  DatabaseBackup,
  FileArchive,
  HardDrive,
  History,
  XCircle,
  Loader2,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import {
  getAllPayments,
  getAuditLog,
  getFeeNotices,
  getMunicipalitySettings,
  getStaff,
  getZones,
  listCitizens,
  logApiError,
  exportSnapshot,
  restoreSnapshot,
  ApiRequestError,
  updateMunicipalitySettings,
} from '@/lib/api-client';
import type { RestoreReport } from '@/lib/api-client';
import { useSettingsSlice } from '@/lib/settings-store';
import type { SettingsCopy } from '@/lib/settings-i18n';
import {
  countCsvRows,
  createZip,
  downloadBlob,
  readZip,
  toCsv,
  type ZipEntry,
} from '@/lib/zip';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { CellTag } from '@/components/ui/cell-tag';
import { Button } from '@/components/ui/button';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  AlignedFieldGrid,
  ScrollableTable,
  SettingsCard,
  SettingsField,
  StatusTile,
} from './settings-ui';
import { cn } from '@/lib/utils';

/** The largest page each list endpoint will serve in one call. */
const EXPORT_LIMIT = 1000;

type Frequency = 'off' | 'daily' | 'weekly' | 'monthly';

interface ScheduleSettings {
  frequency: Frequency;
  /** `HH:mm`, local to whoever set it. */
  timeOfDay: string;
  /** 0 = Sunday, matching `Date.getDay()`. */
  dayOfWeek: string;
  dayOfMonth: string;
  keepCopies: string;
}

interface HistoryEntry {
  at: string;
  action: 'backup' | 'restore';
  scope: string;
  bytes: number;
  ok: boolean;
}

const DEFAULT_SCHEDULE: ScheduleSettings = {
  frequency: 'off',
  timeOfDay: '02:00',
  dayOfWeek: '1',
  dayOfMonth: '1',
  keepCopies: '7',
};

/** What reading a dropped archive told us about it. */
interface ArchiveInspection {
  ok: boolean;
  /** Why it is unusable, when it is. */
  reason: 'empty' | null;
  tables: Array<{ name: string; rows: number }>;
  manifest: { tenant?: string; createdAt?: string; failedTables?: string[] } | null;
}

const EMPTY_HISTORY: { entries: HistoryEntry[] } = { entries: [] };

/** Every table the browser can reach, and how to turn each into rows. */
const TABLES = [
  {
    key: 'citizens',
    load: async (tenant: string, token: string) =>
      (await listCitizens(tenant, token, { limit: EXPORT_LIMIT })).items,
  },
  {
    key: 'staff',
    load: async (tenant: string, token: string) => (await getStaff(tenant, token)).items,
  },
  {
    key: 'fees',
    load: async (tenant: string, token: string) => (await getFeeNotices(tenant, token)).items,
  },
  {
    key: 'payments',
    load: async (tenant: string, token: string) =>
      (await getAllPayments(tenant, token, { limit: EXPORT_LIMIT })).items,
  },
  {
    key: 'zones',
    // `/zones` answers with `zones`, not `items` — the one endpoint here that
    // does not follow the list convention.
    load: async (tenant: string, token: string) => (await getZones(tenant, token)).zones,
  },
  {
    key: 'audit',
    load: async (tenant: string, token: string) =>
      (await getAuditLog(tenant, token, { limit: EXPORT_LIMIT })).items,
  },
  {
    key: 'settings',
    load: async (tenant: string, token: string) => [await getMunicipalitySettings(tenant, token)],
  },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * When the schedule would next fire, computed the way a cron would read it.
 *
 * Shown because a frequency and a time do not by themselves tell an
 * administrator what they just configured — "weekly, Monday, 02:00" set on a
 * Monday afternoon means *next* Monday, which is a week later than most people
 * assume when they save it.
 */
function nextRunAt(schedule: ScheduleSettings, from: Date): Date | null {
  if (schedule.frequency === 'off') return null;
  const [hours, minutes] = schedule.timeOfDay.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes);

  if (schedule.frequency === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.frequency === 'weekly') {
    const target = Number(schedule.dayOfWeek);
    let delta = (target - next.getDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7;
    next.setDate(next.getDate() + delta);
    return next;
  }

  const target = Math.min(Math.max(Number(schedule.dayOfMonth) || 1, 1), 28);
  next.setDate(target);
  if (next <= from) next.setMonth(next.getMonth() + 1);
  return next;
}

/**
 * النسخ الاحتياطي والاستعادة.
 *
 * The backup half genuinely works: it reads every list endpoint the signed-in
 * administrator can reach, turns each into a CSV, and bundles them into a real
 * ZIP written in the browser (see `lib/zip`). No new backend and no dependency
 * — which also fixes the ceiling, and honestly: this is a *tenant data export*
 * of what the API exposes, not a `pg_dump`. It cannot capture what the API does
 * not serve, and each table is capped at the endpoint's page size. A disaster
 * recovery plan needs the database's own backups; this is the copy a
 * municipality can hold, read in Excel, and hand to an auditor.
 *
 * Restore is real, and lives in its own card on the restorable snapshot — not
 * on the CSV archive, which is a report: it exports what the API returns (a
 * joined `fullName`, computed totals) and cannot be written back into tables
 * that want `firstName`/`middleName`/`lastName`, `gender` and
 * `totalRegisteredMembers`/`actualHouseholdMembers`.
 * The CSV panel says so where the file is dropped.
 *
 * The snapshot flow rehearses before it writes. The rehearsal is a real request
 * that parses the file, checks the tenant and the migration set and reports how
 * many rows would go and how many would arrive — all server-side, all without
 * writing. Only then does the destructive button appear, behind the tenant slug
 * typed out.
 */
export function BackupSection({
  tenant,
  token,
  locale,
  copy,
}: {
  tenant: string;
  token: string;
  locale: string;
  copy: SettingsCopy;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [archive, setArchive] = useState<File | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<ArchiveInspection | null>(null);

  /*
   * The restorable snapshot, kept entirely separate from the CSV archive above.
   * Sharing one piece of state between the two is how a screen ends up letting
   * someone press "restore" on a report.
   */
  const snapshotInput = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<File | null>(null);
  const [snapshotDragging, setSnapshotDragging] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  /** Which of the two restore buttons is spinning. */
  const [dryRunPending, setDryRunPending] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [confirmSlug, setConfirmSlug] = useState('');

  const [schedule, setSchedule] = useState<ScheduleSettings>(DEFAULT_SCHEDULE);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getMunicipalitySettings(tenant, token);
        if (cancelled || !result.backupSchedule) return;
        const stored = result.backupSchedule;
        setSchedule({
          frequency: stored.frequency,
          timeOfDay: stored.timeOfDay,
          dayOfWeek: String(stored.dayOfWeek),
          dayOfMonth: String(stored.dayOfMonth),
          keepCopies: String(stored.keepCopies),
        });
      } catch (caught) {
        logApiError(caught);
        /* the defaults stand; the section's other half still works */
      } finally {
        if (!cancelled) setScheduleLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant, token]);

  /**
   * Saves on change rather than behind a button.
   *
   * The schedule is five controls with no interdependent state to review before
   * committing — unlike the finance section, where a rate and a currency have
   * to agree. A save button here would be one more thing to forget, and the
   * failure mode of forgetting it is a backup that never runs.
   */
  const persistSchedule = useCallback(
    (next: ScheduleSettings) => {
      setSchedule(next);
      void (async () => {
        try {
          await updateMunicipalitySettings(tenant, token, {
            backupSchedule: {
              frequency: next.frequency,
              timeOfDay: next.timeOfDay,
              dayOfWeek: Number(next.dayOfWeek) || 0,
              // Clamped, not merely capped by the input: an empty box parses to
              // NaN and the schema rejects the whole save, silently losing the
              // other four fields with it.
              dayOfMonth: Math.min(Math.max(Number(next.dayOfMonth) || 1, 1), 28),
              keepCopies: Math.min(Math.max(Number(next.keepCopies) || 1, 1), 365),
            },
          });
        } catch (caught) {
          logApiError(caught);
          toast.error(copy.common.saveError);
        }
      })();
    },
    [tenant, token, toast, copy.common.saveError],
  );

  /*
   * History stays in the browser, deliberately.
   *
   * It records what *this* machine downloaded — the archive is on this disk and
   * nowhere else, so a shared server-side log would list files a given
   * administrator has no way to open. When a server-run backup exists, its runs
   * belong in a table; these do not.
   */
  const { value: history, persist: persistHistory } = useSettingsSlice<{
    entries: HistoryEntry[];
  }>(tenant, 'backup-history', EMPTY_HISTORY);

  // Recomputed on a timer rather than once: "next run" drifts into the past the
  // moment it passes, and a stale value is how a reader concludes the schedule
  // is broken.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ar-LB-u-nu-latn', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const nextRun = scheduleLoaded ? nextRunAt(schedule, now) : null;

  /** The most recent successful-or-not backup this browser recorded. */
  const lastBackup = history.entries.find((entry) => entry.action === 'backup') ?? null;

  const record = useCallback(
    (entry: HistoryEntry) => {
      // Newest first, capped: this is a convenience log in localStorage, and an
      // unbounded one eventually costs more than the quota it lives in.
      persistHistory({ entries: [entry, ...history.entries].slice(0, 50) });
    },
    [history.entries, persistHistory],
  );

  const runBackup = useCallback(async () => {
    setBusy(true);
    const stamp = new Date();
    const failures: string[] = [];
    const entries: ZipEntry[] = [];

    for (const table of TABLES) {
      try {
        // Through `unknown`: each endpoint returns its own interface, and an
        // interface without an index signature is not assignable to a record
        // even though every one of them is one at runtime. `toCsv` reads keys
        // off whatever it is handed, so the shapes never need to agree.
        const rows = (await table.load(tenant, token)) as unknown as Array<
          Record<string, unknown>
        >;
        entries.push({ name: `${table.key}.csv`, content: toCsv(rows) });
      } catch (caught) {
        logApiError(caught);
        failures.push(table.key);
      }
    }

    if (entries.length === 0) {
      setBusy(false);
      record({ at: stamp.toISOString(), action: 'backup', scope: '—', bytes: 0, ok: false });
      toast.error(copy.backup.backupFailed);
      return;
    }

    /*
     * A manifest beside the data. Six months from now the question asked of an
     * archive is "what is this and when is it from", and a folder of bare CSVs
     * answers neither — least of all which tables failed to export.
     */
    entries.push({
      name: 'manifest.json',
      content: JSON.stringify(
        {
          tenant,
          createdAt: stamp.toISOString(),
          source: 'municipality-portal/settings/backup',
          note: 'Tenant data export of API-exposed tables. Not a database dump.',
          rowLimitPerTable: EXPORT_LIMIT,
          tables: entries.map((entry) => entry.name),
          failedTables: failures,
        },
        null,
        2,
      ),
    });

    const blob = createZip(entries, stamp);
    const iso = stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(blob, `${tenant}-backup-${iso}.zip`);

    record({
      at: stamp.toISOString(),
      action: 'backup',
      // `entries.length - 1` excludes the manifest, which is not a table.
      scope: `${entries.length - 1}/${TABLES.length}`,
      bytes: blob.size,
      ok: failures.length === 0,
    });

    setBusy(false);
    if (failures.length > 0) {
      toast.warning(copy.backup.partial, { description: failures.join(', ') });
    } else {
      toast.success(copy.backup.backupDone);
    }
  }, [tenant, token, record, toast, copy.backup]);

  /**
   * Opens the dropped archive and says what is in it.
   *
   * The file extension is not the check. A `.zip` that turns out to be a
   * half-finished download, an archive of holiday photographs, or last year's
   * export from a different municipality all pass a name test, and the moment
   * an administrator most needs to know otherwise is *before* they act on it —
   * not after a restore they cannot undo. So the archive is actually read: its
   * manifest, its tables, its row counts.
   */

  /** Downloads the restorable snapshot — real table rows, built server-side. */
  const downloadSnapshot = useCallback(async () => {
    setSnapshotBusy(true);
    const stamp = new Date();
    try {
      const blob = await exportSnapshot(tenant, token);
      const iso = stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(blob, `${tenant}-snapshot-${iso}.json.gz`);
      record({
        at: stamp.toISOString(),
        action: 'backup',
        scope: 'snapshot',
        bytes: blob.size,
        ok: true,
      });
      toast.success(copy.backup.backupDone);
    } catch (caught) {
      logApiError(caught);
      record({
        at: stamp.toISOString(),
        action: 'backup',
        scope: 'snapshot',
        bytes: 0,
        ok: false,
      });
      toast.error(
        caught instanceof ApiRequestError ? caught.message : copy.backup.backupFailed,
      );
    } finally {
      setSnapshotBusy(false);
    }
  }, [tenant, token, record, toast, copy.backup]);

  /**
   * Takes the chosen snapshot file.
   *
   * Only the name is checked here. Everything that matters about the file —
   * whether it unzips, which municipality it belongs to, which migrations it
   * was taken at — is checked by the server on the rehearsal, where the answer
   * is authoritative rather than a guess made from eight bytes of header.
   */
  const acceptSnapshot = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith('.gz')) {
        toast.error(copy.backup.notASnapshot);
        return;
      }
      setSnapshot(file);
      // A new file invalidates the rehearsal: leaving the old report on screen
      // would let someone approve a restore against counts from another file.
      setReport(null);
      setConfirmSlug('');
    },
    [toast, copy.backup.notASnapshot],
  );

  const runRestore = useCallback(
    async (dryRun: boolean) => {
      if (!snapshot) return;
      setRestoreBusy(true);
      setDryRunPending(dryRun);
      const stamp = new Date();
      try {
        const result = await restoreSnapshot(tenant, token, snapshot, {
          confirmTenantSlug: dryRun ? tenant : confirmSlug.trim(),
          dryRun,
        });
        setReport(result);

        if (dryRun) {
          toast.info(copy.backup.dryRunDone);
        } else {
          const rows = Object.values(result.written).reduce((a, b) => a + b, 0);
          record({
            at: stamp.toISOString(),
            action: 'restore',
            scope: `${rows}`,
            bytes: snapshot.size,
            ok: true,
          });
          toast.success(copy.backup.restoreDone);
          // Everything on screen elsewhere in the portal now describes rows
          // that no longer exist. A reload is blunt and correct.
          setTimeout(() => window.location.reload(), 1500);
        }
      } catch (caught) {
        logApiError(caught);
        if (!dryRun) {
          record({
            at: stamp.toISOString(),
            action: 'restore',
            scope: '—',
            bytes: snapshot.size,
            ok: false,
          });
        }
        toast.error(
          caught instanceof ApiRequestError ? caught.message : copy.backup.restoreFailed,
        );
      } finally {
        setRestoreBusy(false);
      }
    },
    [tenant, token, snapshot, confirmSlug, record, toast, copy.backup],
  );
  const acceptArchive = useCallback(
    async (file: File) => {
      setArchive(file);
      setInspection(null);
      setInspecting(true);
      try {
        const entries = await readZip(file);

        const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
        let manifest: { tenant?: string; createdAt?: string; failedTables?: string[] } | null =
          null;
        if (manifestEntry) {
          try {
            manifest = JSON.parse(manifestEntry.text) as typeof manifest;
          } catch {
            /* an unreadable manifest is reported below as a missing one */
          }
        }

        const tables = entries
          .filter((entry) => entry.name.toLowerCase().endsWith('.csv'))
          .map((entry) => ({
            name: entry.name.replace(/\.csv$/i, ''),
            rows: countCsvRows(entry.text),
          }));

        if (tables.length === 0) {
          setInspection({ ok: false, reason: 'empty', tables: [], manifest: null });
          toast.error(copy.backup.archiveEmpty);
          return;
        }

        setInspection({ ok: true, reason: null, tables, manifest });
      } catch (caught) {
        // Not `logApiError` — nothing here went near the network.
        console.error(caught);
        setArchive(null);
        setInspection(null);
        toast.error(copy.backup.wrongFormat, { description: copy.backup.unreadableArchive });
      } finally {
        setInspecting(false);
      }
    },
    [toast, copy.backup],
  );

  return (
    <div className="space-y-6">
      <SettingsCard
        icon={DatabaseBackup}
        title={copy.backup.manualHeading}
        hint={copy.backup.manualHint}
      >
        <div className="space-y-5">
          {/*
            Solar's status tiles: the two facts an administrator opens this card
            to check, before the button that would change them.
          */}
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusTile
              label={copy.backup.lastBackup}
              icon={
                lastBackup?.ok ? (
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                ) : lastBackup ? (
                  <XCircle className="size-3.5 text-destructive" aria-hidden />
                ) : (
                  <History className="size-3.5" aria-hidden />
                )
              }
            >
              {lastBackup ? (
                <>
                  <p className="font-medium">{dateFormat.format(new Date(lastBackup.at))}</p>
                  <p className="text-xs text-muted-foreground">
                    {lastBackup.scope} · {formatBytes(lastBackup.bytes)}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">{copy.backup.neverBackedUp}</p>
              )}
            </StatusTile>

            <StatusTile label={copy.backup.includes}>
              <ul className="mt-0.5 flex flex-wrap gap-1.5">
                {TABLES.map((table) => (
                  <li key={table.key}>
                    <Badge variant="soft-muted">
                      {copy.backup.tables[table.key] ?? table.key}
                    </Badge>
                  </li>
                ))}
              </ul>
            </StatusTile>
          </div>

          <Button onClick={() => void runBackup()} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {copy.backup.backingUp}
              </>
            ) : (
              <>
                <FileArchive className="size-4" aria-hidden />
                {copy.backup.backupNow}
              </>
            )}
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={CalendarClock}
        title={copy.backup.scheduleHeading}
        hint={copy.backup.scheduleHint}
      >
        <AlignedFieldGrid>
          <SettingsField label={copy.backup.frequency} htmlFor="backup-frequency">
            <Select
              value={schedule.frequency}
              onValueChange={(next) =>
                persistSchedule({ ...schedule, frequency: next as Frequency })
              }
            >
              <SelectTrigger id="backup-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{copy.backup.frequencyOff}</SelectItem>
                <SelectItem value="daily">{copy.backup.frequencyDaily}</SelectItem>
                <SelectItem value="weekly">{copy.backup.frequencyWeekly}</SelectItem>
                <SelectItem value="monthly">{copy.backup.frequencyMonthly}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsField>

          {schedule.frequency !== 'off' ? (
            <SettingsField label={copy.backup.timeOfDay} htmlFor="backup-time">
              <Input
                id="backup-time"
                type="time"
                dir="ltr"
                className="text-start"
                value={schedule.timeOfDay}
                onChange={(e) => persistSchedule({ ...schedule, timeOfDay: e.target.value })}
              />
            </SettingsField>
          ) : null}

          {schedule.frequency === 'weekly' ? (
            <SettingsField label={copy.backup.dayOfWeek} htmlFor="backup-dow">
              <Select
                value={schedule.dayOfWeek}
                onValueChange={(next) => persistSchedule({ ...schedule, dayOfWeek: next })}
              >
                <SelectTrigger id="backup-dow">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ar-LB', {
                        weekday: 'long',
                        // 2024-01-07 was a Sunday, so +day lands on each weekday.
                      }).format(new Date(Date.UTC(2024, 0, 7 + day)))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
          ) : null}

          {schedule.frequency === 'monthly' ? (
            <SettingsField label={copy.backup.dayOfMonth} htmlFor="backup-dom">
              <Input
                id="backup-dom"
                inputMode="numeric"
                dir="ltr"
                className="text-start"
                value={schedule.dayOfMonth}
                onChange={(e) =>
                  persistSchedule({
                    ...schedule,
                    // Capped at 28 so the schedule fires in February too — a
                    // "31st" rule silently skips five months of the year.
                    dayOfMonth: e.target.value.replace(/\D/g, '').slice(0, 2),
                  })
                }
              />
            </SettingsField>
          ) : null}

          {schedule.frequency !== 'off' ? (
            <SettingsField
              label={copy.backup.keepCopies}
              htmlFor="backup-keep"
            >
              <Input
                id="backup-keep"
                inputMode="numeric"
                dir="ltr"
                className="text-start"
                value={schedule.keepCopies}
                onChange={(e) =>
                  persistSchedule({
                    ...schedule,
                    keepCopies: e.target.value.replace(/\D/g, '').slice(0, 3),
                  })
                }
              />
            </SettingsField>
          ) : null}
        </AlignedFieldGrid>

        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 pt-4 text-sm">
          <p className="text-muted-foreground">
            {copy.backup.nextRun}:{' '}
            <span className="font-medium text-foreground">
              {nextRun ? dateFormat.format(nextRun) : copy.backup.nextRunNever}
            </span>
          </p>
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {copy.backup.scheduleNotRun}
          </p>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={RotateCcw}
        title={copy.backup.restoreHeading}
        hint={copy.backup.restoreHint}
      >
        {/*
          A real drop target, even though the button beyond it is disabled. The
          flow being reviewable — does the file land, is a wrong type caught, is
          the chosen name shown back — is the point of building this now; the
          transaction that writes the rows is a server change.
        */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) acceptArchive(file);
          }}
          className={cn(
            'flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors',
            dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20',
          )}
        >
          {archive ? (
            <>
              {inspecting ? (
                <Loader2 className="size-7 animate-spin text-muted-foreground" aria-hidden />
              ) : inspection?.ok ? (
                <CheckCircle2 className="size-7 text-success" aria-hidden />
              ) : (
                <XCircle className="size-7 text-destructive" aria-hidden />
              )}
              <p className="mt-3 font-medium" dir="ltr">
                {archive.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(archive.size)}
                {inspecting ? ` · ${copy.backup.reading}` : null}
              </p>
              <Button
                variant="ghost"
                className="mt-3"
                onClick={() => {
                  setArchive(null);
                  setInspection(null);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
                {copy.backup.clearFile}
              </Button>
            </>
          ) : (
            <>
              <Upload className="size-7 text-muted-foreground" aria-hidden />
              <p className="mt-3 font-medium">{copy.backup.dropZone}</p>
              <p className="text-sm text-muted-foreground">{copy.backup.dropZoneHint}</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => fileInput.current?.click()}
              >
                {copy.backup.browse}
              </Button>
            </>
          )}

          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) acceptArchive(file);
              e.target.value = '';
            }}
          />
        </div>
        {/*
          A CSV archive is a report and cannot be restored from — it holds a
          joined name and computed totals where the tables want first/middle/
          last, gender and household size. Saying so here, next to the file that
          was just dropped, is the only place the distinction lands before
          someone relies on it.
        */}
        {inspection?.ok ? (
          <div className="mt-4 space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">{copy.backup.archiveContents}</p>
              {inspection.manifest?.createdAt ? (
                <p className="text-xs text-muted-foreground">
                  {dateFormat.format(new Date(inspection.manifest.createdAt))}
                </p>
              ) : null}
            </div>

            <ul className="flex flex-wrap gap-2">
              {inspection.tables.map((table) => (
                <li key={table.name}>
                  <Badge variant="soft-muted" className="gap-1.5">
                    {copy.backup.tables[table.name] ?? table.name}
                    <span className="tabular-nums opacity-70" dir="ltr">
                      {table.rows.toLocaleString('en-US')}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>

            {inspection.manifest?.tenant && inspection.manifest.tenant !== tenant ? (
              <p className="flex items-start gap-2 text-xs leading-relaxed text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {copy.backup.foreignArchive
                  .replace('{archive}', inspection.manifest.tenant)
                  .replace('{current}', tenant)}
              </p>
            ) : null}

            <p className="flex items-start gap-2 text-xs leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {copy.backup.csvNotRestorable}
            </p>
          </div>
        ) : null}
      </SettingsCard>

      {/*
        The restorable pair, kept in its own card and away from the CSV export
        above. They are different files for different purposes, and every
        confusion on this screen has come from their sharing a heading: one is
        the copy a municipality reads in Excel, the other is the one that can
        put the register back.
      */}
      <SettingsCard
        icon={DatabaseBackup}
        title={copy.backup.snapshotHeading}
        hint={copy.backup.snapshotHint}
      >
        <div className="space-y-5">
          <Button variant="outline" onClick={() => void downloadSnapshot()} disabled={snapshotBusy}>
            {snapshotBusy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {copy.backup.backingUp}
              </>
            ) : (
              <>
                <HardDrive className="size-4" aria-hidden />
                {copy.backup.downloadSnapshot}
              </>
            )}
          </Button>

          <div className="space-y-3 border-t pt-5">
            <p className="text-sm font-semibold">{copy.backup.restoreHeading}</p>

            <div
              role="button"
              tabIndex={0}
              onClick={() => snapshotInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  snapshotInput.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setSnapshotDragging(true);
              }}
              onDragLeave={() => setSnapshotDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setSnapshotDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) acceptSnapshot(file);
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all',
                snapshotDragging
                  ? 'border-primary/60 bg-muted/30'
                  : 'border-muted-foreground/25 bg-muted/10 hover:border-primary/60 hover:bg-muted/30',
              )}
            >
              {snapshot ? (
                <>
                  <CheckCircle2 className="size-6 text-success" aria-hidden />
                  <p className="font-medium" dir="ltr">
                    {snapshot.name}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatBytes(snapshot.size)}</p>
                </>
              ) : (
                <>
                  <Upload className="size-6 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-medium">{copy.backup.snapshotDropZone}</p>
                  <p className="text-xs text-muted-foreground">{copy.backup.snapshotDropHint}</p>
                </>
              )}
              <input
                ref={snapshotInput}
                type="file"
                accept=".gz,application/gzip"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) acceptSnapshot(file);
                  e.target.value = '';
                }}
              />
            </div>

            {snapshot ? (
              <>
                {/*
                  The rehearsal runs first and is not optional. It parses the
                  file, checks the tenant and the migration set, and reports how
                  many rows would go and how many would arrive — all without
                  writing. An operator who sees "would delete 4,812, write 12"
                  has caught the wrong file before it cost them the register.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void runRestore(true)}
                    disabled={restoreBusy}
                  >
                    {restoreBusy && dryRunPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )}
                    {copy.backup.dryRun}
                  </Button>
                  <p className="text-xs text-muted-foreground">{copy.backup.dryRunHint}</p>
                </div>

                {report ? (
                  <div
                    className={cn(
                      'space-y-3 rounded-lg border p-4',
                      report.dryRun
                        ? 'border-primary/25 bg-primary/5'
                        : 'border-success/30 bg-success/5',
                    )}
                  >
                    <p className="text-sm font-semibold">
                      {report.dryRun ? copy.backup.dryRunResult : copy.backup.restoreDone}
                    </p>
                    <ScrollableTable minWidth="24rem">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{copy.backup.colTable}</TableHead>
                            <TableHead>{copy.backup.colRemoved}</TableHead>
                            <TableHead>{copy.backup.colWritten}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {Object.keys(report.written).map((name) => (
                            <TableRow key={name}>
                              <TableCell className="font-medium">
                                {copy.backup.tables[name] ?? name}
                              </TableCell>
                              <TableCell className="tabular-nums text-destructive">
                                <bdi dir="ltr">
                                  {(report.deleted[name] ?? 0).toLocaleString('en-US')}
                                </bdi>
                              </TableCell>
                              <TableCell className="tabular-nums">
                                <bdi dir="ltr">{report.written[name].toLocaleString('en-US')}</bdi>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollableTable>
                  </div>
                ) : null}

                {/*
                  The destructive step, behind the tenant's own name typed out.
                  The same guard this codebase already puts on deleting one
                  citizen, for an action that deletes all of them — and the
                  server checks it again, so this is a speed bump rather than
                  the protection.
                */}
                {report?.dryRun ? (
                  <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                    <p className="flex items-start gap-2 text-sm leading-relaxed">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                      <span>
                        <span className="font-semibold text-destructive">
                          {copy.backup.restoreWarning}
                        </span>
                        <span className="mt-0.5 block text-muted-foreground">
                          {copy.backup.restoreWarningWhy.replace('{tenant}', tenant)}
                        </span>
                      </span>
                    </p>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-full max-w-[16rem]">
                        <SettingsField
                          label={copy.backup.typeTenant.replace('{tenant}', tenant)}
                          htmlFor="confirm-tenant"
                        >
                          <Input
                            id="confirm-tenant"
                            dir="ltr"
                            className="text-start font-mono"
                            value={confirmSlug}
                            onChange={(e) => setConfirmSlug(e.target.value)}
                          />
                        </SettingsField>
                      </div>
                      <Button
                        variant="destructive"
                        disabled={restoreBusy || confirmSlug.trim() !== tenant}
                        onClick={() => void runRestore(false)}
                      >
                        {restoreBusy && !dryRunPending ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <RotateCcw className="size-4" aria-hidden />
                        )}
                        {copy.backup.restoreSelected}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={History}
        title={copy.backup.historyHeading}
        hint={copy.backup.historyHint}
      >
        {history.entries.length === 0 ? (
          <EmptyState compact icon={History} title={copy.backup.historyEmpty} />
        ) : (
          <ScrollableTable minWidth="40rem">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.backup.colWhen}</TableHead>
                  <TableHead>{copy.backup.colAction}</TableHead>
                  <TableHead>{copy.backup.colScope}</TableHead>
                  <TableHead>{copy.backup.colSize}</TableHead>
                  <TableHead>{copy.backup.colOutcome}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.entries.map((entry) => (
                  <TableRow key={`${entry.at}-${entry.action}`}>
                    <TableCell className="whitespace-nowrap">
                      {dateFormat.format(new Date(entry.at))}
                    </TableCell>
                    <TableCell>
                      {entry.action === 'backup'
                        ? copy.backup.actionBackup
                        : copy.backup.actionRestore}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <bdi dir="ltr">{entry.scope}</bdi>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <bdi dir="ltr">{formatBytes(entry.bytes)}</bdi>
                    </TableCell>
                    <TableCell>
                      <CellTag tone={entry.ok ? 'success' : 'destructive'}>
                        {entry.ok ? copy.backup.outcomeOk : copy.backup.outcomeFailed}
                      </CellTag>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollableTable>
        )}
      </SettingsCard>
    </div>
  );
}
