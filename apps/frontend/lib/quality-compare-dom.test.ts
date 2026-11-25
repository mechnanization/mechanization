// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { citizenFieldPatch } from '@/lib/citizen-field-edit';
import { FindingCompare } from '@/components/admin/quality/finding-compare';
import {
  ABROAD,
  ALI,
  EAST,
  EAST_BUILDING,
  FIRST,
  HASSAN,
  ONE_RECORD,
  SECOND,
  TWO_BUILDINGS,
  TWO_CITIZENS,
  WEST,
  WEST_BUILDING,
  file,
} from './quality-compare-harness';
import { BASE, TENANT, openScreen, settle, type Screen } from './quality-review-harness';

/*
  The comparison «الإجراء» (PAGE-13, cleanup sprint, 2026-11-25), driven before it is split. It writes a
  citizen's file: a name, a mother's name or a phone, corrected from beside the other record. So the first
  half of this file is that save: what it reads, what it refuses to send, exactly what it sends, and what is
  left on screen after each answer. The merge dialog is a screen of its own and says what it was opened for.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({
  getCitizenProfile: vi.fn(),
  getCitizenForm: vi.fn(),
  updateCitizen: vi.fn(),
  getBuilding: vi.fn(),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toast }));
const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => {}, prefetch: () => {} } };
});
vi.mock('next/navigation', () => ({ useRouter: () => nav.router }));
const merge = vi.hoisted(() => ({
  props: null as null | {
    firstId: string;
    secondId: string;
    onOpenChange: (open: boolean) => void;
    onMerged: (result: { keepId: string }) => void;
  },
}));
vi.mock('@/components/admin/merge-citizens-dialog', () => ({
  MergeCitizensDialog: (props: NonNullable<typeof merge.props>) => {
    merge.props = props;
    return '[merge]';
  },
}));

let screen: Screen;
let back: number;
let changed: number;
type Locale = 'ar' | 'en';
type Props = Partial<Parameters<typeof FindingCompare>[0]>;

const compare = (locale: Locale = 'en', props: Props = {}): ReactElement =>
  createElement(FindingCompare, {
    finding: TWO_CITIZENS,
    tenant: TENANT,
    base: BASE,
    locale,
    token: 'tok',
    canEdit: true,
    canMerge: true,
    onBack: () => {
      back += 1;
    },
    onChanged: () => {
      changed += 1;
    },
    ...props,
  });
const mount = (locale: Locale = 'en', props: Props = {}) => screen.mount(compare(locale, props), locale);

const text = () => screen.container.textContent ?? '';
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const refused = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiRequestError(status, { code, message, ...(details ? { details } : {}) });
const buttons = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
async function press(scope: ParentNode, label: string, nth = 0): Promise<void> {
  const button = buttons(scope, label)[nth];
  if (!button) throw new Error(`no button «${label}» (${nth})`);
  await act(async () => button.click());
  await settle();
}
/** The table's row for one fact. */
const row = (label: string) =>
  [...screen.container.querySelectorAll('dl > div')].find((node) => node.querySelector('dt')?.textContent === label) as HTMLElement;
