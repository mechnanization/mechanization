/**
 * The guard is the only thing standing between a mistyped command and live
 * municipal records, so it gets tests. Run with:
 *
 *   pnpm db:test        (node --test scripts/db/)
 *
 * Every case writes a dotenv file into a scratch directory and asserts that
 * `resolveTarget` either accepts it or refuses with the right reason. Nothing
 * here touches a network or the repository's own env files.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, TARGETS, resolveTarget, parseConnection } from './targets.mjs';

const LOCAL = TARGETS.local;
const STAGING = TARGETS.staging;
const PROD = TARGETS.production;

/**
 * A connection string for `target`: the Docker port for `local`, the usual SSH
 * tunnel for the others.
 */
function urlFor(target, { password = 'pw123', host = target.hosts?.[0] ?? 'localhost:5433' } = {}) {
  return `postgresql://${target.user}:${password}@${host}/${target.database}`;
}

/** A complete, valid env file for `target`. Individual tests corrupt one line. */
function envFor(target) {
  return [
    'NODE_ENV=production',
    `DATABASE_URL="${urlFor(target)}"`,
    `DIRECT_URL="${urlFor(target)}"`,
    '',
  ].join('\n');
}

/** Writes `body` to the env file `target` expects, inside a throwaway root. */
function withEnv(targetName, body, fn) {
  const root = mkdtempSync(join(tmpdir(), 'mech-guard-'));
  const rel = TARGETS[targetName].envFile;
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Returns the refusal message, or null if the guard allowed it through. */
function refusalFor(targetName, body) {
  return withEnv(targetName, body, (root) => {
    try {
      resolveTarget(targetName, { root });
      return null;
    } catch (error) {
      return error.message;
    }
  });
}

describe('parseConnection', () => {
  test('reads role, host and database from a tunnelled URL', () => {
    assert.deepEqual(parseConnection('postgresql://appuser_staging:pw@localhost:5433/municipality_db_staging'), {
      user: 'appuser_staging',
      host: 'localhost:5433',
      database: 'municipality_db_staging',
    });
  });

  test('still reads the database when the password is an unfilled placeholder', () => {
    // The case that matters most: a half-finished file must not become
    // *unidentifiable*, or the guard silently stops guarding.
    assert.equal(parseConnection('postgresql://appuser:<PASSWORD>@localhost:5433/municipality_db')?.database, 'municipality_db');
  });

  test('survives a password holding @, ? and $', () => {
    const found = parseConnection('postgresql://appuser:p@ss?w$rd@13.39.160.240:5432/municipality_db?sslmode=require');
    assert.equal(found?.user, 'appuser');
    assert.equal(found?.database, 'municipality_db');
  });

  test('drops the query string from the database name', () => {
    assert.equal(parseConnection('postgresql://ci:ci@localhost:5432/ci?schema=public')?.database, 'ci');
  });

  test('returns null for something that is not a Postgres URL', () => {
    assert.equal(parseConnection('https://lzgbjcwtzqyrbeoolvdz.supabase.co'), null);
    assert.equal(parseConnection(''), null);
  });
});

describe('resolveTarget refuses', () => {
  test('a local env file pointed at the production database', () => {
    const message = refusalFor('local', envFor(PROD));
    assert.match(message ?? '', /names database 'municipality_db' \(production\)/);
  });

  test('a production env file pointed at staging', () => {
    const message = refusalFor('production', envFor(STAGING));
    assert.match(message ?? '', /names database 'municipality_db_staging' \(staging\)/);
  });

  test('a local env file pointed at the staging database', () => {
    // What `apps/backend/.env` held until 2026-09-25, when `local` was pinned
    // to staging. It must now stop `pnpm dev` instead of attaching it there.
    const message = refusalFor('local', envFor(STAGING));
    assert.match(message ?? '', /names database 'municipality_db_staging' \(staging\)/);
    assert.match(message ?? '', /connects as 'appuser_staging'/);
  });

  test('the right database reached with the production role', () => {
    // The database name is what a pasted URL gets wrong; the role is what the
    // cluster enforces. A staging URL carrying production's role has lost the
    // second of the two walls, so it is refused on its own.
    const body = envFor(STAGING).replaceAll(`//${STAGING.user}:`, `//${PROD.user}:`);
    assert.match(refusalFor('staging', body) ?? '', /connects as 'appuser'/);
  });

  test('a duplicated DATABASE_URL whose later line is production', () => {
    // What `apps/backend/.env` actually held on 2026-09-23: a staging block,
    // then a production block further down. dotenv keeps the *last* value, so
    // the dev server was attached to production while the top of the file
    // read "staging".
    const body = `${envFor(LOCAL)}DATABASE_URL="${urlFor(PROD)}"\nDIRECT_URL="${urlFor(PROD)}"\n`;
    assert.ok(refusalFor('local', body), 'expected a refusal');
  });

  test('a staging file that mentions the production database anywhere, comments included', () => {
    const message = refusalFor('staging', `${envFor(STAGING)}# was ${urlFor(PROD)}\n`);
    assert.match(message ?? '', /mentions 'municipality_db', which belongs to production/);
  });

  test('a local file that mentions the staging database anywhere, comments included', () => {
    // A staging line left behind as a comment is one uncomment away from
    // `pnpm dev` writing to staging again.
    const message = refusalFor('local', `${envFor(LOCAL)}# was ${urlFor(STAGING)}\n`);
    assert.match(message ?? '', /mentions 'municipality_db_staging', which belongs to staging/);
    assert.match(message ?? '', /mentions 'appuser_staging', which belongs to staging/);
  });

  test('a staging file that still names the retired Supabase production project', () => {
    // It holds a full copy of the register until it is deleted.
    const message = refusalFor('staging', `${envFor(STAGING)}SUPABASE_URL="https://thbgwfbcqdougbjvgvyw.supabase.co"\n`);
    assert.match(message ?? '', /thbgwfbcqdougbjvgvyw/);
  });

  test('a local file that names either retired Supabase project', () => {
    for (const ref of ['thbgwfbcqdougbjvgvyw', 'lzgbjcwtzqyrbeoolvdz']) {
      const message = refusalFor('local', `${envFor(LOCAL)}SUPABASE_URL="https://${ref}.supabase.co"\n`);
      assert.match(message ?? '', new RegExp(`mentions '${ref}'`));
    }
  });

  test('a Supabase connection string, which is no target any more', () => {
    const body = envFor(STAGING).replace(
      urlFor(STAGING),
      'postgresql://postgres.lzgbjcwtzqyrbeoolvdz:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    );
    assert.match(refusalFor('staging', body) ?? '', /names database 'postgres'/);
  });

  test('a local URL on any address but the Docker port, even with the right names', () => {
    // 5433 is the SSH tunnel to the Lightsail cluster; 5432 is whatever
    // Postgres the machine itself runs. The names alone would pass the day
    // someone creates `appuser_local` over there.
    for (const host of ['localhost:5433', 'localhost:5432', '13.37.53.105:5432', 'localhost']) {
      const message = refusalFor('local', envFor(LOCAL).replaceAll(LOCAL.hosts[0], host));
      assert.match(message ?? '', new RegExp(`points at '${host.replace(/[.[\]]/g, '\\$&')}'`));
    }
  });

  test('an unfilled template in a connection string', () => {
    const message = refusalFor('staging', envFor(STAGING).replaceAll('pw123', '<PASSWORD>'));
    assert.match(message ?? '', /template placeholders/);
  });

  test('but NOT an unfilled placeholder in an unrelated variable', () => {
    // A guard that blocks a migration over CORS_ORIGINS is a guard people start
    // passing --force to. It warns instead; the app's env schema catches this
    // one at boot, where it actually matters.
    const body = `${envFor(STAGING)}CORS_ORIGINS="<STAGING-WEB-ORIGIN>"\n`;
    assert.equal(refusalFor('staging', body), null);

    const warnings = withEnv('staging', body, (root) => resolveTarget('staging', { root }).warnings);
    assert.match(warnings.join(' '), /CORS_ORIGINS/);
  });

  test('a missing connection string', () => {
    const body = envFor(STAGING).replace(/^DIRECT_URL=.*$/m, '');
    assert.match(refusalFor('staging', body) ?? '', /DIRECT_URL is missing/);
  });

  test('a missing env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mech-guard-'));
    try {
      assert.throws(() => resolveTarget('staging', { root }), /No env file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown target name', () => {
    assert.throws(() => resolveTarget('prod'), /Unknown target/);
  });
});

describe('resolveTarget refuses a URL that moves statements to another schema', () => {
  const withQuery = (target, query) =>
    envFor(target).replaceAll(`/${target.database}"`, `/${target.database}?${query}"`);

  test('?schema= naming anything but public', () => {
    const message = refusalFor('production', withQuery(PROD, 'schema=decoy'));
    assert.match(message, /DATABASE_URL sets \?schema=decoy/);
    assert.match(message, /DIRECT_URL sets \?schema=decoy/);
  });

  test('?options=, which can set search_path', () => {
    assert.match(
      refusalFor('staging', withQuery(STAGING, 'options=-c%20search_path%3Ddecoy')),
      /sets \?options=/,
    );
  });

  test('but NOT ?schema=public, nor ordinary parameters', () => {
    assert.equal(refusalFor('production', withQuery(PROD, 'schema=public')), null);
    assert.equal(refusalFor('staging', withQuery(STAGING, 'sslmode=require&connect_timeout=10')), null);
  });

  test('and is not fooled by a ? inside the password', () => {
    const body = envFor(PROD).replaceAll('appuser:pw123@', 'appuser:p%3Fschema=x@');
    assert.equal(refusalFor('production', body), null);
  });
});

describe('resolveTarget accepts', () => {
  test('a correct staging file', () => {
    assert.equal(refusalFor('staging', envFor(STAGING)), null);
  });

  test('a correct production file', () => {
    assert.equal(refusalFor('production', envFor(PROD)), null);
  });

  test('a correct local file, which points at the Docker database', () => {
    assert.equal(refusalFor('local', envFor(LOCAL)), null);
  });

  test('a local file on every loopback spelling of the Docker port', () => {
    for (const host of LOCAL.hosts) {
      assert.equal(refusalFor('local', envFor(LOCAL).replaceAll(LOCAL.hosts[0], host)), null, host);
    }
  });

  test('any host for staging — through a tunnel every target is localhost, so host proves nothing', () => {
    const body = envFor(STAGING).replaceAll('localhost:5433', '13.39.160.240:5432');
    assert.equal(refusalFor('staging', body), null);
  });

  test('a password containing $, which the dotenv reader must not expand', () => {
    const body = envFor(LOCAL).replaceAll('pw123', 'q1w2$e3');
    assert.equal(refusalFor('local', body), null);
  });
});

describe('the pinned identities', () => {
  test('local, staging and production are three different databases and three different roles', () => {
    // A copy-paste slip here would disable every check above at once.
    const all = [LOCAL, STAGING, PROD];
    assert.equal(new Set(all.map((t) => t.database)).size, 3);
    assert.equal(new Set(all.map((t) => t.user)).size, 3);
  });

  test('local lives on loopback only', () => {
    for (const host of LOCAL.hosts) {
      assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):5434$/);
    }
  });

  test('the local file may name neither staging nor production; staging may not name production', () => {
    assert.deepEqual([...LOCAL.forbid].sort(), ['production', 'staging']);
    assert.deepEqual(STAGING.forbid, ['production']);
  });
});

describe('the production deploy', () => {
  // deploy.mjs runs on import, so this reads its source instead. A tripwire,
  // not a proof: it fails if the promotion check ever goes back to accepting
  // the local file, which is how a laptop's own database could vouch for
  // migrations staging has never run.
  test('reads staging, and never the local target, to vouch for production', () => {
    const source = readFileSync(join(ROOT, 'scripts/db/deploy.mjs'), 'utf8');
    assert.match(source, /resolveTarget\('staging'\)/);
    assert.doesNotMatch(source, /['"]local['"]/);
  });
});
