// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { ReviewQueue } from '@/components/admin/quality/review-queue';
import { ChecksPanel } from '@/components/admin/quality/checks-panel';
import { picks } from './transfer-form-harness';
import {
  APPROVED,
  ASSIGNED_CHECK,
  BASE,
  CHANGED,
  CORRECTED,
  FULL,
  OFFICERS,
  PATH,
  RETURNED,
  TENANT,
  UNASSIGNED_CHECK,
  buttons,
  click,
  openScreen,
  openTab,
  queue,
  settle,
  type,
  type Screen,
} from './quality-review-harness';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  What «اعتماد السجلات» and «عيّنة التحقق» do (PAGE-13, cleanup sprint, 2026-11-25), driven before the queue
  is split: what they read, what each press sends, what the reviewer is told in each language, and what is left
  on screen after it. The words of the toasts are asserted in both languages because no page snapshot holds
  them, and the next step moves them to messages. The real query cache runs; the API is stood in for.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({
  getReviewQueue: vi.fn(),
  approveRecord: vi.fn(),
  returnRecord: vi.fn(),
  getQualityChecks: vi.fn(),
  drawQualitySample: vi.fn(),
  assignQualityCheck: vi.fn(),
  completeQualityCheck: vi.fn(),
}));
vi.mock('@/lib/quality-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quality-api')>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('next/navigation', async () => (await import('./quality-review-harness')).navigationStandIn);
vi.mock('@/components/ui/select', async () => (await import('./transfer-form-harness')).selectStandIn);
vi.mock('@/components/ui/date-picker', async () => (await import('./transfer-form-harness')).datePickerStandIn);
/** The gaps dialog is a screen of its own: here it says whom it was opened for, and saves when told to. */
const dialog = vi.hoisted(() => ({ props: null as null | { citizenId: string; citizenName: string; onSaved: () => void; onOpenChange: (open: boolean) => void } }));
vi.mock('@/components/admin/complete-record-dialog', () => ({
  CompleteRecordDialog: (props: NonNullable<typeof dialog.props>) => {
    dialog.props = props;
    return `[gaps:${props.citizenId}]`;
  },
}));

let screen: Screen;
type Locale = 'ar' | 'en';

const reviews = (locale: Locale = 'en'): ReactElement =>
  createElement(ReviewQueue, { tenant: TENANT, base: BASE, locale, token: 'tok', officers: OFFICERS });
const checks = (locale: Locale = 'en', canReview = true): ReactElement =>
  createElement(ChecksPanel, { tenant: TENANT, base: BASE, locale, token: 'tok', canReview, officers: OFFICERS });

const refused = (message = 'server words') => new ApiRequestError(409, { code: 'NOT_A_CODE_WE_KNOW', message });
const text = () => screen.container.textContent ?? '';
const search = () => window.location.search;
/** The query the screen last asked the server for. */
const asked = (call: ReturnType<typeof vi.fn>) => call.mock.calls.at(-1)![2];

beforeEach(() => {
  for (const spy of [...Object.values(api), ...Object.values(toast)]) spy.mockReset();
  api.getReviewQueue.mockResolvedValue(queue([FULL, CORRECTED, CHANGED]));
  api.approveRecord.mockResolvedValue({});
  api.returnRecord.mockResolvedValue({});
  api.getQualityChecks.mockResolvedValue({ items: [UNASSIGNED_CHECK, ASSIGNED_CHECK] });
  api.drawQualitySample.mockResolvedValue({ sampled: 3 });
  api.assignQualityCheck.mockResolvedValue({});
  api.completeQualityCheck.mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dialog.props = null;
  window.history.replaceState(null, '', PATH);
  screen = openScreen();
});
afterEach(() => screen.close());

