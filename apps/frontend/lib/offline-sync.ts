'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  ApiRequestError,
  createBuilding,
  createCitizen,
  generateUnits,
  logApiError,
} from './api-client';
import { loadSession } from './session';
import {
  dequeue,
  dequeueBuilding,
  enqueue,
  enqueueBuilding,
  getQueued,
  listQueued,
  listQueuedBuildings,
  offlineStorageAvailable,
  recordAttempt,
  reviseQueued,
  retryLater,
  updateQueuedBuilding,
  type QueuedBuilding,
  type QueuedSubmission,
} from './offline-db';

/**
 * Getting queued registrations to the server, once there is a server to reach.
 *
 * One module-level engine per municipality rather than a hook that owns the
 * draining: several screens show the queue at once (the header badge, the
 * registry banner, the entry form's own confirmation), and a per-component
 * sync would have each of them delivering the same record. Components
 * subscribe; the engine is the only thing that sends.
 */

export interface QueueState {
  /** Everything still in the queue, oldest first. */
  items: QueuedSubmission[];
  /** Buildings created offline, plus any whose code changed on delivery (P3-T8). */
  buildings: QueuedBuilding[];
  /** Buildings still waiting to be sent. */
  buildingsPending: number;
  /**
   * Delivered buildings whose code is not the one the phone was showing.
   *
   * Counted separately from `pending` because it is not work — it is a message,
   * and the officer clears it by reading it. See `drainBuildings`.
   */
  buildingsReconciled: number;
  /** Waiting for a connection — the count worth putting on a badge. */
  pending: number;
  /** Refused by the server and needing a person, not a retry. */
  blocked: number;
  /** A drain is in flight. */
  syncing: boolean;
  /**
   * There are records waiting and no staff session to send them under.
   *
   * Engine state rather than a note written onto each record, which is what
   * this was first: per-record notes cost a write per row per attempt, count
   * against nothing, and — the reason they had to go — go stale. Once the
   * officer signs back in, thirty rows still carrying «انتهت الجلسة» are all
   * lying, and nothing clears them until each one happens to be retried. This
   * is one boolean recomputed on every drain, so it is right the moment it is
   * read.
   */
  authRequired: boolean;
  /** How many records the last completed drain delivered. */
  lastSynced: number;
  online: boolean;
}

const EMPTY: QueueState = {
  items: [],
  buildings: [],
  buildingsPending: 0,
  buildingsReconciled: 0,
  pending: 0,
  blocked: 0,
  syncing: false,
  authRequired: false,
  lastSynced: 0,
  online: true,
};

type Listener = () => void;

interface Engine {
  state: QueueState;
  listeners: Set<Listener>;
  /** The drain currently running, so a second trigger joins it rather than racing it. */
  draining: Promise<void> | null;
}

const engines = new Map<string, Engine>();

function engineFor(tenant: string): Engine {
  const existing = engines.get(tenant);
  if (existing) return existing;

  const engine: Engine = {
    state: { ...EMPTY, online: typeof navigator === 'undefined' || navigator.onLine },
    listeners: new Set(),
    draining: null,
  };
  engines.set(tenant, engine);
  return engine;
}

function publish(engine: Engine, patch: Partial<QueueState>): void {
  engine.state = { ...engine.state, ...patch };
  for (const listener of engine.listeners) listener();
}

function summarise(items: QueuedSubmission[]) {
  return {
    items,
    pending: items.filter((item) => item.status === 'pending').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
  };
}

/**
 * A new `clientSubmissionId`.
 *
 * `crypto.randomUUID` exists only in a secure context, and a municipality
 * reaching this portal over plain http on its own network is exactly the
 * deployment this feature is for. The fallback is `getRandomValues` shaped into
 * a v4 UUID — the same entropy source, spelled out — because the id has to be
 * unique across every officer's device, and the server's unique index would
 * turn a collision into one household's registration silently answering for
 * another's. `Math.random()` is not an option here; see the note in the README
 * about the reference numbers that were minted from it.
 */
function newSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Re-reads the queue from IndexedDB and republishes it. */
export async function refreshQueue(tenant: string): Promise<void> {
  if (!offlineStorageAvailable()) return;
  const engine = engineFor(tenant);

  try {
    const [submissions, buildings] = await Promise.all([
      listQueued(tenant),
      listQueuedBuildings(tenant),
    ]);
    publish(engine, {
      ...summarise(submissions),
      buildings,
      buildingsPending: buildings.filter((item) => item.status === 'pending').length,
      buildingsReconciled: buildings.filter((item) => item.status === 'reconciled').length,
    });
  } catch (caught) {
    // A browser with IndexedDB disabled, or a store held open by another tab
    // mid-upgrade. Nothing is lost: the records are still there, and the next
    // refresh will find them. Reporting an empty queue would be the lie.
    logApiError(caught);
  }
}

/**
 * Records a finished registration for later delivery.
 *
 * Returns the id it was stored under so the form can show it, and — more to the
 * point — so the same id is what eventually reaches the server as
 * `clientSubmissionId`.
 */
export async function queueSubmission(
  submission: Omit<
    QueuedSubmission,
    'id' | 'status' | 'savedAt' | 'attempts' | 'lastAttemptAt' | 'lastError'
  >,
): Promise<string> {
  const id = newSubmissionId();

  await enqueue({
    ...submission,
    id,
    status: 'pending',
    savedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  });

  await refreshQueue(submission.tenant);
  return id;
}

/**
 * Whether a failed delivery is worth trying again.
 *
 * The distinction that matters is "the network could not carry this" versus
 * "the server read it and said no". The first is the ordinary condition this
 * whole feature exists for and must retry forever. The second will get the
 * same answer every time, so retrying it only buries the reason under a
 * spinner — the record is parked and shown to a person instead.
 *
 * A 401 counts as retryable: the session expired while the phone was in a bag,
 * and the record is perfectly good. The drain stops at that point rather than
 * burning the rest of the queue against a token that is not coming back.
 */
function isRetryable(caught: unknown): boolean {
  if (!(caught instanceof ApiRequestError)) return true;
  if (caught.status === 0) return true;
  if (caught.status === 401 || caught.status === 408 || caught.status === 429) return true;
  return caught.status >= 500;
}

/**
 * Delivers everything queued for this municipality, in the order it was filed.
 *
 * Sequential on purpose. These are writes against one tenant schema behind a
 * five-connection pool, the officer is on the connection that just came back,
 * and thirty parallel POSTs would fail records for reasons that have nothing
 * to do with their contents. Order is preserved for a plainer reason: two
 * registrations sharing a household are far likelier to be adjacent in the
 * queue than not, and the second one's outcome is easier to explain when the
 * first has already landed.
 */
export async function syncQueue(tenant: string): Promise<void> {
  if (!offlineStorageAvailable()) return;

  const engine = engineFor(tenant);
  // A drain already running is the drain: joining it is both correct and what
  // stops an `online` event and a manual «مزامنة» tap sending everything twice.
  if (engine.draining) return engine.draining;

  const drain = (async () => {
    publish(engine, { syncing: true });
    let delivered = 0;

    try {
      /*
        No usable session — and the queue has to say so rather than go quiet.

        This is reachable with records still waiting: a token that expired while
        the phone was in a bag, or a colleague signing out on a shared tablet.
        Returning silently left «مزامنة الآن» looking like a button that does
        nothing, next to rows claiming to be «بانتظار الإرسال» — which they were
        not, in any sense that would ever resolve on its own.

        Nothing is written to the records themselves. This is a fact about the
        session, not about any one registration, and it stops being true the
        moment someone logs in.
      */
      const session = loadSession(tenant);
      if (!session || session.user.kind !== 'STAFF') {
        const [submissions, buildings] = await Promise.all([
          listQueued(tenant),
          listQueuedBuildings(tenant),
        ]);
        const waiting = [...submissions, ...buildings].some((item) => item.status === 'pending');
        publish(engine, { authRequired: waiting });
        return;
      }

      publish(engine, { authRequired: false });

      /*
        Buildings first — see `drainBuildings`. A queued registration may name a
        building that is also still queued, and the id it names only becomes a
        row when that building lands.
      */
      delivered += await drainBuildings(tenant, session.accessToken);

      for (const item of await listQueued(tenant)) {
        if (item.status !== 'pending') continue;
        if (typeof navigator !== 'undefined' && !navigator.onLine) break;

        try {
          await createCitizen(tenant, session.accessToken, {
            ...item.payload,
            clientSubmissionId: item.id,
          });
          // Delivered — including the case where the server recognised this
          // id from a previous attempt whose response never arrived. Both mean
          // the record is on the register, which is all the queue cares about.
          await dequeue(item.id);
          delivered += 1;
        } catch (caught) {
          logApiError(caught);
          const retryable = isRetryable(caught);
          const message =
            caught instanceof ApiRequestError ? caught.message : 'تعذّر إرسال السجل';

          await recordAttempt(item.id, {
            status: retryable ? 'pending' : 'blocked',
            error: message,
          });

          // An expired session or a dead network will fail every remaining
          // record identically. Stopping leaves the queue readable — thirty
          // rows each carrying the same error explain nothing that one does.
          if (caught instanceof ApiRequestError && (caught.status === 0 || caught.status === 401)) {
            break;
          }
        }
      }
    } finally {
      publish(engine, { syncing: false, lastSynced: delivered });
      await refreshQueue(tenant);
    }
  })();

  engine.draining = drain;
  try {
    await drain;
  } finally {
    engine.draining = null;
  }
}

