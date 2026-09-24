/**
 * What a database has already applied, read so that every doubt stops the
 * deploy instead of being resolved in its favour.
 *
 * `deploy.mjs` used to read this with `.catch(() => ({ rows: [] }))` on every
 * query. That turned "cannot read the list of municipalities" into "there are
 * no municipalities", which made every check downstream pass: nothing pending,
 * nothing destructive, and nothing for staging to have vouched for. Each of those
 * reads now either succeeds or stops the deploy.
 *
 * The case this file is most careful about is a database that was *imported*
 * rather than migrated. Production and staging on the Lightsail box are
 * restores of the old Supabase databases, so their schema and their migration
 * history arrived separately in the dump. If the tables made it and the history
 * did not, every migration looks pending, and running them would re-create
 * tables that already hold citizens' records. The tenant migrator would fail
 * on its first statement and roll back. Prisma would fail too, but it writes a
 * failed row to `_prisma_migrations` that blocks every later deploy until
 * someone repairs it by hand. So a missing history on a database that is
 * visibly in use is refused before anything runs, with the reason stated.
 *
 * No `pg` import: the caller hands in a connected client, which is what lets
 * the tests drive this with a fake one and keeps it runnable in CI's
 * `pnpm db:test`, which has no database.
 */

export class LedgerError extends Error {}

const REGISTRY_LEDGER = 'public._prisma_migrations';
const REGISTRY_TABLE = 'public.tenants';
const tenantLedger = (schema) => `"${schema}"."_tenant_migrations"`;

async function exists(client, qualifiedName) {
  const { rows } = await client.query('select to_regclass($1) is not null as present', [
    qualifiedName,
  ]);
  return rows[0]?.present === true;
}

function missingHistory(where, detail) {
  return new LedgerError(
    `${where} holds a live schema but not the history of how it got there:\n` +
      `    ${detail}\n` +
      '  Running the migrations again would re-create tables that already exist.\n' +
      '  Nothing was applied. Record the history only after proving the schema\n' +
      '  matches the migrations. See docs/database-environments.md,\n' +
      '  "When the migration history is missing". Never `prisma migrate resolve`\n' +
      '  for tenant migrations: that writes to the registry\'s table, which the\n' +
      '  tenant migrator never reads.',
  );
}

/**
 * The registry's history, and the municipalities provisioned on this database,
 * each with the tenant migrations its own schema has recorded.
 *
 * @param client   a connected `pg` client (or anything with the same `query`)
 * @param folders  `{ registry, tenant }`: the migration folder names in the
 *                 repository, sorted, so the first of each is the initial one
 */
