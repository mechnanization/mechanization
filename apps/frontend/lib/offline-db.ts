'use client';

import type { FieldFlag } from '@mechanization/shared-schemas';

/**
 * The queue of citizen registrations recorded with no connection.
 *
 * `wizard-storage` already keeps a *draft* alive across a dropped tab, and it
 * uses localStorage because a draft is small, single, and disposable. This is
 * the other problem: a field officer works a settlement for three hours with no
 * signal and finishes thirty complete registrations. Those are not drafts —
 * they are finished records, and losing one is losing a household's afternoon.
 * So they go to IndexedDB, which is transactional, has room for thirty of them,
 * and does not silently evict the way a full localStorage does.
 *
 * Written against the raw IndexedDB API rather than pulling in `idb`: this is
 * one object store with five operations, the wrapper would be most of what the
 * dependency does, and every byte of this ships to a phone on a bad connection.
 */

const DB_NAME = 'mechanization.offline';
/**
 * Deliberately still 1, and adding a field to the payload is not a reason to
 * change it.
 *
 * The store keeps whole submissions under `payload`, whose sections are opaque
 * records — IndexedDB is storing a structured clone of an object, not rows in
 * a typed table, so a new field like `unitStatus` needs no schema change to be
 * written or read. Bumping the version would buy nothing and cost something
 * real: an upgrade blocks while another tab holds the old connection, and
 * `onblocked` below turns that into "no queue available" for an officer who
 * happens to have two tabs open — exactly the person this store exists for.
 *
 * What a new field *does* need is a server that accepts its absence, because
 * records queued before it existed are still on phones and will arrive without
 * it. That is a schema default, not a database version; see `unitStatusField`,
 * which is optional, and `FieldFlag.kind`, which solved the identical problem
 * with `.default()`.
 *
 * Change this only for a change IndexedDB itself has to know about: a new
 * object store, a new index, or a key path that moves.
 *
 * **Bumped to 2 by P3-T8**, which is exactly that case: buildings created
 * offline need their own store. The upgrade is additive — the citizen store and
 * everything in it is untouched — so a phone carrying thirty queued
 * registrations opens the new version and still has all thirty.
 */
const DB_VERSION = 2;
const STORE = 'citizenSubmissions';
const BUILDING_STORE = 'buildingSubmissions';

/** Groups a queue read by municipality without scanning every record. */
const TENANT_INDEX = 'by-tenant';

export type QueuedStatus =
  /** Waiting for a connection. Retried automatically, forever. */
  | 'pending'
  /**
   * The server refused it, and would refuse it again.
   *
   * A 4xx that is not an expired session — a validation failure, a duplicate
   * identity document, a property type this municipality does not accept.
   * Retrying is pointless and would hide the problem behind a spinner, so the
   * record stops here and is shown to a human with what the server said.
   */
  | 'blocked';

export interface QueuedSubmission {
  /**
   * The `clientSubmissionId` the server deduplicates on.
   *
   * Minted here, before the first send, and never regenerated — that is the
   * whole point. A record whose response was lost to the same bad connection
   * that queued it is re-sent under the same id and recognised, rather than
   * registering the household twice.
   */
  id: string;
  tenant: string;
  /** What the record will be called in the queue list, before it has an id. */
  displayName: string;
  payload: {
    personal: Record<string, unknown>;
    contact: Record<string, unknown>;
    properties: Array<Record<string, unknown>>;
    flags: FieldFlag[];
  };
  status: QueuedStatus;
  savedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  /** What the server or the network said last, verbatim, for the queue list. */
  lastError: string | null;
}

/** Nothing here works server-side, and Next renders these pages there first. */
export function offlineStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (connection) return connection;

  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    /*
      Additive and idempotent, so it is correct from any earlier version.

      Written as "create what is missing" rather than switching on
      `event.oldVersion`: a device that has never opened the app and one that
      has been queueing registrations for a week take the same path, and there
      is no branch that only runs on an upgrade nobody has tested.
    */
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [STORE, BUILDING_STORE]) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        store.createIndex(TENANT_INDEX, 'tenant', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    /*
      Another tab is holding the old version open during an upgrade.

      Rejecting rather than hanging: every caller here treats a failure as "no
      queue available" and falls back to sending online, which is the right
      answer for a browser that cannot open the store at all.
    */
    request.onblocked = () => reject(new Error('offline queue is open in another tab'));
  });

  // A failed open must not be cached as the connection, or the queue stays
  // broken for the life of the page even after the condition clears.
  connection.catch(() => {
    connection = null;
  });

  return connection;
}

