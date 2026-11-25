// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FindingsList } from '@/components/admin/quality/findings-list';
import { ALL, NO_AREA, NO_PIN, SETTLED, SETTLE_RESULT, TWICE, UNLINKED, findings } from './quality-findings-harness';
import { BASE, PATH, TENANT, click, heldRead, openScreen, settle, type Screen } from './quality-review-harness';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  What «ملاحظات الجودة» does (PAGE-13, cleanup sprint, 2026-11-25), driven before its files are split: what it
  reads, how the address names a filter or an open finding, where each control leads, what «تم الحل», «إعادة
  فتحها» and «مراجعة حالة الوحدات» send, and what the reviewer is told in each language. The comparison is a
  screen of its own, with its own pull request: here it says what it was opened with.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({
  getFindings: vi.fn(),
  dismissFinding: vi.fn(),
  restoreFinding: vi.fn(),
  settleAllUnitStatuses: vi.fn(),
}));
vi.mock('@/lib/quality-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quality-api')>()),
  getFindings: api.getFindings,
  dismissFinding: api.dismissFinding,
  restoreFinding: api.restoreFinding,
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  settleAllUnitStatuses: api.settleAllUnitStatuses,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('next/navigation', async () => (await import('./quality-review-harness')).navigationStandIn);
const compare = vi.hoisted(() => ({
  props: null as null | {
    finding: { subjectKey: string };
    canEdit: boolean;
    canMerge: boolean;
    onBack: () => void;
    onChanged: () => void;
  },
}));
vi.mock('@/components/admin/quality/finding-compare', () => ({
  FindingCompare: (props: NonNullable<typeof compare.props>) => {
    compare.props = props;
    return `[compare:${props.finding.subjectKey}]`;
  },
}));

let screen: Screen;
type Locale = 'ar' | 'en';
const list = (locale: 'ar' | 'en' = 'en', role = 'SUPER_ADMIN'): ReactElement =>
  createElement(TooltipProvider, {
    children: createElement(FindingsList, { tenant: TENANT, base: BASE, locale, token: 'tok', role }),
  });
const refused = (message = 'server words') => new ApiRequestError(409, { code: 'NOT_A_CODE_WE_KNOW', message });
const search = () => decodeURIComponent(window.location.search);
const text = () => screen.container.textContent ?? '';
/** The dialog is drawn into the body, outside the container. */
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const table = () => screen.container.querySelector('table')!;
const row = (finding: { subjectKey: string }, index = ALL.findIndex((item) => item === finding)) =>
  table().querySelectorAll('tbody tr')[index] as HTMLElement;
