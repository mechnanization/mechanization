// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError, createBuilding } from '@/lib/api-client';
import { queueBuilding } from '@/lib/offline-sync';
import { heldInDoubt, heldKey } from '@/lib/request-id';
import { BuildingEditor } from '@/components/admin/building-editor';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

/*
  The building editor's creation, driven in jsdom (GOD-21, cleanup sprint, 2026-11-24).

  The audit says two things must survive splitting `BuildingEditor`: the in-flight
  guard on «حفظ» (STA-4: a second press made a second building) and the held
  creation key `building:<parcel>` (a key in a ref died with the form while the
  draft did not, and a locale switch made a second building). Both are decisions
  taken inside one 3,240-line function, so this is written first and the split
  has to keep it green.

  The map is not under test: `ParcelPinPicker` and the cadastre loaders are stubbed,
  because jsdom has no WebGL. The officer's answer to «تعذّر تثبيت المدخل» stands in
  for the pin, which is a thing the form accepts on its own.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenant: 't', locale: 'en', adminPath: 'a' }),
  useRouter: () => ({ push: nav.push, replace: nav.replace, prefetch() {} }),
  usePathname: () => '/t/en/a/buildings/new',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/use-staff-session', () => ({
  useStaffSession: () => ({ token: 'tok', user: { id: 'u1', role: 'SUPER_ADMIN' } }),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    createBuilding: vi.fn(),
    getBuildings: vi.fn(async () => ({ buildings: [], total: 0 })),
    getZones: vi.fn(async () => ({ zones: [] })),
    getZoneParcelIndex: vi.fn(async () => ({})),
    checkPropertyNumber: vi.fn(async () => null),
    getBuildingTypes: vi.fn(async () => []),
    getUnitTypes: vi.fn(async () => []),
  };
});

vi.mock('@/lib/offline-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/offline-sync')>();
  return { ...actual, queueBuilding: vi.fn(async () => undefined) };
});
vi.mock('@/lib/offline-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/offline-db')>();
  return { ...actual, offlineStorageAvailable: () => true };
});

vi.mock('@/components/admin/parcel-pin-picker', () => ({
  ParcelPinPicker: () => null,
  footprintOf: () => null,
  outlineOf: () => null,
  parcelAt: () => null,
  parcelsOf: () => [],
  floorLabel: (floor: number) => `floor ${floor}`,
  loadParcelLabelPoints: async () => null,
  loadParcelOutlines: async () => null,
}));

const messages = JSON.parse(readFileSync(join(__dirname, '../messages/en.json'), 'utf8'));
const roots: Root[] = [];

interface Mounted {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function mount(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages,
        children: createElement(QueryClientProvider, {
          client,
          children: createElement(TooltipProvider, {
            children: createElement(ToastProvider, {
              children: createElement(BuildingEditor, { tenant: 't', locale: 'en', adminPath: 'a' }),
            }),
          }),
        }),
      }),
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

const buttons = (container: HTMLElement, text: string): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text) as HTMLButtonElement[];

/** What an officer does on the first step with no pin to drop: the parcel, then the reason the entrance is not pinned. */
async function fillFirstStep(form: Mounted, parcel: string): Promise<void> {
  await typeInto(form.container.querySelector('#building-parcel') as HTMLInputElement, parcel);
  const tick = form.container.querySelector('button[role="checkbox"]') as HTMLButtonElement;
  await click(tick);
  const reason = form.container.querySelector('textarea') as HTMLTextAreaElement;
  await typeInto(reason, 'no signal on the street');
}

/** The three steps of a creation, to the one with «إنشاء المبنى». */
async function reachSave(form: Mounted, parcel: string): Promise<void> {
  await fillFirstStep(form, parcel);
  await click(buttons(form.container, 'Next')[0]);
  await click(buttons(form.container, 'Next')[0]);
  expect(buttons(form.container, 'Create Building').length, 'the last step').toBeGreaterThan(0);
}

const createBuildingMock = vi.mocked(createBuilding);
const queueBuildingMock = vi.mocked(queueBuilding);

const refusal = (status: number, code: string) =>
  new ApiRequestError(status, { code, message: 'refused', kind: code } as never);
const created = { building: { id: 'b-1', code: 'X' }, reconciled: false, deduplicated: false } as never;