/**
 * Delivers the buildings queued for this municipality, oldest first.
 *
 * Runs **before** the registrations, and that order is the whole of it: a
 * queued registration may carry the `buildingId` of a building that is also
 * still queued, and the server resolves that id against a row that has to exist
 * by then. Draining them in the other order would fail the registration on a
 * foreign key it was right about.
 *
 * §4.4's reconciliation lives here. The phone showed a provisional suffix
 * computed from what it had cached; the server re-allocates under a row lock on
 * the parcel and answers with the authoritative code. When the two differ the
 * record is *kept*, marked `reconciled`, so the officer is told — a code they
 * may already have written on a form in somebody's stairwell has changed, and
 * silently swapping it is how a resident ends up looking for a building that no
 * longer exists under that name.
 */
async function drainBuildings(tenant: string, accessToken: string): Promise<number> {
  let delivered = 0;

  for (const item of await listQueuedBuildings(tenant)) {
    if (item.status !== 'pending') continue;
    if (typeof navigator !== 'undefined' && !navigator.onLine) break;

    try {
      const response = await createBuilding(tenant, accessToken, {
        ...item.payload,
        /*
          Both widened to `never` on the way out, for the same reason.

          IndexedDB stores plain strings — a record queued by yesterday's build
          and replayed by today's may hold an enum value this build's union does
          not know, and a stale queue must not become a type error that stops
          the whole drain. The server validates both with Zod on arrival, which
          is where an unrecognised value should be refused, one record at a time.
        */
        structureType: item.payload.structureType as never,
        lifecycleStatus: item.payload.lifecycleStatus as never,
        provisionalSuffix: item.provisionalSuffix,
        // The id the phone minted *is* the row's id, which is what makes a
        // re-delivered creation find the building it already made rather than
        // putting a second structure on the parcel.
        clientSubmissionId: item.id,
      });

      /*
        The matrix, if one was asked for, and only for a creation that was not
        already delivered.

        `generateUnits` is additive and idempotent per floor, so re-running it
        would be safe — but `deduplicated` says this exact creation has been
        seen before, and re-sending its blueprint would be work for no change.
      */
      if (item.blueprint && !response.deduplicated) {
        await generateUnits(
          tenant,
          accessToken,
          response.building.id,
          item.blueprint as Parameters<typeof generateUnits>[3],
        );
      }

      if (response.reconciled) {
        await updateQueuedBuilding(item.id, {
          status: 'reconciled',
          reconciledCode: response.building.code,
          lastError: null,
        });
      } else {
        // Nothing changed, so there is nothing to tell anyone.
        await dequeueBuilding(item.id);
      }

      delivered += 1;
    } catch (caught) {
      logApiError(caught);
      const retryable = isRetryable(caught);
      const message = caught instanceof ApiRequestError ? caught.message : 'تعذّر إرسال المبنى';

      await updateQueuedBuilding(item.id, {
        status: retryable ? 'pending' : 'blocked',
        lastError: message,
        countAttempt: true,
      });

      if (caught instanceof ApiRequestError && (caught.status === 0 || caught.status === 401)) {
        break;
      }
    }
  }

  return delivered;
}

/**
 * Records a building created with no connection, and returns the id it was
 * stored under — which is also the id the server will give the row.
 */
export async function queueBuilding(
  building: Omit<
    QueuedBuilding,
    'id' | 'status' | 'savedAt' | 'attempts' | 'lastAttemptAt' | 'lastError'
  > & { id?: string },
): Promise<string> {
  const id = building.id ?? newSubmissionId();

  await enqueueBuilding({
    ...building,
    id,
    status: 'pending',
    savedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  });

  await refreshQueue(building.tenant);
  return id;
}

