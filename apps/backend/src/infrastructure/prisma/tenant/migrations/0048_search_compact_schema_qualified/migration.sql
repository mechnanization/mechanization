-- Make `search_compact` resolvable without a search_path, so a dump restores.
--
-- == What was wrong =========================================================
--
-- `0018` created both search functions unqualified, which is correct for this
-- migrator — it runs each file under `SET LOCAL search_path TO "<schema>"` so
-- that one file builds every municipality. But `search_compact`'s *body* also
-- calls `search_normalize` unqualified, and a function body is resolved when it
-- runs, against whatever search_path the caller happens to have. In the live
-- application that is always the tenant schema, so nothing ever failed.
--
-- `pg_restore` is the caller that does not have it. pg_dump writes
-- `SELECT pg_catalog.set_config('search_path', '', false)` into every archive,
-- so at restore time the search_path is empty. Creating `citizen_payments` —
-- whose `searchText` is `GENERATED ALWAYS AS (... search_compact(...)) STORED`
-- — makes Postgres inline the function to check it, the inlined body names
-- `search_normalize` with nothing to resolve it against, and the restore stops:
--
--     pg_restore: error: could not execute query:
--     ERROR:  function search_normalize(text) does not exist
--     CONTEXT:  SQL function "search_compact" during inlining
--
-- The consequence is the one that matters: **the production database could not
-- be restored from its own backup.** Not a slow restore or a partial one — the
-- archive stopped at the first table carrying a generated search column, with
-- the register's rows still in the file and no way to get them out except by
-- hand-patching the SQL. It was found by a restore rehearsal, which is the only
-- thing that could have found it; every dump taken before this point has it.
--
-- == The fix ================================================================
--
-- Qualify the inner call with the schema the function is being created in.
-- `current_schema()` is that schema, because the migrator has already set the
-- search_path to it — so this stays one file for every municipality, and each
-- copy of the function names its own sibling explicitly.
--
-- `CREATE OR REPLACE` rather than DROP + CREATE: the generated columns on
-- `users`, `citizen_payments` and the rest depend on this function, and dropping
-- it is refused while they do. Replacing a body in place is allowed, and it is
-- the only route that does not require rebuilding every generated column.
--
-- The normalisation itself is unchanged — same `replace`, same argument, same
-- result for every input. Stored `searchText` values are therefore still
-- correct and are deliberately not recomputed: this is a one-line change of
-- *where a name is looked up*, not of what the function computes.
DO $migration$
DECLARE
  -- Quoted here rather than interpolated raw. The migrator already refuses any
  -- schema not matching `^tenant_[a-z0-9_]{1,50}$`, so this is belt and braces
  -- — but a DDL string built by concatenation is worth making boring.
  schema_ident text := quote_ident(current_schema());
BEGIN
  EXECUTE format(
    $body$
      CREATE OR REPLACE FUNCTION %s.search_compact(input text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      AS $fn$
        SELECT replace(%s.search_normalize(input), ' ', '');
      $fn$
    $body$,
    schema_ident,
    schema_ident
  );
END
$migration$;
