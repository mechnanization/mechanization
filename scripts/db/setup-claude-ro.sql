-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- claude_ro: a read-only Postgres role for the Claude Code agent.
--
-- WHAT IT CAN READ:
--   - Staff rows (name, role, activity), minus auth secrets.
--   - Citizen NAMES ONLY (first/middle/last/mother, gender, id).
--     No phone, no address, no national/civil/residency numbers, no
--     nationality, no refugee status, no documents.
--   - Structural tables (buildings, units, parcels, zones), registrations,
--     property entries, occupancies, payouts, billing metadata.
--
-- WHAT IT CANNOT READ:
--   - users.passwordHash, users.totpSecret, users.lastTotpStep
--   - staff_refresh_tokens.tokenHash
--   - Any sensitive citizen column beyond names (see the citizens view).
--   - documents (scanned identity documents).
--   - otp_challenges (plaintext phone).
--   - audit_log_entries.before / .after (JSONB snapshots that may hold
--     full citizen field values from repair operations).
--   - unit_visits.notes / cases.notes (officer free-text).
--   - Any table added by a future tenant migration.
--
-- WHAT IT CANNOT DO:
--   Write anything, anywhere. Two locks:
--     1) The role runs with default_transaction_read_only = on (session).
--     2) No INSERT/UPDATE/DELETE/TRUNCATE/DDL grant on ANY object.
--
-- OPERATIONAL LIMITS on the role:
--   CONNECTION LIMIT 2        cannot swamp the app's connection pool
--   statement_timeout 15s     no long scan holds up a migration
--   idle_in_txn_timeout 30s   cannot pin a snapshot for hours
--   lock_timeout 2s           cannot block a writer waiting on a lock
--   log_statement 'all'       every query is written to Postgres logs
--   VALID UNTIL 2027-04-01    forces a rotation review in 6 months
--
-- HOW TO RUN THIS FILE:
--   1) On the Lightsail box, as the postgres superuser:
--        psql -U postgres -d municipality_db -v ON_ERROR_STOP=1 \
--             -f setup-claude-ro.sql
--   2) Then set the password (kept out of this file so it isn't in git):
--        psql -U postgres -d municipality_db -c \
--             "ALTER ROLE claude_ro PASSWORD '<paste-generated-password>';"
--      Generate one with: openssl rand -base64 24
--   3) Prove writes fail â€” run verify-claude-ro.sql from the laptop
--      tunnel, as claude_ro.
--
-- KILL SWITCH: uncomment the block at the bottom and re-run this file.
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

BEGIN;

-- 1. The role, idempotently
DO $create_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    CREATE ROLE claude_ro WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE
      NOSUPERUSER NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 2;
    RAISE NOTICE 'created role claude_ro (no password set â€” run the ALTER separately)';
  ELSE
    RAISE NOTICE 'role claude_ro already exists â€” updating its settings only';
  END IF;
END
$create_role$;

ALTER ROLE claude_ro SET default_transaction_read_only        = on;
ALTER ROLE claude_ro SET statement_timeout                    = '15s';
ALTER ROLE claude_ro SET idle_in_transaction_session_timeout  = '30s';
ALTER ROLE claude_ro SET lock_timeout                         = '2s';
ALTER ROLE claude_ro SET log_statement                        = 'all';
ALTER ROLE claude_ro VALID UNTIL '2027-04-01';

REVOKE ALL PRIVILEGES ON DATABASE  municipality_db     FROM claude_ro;
REVOKE ALL PRIVILEGES ON SCHEMA    public                 FROM claude_ro;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public      FROM claude_ro;
REVOKE ALL PRIVILEGES ON SCHEMA    tenant_albazourieh     FROM claude_ro;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA tenant_albazourieh FROM claude_ro;

GRANT CONNECT ON DATABASE municipality_db TO claude_ro;

-- 2. The wrapper schema
DROP SCHEMA IF EXISTS readonly_claude CASCADE;
CREATE SCHEMA readonly_claude AUTHORIZATION postgres;
COMMENT ON SCHEMA readonly_claude IS
  'Views claude_ro reads through. See setup-claude-ro.sql for definitions.';
GRANT USAGE ON SCHEMA readonly_claude TO claude_ro;

-- 3. Staff â€” no auth secrets
CREATE VIEW readonly_claude.staff AS
  SELECT id, kind, "tenantSlug",
         email, role, "totpConfirmedAt",
         "firstName", "middleName", "lastName", gender,
         "isActive", "lastLoginAt", "tokenVersion",
         "createdAt", "updatedAt"
  FROM tenant_albazourieh.users
  WHERE kind = 'STAFF';

-- 4. Citizens â€” names only
CREATE VIEW readonly_claude.citizens AS
  SELECT id, kind,
         "firstName", "middleName", "lastName", "motherName", gender,
         "isActive",
         "createdAt", "updatedAt"
  FROM tenant_albazourieh.users
  WHERE kind = 'CITIZEN';

