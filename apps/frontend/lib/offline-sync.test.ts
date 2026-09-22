import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offline delivery engine.
 *
 * What makes this worth testing carefully is not complexity, it is that its
 * failures are silent and destructive in the same breath. An officer registers
 * households in a village with no signal; the records live in IndexedDB until
 * a connection returns. A bug here does not throw — it drops a family's
 * registration, or delivers it twice under two reference numbers, and the only
 * person who could notice is standing in a different village.
 *
 * Three behaviours carry most of that risk, and each has its own block below:
 *
 * - **The retry/park decision.** Retrying a refusal forever hides it behind a
 *   spinner; parking a network failure abandons a record that was fine.
 * - **Ordering.** Buildings must land before the registrations that name them,
 *   or the registration fails a foreign key it was right about.
 * - **Reconciliation.** A building's code can change on delivery, and the
 *   officer has to be told rather than have it swapped underneath them.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/*
  `ApiRequestError` is imported from the real module rather than faked.

  `isRetryable` and the drain loops both branch on `caught instanceof
  ApiRequestError`, so a stand-in class would take the `!(caught instanceof
  ApiRequestError) -> retry` path on every error and every one of the parking
  tests would pass for the wrong reason — the exact shape of test that looks
  like coverage and is not.
*/
const { ApiRequestError } = await vi.importActual<typeof import('./api-client')>('./api-client');

const createCitizen = vi.fn();
const createBuilding = vi.fn();
const generateUnits = vi.fn();
const logApiError = vi.fn();

vi.mock('./api-client', async () => {
  const actual = await vi.importActual<typeof import('./api-client')>('./api-client');
  return {
    ...actual,
    createCitizen: (...args: unknown[]) => createCitizen(...args),
    createBuilding: (...args: unknown[]) => createBuilding(...args),
    generateUnits: (...args: unknown[]) => generateUnits(...args),
    logApiError: (...args: unknown[]) => logApiError(...args),
  };
});

const loadSession = vi.fn();
vi.mock('./session', () => ({
  loadSession: (...args: unknown[]) => loadSession(...args),
  clearSession: vi.fn(),
  saveSession: vi.fn(),
}));

/**
 * A stand-in for IndexedDB that behaves like the store rather than like a set
 * of spies.
 *
 * The drain re-reads the queue between steps — `listQueued` is called again
 * after the buildings are delivered — so a mock returning a fixed array would
 * hide any bug where a record is delivered twice or a dequeue does not stick.
 * Backing it with a Map means "was this row actually removed" is a real
 * question the tests can ask.
 */
const submissions = new Map<string, Record<string, unknown>>();
const buildings = new Map<string, Record<string, unknown>>();
let storageAvailable = true;

vi.mock('./offline-db', () => ({
  offlineStorageAvailable: () => storageAvailable,

  enqueue: vi.fn(async (item: { id: string }) => {
    submissions.set(item.id, { ...item });
  }),
  listQueued: vi.fn(async (tenant: string) =>
    [...submissions.values()].filter((item) => item.tenant === tenant),
  ),
  getQueued: vi.fn(async (id: string) => submissions.get(id) ?? null),
  dequeue: vi.fn(async (id: string) => {
    submissions.delete(id);
  }),
  recordAttempt: vi.fn(async (id: string, patch: { status: string; error: string }) => {
    const item = submissions.get(id);
    if (!item) return false;
    submissions.set(id, {
      ...item,
      status: patch.status,
      lastError: patch.error,
      attempts: (item.attempts as number) + 1,
    });
    return true;
  }),
  retryLater: vi.fn(async (id: string) => {
    const item = submissions.get(id);
    if (!item) return false;
    submissions.set(id, { ...item, status: 'pending', lastError: null });
    return true;
  }),
  reviseQueued: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const item = submissions.get(id);
    if (!item) return false;
    submissions.set(id, { ...item, ...patch, status: 'pending' });
    return true;
  }),

  enqueueBuilding: vi.fn(async (item: { id: string }) => {
    buildings.set(item.id, { ...item });
  }),
  listQueuedBuildings: vi.fn(async (tenant: string) =>
    [...buildings.values()].filter((item) => item.tenant === tenant),
  ),
  dequeueBuilding: vi.fn(async (id: string) => {
    buildings.delete(id);
  }),
  updateQueuedBuilding: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const item = buildings.get(id);
    if (!item) return false;
    buildings.set(id, { ...item, ...patch });
    return true;
  }),
}));