export async function readMigrationState(client, folders) {
  const registryAll = folders.registry;
  const tenantAll = folders.tenant;

  // ── Registry ────────────────────────────────────────────────────────────
  const hasRegistryLedger = await exists(client, REGISTRY_LEDGER);
  const hasRegistrySchema = await exists(client, REGISTRY_TABLE);

  const registryApplied = new Set();
  if (hasRegistryLedger) {
    const { rows } = await client.query(
      `select migration_name, finished_at, rolled_back_at from ${REGISTRY_LEDGER}`,
    );

    // A row Prisma started and never finished is the state its own error P3009
    // describes. Every `migrate deploy` refuses until it is resolved, so saying
    // so here beats letting the next command print it mid-deploy.
    const failed = rows.filter((r) => r.finished_at == null && r.rolled_back_at == null);
    if (failed.length > 0) {
      throw new LedgerError(
        'The registry has a migration Prisma started and never finished:\n' +
          failed.map((r) => `    ✗ ${r.migration_name}`).join('\n') +
          '\n  Prisma refuses every later deploy until it is resolved by hand\n' +
          '  (`prisma migrate resolve --rolled-back` or `--applied`, after checking\n' +
          '  what the migration actually did). Nothing was applied.',
      );
    }

    for (const r of rows) {
      if (r.finished_at != null && r.rolled_back_at == null) registryApplied.add(r.migration_name);
    }
  }

  const registryPending = registryAll.filter((m) => !registryApplied.has(m));

  // `public.tenants` is created by the initial registry migration. If it
  // exists, that migration ran, so it cannot honestly be pending.
  if (hasRegistrySchema && registryAll.length > 0 && registryPending.includes(registryAll[0])) {
    throw missingHistory(
      'The registry (public)',
      hasRegistryLedger
        ? `${REGISTRY_LEDGER} has no finished row for ${registryAll[0]}`
        : `${REGISTRY_LEDGER} does not exist`,
    );
  }

  // ── Tenant schemas ──────────────────────────────────────────────────────
  //
  // A database with no registry yet has no municipalities, which is true
  // rather than unreadable: that is a brand-new environment. Once the registry
  // exists, reading it has to work.
  const provisioned = hasRegistrySchema
    ? (
        await client.query(
          // `@@map("tenants")` in the registry schema; the table is not "Tenant".
          `select slug, "schemaName" from ${REGISTRY_TABLE} where "provisionedAt" is not null order by slug`,
        )
      ).rows
    : [];

  const tenants = [];
  for (const { slug, schemaName } of provisioned) {
    const applied = new Set();
    if (await exists(client, tenantLedger(schemaName))) {
      const { rows } = await client.query(`select name from ${tenantLedger(schemaName)}`);
      for (const r of rows) applied.add(r.name);
    }

    const pending = tenantAll.filter((m) => !applied.has(m));

    // `provisionedAt` is written only after the tenant migrator has built the
    // schema, so a provisioned municipality has run the initial migration.
    if (tenantAll.length > 0 && pending.includes(tenantAll[0])) {
      throw missingHistory(
        `Municipality '${slug}' (${schemaName})`,
        applied.size === 0
          ? `${tenantLedger(schemaName)} is missing or empty`
          : `${tenantLedger(schemaName)} has no row for ${tenantAll[0]}`,
      );
    }

    tenants.push({ slug, schema: schemaName, applied, pending });
  }

  // Union across schemas: the tenant SQL this deploy will execute somewhere,
  // which is what the destructive scan and the promotion check care about.
  const tenantPendingUnion = [...new Set(tenants.flatMap((t) => t.pending))].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    registryPending,
    tenantPending: tenants,
    tenantPendingUnion,
    tenantCount: tenants.length,
  };
}

/** Whether anything at all is left to apply. */
export function isUpToDate(state) {
  return state.registryPending.length === 0 && state.tenantPendingUnion.length === 0;
}

/**
 * Why production must not be migrated from this state, if it must not.
 *
 * The production register has municipalities in it. Reading none means the
 * connection reached the wrong database or the registry is unreadable. Either
 * way, "no tenant schemas to migrate" would be a false all-clear.
 */
export function productionProblems(state) {
  if (state.tenantCount === 0) {
    return [
      'Production reports no provisioned municipality. That is not a real state for the live register:\n' +
        '  the connection reached the wrong database, or the registry is unreadable.',
    ];
  }
  return [];
}

/**
 * Which pending production migrations staging has not already run, and why
 * staging's word does not count, if it does not.
 *
 * "Not pending on staging" is only evidence when staging had somewhere to run
 * it. A staging database with no provisioned municipality has no tenant schema
 * pending anything, so every tenant migration would pass vacuously.
 */
export function promotionProblems(production, staging) {
  const problems = [];

  if (production.tenantPendingUnion.length > 0 && staging.tenantCount === 0) {
    problems.push(
      'Staging has no provisioned municipality, so it cannot have run the pending tenant migrations.',
    );
  }

  const notOnStaging = [
    ...production.registryPending
      .filter((m) => staging.registryPending.includes(m))
      .map((m) => `registry/${m}`),
    ...production.tenantPendingUnion
      .filter((m) => staging.tenantPendingUnion.includes(m))
      .map((m) => `tenant/${m}`),
  ];
  if (notOnStaging.length > 0) {
    problems.push(
      'These migrations have not been applied to staging yet:\n' +
        notOnStaging.map((m) => `    ✗ ${m}`).join('\n'),
    );
  }

  return problems;
}
