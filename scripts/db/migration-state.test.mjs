/**
 * The reads that decide whether a deploy runs migrations at all, driven with a
 * fake database. Run with `pnpm db:test`.
 *
 * The cases pinned hardest are the ones that used to pass silently: a registry
 * that could not be read looked like one with no municipalities, and a
 * database restored without its history looked like one needing every
 * migration again.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LedgerError,
  isUpToDate,
  productionProblems,
  promotionProblems,
  readMigrationState,
} from './migration-state.mjs';

const FOLDERS = {
  registry: ['0001_init'],
  tenant: ['0001_init', '0002_parcels', '0003_building_units'],
};

const finished = (name) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null });
const albazourieh = { slug: 'albazourieh', schemaName: 'tenant_albazourieh' };

/**
 * A stand-in for a `pg` client over one database.
 *
 *   registry  rows of public._prisma_migrations, or null when the table is absent
 *   tenants   provisioned rows of public.tenants, or null when the table is absent
 *   ledgers   schema → names in its _tenant_migrations, or null when absent
 *   broken    'tenants' or a schema name, whose read throws as a permission error would
 */
function database({ registry = null, tenants = null, ledgers = {}, broken = null } = {}) {
  return {
    async query(sql, params) {
      if (sql.startsWith('select to_regclass')) {
        const name = params[0];
        if (name === 'public._prisma_migrations') return { rows: [{ present: registry !== null }] };
        if (name === 'public.tenants') return { rows: [{ present: tenants !== null }] };
        const schema = /^"(.+)"\."_tenant_migrations"$/.exec(name)?.[1];
        if (schema) return { rows: [{ present: ledgers[schema] != null }] };
        throw new Error(`unexpected to_regclass(${name})`);
      }
      if (sql.includes('_prisma_migrations')) return { rows: registry };
      if (sql.includes('public.tenants')) {
        if (broken === 'tenants') throw new Error('permission denied for table tenants');
        return { rows: tenants };
      }
      const schema = /from "(.+)"\."_tenant_migrations"/.exec(sql)?.[1];
      if (schema) {
        if (broken === schema) throw new Error(`permission denied for schema ${schema}`);
        return { rows: ledgers[schema].map((name) => ({ name })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

/** The imported production database as it should be: schema and history both there. */
const intact = () =>
  database({
    registry: [finished('0001_init')],
    tenants: [albazourieh],
    ledgers: { tenant_albazourieh: [...FOLDERS.tenant] },
  });

describe('readMigrationState', () => {
  test('an imported database with its history intact has nothing to apply', async () => {
    const state = await readMigrationState(intact(), FOLDERS);

    assert.equal(isUpToDate(state), true);
    assert.equal(state.tenantCount, 1);
  });

  test('a municipality one migration behind has exactly that one pending', async () => {
    const state = await readMigrationState(
      database({
        registry: [finished('0001_init')],
        tenants: [albazourieh],
        ledgers: { tenant_albazourieh: ['0001_init', '0002_parcels'] },
      }),
      FOLDERS,
    );

    assert.deepEqual(state.registryPending, []);
    assert.deepEqual(state.tenantPendingUnion, ['0003_building_units']);
  });

  test('history the repository no longer has (a renamed or unmerged migration) is not pending', async () => {
    const state = await readMigrationState(
      database({
        registry: [finished('0001_init')],
        tenants: [albazourieh],
        ledgers: { tenant_albazourieh: [...FOLDERS.tenant, '0041_unit_vacancy_confirmations'] },
      }),
      FOLDERS,
    );

    assert.equal(isUpToDate(state), true);
  });

  test('a brand-new database is all pending, with no municipalities yet', async () => {
    const state = await readMigrationState(database(), FOLDERS);

    assert.deepEqual(state.registryPending, ['0001_init']);
    assert.equal(state.tenantCount, 0);
  });

  describe('refuses a live schema without its history, rather than re-running migrations', () => {
    test('the registry exists but _prisma_migrations does not', async () => {
      const db = database({ registry: null, tenants: [albazourieh], ledgers: { tenant_albazourieh: [] } });

      await assert.rejects(readMigrationState(db, FOLDERS), (error) => {
        assert.ok(error instanceof LedgerError);
        assert.match(error.message, /public\._prisma_migrations does not exist/);
        assert.match(error.message, /Nothing was applied/);
        return true;
      });
    });

    test('_prisma_migrations exists but has no row for the initial migration', async () => {
      const db = database({ registry: [], tenants: [albazourieh], ledgers: { tenant_albazourieh: [...FOLDERS.tenant] } });

      await assert.rejects(readMigrationState(db, FOLDERS), /no finished row for 0001_init/);
    });

    test("a municipality's _tenant_migrations is missing", async () => {
      const db = database({ registry: [finished('0001_init')], tenants: [albazourieh], ledgers: {} });

      await assert.rejects(readMigrationState(db, FOLDERS), (error) => {
        assert.ok(error instanceof LedgerError);
        assert.match(error.message, /Municipality 'albazourieh' \(tenant_albazourieh\)/);
        assert.match(error.message, /missing or empty/);
        assert.match(error.message, /Never `prisma migrate resolve`/);
        return true;
      });
    });

    test("a municipality's _tenant_migrations is empty", async () => {
      const db = database({
        registry: [finished('0001_init')],
        tenants: [albazourieh],
        ledgers: { tenant_albazourieh: [] },
      });

      await assert.rejects(readMigrationState(db, FOLDERS), LedgerError);
    });
  });

  test('refuses a registry migration Prisma started and never finished (P3009)', async () => {
    const db = database({
      registry: [finished('0001_init'), { migration_name: '0002_x', finished_at: null, rolled_back_at: null }],
      tenants: [albazourieh],
      ledgers: { tenant_albazourieh: [...FOLDERS.tenant] },
    });

    await assert.rejects(readMigrationState(db, FOLDERS), (error) => {
      assert.ok(error instanceof LedgerError);
      assert.match(error.message, /started and never finished:\n\s+✗ 0002_x/);
      return true;
    });
  });

  test('a rolled-back registry row counts as neither applied nor failed', async () => {
    const db = database({
      registry: [
        finished('0001_init'),
        { migration_name: '0002_x', finished_at: null, rolled_back_at: new Date() },
      ],
      tenants: [albazourieh],
      ledgers: { tenant_albazourieh: [...FOLDERS.tenant] },
    });

    const state = await readMigrationState(db, { ...FOLDERS, registry: ['0001_init', '0002_x'] });
    assert.deepEqual(state.registryPending, ['0002_x']);
  });

  describe('a read that fails stops the deploy instead of reading as empty', () => {
    test('the list of municipalities', async () => {
      const db = database({
        registry: [finished('0001_init')],
        tenants: [albazourieh],
        ledgers: { tenant_albazourieh: [...FOLDERS.tenant] },
        broken: 'tenants',
      });

      await assert.rejects(readMigrationState(db, FOLDERS), /permission denied for table tenants/);
    });

    test("one municipality's history", async () => {
      const db = database({
        registry: [finished('0001_init')],
        tenants: [albazourieh],
        ledgers: { tenant_albazourieh: [...FOLDERS.tenant] },
        broken: 'tenant_albazourieh',
      });

      await assert.rejects(readMigrationState(db, FOLDERS), /permission denied for schema/);
    });
  });
});

describe('productionProblems', () => {
  test('production with no provisioned municipality is refused as a false all-clear', () => {
    const [problem] = productionProblems({ tenantCount: 0 });
    assert.match(problem, /wrong database, or the registry is unreadable/);
  });

  test('production with municipalities passes', () => {
    assert.deepEqual(productionProblems({ tenantCount: 1 }), []);
  });
});

describe('promotionProblems', () => {
  const state = (registryPending, tenantPendingUnion, tenantCount = 1) => ({
    registryPending,
    tenantPendingUnion,
    tenantCount,
  });

  test('staging behind production blocks, naming what staging lacks', () => {
    const [problem] = promotionProblems(
      state([], ['0058_new']),
      state([], ['0058_new']),
    );
    assert.match(problem, /not been applied to staging yet:\n\s+✗ tenant\/0058_new/);
  });

  test('staging with no municipality cannot vouch for a tenant migration', () => {
    const problems = promotionProblems(state([], ['0058_new']), state([], [], 0));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Staging has no provisioned municipality/);
  });

  test('staging with no municipality can still vouch for a registry-only migration', () => {
    assert.deepEqual(promotionProblems(state(['0002_x'], []), state([], [], 0)), []);
  });

  test('staging already ahead passes', () => {
    assert.deepEqual(promotionProblems(state([], ['0058_new']), state([], [])), []);
  });
});
