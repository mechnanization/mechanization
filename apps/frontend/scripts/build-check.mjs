#!/usr/bin/env node
/**
 * A production build that cannot disturb a running dev server.
 *
 * `next build` and `next dev` share `.next`. Running the build to verify a
 * change while `pnpm dev` is up rewrites the chunks that server is serving, and
 * the dev server then fails at *runtime* on files that no longer exist:
 *
 *   Error: Cannot find module './vendor-chunks/zod@3.25.76.js'
 *   Require stack: … .next/server/webpack-runtime.js
 *
 * — a 500 on every request to a page whose source is fine, alongside 404s for
 * hot-update chunks and "Fast Refresh had to perform a full reload". Nothing
 * about it points at the real cause, and it survives until the dev server is
 * killed and restarted.
 *
 * So verification builds get their own `distDir`. `next.config.mjs` reads
 * `NEXT_DIST_DIR`; this script sets it and shells out, which is all `cross-env`
 * would have done without adding a dependency for one variable.
 *
 * `pnpm --filter @mechanization/frontend build` is unchanged and still writes
 * `.next` — that is what Vercel and `next start` expect.
 *
 * ## The one file the build writes back into the source tree
 *
 * `next build` rewrites the tracked `next-env.d.ts` to reference
 * `<distDir>/types/routes.d.ts`. With a `distDir` of our own that leaves the
 * repository dirty, pointing every editor and `tsc` at a directory that only
 * a verification build produces — which is the same class of confusion this
 * script exists to avoid, arriving through the type checker instead of the
 * dev server. So it is put back exactly as it was.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next-check';
const ENV_TYPES = fileURLToPath(new URL('../next-env.d.ts', import.meta.url));
const before = existsSync(ENV_TYPES) ? readFileSync(ENV_TYPES, 'utf8') : null;

const result = spawnSync('next', ['build'], {
  stdio: 'inherit',
  // `shell: true` so Windows resolves `next` through `next.cmd` in
  // `node_modules/.bin` the same way the POSIX shells do.
  shell: true,
  env: { ...process.env, NEXT_DIST_DIR: DIST_DIR },
});

// Restored whether the build passed or failed: a failed verification must not
// leave the tree worse than it found it either.
if (before !== null && readFileSync(ENV_TYPES, 'utf8') !== before) {
  writeFileSync(ENV_TYPES, before);
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
