/**
 * The three places this codebase's schema can land, and the checks that keep
 * them apart.
 *
 * The problem this file exists to solve: `DATABASE_URL` lives in a dotenv file,
 * migrations are run by hand (`docs/deploy-vercel.md` §5), and the difference
 * between staging and production is a few characters of connection string.
 * Nothing about `pnpm tenant:migrate-all` tells you which database it is about
 * to rewrite — it reads whatever `.env` happens to say. That is one careless
 * `git stash` away from applying an untested migration to live municipal
 * records.
 *
 * So each target's identity is pinned *here*, in version control, and every
 * script that touches a database resolves its target through `resolveTarget`
 * below. A connection string that does not name the database and role pinned
 * for the target you named is a hard failure, not a warning. Editing a dotenv
 * file can no longer change which database a command hits; only naming a
 * different target can, and naming production additionally costs a typed
 * confirmation.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Both databases live in one Postgres cluster on the Lightsail box, and port
 * 5432 there is closed to the internet: every connection arrives through an SSH
 * tunnel, so from the machine running the command, *every* target is
 * `localhost`. The host therefore identifies nothing, and is deliberately not
 * pinned — a host check would pass a tunnel to production as readily as one to
 * staging.
 *
 * What does identify a target is the database name and the role, and both are
 * pinned. Two, not one, because they fail independently: the database name is
 * what a pasted URL gets wrong, and the role is what the cluster enforces —
 * `appuser_staging` holds no CONNECT on the production database, so a staging
 * file that somehow named `municipality_db` still could not open it. Neither is
 * a secret; the passwords they pair with stay in the ignored dotenv files.
 *
 * The exception is `local`, which is not behind a tunnel and so does have an
 * address worth pinning (see its entry).
 */
export const TARGETS = {
  /**
   * A developer's machine, and the database on it: the `postgres` service in
   * `docker-compose.yml`, which holds seeded, synthetic data and nothing else.
   *
   * Until 2026-09-25 this target was pinned to the staging database, so
   * `pnpm dev` read and wrote staging. That is how six migrations from
   * never-merged branches ended up applied there. Its own database and role
   * mean a laptop now reaches staging only by naming the `staging` target.
   *
   * It is also the one target whose host identifies it. It is not behind a
   * tunnel: it is a container published on loopback port 5434, and 5433 is the
   * tunnel port. So a `local` URL on any other address is refused, even one
   * carrying the right names. That covers the day someone creates
   * `appuser_local` on the Lightsail cluster to "keep the data off laptops".
   *
   * `forbid` lists the targets whose names may not appear anywhere in this
   * file, comments included (see the marker check in `resolveTarget`).
   */
  local: {
    database: 'municipality_db_local',
    user: 'appuser_local',
    hosts: ['127.0.0.1:5434', 'localhost:5434', '[::1]:5434'],
    envFile: 'apps/backend/.env',
    nodeEnv: 'development',
    label: 'local Docker database',
    forbid: ['staging', 'production'],
  },
  /**
   * The staging database on the Lightsail box. CI writes this file from the
   * `STAGING_*` secrets, and it is the only source the production deploy's
   * promotion check will read. A laptop needs it only to migrate or inspect
   * staging by hand. Delete it afterwards: while it exists, this machine can
   * migrate staging.
   */
  staging: {
    database: 'municipality_db_staging',
    user: 'appuser_staging',
    envFile: 'apps/backend/.env.staging',
    nodeEnv: 'production',
    label: 'staging',
    forbid: ['production'],
  },
  production: {
    database: 'municipality_db',
    user: 'appuser',
    envFile: 'apps/backend/.env.production',
    nodeEnv: 'production',
    label: 'PRODUCTION — live municipal records',
    forbid: [],
  },
};

/**
 * The retired Supabase projects, keyed by the environment each one served.
 * Production's still holds a full copy of the register until it is deleted, so
 * a file forbidden from naming production is refused for naming it too. A
 * guard that forgot the old address the day the data moved would have
 * forgotten it while the data was still there. Staging's is listed for the
 * same reason, one level down: the local file must not reach it either.
 */
