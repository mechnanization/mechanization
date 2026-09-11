import { gunzipSync, gzipSync } from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaPrefix } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ValidationError } from '../../common/exceptions';

/**
 * The snapshot format's own version.
 *
 * Bumped whenever the set of tables or the shape of a row changes in a way an
 * older restore could not read. Checked on the way in, because the failure it
 * prevents — a snapshot half-restored before the mismatch is noticed — is not
 * one a municipality can undo.
 */
const SNAPSHOT_VERSION = 2;

/**
 * Ceiling on the *decompressed* snapshot, enforced by `gunzipSync`.
 *
 * `BackupController` caps the upload at 64 MB as bytes arrive, which bounds
 * what is read but not what is allocated: gzip reaches roughly 1000:1 on
 * repetitive input, so an accepted 64 MB upload could ask for tens of
 * gigabytes of heap in one synchronous call, inside a function with 1 GB. That
 * is a decompression bomb, and the upload limit does nothing about it.
 *
 * 512 MB is far above any real municipality — the largest plausible register
 * is a few tens of megabytes of JSON — and far below what would exhaust the
 * process. `gunzipSync` throws once the limit is passed, which lands in the
 * existing catch and surfaces as "not a valid backup" rather than as an OOM.
 */
const MAX_SNAPSHOT_INFLATED_BYTES = 512 * 1024 * 1024;

/**
 * Every table in a tenant schema, in the order rows may be inserted.
 *
 * Derived from the foreign keys in the tenant Prisma schema, not guessed:
 * `Registration` points at `User`, `PropertyEntry` at `Registration`,
 * `BuildingUnit` and `Document` at `PropertyEntry`, `CitizenPayment` at both
 * `User` and `FeeNotice`. `Parcel`, `Zone`, `OtpChallenge` and `SystemSettings`
 * carry no outbound relation and can go anywhere; they are placed early so a
 * failure surfaces on cheap tables first.
 *
 * Deletion walks this list backwards. Getting the order wrong is not a subtle
 * bug — it is a foreign-key violation that aborts the transaction, which is the
 * safe direction for this to fail in.
 *
 * ── Why `auditLogEntry` is not here ────────────────────────────────────────
 *
 * It was, and it made restore impossible. `0001_init` installs a
 * `BEFORE DELETE` trigger that raises on `audit_log_entries`, on purpose: a
 * trail a compromised administrator can rewrite proves nothing. Restore empties
 * every table in this list, so it hit that trigger and aborted the transaction
 * for any municipality that had ever recorded an action — which is all of them,
 * since a staff login writes one.
 *
 * The failure mode was the worst available: `dryRun` only counts rows, so the
 * rehearsal reported success and the real run failed. A municipality would have
 * discovered its backups do not restore at the exact moment it needed them to.
 *
 * Excluding the trail is the resolution rather than disabling the trigger,
 * because it is the honest reading of what a restore *means*: the trail is
 * history — a record of things that were actually done — and rolling the
 * register back to Tuesday does not make Wednesday's actions un-happen. So the
 * data returns to its snapshot state and the trail keeps accumulating across
 * it, including a `REGISTER_RESTORED` entry recording the restore itself.
 */
/**
 * Every table a snapshot carries, parents before children.
 *
 * The order is the whole contract: rows are written in it and deleted in
 * reverse, so a table listed before something it points at fails the restore on
 * a foreign key — inside the one transaction that was meant to make a restore
 * survivable.
 *
 * The census block (`building` … `damageAssessment`) and `case` were added with
 * Phase 2, and `unitVisit` with Phase 4. Their absence was not a missing feature, it was silent data loss:
 * `unit_occupancies.citizenId` cascades from `users`, so a restore — which
 * deletes and rewrites every user — destroyed every record of who lives where
 * and then did not put it back. A municipality would have found that out at the
 * exact moment it needed a restore to work.
 *
 * `case` had the same hole since 0027 and is fixed here rather than separately,
 * because a case now points at a building, a unit and a damage assessment: it
 * cannot be ordered correctly except alongside them.
 */