describe('the review queue reads what the address says', () => {
  it('asks for the first page of the records waiting, thirty a page', async () => {
    await screen.mount(reviews());
    expect(asked(api.getReviewQueue)).toEqual({ tab: 'TO_REVIEW', officerId: undefined, flaggedOnly: false, limit: 30, offset: 0 });
    expect(text()).toContain('To review3');
  });

  it('asks for the queue, officer, flag and page the address names', async () => {
    api.getReviewQueue.mockResolvedValue(queue([RETURNED], 61));
    window.history.replaceState(null, '', `${PATH}?queue=RETURNED&officer=${OFFICERS[0]!.id}&flagged=1&page=2`);
    await screen.mount(reviews());
    expect(asked(api.getReviewQueue)).toEqual({ tab: 'RETURNED', officerId: OFFICERS[0]!.id, flaggedOnly: true, limit: 30, offset: 30 });
  });

  it('writes a change of queue, officer or flag to the address and starts again from page one', async () => {
    api.getReviewQueue.mockResolvedValue(queue([FULL], 61));
    window.history.replaceState(null, '', `${PATH}?page=2`);
    await screen.mount(reviews());
    await openTab(screen, 'With officers');
    expect(search()).toBe('?queue=RETURNED');
    await act(async () => picks.get('review-officer')!(OFFICERS[1]!.id));
    await settle();
    expect(search()).toContain(`officer=${OFFICERS[1]!.id}`);
    await click(screen, 'Unverified fields only');
    expect(search()).toContain('flagged=1');
    expect(asked(api.getReviewQueue)).toMatchObject({ tab: 'RETURNED', officerId: OFFICERS[1]!.id, flaggedOnly: true, offset: 0 });
    await act(async () => picks.get('review-officer')!('ANY'));
    await settle();
    expect(search()).not.toContain('officer=');
  });

  it('steps back to the last page with records when this one is past the end', async () => {
    api.getReviewQueue.mockImplementation((_t: string, _k: string, filter: { offset: number }) =>
      Promise.resolve(queue(filter.offset >= 30 ? [] : [FULL], 30)),
    );
    window.history.replaceState(null, '', `${PATH}?page=3`);
    await screen.mount(reviews());
    await settle();
    expect(search()).toBe('');
    expect(text()).toContain('Citizen 1');
  });
});

