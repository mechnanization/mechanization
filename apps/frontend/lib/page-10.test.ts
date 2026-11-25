// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CaseSummary } from '@/lib/api-client';
import { updateCase } from '@/lib/api-client';
import { CaseQueueTabs } from '@/components/admin/cases/case-queue-tabs';
import { CASE_TABS } from '@/components/admin/cases/case-queues';
import { CaseUnlinkDialog } from '@/components/admin/cases/case-link-dialogs';
import { useCaseColumns } from '@/components/admin/cases/use-case-columns';
import { useCaseLinking } from '@/components/admin/cases/use-case-linking';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  PAGE-10 (cleanup sprint, 2026-11-25): the field-work pages against the page contract. The cases screens
  were the group's gap: their table, actions, queue tabs and link flow wrote about sixty strings inline,
  «تحديث» aside nothing guarded a status change but React state, and a failed re-read replaced the rows
  with an error. The strings are in messages now, and this renders them in both languages. What stays open
  is the list's server paging, which waits for the cases route's missing filters (PAG-03, Hashem).
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch() {} }),
  usePathname: () => '/t/ar/a/cases',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  updateCase: vi.fn(async () => ({})),
}));

const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const CASES_PAGE = 'app/[tenant]/[locale]/[adminPath]/(protected)/cases/page.tsx';

const item = (patch: Partial<CaseSummary> = {}): CaseSummary =>
  ({
    id: 'c1',
    notes: 'nobody home',
    status: 'OPEN',
    caseType: 'UNIT_UNREACHABLE',
    propertyNumber: '1234',
    buildingId: null,
    unitId: null,
    buildingCode: null,
    unitCode: null,
    unitStatus: null,
    unitOccupants: [],
    resolvedCitizenId: null,
    resolvedCitizenName: null,
    scheduledRevisitAt: null,
    ...patch,
  }) as unknown as CaseSummary;

let container: HTMLDivElement;
let root: Root;

async function mount(locale: 'ar' | 'en', element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: (locale === 'en' ? en : ar) as never,
        children: createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ToastProvider, null, createElement(TooltipProvider, null, element)),
        ),
      }),
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(updateCase).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/** The table's columns, drawn: their headers and one row's action cell. */
function Columns({ locale, row, canDelete }: { locale: string; row: CaseSummary; canDelete: boolean }): ReactElement {
  const columns = useCaseColumns({
    locale,
    base: '/t/ar/a',
    busyId: null,
    canWrite: true,
    canDelete,
    advanceStatus: vi.fn(async () => {}),
    openLink: vi.fn(),
    setMatrix: vi.fn(),
    setPendingDelete: vi.fn(),
  });
  const last = columns[columns.length - 1]!;
  const cell = (last.cell as (context: unknown) => ReactElement)({ row: { original: row } });
  const statusColumn = columns.find((column) => (column as { accessorKey?: string }).accessorKey === 'status')!;
  const status = (statusColumn.cell as (context: unknown) => ReactElement)({ row: { original: row } });
  return createElement(
    'div',
    null,
    createElement('ul', { 'data-headers': true }, columns.map((column) => (typeof column.header === 'string' ? createElement('li', { key: column.header }, column.header) : null))),
    createElement('div', { 'data-status': true }, status),
    createElement('div', { 'data-actions': true }, cell),
  );
}
const headers = () => [...container.querySelectorAll('[data-headers] li')].map((node) => node.textContent);
const actionLabels = () =>
  [...container.querySelectorAll('[data-actions] [aria-label]')].map((node) => node.getAttribute('aria-label'));