const {
  acknowledgeBuilding,
  discardSubmission,
  getQueuedSubmission,
  queueBuilding,
  queueSubmission,
  refreshQueue,
  retrySubmission,
  reviseSubmission,
  syncQueue,
} = await import('./offline-sync');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'zahle';

/** A staff session — the only kind that may deliver anything. */
const STAFF_SESSION = {
  accessToken: 'token-abc',
  user: { kind: 'STAFF', name: 'Clerk' },
};

function submissionPayload() {
  return {
    personal: { fullName: 'Test Person' },
    contact: {},
    properties: [],
    flags: [],
  };
}

/** Seeds a queued registration directly, bypassing `queueSubmission`. */
function seedSubmission(id: string, overrides: Record<string, unknown> = {}) {
  submissions.set(id, {
    id,
    tenant: TENANT,
    displayName: `Record ${id}`,
    payload: submissionPayload(),
    status: 'pending',
    savedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  });
}

function seedBuilding(id: string, overrides: Record<string, unknown> = {}) {
  buildings.set(id, {
    id,
    tenant: TENANT,
    parcelNumber: '1042',
    provisionalCode: 'A-1042-B',
    provisionalSuffix: 'B',
    payload: { parcelNumber: '1042', structureType: 'RESIDENTIAL' },
    blueprint: null,
    status: 'pending',
    savedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  });
}

/** The shape `createBuilding` resolves with. */
function buildingResponse(overrides: Record<string, unknown> = {}) {
  return {
    building: { id: 'server-building-1', code: 'A-1042-B' },
    reconciled: false,
    deduplicated: false,
    ...overrides,
  };
}

