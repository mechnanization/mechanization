#!/usr/bin/env node
/**
 * Stop hook: code changed in an area, but none of that area's docs did.
 *
 * The mapping is not kept here. It is the "Keeping the docs true" table in the
 * root CLAUDE.md: column 2 holds backticked path globs, column 3 the docs to
 * update. Reading the table means the rule agents see and the rule this hook
 * enforces cannot drift apart. A row with no globs is guidance only.
 *
 * Contract (Claude Code Stop hook):
 *   stdin  {"stop_hook_active": bool, "cwd": "...", ...}
 *   stdout {"decision":"block","reason":"..."} to keep the agent working
 *   exit 0 and print nothing to let the stop through
 *
 * It never loops: when stop_hook_active is true the agent has already been
 * blocked once this turn, has either updated the docs or said in one line why
 * none are affected, and is let through. It fails open: no git, no CLAUDE.md,
 * no table, or any error means silence, never a blocked session.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TABLE_HEADING = /^##\s+Keeping the docs true\b/;

// Never "code": docs, tests, lockfiles, generated output.
const IGNORED = [
  '**/*.md',
  '**/*.spec.ts',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.mjs',
  '**/test/**',
  '**/__tests__/**',
  'pnpm-lock.yaml',
  '**/package-lock.json',
  'skills-lock.json',
  'graphify-out/**',
  '**/generated/**',
  '**/dist/**',
  '**/.next/**',
  '**/next-env.d.ts',
].map(globToRegExp);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{' && glob.indexOf('}', i) !== -1) {
      const end = glob.indexOf('}', i);
      const options = glob.slice(i + 1, end).split(',').map(escapeRegExp);
      re += `(?:${options.join('|')})`;
      i = end;
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Rows of the root CLAUDE.md table: { change, globs: RegExp[], docs: string[] }. */
function parseDocsTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => TABLE_HEADING.test(l));
  if (start === -1) return [];
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || /^:?-+:?$/.test(cells[0])) continue;
    const globs = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const docs = [...cells[2].matchAll(/\]\(([^)#\s]+)/g)].map((m) => m[1]);
    if (globs.length === 0 || docs.length === 0) continue;
    rows.push({ change: cells[0], globs: globs.map(globToRegExp), docs });
  }
  return rows;
}

/** Changed paths, repo-relative with forward slashes (staged, unstaged, untracked). */
function changedPaths(root) {
  const out = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return out
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3).replace(/\\/g, '/'));
}

function findGaps(rows, paths) {
  const changed = new Set(paths);
  const code = paths.filter((p) => !IGNORED.some((re) => re.test(p)));
  const gaps = [];
  for (const row of rows) {
    const hits = code.filter((p) => row.globs.some((re) => re.test(p)));
    if (hits.length === 0) continue;
    if (row.docs.some((d) => changed.has(d))) continue;
    gaps.push({ change: row.change, hits, docs: row.docs });
  }
  return gaps;
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function main() {
  const input = readStdin();
  if (input.stop_hook_active === true) return;

  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: input.cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return; // not a repository, or no git on PATH
  }

  const claudeMd = join(root, 'CLAUDE.md');
  if (!existsSync(claudeMd)) return;
  const rows = parseDocsTable(readFileSync(claudeMd, 'utf8'));
  if (rows.length === 0) return;

  const gaps = findGaps(rows, changedPaths(root));
  if (gaps.length === 0) return;

  const lines = gaps.map((g) => {
    const shown = g.hits.slice(0, 3).join(', ');
    const more = g.hits.length > 3 ? ` (+${g.hits.length - 3} more)` : '';
    return `- ${g.change}: ${shown}${more} -> check ${g.docs.join(', ')}`;
  });
  const reason = [
    'Code changed but the docs that describe it did not (CLAUDE.md, "Keeping the docs true"):',
    ...lines,
    'Update those docs and their "Last verified" line, or state in one line why none is affected.',
  ].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

try {
  main();
} catch {
  // Fail open: a broken hook must never trap a session.
}