const TABLE_ORDER = [
  'user',
  'otpChallenge',
  'parcel',
  'zone',
  'systemSettings',
  // A building stands on a parcel and is created by a user; it depends on no
  // registration, which is the entire point of it existing (D1).
  'building',
  'unit',
  'registration',
  'propertyEntry',
  'buildingUnit',
  // After `unit`, `user` and `registration` — it references all three.
  'unitOccupancy',
  // The same reasoning as `unitOccupancy`, one table further on: a visit
  // references a unit and an officer, and `officerId` is a `users` row a
  // restore deletes and rewrites. Losing these would erase the municipality's
  // evidence that a door was tried — which is exactly what a resident
  // disputing a notice asks to see.
  'unitVisit',
  'damageAssessment',
  // Last of the census block: a case may point at a building, a unit and the
  // damage assessment that prompted it.
  'case',
  'document',
  'feeNotice',
  'citizenPayment',
] as const;

type TableName = (typeof TABLE_ORDER)[number];

/**
 * Tables a snapshot may legitimately contain but restore must never write.
 *
 * `auditLogEntry` appears in every v1 snapshot. Those are rejected outright by
 * the version check, so this exists for the other direction: a v2 snapshot hand-
 * edited to carry one, which should be refused as an unknown table rather than
 * silently ignored.
 */
const NEVER_RESTORED = new Set(['auditLogEntry']);

export interface SnapshotManifest {
  version: number;
  tenantSlug: string;
  createdAt: string;
  /** The tenant schema's applied migrations, newest last. */
  migrations: string[];
  counts: Record<string, number>;
}

interface Snapshot {
  manifest: SnapshotManifest;
  tables: Record<string, unknown[]>;
}

export interface RestoreReport {
  dryRun: boolean;
  manifest: SnapshotManifest;
  /** Rows deleted per table, then written per table. Empty on a dry run. */
  deleted: Record<string, number>;
  written: Record<string, number>;
}

/**
 * A tenant's data, out and back in.
 *
 * This is the restorable pair. The CSV archive the settings screen builds in
 * the browser is a *report* — it exports what the API returns (a joined
 * `fullName`, computed totals like `feesTotal`) and cannot be read back into
 * tables that want `firstName`/`middleName`/`lastName`, `gender` and
 * `totalRegisteredMembers`/`actualHouseholdMembers`. Both are worth having, and confusing them is how a
 * municipality discovers at the worst moment that its backups restore nothing.
 * This one reads and writes table rows.
 *
 * **Restore replaces.** It empties the tenant's tables and writes the
 * snapshot's rows in their place, inside one transaction — so it either lands
 * completely or not at all. Merging was the alternative and is worse: a
 * snapshot is a picture of a moment, and half-merging it into a schema that has
 * moved on produces a state that never existed, with no way to tell which rows
 * came from where. Replacement is at least a state the municipality once had.
 *
 * Three things gate it, and all three are checked before anything is written:
 * the snapshot's tenant must match the target, its migration set must match,
 * and the caller must name the tenant back. See `restore`.
 */
/**
 * Strips database-generated columns (`GENERATED ALWAYS AS ... STORED`) from
 * snapshot rows so that `createMany` does not attempt to insert a non-DEFAULT value.
 */
