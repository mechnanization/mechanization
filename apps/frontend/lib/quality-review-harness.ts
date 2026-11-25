/*
  What the nets under «اعتماد السجلات» and «عيّنة التحقق» share (PAGE-13): records and checks in every state
  they can be in, and a page that mounts a screen with the real query cache and waits for its answer. Not a test
  file, and no application code imports it. The wallet-list and date-picker stand-ins are the transfer form's
  (`transfer-form-harness.ts`): jsdom cannot open a Radix list or a calendar.
*/
import { act, createElement, useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QualityCheck, ReviewQueue, ReviewQueueItem } from '@/lib/quality-api';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

export const TENANT = 't1';
export const BASE = '/t1/en/office';
export const PATH = '/t1/en/office/quality';

export const OFFICERS = [
  { id: 'a1111111-1111-4111-8111-111111111111', name: 'Rima Haddad' },
  { id: 'b2222222-2222-4222-8222-222222222222', name: 'Karim Saleh' },
];

// ── the review queue ─────────────────────────────────────────────────────────

const card = (over: Partial<ReviewQueueItem['properties'][number]> = {}): ReviewQueueItem['properties'][number] => ({
  propertyType: 'BUILDING',
  occupancyType: 'OWNER',
  propertyNumber: '498',
  buildingName: 'Cedar',
  buildingCode: 'X-498-A',
  buildingId: 'c0000000-0000-4000-8000-000000000001',
  unitCount: 3,
  unitArea: 120,
  ...over,
});

const record = (n: number, over: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
  registrationId: `d000000${n}-0000-4000-8000-000000000000`,
  referenceNumber: `REG-000${n}`,
  submittedAt: '2026-11-20T08:30:00Z',
  updatedAt: '2026-11-20T08:30:00Z',
  state: 'NEW',
  requiresReview: false,
  flags: [],
  notes: null,
  officer: OFFICERS[0]!,
  citizen: {
    id: `e000000${n}-0000-4000-8000-000000000000`,
    name: `Citizen ${n}`,
    motherName: null,
    referenceNumber: `C-${n}`,
    residence: 'RESIDENT',
    householdMembers: null,
  },
  properties: [],
  history: [],
  ...over,
});

/** A record with everything a card can show. */
export const FULL = record(1, {
  updatedAt: '2026-11-24T10:00:00Z',
  flags: [{ path: 'properties.0.units.1.unitArea', reason: 'The owner was away', kind: 'UNVERIFIED' }],
  notes: 'Visit again on Monday',
  citizen: {
    id: 'e0000001-0000-4000-8000-000000000000',
    name: 'Citizen 1',
    motherName: 'Salma',
    referenceNumber: 'C-1',
    residence: 'RESIDENT',
    householdMembers: 4,
  },
  properties: [card(), card({ propertyType: 'LAND', occupancyType: null, propertyNumber: null, buildingName: null, buildingCode: null, buildingId: null, unitCount: 0, unitArea: null })],
  history: [
    {
      id: 'h1',
      outcome: 'RETURNED',
      reason: 'The phone is the landlord’s',
      fields: ['PHONE', 'NAME'],
      at: '2026-11-21T09:00:00Z',
      by: 'Reviewer One',
      resolvedAt: '2026-11-22T09:00:00Z',
      resolvedBy: 'Rima Haddad',
    },
    { id: 'h2', outcome: 'APPROVED', reason: null, fields: [], at: '2026-11-23T09:00:00Z', by: null, resolvedAt: null, resolvedBy: null },
  ],
});
/** Corrected, from nobody we know, with a return still open and no property. */
export const CORRECTED = record(2, {
  state: 'CORRECTED',
  officer: null,
  citizen: { id: 'e0000002-0000-4000-8000-000000000000', name: 'Citizen 2', motherName: null, referenceNumber: null, residence: 'ESTATE', householdMembers: null },
  history: [{ id: 'h3', outcome: 'RETURNED', reason: 'No parcel number', fields: [], at: '2026-11-22T09:00:00Z', by: 'Reviewer One', resolvedAt: null, resolvedBy: null }],
});
export const CHANGED = record(3, { state: 'CHANGED', properties: [card({ occupancyType: 'TENANT', unitCount: 0 })] });
export const RETURNED = record(4, {
  state: 'RETURNED',
  history: [{ id: 'h4', outcome: 'RETURNED', reason: 'Wrong unit', fields: ['UNIT_LINK'], at: '2026-11-22T09:00:00Z', by: 'Reviewer One', resolvedAt: null, resolvedBy: null }],
});
export const APPROVED = record(5, { state: 'APPROVED' });

export const COUNTS = { NEW: 1, CORRECTED: 1, CHANGED: 1, RETURNED: 1, APPROVED: 1 };

export const queue = (items: ReviewQueueItem[], total = items.length): ReviewQueue => ({ items, total, counts: COUNTS });