/** One side of a row: 0 the first file, 1 the second. */
const cell = (label: string, side: 0 | 1) => row(label).querySelectorAll('dd')[side] as HTMLElement;
const edit = (label: string, side: 0 | 1 = 0, words = 'Edit') => press(cell(label, side), words);
const input = (id: string) => screen.container.querySelector<HTMLInputElement>(`#${id}`);
async function type(id: string, value: string): Promise<void> {
  const node = input(id);
  if (!node) throw new Error(`no #${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const sent = (call = 0) => api.updateCitizen.mock.calls[call]![3] as Record<string, unknown>;

beforeEach(() => {
  for (const spy of [...Object.values(api), ...Object.values(toast)]) spy.mockReset();
  nav.push.mockReset();
  merge.props = null;
  api.getCitizenProfile.mockImplementation((_t: string, _k: string, id: string) => Promise.resolve(id === ALI ? FIRST : SECOND));
  api.getCitizenForm.mockImplementation((_t: string, _k: string, id: string) => Promise.resolve(file(id)));
  api.updateCitizen.mockResolvedValue({});
  api.getBuilding.mockImplementation((_t: string, _k: string, id: string) =>
    Promise.resolve(id === EAST ? EAST_BUILDING : WEST_BUILDING),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  back = 0;
  changed = 0;
  screen = openScreen();
});
afterEach(() => {
  screen.close();
  document.body.innerHTML = '';
});

describe('correcting a file from the comparison: what is read and offered', () => {
  it('reads both files, and the editable copy only when somebody starts to edit', async () => {
    await mount();
    expect(api.getCitizenProfile.mock.calls.map((call) => call[2])).toEqual([ALI, HASSAN]);
    expect(api.getCitizenForm).not.toHaveBeenCalled();
    await edit('Phone Number', 1);
    expect(api.getCitizenForm).toHaveBeenCalledWith(TENANT, 'tok', HASSAN);
  });

  it.each([
    ['Full name', ['edit-0-firstName', 'edit-0-middleName', 'edit-0-lastName'], ['محمد', 'أحمد', 'خليل']],
    ["Mother's Full Name", ['edit-0-motherName'], ['فاطمة سعد']],
    ['Phone Number', ['edit-0-phone'], ['+96170123456']],
  ])('opens «%s» filled with what the file holds', async (label, ids, values) => {
    await mount();
    await edit(label);
    expect(ids.map((id) => input(id)?.value)).toEqual(values);
    expect(screen.container.querySelectorAll('input')).toHaveLength(ids.length);
  });

  it('reads each file’s own copy: the second file’s editor does not show the first’s', async () => {
    api.getCitizenForm.mockImplementation((_t: string, _k: string, id: string) =>
      Promise.resolve(
        id === ALI ? file(ALI) : file(HASSAN, { contact: { ...file(HASSAN).contact, phone: '+96171999999' } }),
      ),
    );
    await mount();
    await edit('Phone Number', 0);
    await press(screen.container, 'Cancel');
    await edit('Phone Number', 1);
    expect(input('edit-1-phone')!.value).toBe('+96171999999');
  });

  it('asks an institution for its one name only, and saves it', async () => {
    const institution = file(ALI, {
      residence: 'INSTITUTION',
      personal: { firstName: 'جمعية الأمل' } as never,
    });
    api.getCitizenForm.mockResolvedValue(institution);
    await mount();
    await edit('Full name');
    expect(screen.container.querySelectorAll('input')).toHaveLength(1);
    await type('edit-0-firstName', 'جمعية النور');
    await press(screen.container, 'Save');
    await press(dialog()!, 'Save');
    expect(sent().personal).toEqual({ firstName: 'جمعية النور' });
  });

  it('offers a correction on three facts only, on both sides', async () => {
    await mount();
    expect(buttons(screen.container, 'Edit')).toHaveLength(6);
  });

  it('offers nothing to change to a role that only reviews, and says so', async () => {
    await mount('en', { canEdit: false, canMerge: false });
    expect(buttons(screen.container, 'Edit')).toHaveLength(0);
    expect(text()).toContain('Your role reviews records but does not change them.');
    expect(buttons(screen.container, 'Merge the two files')).toHaveLength(0);
  });

  it('offers no mother’s name to somebody living elsewhere, and no phone to a file that has none', async () => {
    api.getCitizenProfile.mockImplementation((_t: string, _k: string, id: string) => Promise.resolve(id === ALI ? FIRST : ABROAD));
    await mount();
    expect(buttons(cell("Mother's Full Name", 1), 'Edit')).toHaveLength(0);
    expect(buttons(cell('Phone Number', 1), 'Edit')).toHaveLength(0);
    expect(cell("Mother's Full Name", 1).textContent!.length).toBeGreaterThan(5);
    expect(buttons(screen.container, 'Edit')).toHaveLength(4);
  });

  it('says why when the editable copy cannot be read, and opens nothing', async () => {
    api.getCitizenForm.mockRejectedValue(refused(403, 'NOT_A_CODE_WE_KNOW', 'Not yours'));
    await mount();
    await edit('Phone Number');
    expect(toast.error).toHaveBeenCalledWith('Not yours');
    expect(screen.container.querySelector('input')).toBeNull();
    expect((buttons(cell('Phone Number', 0), 'Edit')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes the editor on «cancel», sending nothing', async () => {
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', '+96171000000');
    await press(screen.container, 'Cancel');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(dialog()).toBeNull();
    expect(api.updateCitizen).not.toHaveBeenCalled();
  });
});

describe('correcting a file from the comparison: what is refused before anything is sent', () => {
  it.each([
    ['a blank nobody accounted for', 'Phone Number', 'edit-0-phone', '   '],
    ['a number that is not one', 'Phone Number', 'edit-0-phone', '123'],
    ['a name with digits', "Mother's Full Name", 'edit-0-motherName', 'فاطمة 2'],
    ['a name of one letter', "Mother's Full Name", 'edit-0-motherName', 'ف'],
  ])('%s', async (_name, label, id, value) => {
    await mount();
    await edit(label);
    await type(id, value);
    await press(screen.container, 'Save');
    expect(screen.container.querySelector('[role="alert"]')!.textContent).toContain(':');
    expect(dialog()).toBeNull();
    expect(api.updateCitizen).not.toHaveBeenCalled();
    expect(input(id)!.value).toBe(value);
  });

  it('but lets through a blank an officer marked «غير مؤكَّد»', async () => {
    api.getCitizenForm.mockResolvedValue(
      file(ALI, { flags: [{ path: 'personal.motherName', reason: 'Not known', kind: 'UNESTABLISHED' }] as never }),
    );
    await mount();
    await edit("Mother's Full Name");
    await type('edit-0-motherName', '');
    await press(screen.container, 'Save');
    expect(dialog()).not.toBeNull();
  });

  it('closes the editor without a question when a name is saved as it was', async () => {
    await mount();
    await edit('Full name');
    await press(screen.container, 'Save');
    expect(dialog()).toBeNull();
    expect(screen.container.querySelector('input')).toBeNull();
  });

  it('closes the editor without a question when nothing changed', async () => {
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', ' +961 70 123 456 ');
    await press(screen.container, 'Save');
    expect(dialog()).toBeNull();
    expect(screen.container.querySelector('input')).toBeNull();
    expect(api.updateCitizen).not.toHaveBeenCalled();
  });
});

describe('correcting a file from the comparison: the question, and what is sent', () => {
  it('asks first, showing what becomes what', async () => {
    await mount();
    await edit('Full name');
    await type('edit-0-lastName', 'خليل حمود');
    await press(screen.container, 'Save');
    expect(dialog()!.textContent).toContain('Save this change?');
    expect(dialog()!.textContent).toContain('Full name');
    expect(dialog()!.textContent).toContain('محمد أحمد خليل');
    expect(dialog()!.textContent).toContain('محمد أحمد خليل حمود');
    expect(api.updateCitizen).not.toHaveBeenCalled();
  });

  it('sends the whole file back as it was read, with only the corrected field moved, its version and why', async () => {
    await mount();
    await edit('Phone Number', 1);
    // Typed as an officer types it: spaced, in Arabic digits.
    await type('edit-1-phone', '٧١ ٠٠٠ ٠٠٠');
    await press(screen.container, 'Save');
    await press(dialog()!, 'Save');
    expect(api.updateCitizen).toHaveBeenCalledTimes(1);
    expect(api.updateCitizen.mock.calls[0]!.slice(0, 3)).toEqual([TENANT, 'tok', HASSAN]);
    const { changeReason, ...patch } = sent();
    expect(patch).toEqual(citizenFieldPatch(file(HASSAN), { phone: '+96171000000' }));
    expect(patch.expectedVersion).toBe('filing-1:v7');
    expect(patch.properties).toHaveLength(1);
    expect(changeReason).toBe('Corrected while comparing two records in quality review: Phone Number');
  });

  it('sends the three parts of a name together', async () => {
    await mount();
    await edit('Full name');
    await type('edit-0-firstName', 'محمود');
    await press(screen.container, 'Save');
    await press(dialog()!, 'Save');
    expect(sent().personal).toMatchObject({ firstName: 'محمود', middleName: 'أحمد', lastName: 'خليل' });
    expect(sent().changeReason).toBe('Corrected while comparing two records in quality review: Full name');
  });

  it('writes the reason in Arabic on the Arabic page', async () => {
    await mount('ar');
    await edit('اسم الأم وشهرتها', 0, 'تعديل');
    await type('edit-0-motherName', 'فاطمة سعد الدين');
    await press(screen.container, 'حفظ');
    await press(dialog()!, 'موافق — احفظ');
    expect(sent().changeReason).toBe('تصحيح عند مقارنة سجلَّين في مراجعة الجودة: اسم الأم وشهرتها');
    expect(toast.success).toHaveBeenCalledWith('صُحِّح السجل.');
  });

  it('on success says so, closes both, reads the two files again and tells the list', async () => {
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', '+96171000000');
    await press(screen.container, 'Save');
    const reads = api.getCitizenProfile.mock.calls.length;
    await press(dialog()!, 'Save');
    expect(toast.success).toHaveBeenCalledWith('The record was corrected.');
    expect(dialog()).toBeNull();
    expect(screen.container.querySelector('input')).toBeNull();
    expect(api.getCitizenProfile.mock.calls.length).toBeGreaterThan(reads);
    expect(changed).toBe(1);
    // The version it was saved against is spent: the next edit reads the file again.
    await edit('Phone Number');
    expect(api.getCitizenForm).toHaveBeenCalledTimes(2);
  });

  it('keeps the question open with the server’s words when refused, and the typed value behind it', async () => {
    api.updateCitizen.mockRejectedValueOnce(refused(400, 'NOT_A_CODE_WE_KNOW', 'The file is archived'));
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', '+96171000000');
    await press(screen.container, 'Save');
    await press(dialog()!, 'Save');
    expect(dialog()!.textContent).toContain('The file is archived');
    expect(toast.success).not.toHaveBeenCalled();
    expect(changed).toBe(0);
    await press(dialog()!, 'Save');
    expect(api.updateCitizen).toHaveBeenCalledTimes(2);
    expect(changed).toBe(1);
  });

  it('sends nothing when the question is dismissed, and keeps what was typed', async () => {
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', '+96171000000');
    await press(screen.container, 'Save');
    await press(dialog()!, 'Cancel');
    expect(dialog()).toBeNull();
    expect(api.updateCitizen).not.toHaveBeenCalled();
    expect(input('edit-0-phone')!.value).toBe('+96171000000');
  });

  it('is one write however fast the question is confirmed', async () => {
    api.updateCitizen.mockImplementation(() => new Promise(() => {}));
    await mount();
    await edit('Phone Number');
    await type('edit-0-phone', '+96171000000');
    await press(screen.container, 'Save');
    const confirm = buttons(dialog()!, 'Save')[0]!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(api.updateCitizen).toHaveBeenCalledTimes(1);
  });
});

describe('merging the two files', () => {
  it('is an administrator’s: everyone else is told who can', async () => {
    await mount('en', { canMerge: false });
    expect(buttons(screen.container, 'Merge the two files')).toHaveLength(0);
    expect(text()).toContain('an administrator can merge the two files from this screen');
  });

  it('opens the merge for the two files, and closes it', async () => {
    await mount();
    await press(screen.container, 'Merge the two files');
    expect(merge.props).toMatchObject({ firstId: ALI, secondId: HASSAN });
    await act(async () => merge.props!.onOpenChange(false));
    await settle();
    expect(text()).not.toContain('[merge]');
  });

  it('says so, tells the list and opens the file that was kept', async () => {
    await mount();
    await press(screen.container, 'Merge the two files');
    await act(async () => merge.props!.onMerged({ keepId: ALI }));
    await settle();
    expect(toast.success).toHaveBeenCalledWith('The two files were merged.');
    expect(changed).toBe(1);
    expect(nav.push).toHaveBeenCalledWith(`${BASE}/citizens/${ALI}`);
    expect(text()).not.toContain('[merge]');
  });
});

describe('what the comparison shows', () => {
  it('counts the facts that disagree and the ones asked of one file only', async () => {
    await mount();
    // The name differs and so do other facts; the second file was never asked the mother's name.
    expect(text()).toMatch(/Fields that disagree:\d+/);
    expect(cell("Mother's Full Name", 1).textContent).toContain('Not asked on one record:');
    // A phone typed with spaces is the same phone.
    expect(row('Phone Number').textContent).not.toContain('Differs:');
    expect(row('Full name').textContent).toContain('Differs:');
  });

  it('links each file, and goes back', async () => {
    await mount();
    const links = [...screen.container.querySelectorAll('a')].map((node) => node.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining([`${BASE}/citizens/${ALI}`, `${BASE}/citizens/${HASSAN}`]));
    await press(screen.container, 'Back to quality findings');
    expect(back).toBe(1);
  });

  it('sets two structures side by side, with nothing to change', async () => {
    await mount('en', { finding: TWO_BUILDINGS });
    expect(api.getBuilding.mock.calls.map((call) => call[2])).toEqual([EAST, WEST]);
    expect(buttons(screen.container, 'Edit')).toHaveLength(0);
    expect(row('Code').textContent).toContain('X-498-B');
    expect(row('Entrance pin').textContent).toContain('33.12346, 35.65432');
    const links = [...screen.container.querySelectorAll('a')].map((node) => node.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining([`${BASE}/buildings/${EAST}/matrix`, `${BASE}/buildings/${WEST}/matrix`]));
  });

  it('says there is nothing to compare when a finding names one record', async () => {
    await mount('en', { finding: ONE_RECORD });
    expect(text()).toContain('there is nothing to set against it');
    expect(api.getBuilding).not.toHaveBeenCalled();
  });

  it.each([
    ['the two files', TWO_CITIZENS, 'getCitizenProfile', 'Could not load the two records.'],
    ['the two structures', TWO_BUILDINGS, 'getBuilding', 'Could not load the two structures.'],
  ] as const)('offers a retry when %s cannot be read', async (_name, finding, call, message) => {
    api[call].mockRejectedValueOnce(refused(500, 'INTERNAL_ERROR', 'x'));
    await mount('en', { finding });
    expect(text()).toContain(message);
    await press(screen.container, 'Try again');
    expect(screen.container.querySelector('dl')).not.toBeNull();
  });
});
