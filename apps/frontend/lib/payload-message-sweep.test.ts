import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TXT-6: the words for an API refusal live in `messages/{ar,en}.json`.
 * `ApiRequestError.message` is already that localized text — `localizeApiError`
 * builds it in the constructor (`api-client.ts`) — so a screen that reads
 * `caught.payload.message` instead shows the server's own English log text on
 * an Arabic screen for any refusal with no translation yet (ERR-01, cleanup
 * sprint 2026-11-23). `lib/api-errors.ts` reads `payload.message` once, as
 * that function's own fallback; everywhere else it is the bug this file
 * watches for.
 *
 * Read, not rendered: the runner only collects `lib/**`.
 */
const ROOT = join(__dirname, '..');

const sources = ['app', 'components'].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
    .map((file) => `${dir}/${file.split(sep).join('/')}`),
);

describe('showing a refusal', () => {
  it('no page or component reads payload.message — error.message is already localized', () => {
    const offenders = sources.filter((file) =>
      /\.payload\??\.message\b/.test(readFileSync(join(ROOT, ...file.split('/')), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
