import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic in `lib/`.
 *
 * Scoped to `lib/**` deliberately. The modules there are the ones that decide
 * things — what a receipt says in words, whether a failed delivery is retried
 * or parked, what is redacted before an error leaves the browser — and they are
 * decidable without a DOM. What a component does once it runs (an effect, a
 * click) is a different kind of test with a different dependency, so it opts in
 * file by file with `// @vitest-environment jsdom` (`lib/*-dom.test.ts`,
 * 2026-11-24) and every other file stays on `node`.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    /**
     * `node`, not `jsdom`.
     *
     * Nothing under test touches the DOM: `offline-sync.ts` reads
     * `navigator.onLine` and registers `window` listeners, but only from inside
     * its hooks, and the hooks are not what these tests exercise. `setup.ts`
     * supplies the two globals that are read at module scope. Avoiding `jsdom`
     * keeps the suite at a run time where people will actually run it, and
     * avoids a dependency whose `navigator` would then be the thing under test.
     */
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Each file gets a fresh module registry, which matters here: the offline
    // queue keeps one engine per tenant in module scope, so leaking it between
    // files would make the order tests run in significant.
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