/** One transaction against one store, promisified. */
function runOn<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = work(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

/** The citizen store, which is what every pre-existing caller means. */
function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runOn(STORE, mode, work);
}

/** Queues a finished registration. Resolves once it is durably stored. */
export async function enqueue(submission: QueuedSubmission): Promise<void> {
  await run('readwrite', (store) => store.put(submission));
}

/** Everything still waiting for this municipality, oldest first. */
export async function listQueued(tenant: string): Promise<QueuedSubmission[]> {
  const rows = await run<QueuedSubmission[]>('readonly', (store) =>
    store.index(TENANT_INDEX).getAll(tenant),
  );
  return rows.sort((a, b) => a.savedAt - b.savedAt);
}

/** One queued record by id — for an officer opening it to correct it. */
export async function getQueued(id: string): Promise<QueuedSubmission | null> {
  const result = await run<QueuedSubmission | undefined>('readonly', (store) => store.get(id));
  return result ?? null;
}

/** Removes a record the server has accepted. */
export async function dequeue(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id));
}

/**
 * Read-modify-write inside a single transaction.
 *
 * Not `put` of a whole record held in memory: two tabs may be draining the
 * same queue, and the loser of that race must not resurrect a record the
 * winner has just deleted. A record that is gone by the time this reads it is
 * left gone — resolving `false` rather than silently doing nothing, so a
 * caller correcting a record that was delivered a moment earlier can say so
 * rather than claim a save that never happened.
 */
