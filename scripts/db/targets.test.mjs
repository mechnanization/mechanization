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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TARGETS, resolveTarget, parseConnection } from './targets.mjs';

const STAGING = TARGETS.staging;
const PROD = TARGETS.production;

/** A connection string for `target` through the usual SSH tunnel. */
function urlFor(target, { password = 'pw123', host = 'localhost:5433' } = {}) {
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

  test('the right database reached with the production role', () => {
    // The database name is what a pasted URL gets wrong; the role is what the
    // cluster enforces. A staging URL carrying production's role has lost the
    // second of the two walls, so it is refused on its own.
    const body = envFor(STAGING).replaceAll(`//${STAGING.user}:`, `//${PROD.user}:`);
    assert.match(refusalFor('local', body) ?? '', /connects as 'appuser'/);
  });

  test('a duplicated DATABASE_URL whose later line is production', () => {
    // What `apps/backend/.env` actually held on 2026-09-23: a staging block,
    // then a production block further down. dotenv keeps the *last* value, so
    // the dev server was attached to production while the top of the file
    // read "staging".
    const body = `${envFor(STAGING)}DATABASE_URL="${urlFor(PROD)}"\nDIRECT_URL="${urlFor(PROD)}"\n`;
    assert.ok(refusalFor('local', body), 'expected a refusal');
  });

  test('a staging file that mentions the production database anywhere, comments included', () => {
    const message = refusalFor('staging', `${envFor(STAGING)}# was ${urlFor(PROD)}\n`);
    assert.match(message ?? '', /mentions 'municipality_db', which belongs to production/);
  });

  test('a staging file that still names the retired Supabase production project', () => {
    // It holds a full copy of the register until it is deleted.
    const message = refusalFor('local', `${envFor(STAGING)}SUPABASE_URL="https://thbgwfbcqdougbjvgvyw.supabase.co"\n`);
    assert.match(message ?? '', /thbgwfbcqdougbjvgvyw/);
  });

  test('a Supabase connection string, which is no target any more', () => {
    const body = envFor(STAGING).replace(
      urlFor(STAGING),
      'postgresql://postgres.lzgbjcwtzqyrbeoolvdz:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    );
    assert.match(refusalFor('local', body) ?? '', /names database 'postgres'/);
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

describe('resolveTarget accepts', () => {
  test('a correct staging file', () => {
    assert.equal(refusalFor('staging', envFor(STAGING)), null);
  });

  test('a correct production file', () => {
    assert.equal(refusalFor('production', envFor(PROD)), null);
  });

  test('a correct local file, which points at the staging database', () => {
    assert.equal(refusalFor('local', envFor(STAGING)), null);
  });

  test('any host — through a tunnel every target is localhost, so host proves nothing', () => {
    const body = envFor(STAGING).replaceAll('localhost:5433', '13.39.160.240:5432');
    assert.equal(refusalFor('local', body), null);
  });

  test('a password containing $, which the dotenv reader must not expand', () => {
    const body = envFor(STAGING).replaceAll('pw123', 'q1w2$e3');
    assert.equal(refusalFor('local', body), null);
  });
});

describe('the pinned identities', () => {
  test('staging and production are different databases and different roles', () => {
    // A copy-paste slip here would disable every check above at once.
    assert.notEqual(STAGING.database, PROD.database);
    assert.notEqual(STAGING.user, PROD.user);
  });

  test('local shares the staging database, never production', () => {
    assert.equal(TARGETS.local.database, STAGING.database);
    assert.equal(TARGETS.local.user, STAGING.user);
    assert.notEqual(TARGETS.local.database, PROD.database);
  });
});