describe('a decision on a record', () => {
  it('approves it, says so and reads the queue again', async () => {
    await screen.mount(reviews());
    const reads = api.getReviewQueue.mock.calls.length;
    await click(screen, 'Approve');
    expect(api.approveRecord).toHaveBeenCalledWith(TENANT, 'tok', FULL.registrationId);
    expect(toast.success).toHaveBeenCalledWith('Record approved');
    expect(api.getReviewQueue.mock.calls.length).toBeGreaterThan(reads);
  });

  it('offers «approve again» on an approved record, and no way to return one already returned', async () => {
    api.getReviewQueue.mockResolvedValue(queue([APPROVED, RETURNED]));
    await screen.mount(reviews());
    expect(buttons(screen, 'Approve again')).toHaveLength(1);
    expect(buttons(screen, 'Approve')).toHaveLength(1);
    expect(buttons(screen, 'Return to the officer')).toHaveLength(1);
  });

  it('holds that card’s buttons while it is being saved, and no other card’s', async () => {
    let release: (value: unknown) => void = () => {};
    api.approveRecord.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await screen.mount(reviews());
    await click(screen, 'Approve');
    expect(buttons(screen, 'Approve')[0]!.disabled).toBe(true);
    expect(buttons(screen, 'Return to the officer')[0]!.disabled).toBe(true);
    expect(buttons(screen, 'Fill in the gaps')[0]!.disabled).toBe(true);
    expect(buttons(screen, 'Approve')[1]!.disabled).toBe(false);
    await act(async () => release({}));
    await settle();
    expect(buttons(screen, 'Approve')[0]!.disabled).toBe(false);
  });

  it('returns it with the fields and the trimmed reason, and closes the form', async () => {
    await screen.mount(reviews());
    await click(screen, 'Return to the officer');
    const send = () => buttons(screen, 'Send back')[0]!;
    expect(send().disabled).toBe(true);
    // A reason alone is not enough: the officer has to be told which field.
    await type(screen, '#return-reason', 'Visit again');
    expect(send().disabled).toBe(true);
    await type(screen, '#return-reason', '');
    await click(screen, 'Phone / WhatsApp');
    await click(screen, 'Name');
    await click(screen, 'Name');
    await type(screen, '#return-reason', '  abc ');
    expect(send().disabled).toBe(true);
    await type(screen, '#return-reason', '  Visit again ');
    expect(send().disabled).toBe(false);
    await click(screen, 'Send back');
    expect(api.returnRecord).toHaveBeenCalledWith(TENANT, 'tok', FULL.registrationId, { reason: 'Visit again', fields: ['PHONE'] });
    expect(toast.success).toHaveBeenCalledWith('Returned to the officer');
    expect(screen.container.querySelector('#return-reason')).toBeNull();
  });

  it('closes the form on «cancel», sending nothing', async () => {
    await screen.mount(reviews());
    await click(screen, 'Return to the officer');
    await click(screen, 'Cancel');
    expect(screen.container.querySelector('#return-reason')).toBeNull();
    expect(api.returnRecord).not.toHaveBeenCalled();
  });

  it('keeps the form and what was typed when the server refuses, and says why', async () => {
    api.returnRecord.mockRejectedValue(refused('Already decided'));
    await screen.mount(reviews());
    await click(screen, 'Return to the officer');
    await click(screen, 'Name');
    await type(screen, '#return-reason', 'Visit again');
    await click(screen, 'Send back');
    expect(toast.error).toHaveBeenCalledWith('Already decided');
    expect(screen.container.querySelector<HTMLTextAreaElement>('#return-reason')!.value).toBe('Visit again');
    expect(buttons(screen, 'Send back')[0]!.disabled).toBe(false);
  });

  it('opens the gaps dialog for that citizen, only where there is a gap, and reads again once it saves', async () => {
    await screen.mount(reviews());
    expect(buttons(screen, 'Fill in the gaps')).toHaveLength(1);
    await click(screen, 'Fill in the gaps');
    expect(dialog.props).toMatchObject({ citizenId: FULL.citizen.id, citizenName: FULL.citizen.name });
    const reads = api.getReviewQueue.mock.calls.length;
    await act(async () => dialog.props!.onSaved());
    await settle();
    expect(text()).not.toContain('[gaps:');
    expect(api.getReviewQueue.mock.calls.length).toBeGreaterThan(reads);
    await click(screen, 'Fill in the gaps');
    await act(async () => dialog.props!.onOpenChange(false));
    expect(text()).not.toContain('[gaps:');
  });

  it.each([
    ['en', en.errorState.retry],
    ['ar', ar.errorState.retry],
  ])('offers a retry when the first read fails (%s)', async (locale, retry) => {
    api.getReviewQueue.mockRejectedValueOnce(refused());
    await screen.mount(reviews(locale as Locale), locale as Locale);
    await click(screen, retry);
    expect(text()).toContain('Citizen 1');
  });
});

