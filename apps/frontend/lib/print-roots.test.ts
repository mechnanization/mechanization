import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-12 (cleanup sprint, 2026-11-25): one print mechanism. The treasury's printed documents (the transfer
  paper, the income and expense vouchers, the daily cash report) and the arrears sheet hid the page by
  `visibility`, lifted their own root to the top with `position: absolute` and mounted a stylesheet each
  (`documentPrintCss`), beside `data-print-root` in `globals.css`, which the account statement, the request
  paper and the bulk receipt use. Two mechanisms for one kind of page, and the first leaves the hidden shell
  in the flow, which is how a document gets a blank trailing sheet. Now every printed document is a
  `data-print-root` and the page size is named once, in `globals.css`.

  Read, not rendered: the runner collects `lib/**` only, and printing is a browser's.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: comments name what they replaced. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/** Every printed document, and whether it is the landscape one. */
const DOCUMENTS: ReadonlyArray<readonly [string, boolean]> = [
  ['components/admin/finance/transfer-document.tsx', false],
  ['components/admin/finance/voucher-documents.tsx', false],
  ['components/admin/finance/daily-cash-report.tsx', true],
  ['components/admin/arrears/arrears-batch-sheet.tsx', false],
  ['components/admin/finance/account-statement-view.tsx', false],
  ['components/admin/requests/request-document.tsx', false],
  ['components/admin/bulk-settle/bulk-payment-receipt.tsx', false],
];

describe('every printed document is a print root', () => {
  it.each(DOCUMENTS)('%s has exactly one data-print-root', (file, landscape) => {
    const code = withoutComments(read(file));
    expect(code.match(/\bdata-print-root\b/g)).toHaveLength(1);
    expect(/data-print-page="landscape"/.test(code)).toBe(landscape);
  });

  it('none mounts a stylesheet of its own', () => {
    for (const [file] of DOCUMENTS) expect(withoutComments(read(file)), file).not.toMatch(/<style\b/);
  });
});

describe('the per-document mechanism is gone', () => {
  it('no source names documentPrintCss or builds a print sheet by an id', () => {
    const offenders = ['app', 'components', 'lib']
      .flatMap((dir) => sourcesUnder(join(FRONTEND, dir)))
      .filter((file) => /documentPrintCss|PRINT_CSS/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(FRONTEND, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('the shared helpers that remain are the letterhead, the signature block and the auto-print', () => {
    const source = read('components/admin/finance/official-document.tsx');
    expect(source).not.toMatch(/export function documentPrintCss/);
    expect(source).toMatch(/export function useAutoPrint/);
  });
});

describe('globals.css names the sheets, once', () => {
  const css = read('app/globals.css');

  it('portrait is `register`, landscape `register-landscape`, chosen by the root’s attribute', () => {
    expect(css).toMatch(/@page register \{\s*size: A4 portrait;/);
    expect(css).toMatch(/\[data-print-root\]\[data-print-page='landscape'\] \{\s*page: register-landscape;/);
    expect(css).toMatch(/@page register-landscape \{\s*size: A4 landscape;/);
  });

  it('prints on a light colour scheme, so a dark theme does not paint the margins dark', () => {
    expect(css).toMatch(/html:has\(\[data-print-root\]\) \{\s*color-scheme: light !important;/);
  });

  it('keeps a section whole across a sheet, as the documents asked for', () => {
    expect(css).toMatch(/\[data-print-root\] tr,\s*\[data-print-root\] section \{\s*break-inside: avoid;/);
  });
});