beforeEach(() => {
  nav.push.mockClear();
  createBuildingMock.mockReset();
  queueBuildingMock.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  sessionStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const sentId = (call: number): string => (createBuildingMock.mock.calls[call][2] as { clientSubmissionId: string }).clientSubmissionId;

describe('the first step will not go on without what the save needs', () => {
  it('«التالي» is off with no parcel number, and with a parcel but no pin and no reason', async () => {
    const form = await mount();
    expect(buttons(form.container, 'Next')[0].disabled).toBe(true);
    await typeInto(form.container.querySelector('#building-parcel') as HTMLInputElement, '90001');
    expect(buttons(form.container, 'Next')[0].disabled).toBe(true);
    await click(form.container.querySelector('button[role="checkbox"]')!);
    await typeInto(form.container.querySelector('textarea') as HTMLTextAreaElement, 'no signal here');
    expect(buttons(form.container, 'Next')[0].disabled).toBe(false);
  });
});

describe('the in-flight guard (STA-4)', () => {
  it('two presses of «إنشاء المبنى» in the same tick make one building', async () => {
    let release!: (value: never) => void;
    createBuildingMock.mockReturnValue(new Promise((resolve) => (release = resolve as never)));
    const form = await mount();
    await reachSave(form, '90002');

    const [first] = buttons(form.container, 'Create Building');
    await act(async () => {
      first.click();
      first.click();
      first.click();
    });
    expect(createBuildingMock).toHaveBeenCalledTimes(1);

    await act(async () => release(created));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(String(nav.push.mock.calls[0][0])).toContain('/buildings/b-1/matrix');
  });

  it('after a save that landed the button stays off while the page moves on', async () => {
    createBuildingMock.mockResolvedValue(created);
    const form = await mount();
    await reachSave(form, '90003');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(nav.push).toHaveBeenCalledTimes(1);
    for (const button of buttons(form.container, 'Create Building')) expect(button.disabled, 'locked after a landed save').toBe(true);
    await click(form.container.querySelector('button:not([disabled])') ?? document.body);
    expect(createBuildingMock).toHaveBeenCalledTimes(1);
  });

  it('after a refusal the button comes back, so the officer can fix it and press again', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(400, 'VALIDATION_FAILED'));
    const form = await mount();
    await reachSave(form, '90004');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(createBuildingMock).toHaveBeenCalledTimes(1);
    for (const button of buttons(form.container, 'Create Building')) expect(button.disabled).toBe(false);
  });
});

describe('the held creation key `building:<parcel>`', () => {
  it('goes with the creation as its clientSubmissionId, and is the key held for that parcel', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(400, 'VALIDATION_FAILED'));
    const form = await mount();
    await reachSave(form, '90010');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(sentId(0)).toBe(heldKey('t', 'building:90010'));
  });

  it('is kept across a refusal: a second press goes under the same id', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(400, 'VALIDATION_FAILED')).mockResolvedValueOnce(created);
    const form = await mount();
    await reachSave(form, '90011');
    await click(buttons(form.container, 'Create Building')[0]);
    await click(buttons(form.container, 'Create Building')[0]);
    expect(createBuildingMock).toHaveBeenCalledTimes(2);
    expect(sentId(1)).toBe(sentId(0));
  });

  it('is kept, and marked in doubt, when the answer was lost (the building may exist)', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(0, 'NETWORK_ERROR')).mockResolvedValueOnce(created);
    const form = await mount();
    await reachSave(form, '90012');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(heldInDoubt('t', 'building:90012')).toBe(true);
    await click(buttons(form.container, 'Create Building')[0]);
    expect(sentId(1)).toBe(sentId(0));
  });

  it('is not marked in doubt by a plain refusal', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(400, 'VALIDATION_FAILED'));
    const form = await mount();
    await reachSave(form, '90013');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(heldInDoubt('t', 'building:90013')).toBe(false);
  });

  it('is spent once the building is on file: the next building on the parcel is another act', async () => {
    createBuildingMock.mockResolvedValue(created);
    const first = await mount();
    await reachSave(first, '90014');
    await click(buttons(first.container, 'Create Building')[0]);
    const spentId = sentId(0);
    await first.unmount();
    sessionStorage.clear();

    const second = await mount();
    await reachSave(second, '90014');
    await click(buttons(second.container, 'Create Building')[0]);
    expect(sentId(1)).not.toBe(spentId);
  });

  it('outlives a remount (a language switch, a look at «سجل المباني»): the same form, the same id', async () => {
    createBuildingMock.mockRejectedValueOnce(refusal(0, 'NETWORK_ERROR')).mockResolvedValueOnce(created);
    const first = await mount();
    await reachSave(first, '90015');
    await click(buttons(first.container, 'Create Building')[0]);
    const lostId = sentId(0);
    await first.unmount();

    // a fresh component; the draft (session-scoped) puts the officer back where they were
    const second = await mount();
    // the draft put them back on the last step, with the parcel they had; nothing is typed again
    expect(buttons(second.container, 'Create Building').length, 'back on the step with the save button').toBeGreaterThan(0);
    await click(buttons(second.container, 'Create Building')[0]);
    expect(createBuildingMock).toHaveBeenCalledTimes(2);
    expect(sentId(1)).toBe(lostId);
  });
});

describe('with no connection the building goes to the queue under the held key', () => {
  it('queues it with the id an online press would have sent, and spends the key', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const form = await mount();
    await reachSave(form, '90020');
    const id = heldKey('t', 'building:90020');
    await click(buttons(form.container, 'Create Building')[0]);
    expect(createBuildingMock).not.toHaveBeenCalled();
    expect(queueBuildingMock).toHaveBeenCalledTimes(1);
    expect(queueBuildingMock.mock.calls[0][0].id).toBe(id);
    expect(queueBuildingMock.mock.calls[0][0].parcelNumber).toBe('90020');
    // handed to the queue: the next building on this parcel is a new act
    expect(heldKey('t', 'building:90020')).not.toBe(id);
  });
});
