-- first-run-check.sql
--
-- What the first push to main will do to THIS database, decided with the same
-- rules the pipeline uses (scripts/db/migration-state.mjs and deploy.mjs at
-- 4c20566). Read-only: it runs inside a READ ONLY transaction that is rolled
-- back, and reads only the catalog, the two migration ledgers and
-- public.tenants (slug, "schemaName", "provisionedAt"). It reads no citizen row.
--
-- Run it on the box, once per database, as the postgres superuser. Feed the
-- file on stdin (`<`, not `-f`): your own shell opens it, so the postgres user
-- does not need to read your home directory.
--
--   curl -fsSL -o ~/first-run-check.sql https://raw.githubusercontent.com/mechnanization/mechanization/feat/lightsail-migrations/scripts/db/first-run-check.sql
--   sudo -u postgres psql -X -q -d municipality_db         < ~/first-run-check.sql
--   sudo -u postgres psql -X -q -d municipality_db_staging < ~/first-run-check.sql
--
-- Expected on both: every line starts with OK or INFO, and the last line is
--   VERDICT <db>: nothing to apply, nothing refused. The first run will say "Already up to date".
--
-- A one-off check for merging PR #41. The repository's migration list below is
-- the one at commit 4c20566, unchanged through 5f4ff26 (registry 0001_init;
-- tenant 0001_init .. 0057_whish_checkouts, 59 folders). It goes stale with the
-- next migration: regenerate the list or delete this file.

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $check$
DECLARE
  repo_registry CONSTANT text[] := ARRAY['0001_init'];
  repo_tenant CONSTANT text[] := ARRAY[
    '0001_init', '0002_parcels', '0003_building_units',
    '0004_parcel_co_registration', '0005_neighborhood_and_marital_status', '0006_zones',
    '0007_field_level_rejection', '0008_correction_mode', '0009_fees_and_payments',
    '0010_recurring_billing', '0011_partial_payments', '0012_municipality_contact',
    '0013_collector_payment_method', '0014_collector_identity', '0015_settings_expansion',
    '0016_add_collector_role', '0016_session_revocation', '0017_add_accountant_and_admin_officer_roles',
    '0017_payment_ledger', '0018_search_normalization', '0019_add_blood_type',
    '0020_add_payment_seen', '0021_field_flags', '0022_per_unit_billing',
    '0023_unit_occupancy_status', '0024_fee_bearer', '0025_inspector_commission_and_payouts',
    '0026_household_member_split', '0027_cases', '0028_land_shares',
    '0029_case_resolution_link', '0030_building_census', '0031_unit_fields_flaggable',
    '0032_unit_visits', '0033_building_lifecycle', '0034_free_occupied_unit_status',
    '0035_backfill_unit_status_from_occupancy', '0036_registration_notes', '0037_landlord_link',
    '0038_unit_block_span', '0039_building_basements', '0040_owner_records_and_occupancy_end',
    '0041_war_damaged_uninhabited', '0042_garage_unit_and_building_log_order', '0043_unit_vacancy_confirmations',
    '0044_mother_name', '0045_landlord_link_footprint', '0046_ended_tenancy',
    '0047_building_parcel_partitioning', '0048_search_compact_schema_qualified', '0049_quality_review',
    '0050_constraints_missed_by_global_guards', '0051_pilotis_unit_type', '0052_pilotis_excluded_from_unit_counts',
    '0053_empty_floor_unit_type', '0054_structural_units_excluded_from_counts', '0055_census_sync_marker',
    '0056_billing_run_ledger', '0057_whish_checkouts'];
  -- The repo migrations scripts/db/destructive-sql.mjs classes as blocking.
  -- If any of them is pending, the automatic run refuses.
  destructive CONSTANT text[] := ARRAY[
    '0024_fee_bearer', '0026_household_member_split', '0034_free_occupied_unit_status'];

  db   text := current_database();
  -- The role the pipeline connects as, pinned in scripts/db/targets.mjs.
  who  text := CASE current_database()
                 WHEN 'municipality_db' THEN 'appuser'
                 WHEN 'municipality_db_staging' THEN 'appuser_staging'
               END;
  refused int := 0;
  applies int := 0;
  n_tenants int := 0;
  applied text[];
  pending text[];
  extra text[];
  failed text[];
  hit text[];
  ledger text;
  owners text;
  t record;
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'Run this on municipality_db or municipality_db_staging, not %', db;
  END IF;
  RAISE NOTICE 'INFO    database %, pipeline role %', db, who;

  -- 0. Can the pipeline role get in and read what the guard reads?
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who) THEN
    RAISE NOTICE 'REFUSE  role % does not exist, so the pipeline cannot log in', who;
    refused := refused + 1;
    who := NULL;
  ELSIF NOT has_database_privilege(who, db, 'CONNECT') THEN
    RAISE NOTICE 'REFUSE  % has no CONNECT on %', who, db;
    refused := refused + 1;
  END IF;

  -- 1. Registry (migration-state.mjs:76-115)
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    applied := '{}';
  ELSE
    IF who IS NOT NULL AND NOT has_table_privilege(who, 'public._prisma_migrations', 'SELECT') THEN
      RAISE NOTICE 'REFUSE  % cannot SELECT public._prisma_migrations (permission denied on the first read)', who;
      refused := refused + 1;
    END IF;
    SELECT coalesce(array_agg(migration_name ORDER BY migration_name), '{}') INTO failed
      FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
    IF cardinality(failed) > 0 THEN
      RAISE NOTICE 'REFUSE  registry: Prisma started and never finished %', failed;
      refused := refused + 1;
    END IF;
    SELECT coalesce(array_agg(migration_name), '{}') INTO applied
      FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  END IF;

  pending := ARRAY(SELECT unnest(repo_registry) EXCEPT SELECT unnest(applied) ORDER BY 1);
  IF to_regclass('public.tenants') IS NOT NULL AND '0001_init' = ANY (pending) THEN
    RAISE NOTICE 'REFUSE  registry: live schema without history (% %)',
      CASE WHEN to_regclass('public._prisma_migrations') IS NULL
           THEN 'public._prisma_migrations does not exist'
           ELSE 'no finished row for' END,
      CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN '' ELSE '0001_init' END;
    refused := refused + 1;
  ELSIF cardinality(pending) > 0 THEN
    RAISE NOTICE 'APPLY   registry: %', pending;
    applies := applies + cardinality(pending);
  ELSE
    RAISE NOTICE 'OK      registry: 0001_init recorded as finished';
  END IF;

  -- 2. Municipalities (migration-state.mjs:122-159)
  IF to_regclass('public.tenants') IS NOT NULL THEN
    IF who IS NOT NULL AND NOT has_table_privilege(who, 'public.tenants', 'SELECT') THEN
      RAISE NOTICE 'REFUSE  % cannot SELECT public.tenants', who;
      refused := refused + 1;
    END IF;

    FOR t IN
      SELECT slug, "schemaName" AS schema_name FROM public.tenants
       WHERE "provisionedAt" IS NOT NULL ORDER BY slug
    LOOP
      n_tenants := n_tenants + 1;
      ledger := format('%I._tenant_migrations', t.schema_name);

      IF who IS NOT NULL
         AND to_regnamespace(quote_ident(t.schema_name)) IS NOT NULL
         AND NOT has_schema_privilege(who, t.schema_name, 'USAGE') THEN
        RAISE NOTICE 'REFUSE  %: % has no USAGE on schema %', t.slug, who, t.schema_name;
        refused := refused + 1;
      END IF;

      IF to_regclass(ledger) IS NULL THEN
        applied := '{}';
      ELSE
        IF who IS NOT NULL AND NOT has_table_privilege(who, ledger, 'SELECT') THEN
          RAISE NOTICE 'REFUSE  %: % cannot SELECT %', t.slug, who, ledger;
          refused := refused + 1;
        END IF;
        EXECUTE format('SELECT coalesce(array_agg(name), ''{}'') FROM %s', ledger) INTO applied;
      END IF;

      pending := ARRAY(SELECT unnest(repo_tenant) EXCEPT SELECT unnest(applied) ORDER BY 1);
      extra   := ARRAY(SELECT unnest(applied) EXCEPT SELECT unnest(repo_tenant) ORDER BY 1);

      IF '0001_init' = ANY (pending) THEN
        RAISE NOTICE 'REFUSE  % (%): live schema without history (% is missing or has no 0001_init row)',
          t.slug, t.schema_name, ledger;
        refused := refused + 1;
      ELSIF cardinality(pending) > 0 THEN
        -- The guard does NOT refuse a missing middle row: it applies it.
        RAISE NOTICE 'APPLY   % (%): % pending: %', t.slug, t.schema_name, cardinality(pending), pending;
        applies := applies + cardinality(pending);
        hit := ARRAY(SELECT unnest(pending) INTERSECT SELECT unnest(destructive) ORDER BY 1);
        IF cardinality(hit) > 0 THEN
          RAISE NOTICE 'REFUSE  % (%): pending migration(s) hold data-losing SQL: %', t.slug, t.schema_name, hit;
          refused := refused + 1;
        END IF;
      ELSE
        RAISE NOTICE 'OK      % (%): all % repo migrations recorded (% ledger rows)',
          t.slug, t.schema_name, cardinality(repo_tenant), cardinality(applied);
      END IF;

      IF cardinality(extra) > 0 THEN
        RAISE NOTICE 'INFO    % (%): % ledger row(s) with no repo folder, ignored by the guard: %',
          t.slug, t.schema_name, cardinality(extra), extra;
      END IF;

      -- Not a first-run blocker: the first run applies nothing. A later
      -- migration that ALTERs a table the pipeline role does not own fails
      -- with "must be owner", safely, and blocks that deploy.
      SELECT string_agg(tableowner || ' x' || c, ', ' ORDER BY tableowner) INTO owners
        FROM (SELECT tableowner, count(*) AS c FROM pg_tables
               WHERE schemaname = t.schema_name GROUP BY tableowner) o;
      RAISE NOTICE 'INFO    % (%): table owners %', t.slug, t.schema_name, coalesce(owners, 'none');
    END LOOP;
  END IF;

  SELECT string_agg(tableowner || ' x' || c, ', ' ORDER BY tableowner) INTO owners
    FROM (SELECT tableowner, count(*) AS c FROM pg_tables
           WHERE schemaname = 'public' GROUP BY tableowner) o;
  RAISE NOTICE 'INFO    public: table owners %', coalesce(owners, 'none');
  RAISE NOTICE 'INFO    provisioned municipalities: %', n_tenants;

  -- 3. Production must report a municipality (migration-state.mjs:188-196)
  IF db = 'municipality_db' AND n_tenants = 0 THEN
    RAISE NOTICE 'REFUSE  production reports no provisioned municipality';
    refused := refused + 1;
  END IF;

  IF refused > 0 THEN
    RAISE NOTICE 'VERDICT %: % refusal(s). The first run stops here and deploys no code.', db, refused;
  ELSIF applies > 0 THEN
    RAISE NOTICE 'VERDICT %: % migration(s) would be APPLIED on the first run. Not the expected "Already up to date".', db, applies;
  ELSE
    RAISE NOTICE 'VERDICT %: nothing to apply, nothing refused. The first run will say "Already up to date".', db;
  END IF;
END
$check$;

ROLLBACK;
