/**
 * The two browser globals the modules under test read at module scope.
 *
 * `navigator.onLine` is the important one, and it is a genuine trap rather than
 * boilerplate. Node has provided a global `navigator` since v21 — but it is a
 * `Navigator` with `userAgent`, `platform` and little else, and **no `onLine`**.
 * So `typeof navigator === 'undefined'` is false while `navigator.onLine` is
 * `undefined`, and every guard in `offline-sync.ts` shaped like
 *
 *     if (typeof navigator !== 'undefined' && !navigator.onLine) break;
 *
 * reads as "the device is offline" and stops the drain before it sends
 * anything. Left unset, the queue tests would pass a completely inert function
 * and prove nothing — the failure mode this whole file exists to prevent.
 *
 * Defined with `configurable: true` so individual tests can flip it to exercise
 * the offline path, which `offline-sync.test.ts` does.
 */
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  writable: true,
  configurable: true,
});

/**
 * A minimal `window` with working listener registration.
 *
 * Only the hooks in `offline-sync.ts` attach listeners, and the hooks are not
 * under test here — but `window` is referenced at the top level of enough of
 * `lib/` that its absence turns an assertion failure into an unrelated
 * `ReferenceError`, which is a worse test failure than the one it replaces.
 */
Object.defineProperty(globalThis, 'window', {
  value: {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
  writable: true,
  configurable: true,
});