describe('the words after a press, in each language', () => {
  it.each([
    ['en', 'Approve', 'Record approved', 'The decision was not saved.'],
    ['ar', 'اعتماد', 'تم اعتماد السجل', 'لم يُحفظ القرار.'],
  ])('approving (%s)', async (locale, button, done, failed) => {
    await screen.mount(reviews(locale as Locale), locale as Locale);
    await click(screen, button);
    expect(toast.success).toHaveBeenCalledWith(done);
    api.approveRecord.mockRejectedValueOnce(new Error('network'));
    await click(screen, button);
    expect(toast.error).toHaveBeenCalledWith(failed);
  });

  it.each([
    ['en', 'Return to the officer', 'Name', 'Send back', 'Returned to the officer'],
    ['ar', 'إعادة إلى الموظف', 'الاسم', 'إعادة السجل', 'أُعيد السجل إلى الموظف'],
  ])('returning (%s)', async (locale, open, field, send, done) => {
    await screen.mount(reviews(locale as Locale), locale as Locale);
    await click(screen, open);
    await click(screen, field);
    await type(screen, '#return-reason', 'Visit again');
    await click(screen, send);
    expect(toast.success).toHaveBeenCalledWith(done);
  });

  it.each([
    ['en', 'Draw a sample', '3 record(s) added to the sample', 'The sample already covers this period', 'Could not draw a sample.'],
    ['ar', 'سحب عيّنة', 'أُضيف 3 سجلاً إلى العيّنة', 'العيّنة تغطي هذه الفترة بالفعل', 'تعذّر سحب العيّنة.'],
  ])('drawing a sample (%s)', async (locale, button, added, covered, failed) => {
    await screen.mount(checks(locale as Locale), locale as Locale);
    await click(screen, button);
    expect(toast.success).toHaveBeenLastCalledWith(added);
    api.drawQualitySample.mockResolvedValueOnce({ sampled: 0 });
    await click(screen, button);
    expect(toast.success).toHaveBeenLastCalledWith(covered);
    api.drawQualitySample.mockRejectedValueOnce(new Error('network'));
    await click(screen, button);
    expect(toast.error).toHaveBeenCalledWith(failed);
  });

  it.each([
    ['en', 'Assignment saved', 'Check recorded', 'Not saved.', 'Record what you found', 'What I found matches the record', 'Save'],
    ['ar', 'حُفظ الإسناد', 'سُجِّل التحقق', 'لم يُحفظ.', 'تسجيل ما وجدته', 'ما وجدته مطابق للسجل', 'حفظ'],
  ])('assigning and recording a check (%s)', async (locale, assigned, recorded, failed, open, matches, save) => {
    await screen.mount(checks(locale as Locale), locale as Locale);
    await act(async () => picks.get(`assign-${UNASSIGNED_CHECK.id}`)!(OFFICERS[1]!.id));
    await settle();
    expect(toast.success).toHaveBeenLastCalledWith(assigned);
    await click(screen, open);
    await click(screen, matches);
    await click(screen, save);
    expect(toast.success).toHaveBeenLastCalledWith(recorded);
    api.assignQualityCheck.mockRejectedValueOnce(new Error('network'));
    await act(async () => picks.get(`assign-${UNASSIGNED_CHECK.id}`)!(OFFICERS[1]!.id));
    await settle();
    expect(toast.error).toHaveBeenCalledWith(failed);
  });
});

describe('the sample', () => {
  it('draws a week to today at five per cent unless told otherwise', async () => {
    await screen.mount(checks());
    await click(screen, 'Draw a sample');
    const body = asked(api.drawQualitySample);
    expect(body.percent).toBe(5);
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(7);
  });

  it('draws the period and share typed, keeping two digits at most', async () => {
    await screen.mount(checks());
    await type(screen, '#sample-from', '2026-11-01');
    await type(screen, '#sample-to', '2026-11-10');
    await type(screen, '#sample-percent', 'a125');
    expect(screen.container.querySelector<HTMLInputElement>('#sample-percent')!.value).toBe('12');
    await click(screen, 'Draw a sample');
    expect(asked(api.drawQualitySample)).toEqual({ from: '2026-11-01', to: '2026-11-10', percent: 12 });
    await type(screen, '#sample-percent', '');
    await click(screen, 'Draw a sample');
    expect(asked(api.drawQualitySample).percent).toBe(5);
  });

  it('is off without both ends of the period, and while it is being drawn', async () => {
    api.drawQualitySample.mockImplementation(() => new Promise(() => {}));
    await screen.mount(checks());
    await type(screen, '#sample-from', '');
    expect(buttons(screen, 'Draw a sample')[0]!.disabled).toBe(true);
    await type(screen, '#sample-from', '2026-11-01');
    await click(screen, 'Draw a sample');
    expect(buttons(screen, 'Draw a sample')[0]!.disabled).toBe(true);
  });

  it('reads the checks again after a draw', async () => {
    await screen.mount(checks());
    const reads = api.getQualityChecks.mock.calls.length;
    await click(screen, 'Draw a sample');
    expect(api.getQualityChecks.mock.calls.length).toBeGreaterThan(reads);
  });

  it('is not offered to someone who only answers checks, nor is assigning', async () => {
    await screen.mount(checks('en', false));
    expect(buttons(screen, 'Draw a sample')).toHaveLength(0);
    expect(picks.has(`assign-${ASSIGNED_CHECK.id}`) && screen.container.querySelector(`#assign-${ASSIGNED_CHECK.id}`)).toBeFalsy();
  });
});