beforeEach(() => {
  submissions.clear();
  buildings.clear();
  storageAvailable = true;
  (globalThis.navigator as { onLine: boolean }).onLine = true;
  loadSession.mockReturnValue(STAFF_SESSION);
  createCitizen.mockResolvedValue({ citizenId: 'c1', deduplicated: false });
  createBuilding.mockResolvedValue(buildingResponse());
  generateUnits.mockResolvedValue({ created: 0, skipped: 0, units: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('queueSubmission', () => {
  it('stores the record as pending and returns the id it was stored under', async () => {
    const id = await queueSubmission({
      tenant: TENANT,
      displayName: 'Ahmad',
      payload: submissionPayload(),
    } as never);

    const stored = submissions.get(id);
    expect(stored).toMatchObject({ id, tenant: TENANT, status: 'pending', attempts: 0 });
  });

  it('mints a distinct id per record', async () => {
    // The server's unique index on `clientSubmissionId` turns a collision into
    // one household's registration silently answering for another's, so this
    // is the assertion behind that whole comment in `newSubmissionId`.
    const ids = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      ids.add(
        await queueSubmission({
          tenant: TENANT,
          displayName: 'x',
          payload: submissionPayload(),
        } as never),
      );
    }
    expect(ids.size).toBe(50);
  });

  it('falls back to getRandomValues when randomUUID is unavailable', async () => {
    /*
      The plain-http case, which is the deployment this feature is for.

      `crypto.randomUUID` exists only in a secure context, and a municipality
      reaching the portal over http on its own network has no `randomUUID` — so
      this fallback is the *only* path in that deployment, not an edge case.
    */
    const original = crypto.randomUUID;
    // @ts-expect-error — deliberately removing it to exercise the fallback.
    crypto.randomUUID = undefined;

    try {
      const id = await queueSubmission({
        tenant: TENANT,
        displayName: 'x',
        payload: submissionPayload(),
      } as never);

      // A well-formed v4 UUID: version nibble 4, variant nibble 8/9/a/b.
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      crypto.randomUUID = original;
    }
  });
});

describe('syncQueue — the session gate', () => {
  it('reports authRequired instead of failing every record against a dead token', async () => {
    loadSession.mockReturnValue(null);
    seedSubmission('a');

    await syncQueue(TENANT);

    // Nothing sent, and — the point — nothing written onto the records. The
    // fact is about the session, not about any one registration.
    expect(createCitizen).not.toHaveBeenCalled();
    expect(submissions.get('a')).toMatchObject({ status: 'pending', lastError: null });
  });

  it('refuses to deliver under a citizen session', async () => {
    // A shared tablet where a citizen signed in to check their own fees must
    // not become the identity that files an officer's backlog.
    loadSession.mockReturnValue({ accessToken: 't', user: { kind: 'CITIZEN' } });
    seedSubmission('a');

    await syncQueue(TENANT);

    expect(createCitizen).not.toHaveBeenCalled();
  });

  it('does nothing at all when offline storage is unavailable', async () => {
    storageAvailable = false;
    seedSubmission('a');

    await syncQueue(TENANT);

    expect(createCitizen).not.toHaveBeenCalled();
  });
});

describe('syncQueue — delivering registrations', () => {
  it('sends the queued id as clientSubmissionId, not a fresh one', async () => {
    /*
      The single most important assertion in this file.

      The id minted when the record was saved is what makes a re-delivery —
      after a response was lost to the same bad connection that queued it —
      recognised as a duplicate instead of registering the household twice.
      Sending a new id on retry would produce two reference numbers for one
      family, and nothing downstream could tell they were the same people.
    */
    seedSubmission('queued-id-1');

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledWith(
      TENANT,
      STAFF_SESSION.accessToken,
      expect.objectContaining({ clientSubmissionId: 'queued-id-1' }),
    );
  });

  it('removes a delivered record from the queue', async () => {
    seedSubmission('a');

    await syncQueue(TENANT);

    expect(submissions.has('a')).toBe(false);
  });

  it('delivers in the order the records were filed', async () => {
    seedSubmission('first', { savedAt: 1 });
    seedSubmission('second', { savedAt: 2 });

    await syncQueue(TENANT);

    const sentIds = createCitizen.mock.calls.map((call) => call[2].clientSubmissionId);
    expect(sentIds).toEqual(['first', 'second']);
  });

  it('skips records that are blocked rather than pending', async () => {
    seedSubmission('blocked', { status: 'blocked' });
    seedSubmission('pending');

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledTimes(1);
    expect(submissions.has('blocked')).toBe(true);
  });

  it('re-reads the token per record, so one exchange serves the whole drain', async () => {
    /*
      Staff tokens are short now and `apiFetch` exchanges them mid-flight,
      writing the new one back to storage. A drain that kept the token it
      started with would present a stale one for every remaining record — each
      costing a 401 and an exchange that had already happened, thirty times over
      on a thirty-record backlog, on exactly the connection this feature exists
      for.
    */
    seedSubmission('a', { savedAt: 1 });
    seedSubmission('b', { savedAt: 2 });

    // The token changes between the two records, as an exchange would change it.
    loadSession
      .mockReturnValueOnce(STAFF_SESSION) // the drain's own session read
      .mockReturnValueOnce(STAFF_SESSION) // record a
      .mockReturnValue({ ...STAFF_SESSION, accessToken: 'token-refreshed' });

    await syncQueue(TENANT);

    const tokensUsed = createCitizen.mock.calls.map((call) => call[1]);
    expect(tokensUsed).toEqual(['token-abc', 'token-refreshed']);
  });

  it('falls back to the drain session when storage was cleared mid-drain', async () => {
    // Another tab signed out. The record in flight is still attempted rather
    // than sent with an empty token.
    seedSubmission('a');
    loadSession.mockReturnValueOnce(STAFF_SESSION).mockReturnValue(null);

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledWith(
      TENANT,
      STAFF_SESSION.accessToken,
      expect.anything(),
    );
  });

  it('stops before sending anything when the browser reports no connection', async () => {
    (globalThis.navigator as { onLine: boolean }).onLine = false;
    seedSubmission('a');

    await syncQueue(TENANT);

    expect(createCitizen).not.toHaveBeenCalled();
  });
});

describe('syncQueue — retry versus park', () => {
  /** Builds the error the api-client would have thrown for a given status. */
  function apiError(status: number, message = 'refused') {
    return new ApiRequestError(status, { code: 'X', message });
  }

  it.each([
    [500, 'a server fault'],
    [503, 'an unavailable service'],
    [429, 'rate limiting'],
    [408, 'a request timeout'],
    [0, 'no network at all'],
  ])('keeps the record pending after %i (%s)', async (status) => {
    seedSubmission('a');
    createCitizen.mockRejectedValue(apiError(status));

    await syncQueue(TENANT);

    // Still queued, attempt counted, and available to the next drain.
    expect(submissions.get('a')).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it.each([
    [400, 'a malformed payload'],
    [404, 'a parcel that does not exist'],
    [409, 'a conflicting registration'],
    [422, 'a validation failure'],
  ])('parks the record as blocked after %i (%s)', async (status) => {
    /*
      The server read this and said no. It will say no again, identically, on
      every future attempt — so retrying only buries the reason under a
      spinner. The record is parked for a person to look at.
    */
    seedSubmission('a');
    createCitizen.mockRejectedValue(apiError(status, 'رقم العقار غير موجود'));

    await syncQueue(TENANT);

    expect(submissions.get('a')).toMatchObject({
      status: 'blocked',
      lastError: 'رقم العقار غير موجود',
    });
  });

  it('keeps a record pending after a 401, because the record is fine', async () => {
    // The session expired while the phone was in a bag. Nothing is wrong with
    // the registration.
    seedSubmission('a');
    createCitizen.mockRejectedValue(apiError(401));

    await syncQueue(TENANT);

    expect(submissions.get('a')).toMatchObject({ status: 'pending' });
  });

  it('treats a non-API error as retryable rather than discarding the record', async () => {
    seedSubmission('a');
    createCitizen.mockRejectedValue(new TypeError('boom'));

    await syncQueue(TENANT);

    expect(submissions.get('a')).toMatchObject({ status: 'pending' });
  });

  it('stops the drain on a 401 instead of burning the rest of the queue', async () => {
    /*
      Thirty rows each carrying the same «انتهت الجلسة» explain nothing that one
      does — and each failed attempt is a write. Stopping leaves the queue
      readable and the remaining records untouched.
    */
    seedSubmission('a', { savedAt: 1 });
    seedSubmission('b', { savedAt: 2 });
    seedSubmission('c', { savedAt: 3 });
    createCitizen.mockRejectedValue(apiError(401));

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledTimes(1);
    expect(submissions.get('b')).toMatchObject({ attempts: 0, lastError: null });
    expect(submissions.get('c')).toMatchObject({ attempts: 0, lastError: null });
  });

  it('stops the drain when the network drops mid-queue', async () => {
    seedSubmission('a', { savedAt: 1 });
    seedSubmission('b', { savedAt: 2 });
    createCitizen.mockRejectedValue(apiError(0));

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledTimes(1);
  });

  it('continues past a parked record to deliver the ones behind it', async () => {
    // A 409 is about *this* record. The next one may be perfectly deliverable,
    // and an officer's backlog should not be held up by one bad row.
    seedSubmission('bad', { savedAt: 1 });
    seedSubmission('good', { savedAt: 2 });
    createCitizen.mockRejectedValueOnce(apiError(409)).mockResolvedValueOnce({ citizenId: 'c' });

    await syncQueue(TENANT);

    expect(createCitizen).toHaveBeenCalledTimes(2);
    expect(submissions.get('bad')).toMatchObject({ status: 'blocked' });
    expect(submissions.has('good')).toBe(false);
  });
});

describe('syncQueue — concurrency', () => {
  it('joins an in-flight drain rather than sending everything twice', async () => {
    /*
      Two triggers arrive together in normal use: the `online` event fires as
      the signal returns and the officer taps «مزامنة الآن» at the same moment.
      Without the shared promise, both drains read the same pending rows before
      either had dequeued anything, and every record was delivered twice.
    */
    seedSubmission('a');

    /*
      The gate is built *before* the mock that waits on it, deliberately.

      Capturing `resolve` from inside `mockImplementation` only works if the
      implementation has actually run by the time the test releases it — and it
      has not, because `syncQueue` awaits several times before it ever reaches
      `createCitizen`. Releasing a resolver that is still the placeholder leaves
      the drain pending forever, and because the engine is module-level and
      keyed by tenant, `engine.draining` then stays set: every later test in the
      file awaits that same dead promise and times out. One hung test takes the
      suite with it.
    */
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    createCitizen.mockImplementation(async () => {
      await gate;
      return { citizenId: 'c' };
    });

    const first = syncQueue(TENANT);
    const second = syncQueue(TENANT);
    openGate();
    await Promise.all([first, second]);

    expect(createCitizen).toHaveBeenCalledTimes(1);
  });
});

describe('drainBuildings — ordering', () => {
  it('delivers buildings before registrations', async () => {
    /*
      A queued registration may carry the `buildingId` of a building that is
      also still queued, and the server resolves that id against a row that has
      to exist by then. The other order fails the registration on a foreign key
      it was right about.
    */
    const order: string[] = [];
    createBuilding.mockImplementation(async () => {
      order.push('building');
      return buildingResponse();
    });
    createCitizen.mockImplementation(async () => {
      order.push('citizen');
      return { citizenId: 'c' };
    });

    seedBuilding('b1');
    seedSubmission('s1');

    await syncQueue(TENANT);

    expect(order).toEqual(['building', 'citizen']);
  });

  it('sends the queued id as the building id, so a replay finds the same row', async () => {
    seedBuilding('building-id-1');

    await syncQueue(TENANT);

    expect(createBuilding).toHaveBeenCalledWith(
      TENANT,
      STAFF_SESSION.accessToken,
      expect.objectContaining({
        clientSubmissionId: 'building-id-1',
        provisionalSuffix: 'B',
      }),
    );
  });
});

describe('drainBuildings — reconciliation', () => {
  it('removes the record silently when the code did not change', async () => {
    seedBuilding('b1');
    createBuilding.mockResolvedValue(buildingResponse({ reconciled: false }));

    await syncQueue(TENANT);

    // Nothing changed, so there is nothing to tell anyone.
    expect(buildings.has('b1')).toBe(false);
  });

  it('keeps the record and marks it reconciled when the server assigned another code', async () => {
    /*
      §4.4. The phone showed a provisional code computed from what it had
      cached; the server re-allocated under a row lock and answered with a
      different one. Swapping it silently is how a resident ends up looking for
      a building that no longer exists under the name written on a form in
      their stairwell.
    */
    seedBuilding('b1');
    createBuilding.mockResolvedValue(
      buildingResponse({ reconciled: true, building: { id: 'srv', code: 'A-1042-D' } }),
    );

    await syncQueue(TENANT);

    expect(buildings.get('b1')).toMatchObject({
      status: 'reconciled',
      reconciledCode: 'A-1042-D',
      lastError: null,
    });
  });

  it('clears the notice only when the officer acknowledges it', async () => {
    // Not automatic: a notice that dismissed itself on the next drain is a
    // notice nobody read.
    seedBuilding('b1', { status: 'reconciled', reconciledCode: 'A-1042-D' });

    await syncQueue(TENANT);
    expect(buildings.has('b1')).toBe(true);

    await acknowledgeBuilding(TENANT, 'b1');
    expect(buildings.has('b1')).toBe(false);
  });

  it('parks a building the server refused', async () => {
    seedBuilding('b1');
    createBuilding.mockRejectedValue(new ApiRequestError(409, { code: 'X', message: 'مكرر' }));

    await syncQueue(TENANT);

    expect(buildings.get('b1')).toMatchObject({ status: 'blocked', lastError: 'مكرر' });
  });
});

describe('drainBuildings — the unit blueprint', () => {
  it('generates the matrix when one was asked for', async () => {
    seedBuilding('b1', { blueprint: { floors: 3, unitsPerFloor: 4 } });

    await syncQueue(TENANT);

    expect(generateUnits).toHaveBeenCalledWith(TENANT, STAFF_SESSION.accessToken, 'server-building-1', {
      floors: 3,
      unitsPerFloor: 4,
    });
  });

  it('still generates the matrix on a re-delivery the server recognised', async () => {
    /*
      A regression this used to have, and the reason the guard was removed.

      `createBuilding` commits, the connection drops before `generateUnits`
      runs, and the item goes back to `pending`. The retry is recognised as a
      duplicate — and the old code skipped the blueprint on that basis, then
      dequeued the record. The result was a building with zero units and
      nothing anywhere recording that twelve flats had been expected.

      `generateUnits` is additive and idempotent per floor, so sending it every
      time costs nothing; skipping it costs the whole matrix.
    */
    seedBuilding('b1', { blueprint: { floors: 3, unitsPerFloor: 4 } });
    createBuilding.mockResolvedValue(buildingResponse({ deduplicated: true }));

    await syncQueue(TENANT);

    expect(generateUnits).toHaveBeenCalledTimes(1);
  });

  it('does not call generateUnits when no matrix was asked for', async () => {
    seedBuilding('b1', { blueprint: null });

    await syncQueue(TENANT);

    expect(generateUnits).not.toHaveBeenCalled();
  });
});

describe('queueBuilding', () => {
  it('honours a caller-supplied id, because it is also the row id', async () => {
    // The registration queued alongside it already names this id.
    const id = await queueBuilding({
      id: 'chosen-id',
      tenant: TENANT,
      parcelNumber: '1042',
      provisionalCode: 'A-1042-B',
      provisionalSuffix: 'B',
      payload: { parcelNumber: '1042' },
    } as never);

    expect(id).toBe('chosen-id');
    expect(buildings.get('chosen-id')).toMatchObject({ status: 'pending' });
  });

  it('mints one when the caller has none', async () => {
    const id = await queueBuilding({
      tenant: TENANT,
      parcelNumber: '1042',
      provisionalCode: 'A-1042-B',
      provisionalSuffix: 'B',
      payload: { parcelNumber: '1042' },
    } as never);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('getQueuedSubmission', () => {
  it('returns the record for its own municipality', async () => {
    seedSubmission('a');
    await expect(getQueuedSubmission(TENANT, 'a')).resolves.toMatchObject({ id: 'a' });
  });

  it('refuses a record belonging to another municipality', async () => {
    /*
      Tenancy in this system is by Postgres schema, not by a column — but the
      offline queue is one IndexedDB store on one device, so this check is the
      only thing scoping it. A stale bookmark or a hand-typed id must not
      surface another municipality's queued record.
    */
    seedSubmission('a', { tenant: 'albazourieh' });
    await expect(getQueuedSubmission(TENANT, 'a')).resolves.toBeNull();
  });

  it('returns null when storage is unavailable rather than throwing', async () => {
    storageAvailable = false;
    await expect(getQueuedSubmission(TENANT, 'a')).resolves.toBeNull();
  });
});

describe('reviseSubmission', () => {
  it('replaces the payload and re-queues the record', async () => {
    seedSubmission('a', { status: 'blocked', lastError: 'رقم العقار غير موجود' });
    const corrected = { ...submissionPayload(), personal: { fullName: 'Corrected' } };
    // The immediate drain would deliver and dequeue the record, leaving nothing
    // to inspect — so the send is held offline to keep the revision observable.
    // What is under test here is the revision, not the delivery.
    (globalThis.navigator as { onLine: boolean }).onLine = false;

    await expect(reviseSubmission(TENANT, 'a', corrected as never, 'Corrected')).resolves.toBe(
      true,
    );

    expect(submissions.get('a')).toMatchObject({
      status: 'pending',
      displayName: 'Corrected',
      payload: corrected,
    });
  });

  it('tries to deliver the corrected record immediately', async () => {
    /*
      Without the drain here, a corrected record would sit as `pending` until
      the next `online` event or a manual «مزامنة» — which reads to the officer
      as though the edit changed nothing at all.
    */
    seedSubmission('a', { status: 'blocked', lastError: 'refused' });

    await reviseSubmission(TENANT, 'a', submissionPayload() as never, 'Corrected');
    // `reviseSubmission` fires the drain without awaiting it, so yield once.
    await vi.waitFor(() => expect(createCitizen).toHaveBeenCalledTimes(1));
  });

  it('reports honestly when another tab delivered the record first', async () => {
    // Between opening the edit screen and pressing save, a second tab's drain
    // delivered it. Claiming an update that never landed anywhere would be the
    // lie.
    await expect(
      reviseSubmission(TENANT, 'gone', submissionPayload() as never, 'x'),
    ).resolves.toBe(false);
  });
});

describe('retrySubmission and discardSubmission', () => {
  it('hands a blocked record back to the queue and tries it immediately', async () => {
    seedSubmission('a', { status: 'blocked', lastError: 'refused' });

    await retrySubmission(TENANT, 'a');

    expect(createCitizen).toHaveBeenCalledTimes(1);
    expect(submissions.has('a')).toBe(false);
  });

  it('abandons a record for good', async () => {
    seedSubmission('a');

    await discardSubmission(TENANT, 'a');

    expect(submissions.has('a')).toBe(false);
  });
});

describe('refreshQueue', () => {
  it('survives an IndexedDB failure instead of reporting an empty queue', async () => {
    /*
      A browser with IndexedDB disabled, or a store held open by another tab
      mid-upgrade. Nothing is lost — the records are still there — and
      reporting an empty queue would be the lie. The failure is logged and the
      call resolves.
    */
    const db = await import('./offline-db');
    vi.mocked(db.listQueued).mockRejectedValueOnce(new Error('InvalidStateError'));

    await expect(refreshQueue(TENANT)).resolves.toBeUndefined();
    expect(logApiError).toHaveBeenCalled();
  });

  it('does nothing when offline storage is unavailable', async () => {
    storageAvailable = false;
    const db = await import('./offline-db');

    await refreshQueue(TENANT);

    expect(db.listQueued).not.toHaveBeenCalled();
  });
});
