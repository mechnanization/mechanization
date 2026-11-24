#!/usr/bin/env node
/*
  `pnpm lint:unused`: unused files, exports, types and dependencies in every
  workspace (knip, configured in knip.jsonc), held to a baseline (DEAD-18).

  What was already unused on 2026-11-24 is listed in scripts/knip-baseline.json
  and passes; anything else fails, so dead code cannot come back unnoticed.
  The baseline only shrinks as DEAD-14…16 delete what it lists:

    pnpm lint:unused             fail on a finding that is not in the baseline
    pnpm lint:unused --update    write today's findings as the baseline

  An entry is a file, an issue type and a name, never a line number, so moving
  code does not invalidate it. An entry no longer found is reported and does
  not fail the run; `--update` drops it.
*/
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// knip matches files to workspaces by path prefix. On Windows a working
// directory spelled `c:\…` while the resolver answers `C:\…` makes every import
// of @mechanization/shared-schemas look external, and all its exports unused.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const BASELINE = join(ROOT, 'scripts', 'knip-baseline.json');
const KNIP = join(ROOT, 'node_modules', 'knip', 'bin', 'knip.js');

const WORKSPACES = ['apps/backend', 'apps/frontend', 'packages/shared-schemas'];
const workspaceOf = (file) => WORKSPACES.find((ws) => file.startsWith(`${ws}/`)) ?? '.';

/** `{ file: { type: [name, …] } }`, every level sorted, from knip's JSON report. */
function findings() {
  const run = spawnSync(process.execPath, [KNIP, '--no-progress', '--no-config-hints', '--reporter', 'json', '--no-exit-code'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout);
    console.error('\nknip itself failed (exit %s): fix the run or knip.jsonc first.', run.status);
    process.exit(2);
  }
  const out = {};
  for (const row of JSON.parse(run.stdout).issues) {
    for (const [type, list] of Object.entries(row)) {
      if (!Array.isArray(list) || list.length === 0 || type === 'owners') continue;
      // `duplicates` and `cycles` are groups of symbols; the rest are one each.
      const names = list.map((item) => (Array.isArray(item) ? item.map((s) => s.name).join(' = ') : item.name));
      ((out[row.file] ??= {})[type] ??= []).push(...names);
    }
  }
  return sortDeep(out);
}

function sortDeep(byFile) {
  const sorted = {};
  for (const file of Object.keys(byFile).sort()) {
    sorted[file] = {};
    for (const type of Object.keys(byFile[file]).sort()) sorted[file][type] = [...new Set(byFile[file][type])].sort();
  }
  return sorted;
}

const flatten = (byFile) => {
  const keys = new Set();
  for (const [file, types] of Object.entries(byFile)) {
    for (const [type, names] of Object.entries(types)) for (const name of names) keys.add(`${type}\t${file}\t${name}`);
  }
  return keys;
};

function summary(keys) {
  const table = {};
  for (const key of keys) {
    const [type, file] = key.split('\t');
    const row = (table[workspaceOf(file)] ??= {});
    row[type] = (row[type] ?? 0) + 1;
  }
  return table;
}

function readBaseline() {
  try {
    const { findings: byFile } = JSON.parse(readFileSync(BASELINE, 'utf8'));
    return byFile ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

const current = findings();
const now = flatten(current);
const before = flatten(readBaseline());

if (process.argv.includes('--update')) {
  const added = [...now].filter((key) => !before.has(key)).length;
  const dropped = [...before].filter((key) => !now.has(key)).length;
  const body = {
    $comment:
      'Unused code knip found before DEAD-18 (2026-11-24), allowed until DEAD-14…16 delete it. Written by `pnpm lint:unused --update`; never add to it by hand.',
    findings: current,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
  console.log('Baseline written: %d entries (%d added, %d dropped).', now.size, added, dropped);
  console.table(summary(now));
  process.exit(0);
}

const fresh = [...now].filter((key) => !before.has(key)).sort();
const gone = [...before].filter((key) => !now.has(key)).sort();

console.log('Unused, per workspace (baseline included):');
console.table(summary(now));

if (gone.length > 0) {
  console.log('\n%d baseline entries are no longer found. Run `pnpm lint:unused --update` to drop them:', gone.length);
  for (const key of gone) console.log('  - %s', key.replaceAll('\t', '  '));
}

if (fresh.length > 0) {
  console.error('\n%d new unused finding(s), not in scripts/knip-baseline.json:', fresh.length);
  for (const key of fresh) console.error('  + %s', key.replaceAll('\t', '  '));
  console.error(
    '\nDelete the unused code (or drop `export` from what only its own file uses). If knip is wrong, teach it in knip.jsonc, with the reason, rather than adding to the baseline.',
  );
  process.exit(1);
}

console.log('\nNo new unused code.');
