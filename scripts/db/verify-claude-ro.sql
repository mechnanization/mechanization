-- Run as the claude_ro role, over the tunnel, from the laptop:
--   psql "host=localhost port=5439 dbname=municipality_db user=claude_ro" \
--        -v ON_ERROR_STOP=0 -f verify-claude-ro.sql
-- Each block prints one of PASS / FAIL / (error text). Any FAIL means stop.

\echo '── 1. Server identity ────────────────────────────────────────────'
SELECT current_user, current_database(), inet_server_addr()::text AS server;

\echo '── 2. Reads work: last activity should be today ─────────────────'
SELECT (SELECT max("submittedAt") FROM readonly_claude.registrations) AS last_reg,
       (SELECT count(*) FROM readonly_claude.staff)                   AS staff_rows,
       (SELECT count(*) FROM readonly_claude.citizens)                AS citizen_rows,
       (SELECT count(*) FROM readonly_claude.inspector_payouts)       AS payouts;

\echo '── 3. Auth secrets must NOT be readable ─────────────────────────'
-- These should each fail with "permission denied for table users"
SELECT "passwordHash" FROM tenant_albazourieh.users LIMIT 1;
SELECT "totpSecret"   FROM tenant_albazourieh.users LIMIT 1;

\echo '── 4. Hidden tables must NOT be readable ────────────────────────'
SELECT count(*) FROM tenant_albazourieh.documents;
SELECT count(*) FROM tenant_albazourieh.otp_challenges;

\echo '── 5. Writes must fail with "permission denied" ─────────────────'
CREATE TABLE readonly_claude.gotcha (x int);
INSERT INTO readonly_claude.citizens ("firstName") VALUES ('Injected');
DELETE FROM readonly_claude.staff;
SET default_transaction_read_only = off;
UPDATE readonly_claude.citizens SET "firstName" = 'x';