const LEGACY_SUPABASE_REFS = {
  production: 'thbgwfbcqdougbjvgvyw',
  staging: 'lzgbjcwtzqyrbeoolvdz',
};

/** Every name that identifies `owner`: its database, its role, its retired Supabase ref. */
function markersOf(owner) {
  const target = TARGETS[owner];
  return [target.database, target.user, LEGACY_SUPABASE_REFS[owner]].filter(Boolean);
}

/**
 * Pulls the role, host and database out of a Postgres connection string.
 *
 * Parsed by hand rather than with `new URL()` on purpose: a password that is
 * still a `<PLACEHOLDER>`, or one holding a character the URL parser rejects,
 * must not make the database unreadable. Knowing *which database* a
 * half-finished file names is exactly when this check earns its keep.
 *
 * The userinfo ends at the *last* `@`, so a password containing `@` still
 * parses; the query string is dropped only after that, so a password
 * containing `?` does too.
 *
 * Returns null rather than throwing: the caller reports "not a Postgres
 * connection string" more usefully than a parse error does.
 */
export function parseConnection(connectionString) {
  if (!connectionString) return null;

  const scheme = /^postgres(?:ql)?:\/\//i.exec(connectionString.trim());
  if (!scheme) return null;

  const rest = connectionString.trim().slice(scheme[0].length);
  const at = rest.lastIndexOf('@');
  if (at === -1) return null;

  const userinfo = rest.slice(0, at);
  const location = rest.slice(at + 1).split(/[?#]/)[0];
  const slash = location.indexOf('/');
  if (slash === -1) return null;

  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const user = decode(userinfo.split(':')[0]);
  const host = location.slice(0, slash);
  const database = decode(location.slice(slash + 1));
  if (!user || !database) return null;

  return { user, host, database };
}

/**
 * The query-string parameters of a Postgres connection string, read after the
 * *last* `@` so a password containing `?` is not mistaken for the start of one.
 */
export function connectionParams(connectionString) {
  const trimmed = (connectionString ?? '').trim();
  const afterAt = trimmed.slice(trimmed.lastIndexOf('@') + 1);
  const query = afterAt.split('#')[0].split('?').slice(1).join('?');
  return new URLSearchParams(query);
}

/** Values still carrying a `<FILL-ME>` marker from the template. */
function placeholderKeys(env) {
  return Object.entries(env)
    .filter(([, value]) => /<[A-Za-z0-9_ -]+>/.test(value))
    .map(([key]) => key);
}

/** Minimal dotenv reader. Enough for KEY=value with optional quotes; no interpolation. */
export function parseEnvFile(path) {
  const out = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** `name` as a whole identifier — `municipality_db` must not match `municipality_db_staging`. */
function identifierPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

/** Which target a database name belongs to, for error messages. */
function ownerOf(database) {
  return Object.entries(TARGETS).find(([, t]) => t.database === database)?.[0] ?? 'no known target';
}

export class TargetError extends Error {}

/**
 * Loads the dotenv file for `name` and refuses to hand it back unless every
 * connection string in it names that target's database and role.
 *
 * The checks are ordered by how badly they end: wrong database first, then
 * production leaking into a non-production file anywhere at all.
 */
export function resolveTarget(name, { root = ROOT } = {}) {
  const target = TARGETS[name];
  if (!target) {
    throw new TargetError(
      `Unknown target '${name}'. Expected one of: ${Object.keys(TARGETS).join(', ')}`,
    );
  }

  const envPath = join(root, target.envFile);
  if (!existsSync(envPath)) {
    throw new TargetError(
      `No env file for '${name}' at ${target.envFile}\n` +
        `  It needs DATABASE_URL and DIRECT_URL naming ${target.user}@…/${target.database}.`,
    );
  }

  const env = parseEnvFile(envPath);
  const problems = [];
  const warnings = [];

  const CONNECTION_KEYS = ['DATABASE_URL', 'DIRECT_URL'];
  for (const key of CONNECTION_KEYS) {
    if (!env[key]) problems.push(`${key} is missing from ${target.envFile}`);
  }

  // Reported before the identity checks so an unfilled template says "fill
  // this in" rather than "this names the wrong database", which sends people
  // looking for the wrong problem.
  //
  // Only the keys that decide *which database this is* can block. An unfilled
  // CORS_ORIGINS has nothing to do with whether a migration is safe to run, and
  // a guard that refuses work for unrelated reasons is a guard people start
  // passing flags to get around. The rest are reported and let through; the
  // app's own env schema fails at boot on anything it actually needs.
  const unfilled = placeholderKeys(env);
  const blockingUnfilled = unfilled.filter((key) => CONNECTION_KEYS.includes(key));
  const otherUnfilled = unfilled.filter((key) => !CONNECTION_KEYS.includes(key));

  if (blockingUnfilled.length > 0) {
    problems.push(
      `${target.envFile} still has template placeholders in: ${blockingUnfilled.join(', ')}`,
    );
  }
  if (otherUnfilled.length > 0) {
    warnings.push(`${target.envFile} still has placeholders in: ${otherUnfilled.join(', ')}`);
  }

  // ── The check this whole file exists for ────────────────────────────────
  let host = null;
  for (const key of CONNECTION_KEYS) {
    if (!env[key]) continue;
    const found = parseConnection(env[key]);
    if (found === null) {
      problems.push(`${key} is not a Postgres connection string — no role or database found in it`);
      continue;
    }
    host ??= found.host;

    if (found.database !== target.database) {
      problems.push(
        `${key} names database '${found.database}' (${ownerOf(found.database)}), ` +
          `but target '${name}' is pinned to '${target.database}'`,
      );
    }
    if (found.user !== target.user) {
      problems.push(
        `${key} connects as '${found.user}', but target '${name}' is pinned to role '${target.user}'`,
      );
    }
    if (target.hosts && !target.hosts.includes(found.host.toLowerCase())) {
      problems.push(
        `${key} points at '${found.host}', but target '${name}' only lives at ` +
          `${target.hosts.join(' / ')} (the postgres service in docker-compose.yml)`,
      );
    }
  }

  // The pin covers the database, not the schema inside it, and two parameters
  // can move every statement somewhere else in that database. Prisma honours
  // `?schema=`: a registry migration then builds its tables in that schema,
  // and the checks above still pass, because the database name is right.
  // `options` can set `search_path` for the whole session. Proven end to end
  // against a throwaway database before this check existed.
  for (const key of CONNECTION_KEYS) {
    if (!env[key]) continue;
    const params = connectionParams(env[key]);
    const schema = params.get('schema');
    if (schema !== null && schema !== 'public') {
      problems.push(
        `${key} sets ?schema=${schema}. Migrations would run in that schema of ` +
          `${target.database} instead of public; only ?schema=public is accepted`,
      );
    }
    if (params.has('options')) {
      problems.push(`${key} sets ?options=, which can change search_path for every statement`);
    }
  }

  // A half-edited file — someone swapped DATABASE_URL but left a production
  // line or a stray comment behind — is caught here even when the two URLs
  // above happen to be right. This is the check that catches a duplicated key,
  // where the parser keeps one value and a different tool keeps the other.
  //
  // Each target names the environments it must never mention: production for
  // staging, and both for the local file, since a staging line left in
  // `apps/backend/.env` is one edit away from `pnpm dev` writing to staging.
  const raw = readFileSync(envPath, 'utf8');
  for (const owner of target.forbid) {
    for (const marker of markersOf(owner)) {
      if (identifierPattern(marker).test(raw)) {
        problems.push(
          `${target.envFile} mentions '${marker}', which belongs to ${owner}. ` +
            `Nothing outside the ${owner} target may reference it.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new TargetError(
      `Refusing to run against '${name}':\n` + problems.map((p) => `  ✗ ${p}`).join('\n'),
    );
  }

  return { name, ...target, host, envPath, env, warnings };
}