async function updateOn<T extends { id: string }>(
  storeName: string,
  id: string,
  patch: (existing: T) => T,
): Promise<boolean> {
  const db = await open();
  let found = false;

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const read = store.get(id);

    read.onsuccess = () => {
      const existing = read.result as T | undefined;
      if (existing) {
        found = true;
        store.put(patch(existing));
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return found;
}

/** The citizen store's read-modify-write, which is what the callers below mean. */
function update(
  id: string,
  patch: (existing: QueuedSubmission) => QueuedSubmission,
): Promise<boolean> {
  return updateOn(STORE, id, patch);
}

/** Records the outcome of one delivery attempt. */
export function recordAttempt(
  id: string,
  outcome: { status: QueuedStatus; error: string | null },
): Promise<boolean> {
  return update(id, (existing) => ({
    ...existing,
    status: outcome.status,
    attempts: existing.attempts + 1,
    lastAttemptAt: Date.now(),
    lastError: outcome.error,
  }));
}

/**
 * Puts a blocked record back in line — the officer has said to try again.
 *
 * Offered because "blocked" is a judgement about the *last* attempt: a
 * rejection for a duplicate identity document stops being true once the
 * duplicate is deleted, and a municipality that enables a property type makes
 * a previously refused registration valid without anyone editing it. It does
 * not count as an attempt, because nothing has been attempted yet.
 */
export function retryLater(id: string): Promise<boolean> {
  return update(id, (existing) => ({ ...existing, status: 'pending', lastError: null }));
}

/**
 * Replaces a queued record's payload — an officer correcting the field the
 * server rejected, or one they caught before it was ever sent.
 *
 * Goes back to `pending` with its error cleared: whatever the reason was, the
 * officer has just acted on it, and leaving the record in `blocked` next to a
 * complaint that may no longer even apply would read as though the edit had
 * not registered at all.
 *
 * `savedAt` and `attempts` are left untouched — they are the record's own
 * history (when it was first filed, how many times it has been tried), not
 * something a correction should erase.
 */
export function reviseQueued(
  id: string,
  patch: { payload: QueuedSubmission['payload']; displayName: string },
): Promise<boolean> {
  return update(id, (existing) => ({
    ...existing,
    payload: patch.payload,
    displayName: patch.displayName,
    status: 'pending',
    lastError: null,
  }));
}

// ─────────────────────  Buildings created offline (P3-T8)  ─────────────────────

/**
 * A building an officer created on a phone with no signal.
 *
 * Separate from the citizen queue rather than folded into it, because the two
 * are different records with different failure modes and — the part that
 * matters — a different *order*. A queued registration may carry the
 * `buildingId` of a building that is also still queued, so the buildings have
 * to land first or the registration references a row that does not exist yet.
 * One store per kind is what lets `syncQueue` say that plainly.
 *
 * `id` is minted before the first send and is also the row's primary key
 * server-side (`clientSubmissionId` → `Building.id`), which is what makes a
 * re-delivered creation idempotent: the second attempt finds the building it
 * already made rather than putting a second structure on the parcel.
 */
export interface QueuedBuilding {
  id: string;
  tenant: string;
  /** رقم العقار, for the queue list — the one thing that names it before a code. */
  parcelNumber: string;
  /**
   * The code the phone showed while offline, e.g. `A-1042-B مؤقت`.
   *
   * Computed from whatever the device had cached, so two officers on the same
   * parcel will both compute the same one. It is never authoritative — see
   * `reconciledCode` — and the badge beside it says so.
   */
  provisionalCode: string;
  /** The suffix half of the above, sent so the server can say whether it changed. */
  provisionalSuffix: string;
  payload: {
    parcelNumber: string;
    name?: string;
    postedNumber?: string;
    structureType: string;
    /** Permitted / going up / standing / abandoned / gone. See `BUILDING_LIFECYCLE`. */
    lifecycleStatus?: string;
    latitude?: number;
    longitude?: number;
    floorsCount?: number;
    notes?: string;
    /**
     * Carried because the officer was shown the parcel's existing structures
     * *before* the record was queued, and answered.
     *
     * Without it the server would refuse this creation on delivery — hours
     * later, with nobody at the screen to answer the question again.
     */
    acknowledgedDuplicates?: boolean;
  };
  /** The matrix to generate once the shell exists, if the officer asked for one. */
  blueprint: unknown | null;
  status: QueuedBuildingStatus;
  savedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  /**
   * What the server actually allocated, once it has.
   *
   * Set only when it differs from `provisionalCode`. The record is kept — not
   * deleted — precisely so this survives a page reload: an officer who wrote
   * `A-1042-A` on a form in somebody's stairwell has to be told it became
   * `A-1042-B`, and a notice that vanished with the tab would not tell them.
   */
  reconciledCode?: string;
}

export type QueuedBuildingStatus =
  | 'pending'
  | 'blocked'
  /**
   * Delivered, and the code changed. Kept until the officer dismisses it.
   *
   * A delivered building whose code did *not* change is simply removed — there
   * is nothing to tell anyone.
   */
  | 'reconciled';

/** Queues a building created with no connection. */
export async function enqueueBuilding(building: QueuedBuilding): Promise<void> {
  await runOn(BUILDING_STORE, 'readwrite', (store) => store.put(building));
}

/** Everything still waiting, or waiting to be read, for this municipality. */
export async function listQueuedBuildings(tenant: string): Promise<QueuedBuilding[]> {
  const rows = await runOn<QueuedBuilding[]>(BUILDING_STORE, 'readonly', (store) =>
    store.index(TENANT_INDEX).getAll(tenant),
  );
  return rows.sort((a, b) => a.savedAt - b.savedAt);
}

export async function dequeueBuilding(id: string): Promise<void> {
  await runOn(BUILDING_STORE, 'readwrite', (store) => store.delete(id));
}

/** Records one delivery attempt's outcome, or its reconciliation. */
export function updateQueuedBuilding(
  id: string,
  patch: Partial<Pick<QueuedBuilding, 'status' | 'lastError' | 'reconciledCode'>> & {
    countAttempt?: boolean;
  },
): Promise<boolean> {
  return updateOn(BUILDING_STORE, id, (existing: QueuedBuilding) => ({
    ...existing,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    ...(patch.reconciledCode !== undefined ? { reconciledCode: patch.reconciledCode } : {}),
    ...(patch.countAttempt
      ? { attempts: existing.attempts + 1, lastAttemptAt: Date.now() }
      : {}),
  }));
}
