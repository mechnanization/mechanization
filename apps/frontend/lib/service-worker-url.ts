/**
 * The address the service worker is registered at (ARCH-23).
 *
 * The worker names its caches after a version, and a cache of an earlier
 * version is deleted when a new worker activates. That version was a constant
 * in `public/sw.js`, bumped by hand — so a deploy that changed every chunk's
 * name left an officer's device holding the old shell until somebody
 * remembered. It is the build's commit now, carried in the address
 * (`/sw.js?v=<sha>`) and read by the worker from its own location. A deploy is
 * a new address, so the browser installs the new worker, and the new worker
 * retires the old caches. `public/sw.js` stays a plain static file: nothing at
 * build time rewrites a tracked file.
 *
 * With no commit to name — a local build — the address is plain, and the worker
 * reads that as «unversioned».
 */
export function serviceWorkerUrl(commitSha: string | undefined): string {
  const version = commitSha?.trim().slice(0, 12);
  return version ? `/sw.js?v=${encodeURIComponent(version)}` : '/sw.js';
}