/**
 * Clears one reconciliation notice — the officer has read it.
 *
 * Not automatic: the whole point is that a person sees the new code, and a
 * notice that dismissed itself on the next drain would be a notice nobody read.
 */
export async function acknowledgeBuilding(tenant: string, id: string): Promise<void> {
  await dequeueBuilding(id);
  await refreshQueue(tenant);
}

/** Hands a blocked record back to the queue, then tries it immediately. */
export async function retrySubmission(tenant: string, id: string): Promise<void> {
  await retryLater(id);
  await refreshQueue(tenant);
  await syncQueue(tenant);
}

/**
 * One queued record, for an officer opening it to correct it.
 *
 * Scoped to the tenant even though the lookup is by id alone: an id typed by
 * hand, or a stale bookmark, must not surface another municipality's queued
 * record. In practice a staff session is already scoped to one tenant and
 * this can only really happen by mistake — the check is cheap enough to keep
 * regardless.
 */
export async function getQueuedSubmission(
  tenant: string,
  id: string,
): Promise<QueuedSubmission | null> {
  if (!offlineStorageAvailable()) return null;
  const item = await getQueued(id);
  return item && item.tenant === tenant ? item : null;
}

/**
 * Replaces a queued record's payload and immediately tries to deliver it.
 *
 * The immediate attempt is what makes fixing a blocked record feel like
 * fixing it: without triggering a drain here, the corrected record would sit
 * as `pending` again until the next `online` event or a manual «مزامنة»,
 * which reads as though the edit changed nothing.
 *
 * Returns `false` when the record was already gone by the time this ran — a
 * second tab's drain delivered it in the moment between opening the edit
 * screen and pressing save. The caller reports that honestly rather than
 * claiming an update that never landed anywhere.
 */
export async function reviseSubmission(
  tenant: string,
  id: string,
  payload: QueuedSubmission['payload'],
  displayName: string,
): Promise<boolean> {
  const found = await reviseQueued(id, { payload, displayName });
  await refreshQueue(tenant);
  if (found) void syncQueue(tenant);
  return found;
}

/** Abandons a record for good. Only ever called behind a confirmation. */
export async function discardSubmission(tenant: string, id: string): Promise<void> {
  await dequeue(id);
  await refreshQueue(tenant);
}

/**
 * The queue, live, for one municipality.
 *
 * Also the thing that starts the engine: mounting this anywhere reads the
 * queue and wires the `online` listener, so a page that merely *shows* the
 * badge is enough to get a backlog delivered. The officer does not have to
 * find the right screen — they only have to have the portal open when the
 * signal returns.
 */
export function useOfflineQueue(tenant: string): QueueState & {
  sync: () => void;
  retry: (id: string) => void;
  discard: (id: string) => void;
} {
  const engine = engineFor(tenant);

  const subscribe = useCallback(
    (listener: Listener) => {
      engine.listeners.add(listener);
      return () => {
        engine.listeners.delete(listener);
      };
    },
    [engine],
  );

  const state = useSyncExternalStore(
    subscribe,
    () => engine.state,
    // The server render has no IndexedDB and no `navigator`; handing it the
    // same frozen object every time is what keeps the first paint from
    // mismatching the hydration that follows it.
    () => EMPTY,
  );

  useEffect(() => {
    void refreshQueue(tenant);

    const goOnline = () => {
      publish(engineFor(tenant), { online: true });
      void syncQueue(tenant);
    };
    const goOffline = () => publish(engineFor(tenant), { online: false });

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // `navigator.onLine` is only ever trustworthy when it says *false* — it
    // reports a captive portal or a dead uplink as online. So a backlog is
    // drained on mount regardless, and a failed attempt simply leaves the
    // record queued, which is the same outcome as not having tried.
    void syncQueue(tenant);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [tenant]);

  return {
    ...state,
    sync: useCallback(() => void syncQueue(tenant), [tenant]),
    retry: useCallback((id: string) => void retrySubmission(tenant, id), [tenant]),
    discard: useCallback((id: string) => void discardSubmission(tenant, id), [tenant]),
  };
}

/**
 * Whether the browser currently believes it has a connection.
 *
 * Its own hook because the entry form needs it before anything is queued —
 * «حفظ» has to say what it is about to do, and «حفظ محلياً» on a working
 * connection would be as wrong as a silent failure on a dead one.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