describe('the table speaks the page’s language (contract item 7)', () => {
  it.each([
    ['en', ['What happened', 'Property ID', 'Status', 'Logged By', 'Date', 'Actions']],
    ['ar', ['ماذا حصل', 'رقم العقار', 'الحالة', 'سجّلها', 'التاريخ', 'إجراء']],
  ] as const)('headers in %s', async (locale, expected) => {
    await mount(locale, createElement(Columns, { locale, row: item(), canDelete: false }));
    expect(headers()).toEqual(expect.arrayContaining([...expected]));
  });

  it.each([
    ['en', ['Register Citizen', 'Link to Citizen', 'Advance status', 'Open the unit matrix', 'Edit', 'Delete']],
    ['ar', ['تسجيل المواطن', 'ربط بمواطن', 'تقديم حالة المعاملة', 'فتح مصفوفة الوحدات', 'تعديل', 'حذف']],
  ] as const)('an open case on a censused unit offers its actions in %s', async (locale, expected) => {
    await mount(locale, createElement(Columns, { locale, row: item({ buildingId: 'b1', unitId: 'u1' }), canDelete: true }));
    expect(actionLabels()).toEqual([...expected]);
  });

  it('offers a manager no delete, and a resolved case no «register»', async () => {
    await mount('en', createElement(Columns, { locale: 'en', row: item({ status: 'RESOLVED' }), canDelete: false }));
    expect(actionLabels()).toEqual(['Link to Citizen', 'Advance status', 'Edit']);
  });

  it('closes «register» when somebody already lives on the unit, and says who, in both languages', async () => {
    const occupied = item({
      unitId: 'u1',
      unitOccupants: [{ citizenId: 'x', name: 'Rima', role: 'TENANT' }],
    });
    await mount('en', createElement(Columns, { locale: 'en', row: occupied, canDelete: false }));
    expect(actionLabels()[0]).toMatch(/^Someone already lives on this unit, registered: Rima \(.+\) — link the case to them instead\.$/);
    await mount('ar', createElement(Columns, { locale: 'ar', row: occupied, canDelete: false }));
    expect(actionLabels()[0]).toMatch(/^الوحدة مسكونة ومسجَّلة: Rima \(.+\) — اربط الحالة به بدلاً من تسجيل مواطن جديد\.$/);
  });

  it.each([
    ['en', /^Revisit \d{2}\/\d{2}\/2026$/],
    ['ar', /^العودة \d{2}\/\d{2}\/2026$/],
  ] as const)('writes a scheduled revisit with its date in the sentence, in %s', async (locale, sentence) => {
    await mount(locale, createElement(Columns, { locale, row: item({ status: 'SCHEDULED', scheduledRevisitAt: '2026-12-03T10:00:00.000Z' }), canDelete: false }));
    const note = [...container.querySelectorAll('[data-status] p')].map((node) => node.textContent?.trim());
    expect(note).toHaveLength(1);
    expect(note[0]).toMatch(sentence);
  });
});

describe('the queue tabs (contract item 7)', () => {
  const COUNTS = { all: 9, revisit: 4, disputes: 3, notes: 2 };
  const tabs = () => [...container.querySelectorAll('[role="tab"]')].map((node) => node.textContent);

  it.each([
    ['en', ['All9', 'Revisit4', 'Refusals & disputes3', 'Notes2']],
    ['ar', ['الكل9', 'إعادة زيارة4', 'رفض ونزاعات3', 'ملاحظات2']],
  ] as const)('are named from messages, in %s, with their counts', async (locale, expected) => {
    await mount(
      locale,
      createElement(CaseQueueTabs, { locale, tab: 'all', counts: COUNTS, onSelect: vi.fn(), children: null }),
    );
    expect(tabs()).toEqual([...expected]);
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(locale === 'en' ? 'Case queues' : 'قوائم الحالات');
  });

  it('every queue has a name in both languages, and the definitions carry no words of their own', () => {
    for (const entry of CASE_TABS) {
      expect(en.cases.queues[entry.id]).toBeTruthy();
      expect(ar.cases.queues[entry.id]).toBeTruthy();
      expect(entry).not.toHaveProperty('ar');
      expect(entry).not.toHaveProperty('en');
    }
  });
});

