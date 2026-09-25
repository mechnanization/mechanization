-- The local development database: the `postgres` service in docker-compose.yml.
--
-- Runs once, when the service's volume is first created (the image runs every
-- file in /docker-entrypoint-initdb.d against an empty data directory, and
-- never again). To run it again: `docker compose down -v`, then `up`. That
-- deletes the local database, which holds seeded data and nothing else.
--
-- The application role owns its database but is not a superuser, the same
-- shape as `appuser` on the Lightsail box. The tenant migrator needs CREATE on
-- the database (CREATE SCHEMA, pgcrypto) and ownership of `public` (Prisma's
-- registry migration). On Postgres 15+ the database owner has both. A
-- superuser here would hide exactly the privilege errors a first run on
-- Lightsail hits. CREATEDB is only for the shadow database that
-- `prisma migrate dev` builds when a registry migration is authored.
--
-- The password matches the local .env in docs/database-environments.md §0.1.
-- It is not a secret: the port is published on 127.0.0.1 only, and the data
-- is synthetic.

CREATE ROLE appuser_local LOGIN PASSWORD 'localdev' CREATEDB;
CREATE DATABASE municipality_db_local OWNER appuser_local;
