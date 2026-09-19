#!/usr/bin/env node
// Starts Docker (if needed), then Redis, then the backend, then — only once
// the backend is actually accepting requests — the frontend. Sequential on
// purpose: the frontend's first render fetches from the API, so starting it
// alongside the backend just means its first few requests fail while the
// backend is still compiling.
//
// Nest/Next print hundreds of lines of routine startup noise (route mapping,
// dependency init, pnpm banners). We filter both processes' output down to
// one "running on" line per service, and let real errors/warnings through
// unfiltered so problems are never hidden.
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DOCKER_DESKTOP_PATH = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const BACKEND_URL = 'http://localhost:4000/api/v1';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const GREEN = '\x1b[92m';
const BLUE = '\x1b[94m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

/** e.g. statusLine('docker', 'running on', 'Docker Desktop') */
function statusLine(label, verb, value) {
  return `${GREEN}> ${label.padEnd(9)} ${verb}${RESET} ${BLUE}${value}${RESET}`;
}

function colorize(line, color) {
  return `${color}${line}${RESET}`;
}

function cleanupStaleProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const currentPid = process.pid;
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4000, 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.ProcessId -ne ${currentPid} -and ($_.CommandLine -like '*@mechanization*' -or $_.CommandLine -like '*presentation*main*' -or $_.CommandLine -like '*nest*' -or $_.CommandLine -like '*apps*backend*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
      { stdio: 'ignore', timeout: 10_000 },
    );
  } catch {
    // Ignore cleanup errors
  }
}

// Clean up any stale background processes from prior aborted runs that might hold file locks on Prisma engine DLLs
cleanupStaleProcesses();

// Verify local environment configuration before starting processes
try {
  execSync('node scripts/db/check.mjs local', { stdio: 'inherit' });
} catch {
  process.exit(1);
}

// Ensure shared packages are built before apps start
try {
  execSync('pnpm --filter "./packages/*" build', { stdio: 'ignore' });
  execSync('pnpm --filter "./packages/*" build', { stdio: 'ignore', timeout: 60_000 });
} catch {
  // Continue even if package build fails; dev watch will surface issues
}

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    execSync('docker info', { stdio: 'ignore', timeout: 2_500 });
    return true;
  } catch {
    return false;
  }
}

async function ensureDockerRunning() {
// Redis is a cache, not a dependency — without it the app falls through to
// Postgres. So probe once, bounded, and move on: never launch Docker Desktop,
// never wait for it. Waiting cost 90s of dead time on every start for a
// service the app does not need in order to run. Start Docker yourself if you
// want the cache; SKIP_DOCKER=1 skips even the probe.
function ensureDockerRunning() {
  if (process.env.SKIP_DOCKER === '1') {
    console.warn(colorize('! SKIP_DOCKER=1 — skipping redis, app will fall through to Postgres', YELLOW));
    return false;
  }

  if (dockerAvailable()) {
    console.log(statusLine('docker', 'running on', 'Docker Desktop'));
    return true;
  }

  if (process.platform !== 'win32' || !existsSync(DOCKER_DESKTOP_PATH)) {
    console.warn(colorize('! docker not running — skipping redis, app will fall through to Postgres', YELLOW));
    return false;
  }

  spawn(DOCKER_DESKTOP_PATH, { detached: true, stdio: 'ignore' }).unref();

  const timeoutMs = 90_000;
  const intervalMs = 3_000;
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (dockerAvailable()) {
      console.log(statusLine('docker', 'running on', 'Docker Desktop'));
      return true;
    }
  }

  console.warn(colorize('! docker took too long to start — skipping redis, app will fall through to Postgres', YELLOW));
  console.warn(
    colorize(
      '! docker not running or unresponsive — skipping redis, app will fall through to Postgres',
      YELLOW,
    ),
  );
  return false;
}

