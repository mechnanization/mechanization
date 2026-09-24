#!/usr/bin/env node
/**
 * Validates dotenv files against the pinned database identities. Touches no network.
 *
 *   node scripts/db/check.mjs            every target whose env file exists
 *   node scripts/db/check.mjs local      one target; missing file is an error
 *
 * `pnpm dev` runs the `local` form before starting anything, which is the point:
 * the moment someone pastes a production connection string into
 * `apps/backend/.env` — to read one row, to reproduce one bug — the dev server
 * stops booting instead of quietly attaching the whole application to live data.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, resolveTarget, TargetError } from './targets.mjs';

const green = (s) => `\x1b[92m${s}\x1b[0m`;
const red = (s) => `\x1b[91m${s}\x1b[0m`;
const yellow = (s) => `\x1b[93m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const requested = process.argv[2];
const names = requested ? [requested] : Object.keys(TARGETS);

let failed = false;
let checked = 0;

for (const name of names) {
  const target = TARGETS[name];
  if (!target) {
    console.error(red(`✗ Unknown target '${name}'`));
    failed = true;
    continue;
  }

  // Without an explicit request, a missing file is simply a target this machine
  // does not have — the normal state for production on a laptop.
  if (!requested && !existsSync(join(ROOT, target.envFile))) {
    console.log(dim(`· ${name.padEnd(11)} ${target.envFile} — not present, skipped`));
    continue;
  }

  try {
    const resolved = resolveTarget(name);
    console.log(green(`✓ ${name.padEnd(11)}`) + `${resolved.envFile} → ${resolved.user}@${resolved.host}/${resolved.database}`);
    for (const warning of resolved.warnings) console.log(yellow(`  ! ${warning}`));
    checked += 1;
  } catch (error) {
    failed = true;
    console.error(red(`✗ ${name.padEnd(11)}`) + (error instanceof TargetError ? error.message : error));
  }
}

if (failed) process.exit(1);
if (checked === 0 && !requested) console.log(dim('No env files to check.'));