const control = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLElement>('button, a')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
async function press(scope: ParentNode, label: string): Promise<void> {
  const node = control(scope, label);
  if (!node) throw new Error(`no control «${label}»`);
  await act(async () => node.click());
  await settle();
}
async function write(value: string): Promise<void> {
  const node = dialog()!.querySelector<HTMLTextAreaElement>('#resolve-reason')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const mount = (locale: Locale = 'en', role = 'SUPER_ADMIN') => screen.mount(list(locale, role), locale);
const rows = () => [...table().querySelectorAll('tbody tr')].map((node) => node.textContent ?? '');

beforeEach(() => {
  for (const spy of [...Object.values(api), ...Object.values(toast)]) spy.mockReset();
  api.getFindings.mockResolvedValue(findings());
  api.dismissFinding.mockResolvedValue({});
  api.restoreFinding.mockResolvedValue({});
  api.settleAllUnitStatuses.mockResolvedValue(SETTLE_RESULT);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  compare.props = null;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', PATH);
  screen = openScreen();
});
afterEach(() => screen.close());

describe('the queue', () => {
  it('reads the open findings and draws a row for each', async () => {
    await mount();
    expect(api.getFindings.mock.calls.at(-1)![2]).toEqual({ includeDismissed: false });
    expect(rows()).toHaveLength(4);
    expect(rows()[0]).toContain('Rima Haddad, Karim Saleh');
  });

  it('reads the resolved ones too once asked, and writes that to the address', async () => {
    await mount();
    await click(screen, 'Show resolved');
    expect(search()).toBe('?dismissed=1');
    expect(api.getFindings.mock.calls.at(-1)![2]).toEqual({ includeDismissed: true });
  });

  it('narrows to one kind in the browser, from the first page', async () => {
    window.history.replaceState(null, '', `${PATH}?page=2`);
    await mount();
    // The chips are drawn once the filter bar is open; each says the kind and how many are open.
    await press(screen.container, 'Occupied units with no area1');
    expect(search()).toBe('?kind=UNITS_WITHOUT_AREA');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Four flats have no area');
    expect(api.getFindings.mock.calls.every((call) => call[2].includeDismissed === false)).toBe(true);
    await press(screen.container, 'All4');
    expect(search()).toBe('');
    expect(rows()).toHaveLength(4);
  });

  /** Enough of one kind for a second page to survive the narrowing. */
  const many = () =>
    findings(Array.from({ length: 12 }, (_, n) => ({ ...NO_AREA, subjectKey: `flat-${n}` })));

  it.each([
    ['a kind', '', 'Occupied units with no area1'],
    ['«all»', '&kind=UNITS_WITHOUT_AREA', 'All12'],
    ['«show resolved»', '', 'Show resolved'],
  ])('goes back to the first page when %s is pressed, though a second would still exist', async (_name, query, chip) => {
    api.getFindings.mockResolvedValue(many());
    window.history.replaceState(null, '', `${PATH}?page=2${query}`);
    await mount();
    expect(search()).toContain('page=2');
    await press(screen.container, chip);
    expect(search()).not.toContain('page=');
  });

  it('leads each row to where it is put right', async () => {
    await mount();
    expect(control(row(TWICE), 'Compare')).toBeDefined();
    expect(control(row(NO_AREA), 'Open the record')!.getAttribute('href')).toBe(`${BASE}/buildings/${NO_AREA.subjectKey}/matrix`);
    expect(control(row(NO_PIN), 'Open the record')!.getAttribute('href')).toBe(`${BASE}/buildings/${NO_PIN.subjectKey}/edit`);
    expect(control(row(UNLINKED), 'Open the record')!.getAttribute('href')).toBe(`${BASE}/citizens/landlord-links`);
  });

  it('offers «resolved» only where a finding may be closed by hand', async () => {
    await mount();
    expect((control(row(TWICE), 'Resolved') as HTMLButtonElement).disabled).toBe(false);
    expect((control(row(NO_AREA), 'Resolved') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a retry when the first read fails', async () => {
    api.getFindings.mockRejectedValueOnce(refused());
    await mount();
    expect(text()).toContain('Failed to load the findings.');
    await click(screen, 'Retry');
    expect(rows()).toHaveLength(4);
  });
});

describe('a finding opened', () => {
  it('names itself in the address, shows the records and what else is open on them, and goes back', async () => {
    await mount();
    await press(row(NO_AREA), 'View details');
    expect(search()).toBe(`?finding=UNITS_WITHOUT_AREA|${NO_AREA.subjectKey}`);
    expect(screen.container.querySelector('table')).toBeNull();
    expect(text()).toContain('Other findings on the same records1');
    expect(control(screen.container, 'Edit the structure')!.getAttribute('href')).toBe(`${BASE}/buildings/${NO_AREA.subjectKey}/edit`);
    await press(screen.container, 'Open');
    expect(search()).toContain('BUILDING_WITHOUT_PIN');
    await press(screen.container, 'Back to quality findings');
    expect(search()).toBe('');
    expect(rows()).toHaveLength(4);
  });

  it('follows the address: when the browser takes it away, the list is back', async () => {
    await mount();
    await press(row(NO_AREA), 'View details');
    await act(async () => window.history.replaceState(null, '', PATH));
    await settle();
    expect(rows()).toHaveLength(4);
  });

  it('opens a finding whose key the address will not hold, and keeps it out of the address', async () => {
    api.getFindings.mockResolvedValue(findings([{ ...NO_AREA, subjectKey: 'not-a-record-id' }]));
    await mount();
    await press(table(), 'View details');
    expect(search()).toBe('');
    expect(text()).toContain('The records this is about');
  });

  it('is reopened by its address after a reload', async () => {
    window.history.replaceState(null, '', `${PATH}?finding=DUPLICATE_CITIZEN|${TWICE.subjectKey}`);
    await mount();
    expect(text()).toContain('The records this is about');
    expect(control(screen.container, 'Correct the file')!.getAttribute('href')).toBe(`${BASE}/citizens/${TWICE.subjects[0]!.id}/edit`);
  });

  it('is said to be gone when the register no longer finds it', async () => {
    window.history.replaceState(null, '', `${PATH}?finding=DUPLICATE_CITIZEN|${NO_AREA.subjectKey}`);
    await mount();
    expect(text()).toContain('This finding is no longer in the queue.');
    await press(screen.container, 'Back to quality findings');
    expect(rows()).toHaveLength(4);
  });

  it.each([
    ['SUPER_ADMIN', true, true],
    ['ADMINISTRATIVE_OFFICER', true, false],
    ['AUDITOR', false, false],
  ])('opens the comparison for %s with what that role may do', async (role, canEdit, canMerge) => {
    await mount('en', role);
    await press(row(TWICE), 'Compare');
    expect(compare.props).toMatchObject({ canEdit, canMerge });
    expect(text()).toContain(`[compare:${TWICE.subjectKey}]`);
    const reads = api.getFindings.mock.calls.length;
    await act(async () => compare.props!.onChanged());
    await settle();
    expect(api.getFindings.mock.calls.length).toBeGreaterThan(reads);
    await act(async () => compare.props!.onBack());
    await settle();
    expect(rows()).toHaveLength(4);
  });
});

describe('«تم الحل»', () => {
  it('asks why, sends the trimmed reason and closes', async () => {
    await mount();
    await press(row(TWICE), 'Resolved');
    expect(dialog()!.textContent).toContain('Mark as resolved');
    const confirm = () => control(dialog()!, 'Mark resolved') as HTMLButtonElement;
    await write('  ab ');
    expect(confirm().disabled).toBe(true);
    await write('  Two cousins ');
    await press(dialog()!, 'Mark resolved');
    expect(api.dismissFinding).toHaveBeenCalledWith(TENANT, 'tok', {
      kind: 'DUPLICATE_CITIZEN',
      subjectKey: TWICE.subjectKey,
      reason: 'Two cousins',
    });
    expect(toast.success).toHaveBeenCalledWith('Marked resolved');
    expect(dialog()).toBeNull();
  });

  it('forgets the reason when it is cancelled', async () => {
    await mount();
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    const cancels = [...dialog()!.querySelectorAll('button')].filter((node) => node.textContent?.trim() === 'Cancel');
    await act(async () => cancels.at(-1)!.click());
    await settle();
    expect(dialog()).toBeNull();
    await press(row(TWICE), 'Resolved');
    expect(dialog()!.querySelector<HTMLTextAreaElement>('#resolve-reason')!.value).toBe('');
    expect(api.dismissFinding).not.toHaveBeenCalled();
  });

  it('stays open with the server’s words when refused, and says nothing behind it', async () => {
    api.dismissFinding.mockRejectedValue(refused('Already closed'));
    await mount();
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(dialog()!.textContent).toContain('Already closed');
    expect(dialog()!.querySelector<HTMLTextAreaElement>('#resolve-reason')!.value).toBe('Two cousins');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('leaves the view of the finding it just closed', async () => {
    await mount();
    await press(row(TWICE), 'View details');
    await press(screen.container, 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(search()).toBe('');
    expect(rows()).toHaveLength(4);
  });

  it('reads the findings again', async () => {
    await mount();
    const reads = api.getFindings.mock.calls.length;
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(api.getFindings.mock.calls.length).toBeGreaterThan(reads);
  });
});

describe('«إعادة فتحها»', () => {
  beforeEach(() => api.getFindings.mockResolvedValue(findings([SETTLED])));

  it('restores a resolved finding and says so', async () => {
    await mount();
    await press(table(), 'Reopen');
    expect(api.restoreFinding).toHaveBeenCalledWith(TENANT, 'tok', { kind: SETTLED.kind, subjectKey: SETTLED.subjectKey });
    expect(toast.success).toHaveBeenCalledWith('Reopened');
  });

  it('is sent once while the first is on the wire', async () => {
    api.restoreFinding.mockImplementation(() => new Promise(() => {}));
    await mount();
    const button = control(table(), 'Reopen')!;
    await act(async () => {
      button.click();
      button.click();
    });
    await settle();
    expect(api.restoreFinding).toHaveBeenCalledTimes(1);
  });

  it('says why it was refused', async () => {
    api.restoreFinding.mockRejectedValue(refused('Not yours'));
    await mount();
    await press(table(), 'Reopen');
    expect(toast.error).toHaveBeenCalledWith('Not yours');
  });
});

describe('«مراجعة حالة الوحدات»', () => {
  it.each(['ADMINISTRATIVE_OFFICER', 'AUDITOR'])('is not offered to %s', async (role) => {
    await mount('en', role);
    expect(control(screen.container, 'Review unit statuses')).toBeUndefined();
  });

  it('runs once, is off while it runs, then reads the findings again', async () => {
    let finish: (value: unknown) => void = () => {};
    api.settleAllUnitStatuses.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await mount();
    const button = control(screen.container, 'Review unit statuses') as HTMLButtonElement;
    await act(async () => {
      button.click();
      button.click();
    });
    await settle();
    expect(api.settleAllUnitStatuses).toHaveBeenCalledTimes(1);
    expect((control(screen.container, 'Reviewing…') as HTMLButtonElement).disabled).toBe(true);
    const reads = api.getFindings.mock.calls.length;
    await act(async () => finish(SETTLE_RESULT));
    await settle();
    expect(api.getFindings.mock.calls.length).toBeGreaterThan(reads);
  });
});

describe('the words after a press, in each language', () => {
  it.each([
    [
      'en',
      'Review unit statuses',
      '40 flats checked — 3 statuses corrected, 2 review cases opened, 1 closed. 5 still under review.',
      'The review could not run.',
    ],
    [
      'ar',
      'مراجعة حالة الوحدات',
      'فُحصت 40 وحدة — صُحِّحت حالة 3، وفُتحت 2 حالة مراجعة وأُغلقت 1. ما زالت 5 وحدة قيد المراجعة.',
      'تعذّر تشغيل المراجعة.',
    ],
  ])('the unit review (%s)', async (locale, button, done, failed) => {
    await mount(locale as Locale);
    await press(screen.container, button);
    expect(toast.success).toHaveBeenCalledWith(done);
    api.settleAllUnitStatuses.mockRejectedValueOnce(new Error('network'));
    await press(screen.container, button);
    expect(toast.error).toHaveBeenCalledWith(failed);
  });

  it.each([
    ['en', 'Resolved', 'Mark resolved', 'Marked resolved', 'Not saved.'],
    ['ar', 'تم الحل', 'تم الحل', 'عُلِّمت «تم الحل»', 'لم يُحفظ.'],
  ])('resolving (%s)', async (locale, open, confirm, done, failed) => {
    api.dismissFinding.mockRejectedValueOnce('not an error object');
    await mount(locale as Locale);
    await press(row(TWICE), open);
    await write('Two cousins');
    await press(dialog()!, confirm);
    expect(dialog()!.textContent).toContain(failed);
    await press(dialog()!, confirm);
    expect(toast.success).toHaveBeenCalledWith(done);
  });

  it.each([
    ['en', 'Reopen', 'Reopened', 'Not saved.'],
    ['ar', 'إعادة فتحها', 'أُعيد فتح الملاحظة', 'لم يُحفظ.'],
  ])('reopening (%s)', async (locale, button, done, failed) => {
    api.getFindings.mockResolvedValue(findings([SETTLED]));
    await mount(locale as Locale);
    await press(table(), button);
    expect(toast.success).toHaveBeenCalledWith(done);
    api.restoreFinding.mockRejectedValueOnce(new Error('network'));
    await press(table(), button);
    expect(toast.error).toHaveBeenCalledWith(failed);
  });
});

describe('a write on one finding leaves the others alone (STA-3)', () => {
  const both = [TWICE, { ...NO_PIN, dismissal: SETTLED.dismissal }];

  /** Lets a test answer a write when it chooses to. */
  function held(spy: ReturnType<typeof vi.fn>) {
    let answer: (value: unknown) => void = () => {};
    spy.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    return () => act(async () => answer({}));
  }

  it('resolves one while another is being reopened, instead of closing the dialog with nothing sent', async () => {
    api.getFindings.mockResolvedValue(findings(both));
    held(api.restoreFinding);
    await mount();
    await press(row(NO_PIN, 1), 'Reopen');
    expect((control(row(NO_PIN, 1), 'Reopen') as HTMLButtonElement).disabled).toBe(true);
    expect((control(row(TWICE, 0), 'Resolved') as HTMLButtonElement).disabled).toBe(false);
    await press(row(TWICE, 0), 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(api.dismissFinding).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Marked resolved');
  });

  it('resolves once however fast the dialog is confirmed, and keeps it open until the answer', async () => {
    const answer = held(api.dismissFinding);
    await mount();
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    const confirm = control(dialog()!, 'Mark resolved')!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(api.dismissFinding).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
    await answer();
    await settle();
    expect(dialog()).toBeNull();
  });

  it('closes the dialog on the answer, and holds the finding until the list is read again', async () => {
    await mount();
    let read: (value: unknown) => void = () => {};
    api.getFindings.mockImplementationOnce(() => {
      const waiting = heldRead();
      read = waiting.answer;
      return waiting.promise;
    });
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(dialog()).toBeNull();
    expect((control(row(TWICE), 'Resolved') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => read(findings()));
    await settle();
    expect((control(row(TWICE), 'Resolved') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets a refused reopen be tried again', async () => {
    api.getFindings.mockResolvedValue(findings([SETTLED]));
    api.restoreFinding.mockRejectedValueOnce(refused());
    await mount();
    await press(table(), 'Reopen');
    await press(table(), 'Reopen');
    expect(api.restoreFinding).toHaveBeenCalledTimes(2);
  });

  it('runs the unit review again once the last one ended', async () => {
    api.settleAllUnitStatuses.mockRejectedValueOnce(refused());
    await mount();
    await press(screen.container, 'Review unit statuses');
    await press(screen.container, 'Review unit statuses');
    await press(screen.container, 'Review unit statuses');
    expect(api.settleAllUnitStatuses).toHaveBeenCalledTimes(3);
  });

  it('holds a finding in its detail view too', async () => {
    api.getFindings.mockResolvedValue(findings([SETTLED]));
    held(api.restoreFinding);
    await mount();
    await press(table(), 'View details');
    await press(screen.container, 'Reopen');
    expect((control(screen.container, 'Reopen') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what a write marks stale', () => {
  const staled = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey.join('/')).sort();

  it('every page of findings and the officers’ figures, after one is resolved', async () => {
    await mount();
    const stale = vi.spyOn(screen.client, 'invalidateQueries');
    await press(row(TWICE), 'Resolved');
    await write('Two cousins');
    await press(dialog()!, 'Mark resolved');
    expect(staled(stale)).toEqual(['quality-findings/t1', 'quality-officers/t1']);
  });

  it('the buildings and the cases too, after the unit review', async () => {
    await mount();
    const stale = vi.spyOn(screen.client, 'invalidateQueries');
    await press(screen.container, 'Review unit statuses');
    expect(staled(stale)).toEqual(['buildings/t1', 'cases/t1', 'quality-findings/t1', 'quality-officers/t1']);
  });

  it('the review queue as well, after a correction made in the comparison', async () => {
    await mount();
    await press(row(TWICE), 'Compare');
    const stale = vi.spyOn(screen.client, 'invalidateQueries');
    await act(async () => compare.props!.onChanged());
    await settle();
    expect(staled(stale)).toEqual(['quality-findings/t1', 'quality-officers/t1', 'quality-reviews/t1']);
  });

  it('nothing, when the write was refused', async () => {
    api.settleAllUnitStatuses.mockRejectedValueOnce(refused());
    await mount();
    const stale = vi.spyOn(screen.client, 'invalidateQueries');
    await press(screen.container, 'Review unit statuses');
    expect(stale).not.toHaveBeenCalled();
  });
});

describe('a failed re-read keeps what is on screen (STA-1)', () => {
  const failNextRead = async () => {
    api.getFindings.mockRejectedValueOnce(refused());
    await act(async () => {
      await screen.client.invalidateQueries({ queryKey: ['quality-findings', TENANT] });
    });
    await settle();
  };

  it.each([
    ['en', en.common.refreshFailed, en.common.retry, 'Could not load the findings.'],
    ['ar', ar.common.refreshFailed, ar.common.retry, 'تعذّر تحميل ملاحظات الجودة.'],
  ])('the list (%s)', async (locale, title, retry, message) => {
    await mount(locale as Locale);
    await failNextRead();
    expect(rows()).toHaveLength(4);
    expect(text()).toContain(title);
    expect(text()).toContain(message);
    await press(screen.container, retry);
    expect(text()).not.toContain(title);
  });

  it('an open finding', async () => {
    await mount();
    await press(row(NO_AREA), 'View details');
    await failNextRead();
    expect(text()).toContain('The records this is about');
    expect(text()).toContain(en.common.refreshFailed);
  });

  it('an open comparison', async () => {
    await mount();
    await press(row(TWICE), 'Compare');
    await failNextRead();
    expect(text()).toContain(`[compare:${TWICE.subjectKey}]`);
    expect(text()).toContain(en.common.refreshFailed);
  });

  it('a half-written reason', async () => {
    await mount();
    await press(row(TWICE), 'Resolved');
    await write('Half written');
    await failNextRead();
    expect(dialog()!.querySelector<HTMLTextAreaElement>('#resolve-reason')!.value).toBe('Half written');
  });
});

describe('officers’ names are joined with the page’s comma', () => {
  it.each([
    ['en', 'Rima Haddad, Karim Saleh', 'View details'],
    ['ar', 'Rima Haddad، Karim Saleh', 'عرض التفاصيل'],
  ])('%s', async (locale, names, open) => {
    await mount(locale as Locale);
    expect(rows()[0]).toContain(names);
    await press(row(TWICE), open);
    expect(text()).toContain(names);
  });
});