// ── the checks ───────────────────────────────────────────────────────────────

const check = (n: number, over: Partial<QualityCheck> = {}): QualityCheck => ({
  id: `f000000${n}-0000-4000-8000-000000000000`,
  status: 'OPEN',
  result: null,
  differences: [],
  notes: null,
  sampledAt: '2026-11-22T08:00:00Z',
  checkedAt: null,
  originalOfficer: { id: OFFICERS[0]!.id, name: OFFICERS[0]!.name },
  assignedTo: null,
  checkedBy: null,
  citizen: { id: `e000000${n}-0000-4000-8000-000000000000`, name: `Citizen ${n}`, householdMembers: 4 },
  referenceNumber: `REG-000${n}`,
  filedAt: '2026-11-20T08:30:00Z',
  properties: [
    { propertyType: 'BUILDING', occupancyType: 'OWNER', propertyNumber: '498', buildingName: 'Cedar', buildingCode: 'X-498-A', units: ['A-1', 'A-2'] },
    { propertyType: 'LAND', occupancyType: null, propertyNumber: null, buildingName: null, buildingCode: null, units: [] },
  ],
  ...over,
});

export const UNASSIGNED_CHECK = check(1);
export const ASSIGNED_CHECK = check(2, { assignedTo: { id: OFFICERS[1]!.id, name: OFFICERS[1]!.name } });
export const MATCHING = check(3, { status: 'DONE', result: 'MATCHES', checkedAt: '2026-11-23T11:15:00Z', checkedBy: 'Karim Saleh' });
export const DIFFERING = check(4, {
  status: 'DONE',
  result: 'DIFFERS',
  differences: ['PHONE', 'AREA'],
  notes: 'The area is half what was filed',
  checkedAt: '2026-11-23T12:00:00Z',
  checkedBy: 'Karim Saleh',
  originalOfficer: null,
});

// ── the address ──────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
/* Next keeps `useSearchParams` in step with `history.replaceState`, which `useUrlState` writes with; so does this. */
const replaceState = window.history.replaceState.bind(window.history);
window.history.replaceState = (...args) => {
  replaceState(...args);
  for (const listener of listeners) listener();
};
/* One object, as the app router's is: a new one on every render loops an effect that depends on it. */
const router = { push: () => {}, replace: () => {}, prefetch: () => {} };

/** What `next/navigation` is stood in for with. */
export const navigationStandIn = {
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribe, () => window.location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
};

// ── the page ─────────────────────────────────────────────────────────────────

export interface Screen {
  container: HTMLDivElement;
  client: QueryClient;
  mount: (element: ReactElement, locale?: 'ar' | 'en') => Promise<void>;
  close: () => void;
}

/** The cache of the screen now open: `settle` waits on it. */
let current: QueryClient | null = null;

/** The reads a test holds open: `settle` does not wait for them. */
let held = 0;

/** A read that answers when the test says, or never. */
export function heldRead<T = unknown>(): { promise: Promise<T>; answer: (value: T) => void } {
  held += 1;
  let answer!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    answer = (value) => {
      held -= 1;
      resolve(value);
    };
  });
  return { promise, answer };
}

/**
 * Lets the query cache answer: it schedules its notifications on timers, and on a busy machine a fixed few
 * turns of the loop is not enough. So it waits for four quiet turns in a row, a turn with a read still out
 * not counting unless the test is holding it, and stops after sixty whatever is happening.
 */
export async function settle(): Promise<void> {
  for (let turns = 0, quiet = 0; turns < 60 && quiet < 4; turns += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    quiet = current && current.isFetching() > held ? 0 : quiet + 1;
  }
}

export function openScreen(): Screen {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current = client;
  held = 0;
  return {
    container,
    client,
    mount: async (element, locale = 'en') => {
      await act(async () => {
        root.render(
          createElement(NextIntlClientProvider, {
            locale,
            timeZone: 'Asia/Beirut',
            messages: (locale === 'en' ? en : ar) as never,
            children: createElement(QueryClientProvider, { client, children: element }),
          }),
        );
      });
      await settle();
    },
    close: () => {
      act(() => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

export const buttons = (screen: Screen, text: string) =>
  [...screen.container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === text);

export async function click(screen: Screen, text: string, nth = 0): Promise<void> {
  const button = buttons(screen, text)[nth];
  if (!button) throw new Error(`no button «${text}» (${nth})`);
  await act(async () => {
    button.click();
  });
  await settle();
}

/** Radix tabs change on mouse down, not on click. */
export async function openTab(screen: Screen, text: string): Promise<void> {
  const tab = [...screen.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) =>
    node.textContent?.startsWith(text),
  );
  if (!tab) throw new Error(`no tab «${text}»`);
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  await settle();
}

export async function type(screen: Screen, selector: string, value: string): Promise<void> {
  const node = screen.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!node) throw new Error(`no ${selector}`);
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