COMMENT ON VIEW readonly_claude.citizens IS
  'Citizen names only. No phone, address, nationality, residency or identity numbers, marital status, blood type or household size.';

-- 5. Refresh tokens â€” no hashed session key

-- 6. Audit log â€” without JSONB snapshots
CREATE VIEW readonly_claude.audit_log_entries AS
  SELECT id, "actorId", "actorType", "actorRole", "actorEmail",
         action, "entityType", "entityId",
         "ipAddress", "userAgent", "createdAt"
  FROM tenant_albazourieh.audit_log_entries;

-- 7. Officer notes stripped
CREATE VIEW readonly_claude.unit_visits AS
  SELECT id, "unitId", "officerId", "visitedAt", outcome, "createdAt"
  FROM tenant_albazourieh.unit_visits;

CREATE VIEW readonly_claude.cases AS
  SELECT id, "propertyNumber", neighborhood, "propertyType",
         "buildingName", floor, side, "landType", "tentLocation",
         status, "createdById", "createdAt", "updatedAt",
         "resolvedCitizenId", "resolvedAt", "caseType",
         "buildingId", "unitId", "damageAssessmentId"
  FROM tenant_albazourieh.cases;

-- 8. Passthroughs
CREATE VIEW readonly_claude.billing_run_entries        AS SELECT * FROM tenant_albazourieh.billing_run_entries;
CREATE VIEW readonly_claude.building_units             AS SELECT * FROM tenant_albazourieh.building_units;
CREATE VIEW readonly_claude.buildings                  AS SELECT * FROM tenant_albazourieh.buildings;
CREATE VIEW readonly_claude.citizen_payments           AS SELECT * FROM tenant_albazourieh.citizen_payments;
CREATE VIEW readonly_claude.damage_assessments         AS SELECT * FROM tenant_albazourieh.damage_assessments;
CREATE VIEW readonly_claude.data_quality_dismissals    AS SELECT * FROM tenant_albazourieh.data_quality_dismissals;
CREATE VIEW readonly_claude.fee_notices                AS SELECT * FROM tenant_albazourieh.fee_notices;
CREATE VIEW readonly_claude.inspector_payouts          AS SELECT * FROM tenant_albazourieh.inspector_payouts;
CREATE VIEW readonly_claude.parcels                    AS SELECT * FROM tenant_albazourieh.parcels;
CREATE VIEW readonly_claude.payment_transactions       AS SELECT * FROM tenant_albazourieh.payment_transactions;
CREATE VIEW readonly_claude.property_entries           AS SELECT * FROM tenant_albazourieh.property_entries;
CREATE VIEW readonly_claude.quality_checks             AS SELECT * FROM tenant_albazourieh.quality_checks;
CREATE VIEW readonly_claude.record_reviews             AS SELECT * FROM tenant_albazourieh.record_reviews;
CREATE VIEW readonly_claude.registrations              AS SELECT * FROM tenant_albazourieh.registrations;
CREATE VIEW readonly_claude.system_settings            AS SELECT * FROM tenant_albazourieh.system_settings;
CREATE VIEW readonly_claude.tenant_migrations          AS SELECT * FROM tenant_albazourieh."_tenant_migrations";
CREATE VIEW readonly_claude.unit_occupancies           AS SELECT * FROM tenant_albazourieh.unit_occupancies;
CREATE VIEW readonly_claude.unit_vacancy_confirmations AS SELECT * FROM tenant_albazourieh.unit_vacancy_confirmations;
CREATE VIEW readonly_claude.units                      AS SELECT * FROM tenant_albazourieh.units;
CREATE VIEW readonly_claude.whish_checkouts            AS SELECT * FROM tenant_albazourieh.whish_checkouts;
CREATE VIEW readonly_claude.zones                      AS SELECT * FROM tenant_albazourieh.zones;

-- 9. Grant
GRANT SELECT ON ALL TABLES IN SCHEMA readonly_claude TO claude_ro;

-- 10. Report
DO $summary$
DECLARE
  v_views int;
BEGIN
  SELECT count(*) INTO v_views
    FROM information_schema.tables
    WHERE table_schema = 'readonly_claude';
  RAISE NOTICE 'claude_ro: % views granted', v_views;
END
$summary$;

COMMIT;

-- â”€â”€â”€ KILL SWITCH â€” uncomment all four lines to remove access â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- BEGIN;
-- DROP SCHEMA IF EXISTS readonly_claude CASCADE;
-- REASSIGN OWNED BY claude_ro TO postgres;
-- DROP OWNED BY claude_ro;
-- DROP ROLE IF EXISTS claude_ro;
-- COMMIT;