function sanitizeRowForSnapshot(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;
  const { searchText: _searchText, ...rest } = row as Record<string, unknown>;
  return rest;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /** A Prisma delegate by table name, typed loosely because the list is data. */
  private delegate(table: TableName): {
    findMany: (args?: unknown) => Promise<unknown[]>;
    createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
    deleteMany: (args?: unknown) => Promise<{ count: number }>;
    count: () => Promise<number>;
  } {
    const client = this.db as unknown as Record<string, unknown>;
    const found = client[table];
    if (!found) throw new Error(`Unknown table '${table}' in snapshot table order`);
    return found as ReturnType<BackupService['delegate']>;
  }

  /** The migrations this schema has applied, so a restore can refuse a mismatch. */
  private async appliedMigrations(): Promise<string[]> {
    /*
      Schema-qualified like every other raw query here — `search_path` is not
      ours to rely on behind a transaction pooler (`tenant-schema-ref.ts`), and
      a restore that read *another* schema's migration list would compare the
      snapshot against the wrong history and either refuse a good restore or
      accept a mismatched one.
    */
    const rows = await this.db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT "name" FROM ${tenantSchemaPrefix(this.tenantContext.schemaName)}"_tenant_migrations" ORDER BY "name"`,
    );
    return rows.map((row) => row.name);
  }

  /**
   * Every row of every table, gzipped.
   *
   * Gzipped JSON rather than a ZIP of CSVs: CSV has no types, so a boolean
   * comes back as the string `"true"` and a null as an empty cell
   * indistinguishable from an empty string — differences that matter the moment
   * the rows are written back. JSON keeps them, and `Date` survives as an ISO
   * string Prisma accepts on the way in. Gzip because a municipal register is
   * mostly repeated Arabic text and compresses to roughly a tenth.
   */
  async exportSnapshot(): Promise<{ buffer: Buffer; manifest: SnapshotManifest }> {
    const scope = this.tenantContext.require();

    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};

    for (const table of TABLE_ORDER) {
      const rawRows = await this.delegate(table).findMany();
      const rows = rawRows.map((row) => sanitizeRowForSnapshot(row));
      tables[table] = rows;
      counts[table] = rows.length;
    }

    const manifest: SnapshotManifest = {
      version: SNAPSHOT_VERSION,
      tenantSlug: scope.tenantSlug,
      createdAt: new Date().toISOString(),
      migrations: await this.appliedMigrations(),
      counts,
    };

    const snapshot: Snapshot = { manifest, tables };
    // `JSON.stringify` turns Decimal into its string form and Date into ISO,
    // both of which Prisma accepts back — no custom replacer needed.
    const buffer = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));

    this.logger.log(
      `Exported ${scope.tenantSlug}: ${Object.values(counts).reduce((a, b) => a + b, 0)} rows, ${buffer.length} bytes`,
    );

    return { buffer, manifest };
  }

  /** Parses and validates a snapshot without touching the database. */
  private parse(gzipped: Buffer): Snapshot {
    let text: string;
    try {
      text = gunzipSync(gzipped, { maxOutputLength: MAX_SNAPSHOT_INFLATED_BYTES }).toString(
        'utf8',
      );
    } catch {
      throw new ValidationError('الملف ليس نسخة احتياطية صالحة (تعذّر فك الضغط).');
    }

    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(text) as Snapshot;
    } catch {
      throw new ValidationError('محتوى النسخة الاحتياطية غير صالح.');
    }

    if (!snapshot?.manifest || !snapshot.tables) {
      throw new ValidationError('النسخة الاحتياطية لا تحتوي على بيان أو جداول.');
    }
    if (snapshot.manifest.version !== SNAPSHOT_VERSION) {
      throw new ValidationError(
        `إصدار النسخة (${snapshot.manifest.version}) لا يطابق الإصدار المدعوم (${SNAPSHOT_VERSION}).`,
      );
    }

    return snapshot;
  }

  /**
   * Writes a snapshot back over this tenant's data.
   *
   * @param confirmTenantSlug the tenant slug, typed by the operator. Not
   *   security — the route is already SUPER_ADMIN and tenant-scoped — but the
   *   one confirmation muscle memory cannot dismiss, matching how this codebase
   *   already guards deleting a citizen.
   * @param dryRun validates everything and reports what *would* happen. The
   *   default from the UI, because "restore" is a word people click before they
   *   have read the sentence next to it.
   */
  async restore(
    gzipped: Buffer,
    options: { confirmTenantSlug: string; dryRun: boolean },
    actor: { id: string; role: string },
  ): Promise<RestoreReport> {
    const scope = this.tenantContext.require();
    const snapshot = this.parse(gzipped);
    const manifest = snapshot.manifest;

    /*
     * The three gates, all before any write.
     *
     * The tenant check is the one that matters most: an
     * `albazourieh-backup.zip` restored into Zahle looks like a backup either
     * way from its file name, and the result is one municipality's register
     * replaced by another's.
     */
    if (manifest.tenantSlug !== scope.tenantSlug) {
      throw new ValidationError(
        `هذه النسخة تخصّ «${manifest.tenantSlug}» ولا يمكن استعادتها في «${scope.tenantSlug}».`,
      );
    }

    if (options.confirmTenantSlug.trim() !== scope.tenantSlug) {
      throw new ValidationError('اكتب اسم البلدية كما هو للتأكيد.');
    }

    /*
     * A snapshot taken before a migration has columns the current schema does
     * not, or is missing ones it now requires. Prisma would reject the row and
     * abort — correctly, but with an error about one column rather than about
     * the real problem, so it is caught here where it can be explained.
     */
    const current = await this.appliedMigrations();
    const missing = current.filter((name) => !manifest.migrations.includes(name));
    const extra = manifest.migrations.filter((name) => !current.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new ValidationError(
        `النسخة أُخذت من قاعدة بإصدار مختلف (فرق: ${[...missing, ...extra].join('، ')}).`,
      );
    }

    /**
     * A table this restore does not know how to write is refused rather than
     * skipped. Silently ignoring one would mean a snapshot appearing to restore
     * completely while a table's worth of rows never arrived — which is exactly
     * the "state the municipality never had" that the all-or-nothing
     * transaction below exists to prevent.
     */
    const unknownTables = Object.keys(snapshot.tables).filter(
      (name) => !TABLE_ORDER.includes(name as TableName) || NEVER_RESTORED.has(name),
    );
    if (unknownTables.length > 0) {
      throw new ValidationError(`جداول غير معروفة في النسخة: ${unknownTables.join('، ')}.`);
    }

    if (options.dryRun) {
      const deleted: Record<string, number> = {};
      for (const table of TABLE_ORDER) deleted[table] = await this.delegate(table).count();
      return {
        dryRun: true,
        manifest,
        deleted,
        written: Object.fromEntries(
          TABLE_ORDER.map((table) => [table, snapshot.tables[table]?.length ?? 0]),
        ),
      };
    }

    const deleted: Record<string, number> = {};
    const written: Record<string, number> = {};

    /*
     * One interactive transaction for the whole thing.
     *
     * Half a restore is worse than none — a register missing its payments but
     * holding its citizens is a state no municipality ever had and nothing can
     * reconcile. The timeout is generous because this is the one operation on
     * this system where taking too long is preferable to giving up midway; the
     * transaction still rolls back cleanly if it is exceeded.
     */
    await this.db.$transaction(
      async (tx) => {
        const scoped = (table: TableName) => {
          const client = tx as unknown as Record<string, unknown>;
          return client[table] as ReturnType<BackupService['delegate']>;
        };

        // Backwards: a child's rows go before the parent they point at.
        for (const table of [...TABLE_ORDER].reverse()) {
          const result = await scoped(table).deleteMany({});
          deleted[table] = result.count;
        }

        for (const table of TABLE_ORDER) {
          const rawRows = snapshot.tables[table] ?? [];
          if (rawRows.length === 0) {
            written[table] = 0;
            continue;
          }
          // Generated columns (`GENERATED ALWAYS AS ... STORED`) are computed
          // by Postgres on insert/update and reject an explicit non-DEFAULT value.
          const rows = rawRows.map((row) => sanitizeRowForSnapshot(row));
          // `createMany` in one call per table rather than a row at a time:
          // a register of ten thousand citizens is ten thousand round trips
          // otherwise, inside a transaction holding locks the whole while.
          const result = await scoped(table).createMany({ data: rows as never });
          written[table] = result.count;
        }
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    this.logger.warn(
      `Restored ${scope.tenantSlug} from snapshot of ${manifest.createdAt} by ${actor.id}`,
    );

    this.events.emit('backup.restored', {
      tenantSlug: scope.tenantSlug,
      actorId: actor.id,
      actorRole: actor.role,
      snapshotCreatedAt: manifest.createdAt,
      written,
    });

    return { dryRun: false, manifest, deleted, written };
  }
}