if (await ensureDockerRunning()) {
if (ensureDockerRunning()) {
  try {
    execSync('docker compose up -d redis', { stdio: 'ignore' });
    // Bounded for the same reason the probe is: a half-wedged engine can
    // accept the connection and then never answer.
    execSync('docker compose up -d redis', { stdio: 'ignore', timeout: 30_000 });
    console.log(statusLine('redis', 'running on', 'redis://localhost:6379'));
  } catch {
    console.warn(colorize('! failed to start redis — continuing without cache (falls through to Postgres)', YELLOW));
  }
}

// Once a genuine ERROR/failure line matches, keep printing the lines right
// after it unfiltered too — that's where the actual stack trace lives, and
// dropping it (as this filter used to) means a real failure looks identical
// to silence. A routine WARN does NOT open this window: it prints itself and
// nothing else, so one warning at boot doesn't let the whole noisy dependency
// dump through behind it.
let errorTailLinesRemaining = 0;
const ERROR_TAIL_LINES = 30;
const ERROR_PATTERN = /\bERROR\b|Error:|error TS\d+:|EADDRINUSE|EPERM|Cannot find module|Failed to compile|Failed to start/i;
const ERROR_PATTERN =
  /\bERROR\b|Error:|error TS\d+:|EADDRINUSE|EPERM|Cannot find module|Failed to compile|Failed to start|Invalid environment configuration/i;
const WARN_PATTERN = /\bWARN\b/;
const RESTART_TRIGGER_PATTERN = /Starting compilation in watch mode|File change detected|Starting incremental compilation/;
const COMPILE_RESULT_PATTERN = /Found (\d+) errors?\. Watching for file changes\./;

let backendBootedOnce = false;
let frontendLocalShown = false;
let frontendNetworkShown = false;

// Default-deny: only our own "running on" lines and genuine problems get
// through. Everything else (dependency graphs, route tables, pnpm banners)
// is routine noise and is dropped.
function handleLine(rawLine) {
  const line = rawLine.replace(ANSI_RE, '').trim();

  if (errorTailLinesRemaining > 0) {
    errorTailLinesRemaining -= 1;
    if (!line) return; // blank line ends the trace early
    console.log(colorize(line, RED));
    return;
  }

  if (!line) return;

  // Nodemon-style feedback for the backend: every save that recompiles gets a
  // "restarting" line, and — since Nest silently keeps the last *working*
  // build running if the new one fails to compile — a save with a type error
  // gets a clear line saying so, rather than an editor looking like it did
  // nothing.
  if (RESTART_TRIGGER_PATTERN.test(line)) {
    if (backendBootedOnce) {
      console.log(colorize('> backend   restarting (files changed)...', YELLOW));
    }
    return;
  }
  const compileResult = line.match(COMPILE_RESULT_PATTERN);
  if (compileResult) {
    const errorCount = Number(compileResult[1]);
    if (errorCount > 0) {
      console.log(
        colorize(
          `> backend   ${errorCount} compile error(s) — still running the last working build`,
          RED,
        ),
      );
    }
    return;
  }

  if (/API listening on/.test(line)) {
    backendBootedOnce = true;
    console.log(statusLine('backend', 'running on', BACKEND_URL));
    return;
  }
  const localMatch = !frontendLocalShown && line.match(/-\s*Local:\s*(\S+)/);
  if (localMatch) {
    frontendLocalShown = true;
    const base = localMatch[1];
    console.log(statusLine('frontend', 'running on', `${base} (local)`));
    // Matches the seeded albazourieh tenant (seed.ts) — dev convenience only.
    console.log(statusLine('admin', 'login page at', `${base}/albazourieh/ar/admin-portal-a91f/login`));
    console.log(statusLine('citizens', 'page at', `${base}/albazourieh/ar/admin-portal-a91f/citizens/{id}`));
    return;
  }
  const networkMatch = !frontendNetworkShown && line.match(/-\s*Network:\s*(\S+)/);
  if (networkMatch) {
    frontendNetworkShown = true;
    console.log(statusLine('frontend', 'running on', `${networkMatch[1]} (network)`));
    return;
  }
  if (ERROR_PATTERN.test(line)) {
    console.log(colorize(line, RED));
    errorTailLinesRemaining = ERROR_TAIL_LINES;
    return;
  }
  if (WARN_PATTERN.test(line)) {
    console.log(colorize(line, YELLOW));
  }
}

function pipeLines(stream) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
}

function runDevProcess(filterName) {
  const child = spawn(`pnpm --filter ${filterName} dev`, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true,
  });
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  return child;
}

/**
 * A process dying is never allowed to just end the script silently — that's
 * exactly what happened when a backend crash (EPERM from a stale file lock,
 * in practice) didn't match the error filter: nothing printed, and `pnpm
 * start` just returned to the prompt with no indication anything had gone
 * wrong at all.
 */
function watchProcess(name, child, becameReady) {
  child.on('error', (err) => {
    console.log(colorize(`> ${name}   failed to start: ${err.message}`, RED));
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (!becameReady()) {
      console.log(
        colorize(
          `> ${name}   exited before it finished starting (code ${code}, signal ${signal}) — see the error above, or a stale process from an earlier run may still be holding a file lock`,
          RED,
        ),
      );
    }
    process.exit(code ?? 1);
  });
}

function killChildTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Process already terminated
  }
}

const backend = runDevProcess('@mechanization/backend');
watchProcess('backend', backend, () => backendBootedOnce);

let frontend;

process.on('SIGINT', () => {
  killChildTree(backend);
  if (frontend) killChildTree(frontend);
  process.exit(0);
});

process.on('SIGTERM', () => {
  killChildTree(backend);
  if (frontend) killChildTree(frontend);
  process.exit(0);
});

// Frontend's first render fetches from the API — start it only once the
// backend is actually listening, rather than racing it and eating a burst of
// ECONNREFUSED on every dev-server restart.
await new Promise((resolve) => {
  const check = setInterval(() => {
    if (backendBootedOnce) {
      clearInterval(check);
      resolve();
    }
  }, 200);
});

frontend = runDevProcess('@mechanization/frontend');
watchProcess('frontend', frontend, () => frontendLocalShown);