describe('the unlink confirmation (contract item 7)', () => {
  const pending = item({
    status: 'RESOLVED',
    resolvedCitizenId: 'r1',
    resolvedCitizenName: 'Rima',
    buildingId: 'b1',
    unitId: 'u1',
    buildingCode: 'B1',
    unitCode: 'A1',
    unitOccupants: [{ citizenId: 'x', name: 'Samir', role: 'TENANT' }],
  });
  const linkage = { pendingUnlink: pending, setPendingUnlink: vi.fn(), unlinkCitizen: vi.fn(async () => {}) } as never;

  it('says it in English, naming the citizen, the unit and who stays on it', async () => {
    await mount('en', createElement(CaseUnlinkDialog, { linkage, locale: 'en', onOpenUnit: vi.fn() }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Unlink this case?');
    expect(text).toContain('The case will no longer name Rima.');
    expect(text).toContain('It stays marked resolved');
    expect(text).toContain('Unlinking does not take anyone off unit B1 · A1. Recorded on it now: Samir (');
    expect(text).toContain('Keep the link');
    expect(text).toContain('Open the unit');
  });

  it('and in Arabic', async () => {
    await mount('ar', createElement(CaseUnlinkDialog, { linkage, locale: 'ar', onOpenUnit: vi.fn() }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('إلغاء ربط الحالة؟');
    expect(text).toContain('لن تبقى الحالة باسم Rima.');
    expect(text).toContain('إلغاء الربط لا يُخرج أحداً من الوحدة B1 · A1.');
    expect(text).toContain('إبقاء الربط');
    expect(text).toContain('فتح الوحدة');
  });

  it('names “a citizen” when the case holds no name, and says so about a unit with nobody on it', async () => {
    const bare = { ...pending, resolvedCitizenName: null, status: 'OPEN', unitOccupants: [] } as unknown as CaseSummary;
    await mount('en', createElement(CaseUnlinkDialog, { linkage: { ...(linkage as object), pendingUnlink: bare } as never, locale: 'en', onOpenUnit: vi.fn() }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('The case will no longer name a citizen.');
    expect(text).not.toContain('It stays marked resolved');
    expect(text).toContain('Unlinking does not change who is recorded on unit B1 · A1.');
  });
});

describe('the unlink write’s words (contract items 6 and 7)', () => {
  let api: ReturnType<typeof useCaseLinking> | undefined;
  function Linker({ locale, token }: { locale: string; token: string | null }): null {
    api = useCaseLinking({ tenant: 't', token, locale, load: async () => {} });
    return null;
  }
  const caught = async (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => '',
      (error: Error) => error.message,
    );

  it.each([
    ['en', 'Your session has ended.'],
    ['ar', 'انتهت الجلسة.'],
  ] as const)('refuses without a session, in %s', async (locale, words) => {
    await mount(locale, createElement(Linker, { locale, token: null }));
    expect(await caught(api!.unlinkCitizen(item()))).toBe(words);
    expect(updateCase).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'Link removed', 'Nobody was taken off the unit.'],
    ['ar', 'أُزيل الربط', 'لم يُخرَج أحد من الوحدة.'],
  ] as const)('says «removed» in %s, and that nobody left the unit', async (locale, title, body) => {
    await mount(locale, createElement(Linker, { locale, token: 'tok' }));
    await act(async () => {
      await api!.unlinkCitizen(item({ unitId: 'u1', buildingCode: 'B1', unitCode: 'A1', resolvedCitizenId: 'r1' }));
    });
    expect(updateCase).toHaveBeenCalledWith('t', 'tok', 'c1', { resolvedCitizenId: null });
    expect(document.body.textContent).toContain(title);
    expect(document.body.textContent).toContain(body);
  });

  it('turns a second press away while the first is in flight, in words', async () => {
    let release: () => void = () => {};
    vi.mocked(updateCase).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({} as never); }));
    await mount('en', createElement(Linker, { locale: 'en', token: 'tok' }));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = api!.unlinkCitizen(item());
    });
    expect(await caught(api!.unlinkCitizen(item()))).toBe('Another change to this case is still being saved.');
    await act(async () => {
      release();
      await first;
    });
    expect(updateCase).toHaveBeenCalledTimes(1);
  });
});

describe('the page (contract items 3 and 6)', () => {
  const page = read(CASES_PAGE);

  it('lets one status change or delete run at a time, the ref set before the state', () => {
    expect(page).toMatch(/const writing = useRef\(false\);/);
    expect(page).toMatch(/if \(!token \|\| writing\.current\) return;\s*\n\s*writing\.current = true;[\s\S]*?setBusyId\(item\.id\)/);
    expect(page).toMatch(/if \(writing\.current\) throw new Error\(tLinking\('stillSaving'\)\);\s*\n\s*writing\.current = true;\s*\n\s*setBusyId\(item\.id\)/);
    expect((page.match(/writing\.current = false;/g) ?? []).length).toBe(2);
  });

  it('keeps the rows on a failed re-read and says so; the error takes the table only while nothing has loaded', () => {
    expect(page).toMatch(/const view = readView\(query\.data, query\.error\);/);
    expect(page).toMatch(/view\.state === 'ready' && view\.refreshFailed \? \(\s*<RefreshFailedAlert message=\{view\.refreshFailed\} onRetry=\{query\.refetch\} \/>/);
    expect(page).toMatch(/error=\{view\.state === 'failed' \? view\.error : null\}/);
    expect(page).not.toMatch(/error=\{query\.error\}/);
  });

  it('is still the unpaged list: server paging waits for PAG-03', () => {
    // Pinned so that the day the route has its filters, this test is the one that is rewritten.
    expect(page).toMatch(/getCases\(tenant, accessToken, \{\}, signal\)/);
  });
});

describe('no inline copy is left in the cases files', () => {
  it.each([
    'components/admin/cases/use-case-columns.tsx',
    'components/admin/cases/case-link-dialogs.tsx',
    'components/admin/cases/use-case-linking.ts',
    'components/admin/cases/case-queue-tabs.tsx',
    'components/admin/cases/case-queues.ts',
  ])('%s', (file) => {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
    // A word in either language, not `dir={en ? 'ltr' : 'rtl'}`.
    expect(code).not.toMatch(/\b(?:en|isAr)\s*\?\s*['`"](?!ltr'|rtl')/);
    expect(code).not.toMatch(/locale === 'en'\s*\?\s*['`"(]\s*(?!en'|ar')/);
  });
});