describe('a check', () => {
  it('lists the ones to do, or the ones done, as the address says', async () => {
    await screen.mount(checks());
    expect(asked(api.getQualityChecks)).toEqual({ status: 'OPEN' });
    await click(screen, 'Checked');
    expect(search()).toBe('?status=DONE');
    expect(asked(api.getQualityChecks)).toEqual({ status: 'DONE' });
  });

  it('can go to any officer but the one who filed it, or to anyone', async () => {
    await screen.mount(checks());
    const offered = [...screen.container.querySelectorAll(`[data-list="assign-${UNASSIGNED_CHECK.id}"] [data-option]`)].map((node) =>
      node.getAttribute('data-option'),
    );
    expect(offered).toEqual(['UNASSIGNED', OFFICERS[1]!.id]);
    await act(async () => picks.get(`assign-${ASSIGNED_CHECK.id}`)!('UNASSIGNED'));
    await settle();
    expect(api.assignQualityCheck).toHaveBeenCalledWith(TENANT, 'tok', ASSIGNED_CHECK.id, null);
    await act(async () => picks.get(`assign-${UNASSIGNED_CHECK.id}`)!(OFFICERS[1]!.id));
    await settle();
    expect(api.assignQualityCheck).toHaveBeenCalledWith(TENANT, 'tok', UNASSIGNED_CHECK.id, OFFICERS[1]!.id);
  });

  it('records that what was found matches', async () => {
    await screen.mount(checks());
    await click(screen, 'Record what you found');
    expect(buttons(screen, 'Save')[0]!.disabled).toBe(true);
    await click(screen, 'What I found matches the record');
    await click(screen, 'Save');
    expect(api.completeQualityCheck).toHaveBeenCalledWith(TENANT, 'tok', UNASSIGNED_CHECK.id, {
      result: 'MATCHES',
      differences: [],
      notes: undefined,
    });
    expect(screen.container.querySelector('textarea')).toBeNull();
    expect(buttons(screen, 'Save')).toHaveLength(0);
  });

  it('needs what differs and what was found before it can say something differs', async () => {
    await screen.mount(checks());
    await click(screen, 'Record what you found');
    await click(screen, 'Something is different');
    expect(buttons(screen, 'Save')[0]!.disabled).toBe(true);
    await click(screen, 'Phone');
    expect(buttons(screen, 'Save')[0]!.disabled).toBe(true);
    await type(screen, 'textarea', '  Another number  ');
    await click(screen, 'Save');
    expect(api.completeQualityCheck).toHaveBeenCalledWith(TENANT, 'tok', UNASSIGNED_CHECK.id, {
      result: 'DIFFERS',
      differences: ['PHONE'],
      notes: 'Another number',
    });
  });

  it('keeps the answer on screen when the server refuses, and says why', async () => {
    api.completeQualityCheck.mockRejectedValue(refused('Someone else recorded it'));
    await screen.mount(checks());
    await click(screen, 'Record what you found');
    await click(screen, 'Something is different');
    await click(screen, 'Phone');
    await type(screen, 'textarea', 'Another number');
    await click(screen, 'Save');
    expect(toast.error).toHaveBeenCalledWith('Someone else recorded it');
    expect(screen.container.querySelector('textarea')!.value).toBe('Another number');
  });

  it('closes the answer on «cancel», sending nothing', async () => {
    await screen.mount(checks());
    await click(screen, 'Record what you found');
    expect(screen.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    await click(screen, 'Cancel');
    expect(screen.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(api.completeQualityCheck).not.toHaveBeenCalled();
    expect(buttons(screen, 'Record what you found')).toHaveLength(2);
  });

  it('offers a retry when the first read fails', async () => {
    api.getQualityChecks.mockRejectedValueOnce(refused());
    await screen.mount(checks());
    await click(screen, en.errorState.retry);
    expect(text()).toContain('Citizen 1');
  });
});
