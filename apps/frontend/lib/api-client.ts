import { IMPORT_BATCH_SIZE, type ErrorParams } from '@mechanization/shared-schemas';
import { localizeApiError } from './api-errors';
import { cachedRequest, invalidateRequests, peekCachedRequest } from './request-cache';
import type {
  BackupSchedule,
  CitizenImportResult,
  CitizenMergePreview,
  CitizenMergeRecord,
  CitizenMergeResult,
  CitizenUnmergePreview,
  CaseStatus,
  CaseType,
  CitizenRecordStatus,
  CitizenResidence,
  CurrencyCode,
  DamageLevel,
  DamageSource,
  DuplicateMatchedOn,
  FeeAssessment,
  FeeAssessmentLine,
  FeeBasis,
  FeeBearer,
  FeeFrequency,
  FieldFlag,
  ImportRow,
  InspectorPayoutItem,
  InspectorProfileResponse,
  NumberingSequence,
  OccupancyEndReason,
  OccupancyRole,
  PaymentMethod,
  PossibleDuplicateMatch,
  PossibleDuplicatesQuery,
  PaymentStatus,
  RecordInspectorPayoutInput,
  SequenceKey,
  SettlePayment,
  BuildingLifecycle,
  StructureType,
  SurveyStatus,
  UnitStatus,
  UnitType,
  VacancyBasis,
  VacancyEndReason,
} from '@mechanization/shared-schemas';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export interface ApiError {
  /**
   * A specific code from `ERROR_CODES` (translated by `localizeApiError`), or
   * the kind for a refusal the API has not given a code yet.
   */
  code: string;
  /** `CONFLICT`, `VALIDATION_FAILED`, … — absent from an API older than the error codes. */
  kind?: string;
  /** For logs, and the text shown only when the code has no translation. */
  message: string;
  /** The values the translated message fills in. */
  params?: ErrorParams;
  /**
   * Whatever the caller has to look at before it can decide.
   *
   * Two shapes, and they are not interchangeable: a validation failure sends an
   * array of field paths, and a conflict sends an object describing what it
   * collided with. Typed as the union rather than the array alone because the
   * server has been able to send both since the duplicate-building guard
   * shipped — and `fieldErrors` below used to call `.map` on it unconditionally,
   * which turned a conflict into a `TypeError` in the catch block meant to
   * display it.
   */
  details?: { path: string; message: string }[] | Record<string, unknown>;
  correlationId?: string;
}

/**
 * A structure already standing on the parcel a new building is being created on.
 *
 * Sent with the refusal so the "is this a different building?" dialog can show
 * what is there without a second request — which matters most on exactly the
 * offline phone least able to make one.
 */
export interface DuplicateBuildingCandidate {
  id: string;
  code: string;
  name: string | null;
  postedNumber: string | null;
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  unitsTotal: number;
  latitude: number | null;
  longitude: number | null;
  /**
   * Metres from the pin being proposed, or null when either side has no pin.
   *
   * Never 0 for "we cannot tell". "There is another building here" is a shrug;
   * "there is another building fifteen metres away called بناية النور" is a
   * decision, and an unknown distance rendered as zero would talk an officer
   * out of recording a structure that really exists.
   */
  distanceMetres: number | null;
  /** The عقار this building is filed under — the one its code names. */
  ownParcelNumber?: string;
  /**
   * The building is on the parcel being checked as a *shared* one: filed under
   * `ownParcelNumber`, and covering this parcel too. Said in the dialog, because
   * a candidate whose code names a different parcel reads as a mistake otherwise.
   */
  sharesParcel?: boolean;
}

/**
 * The candidates carried by a duplicate-building refusal, or null for any other
 * error.
 *
 * A function rather than a getter on `ApiRequestError`, so the narrowing is
 * visible at the call site: everything below the `if` knows it is holding a
 * duplicate prompt rather than a failed save.
 */
export function duplicateBuildingsOf(caught: unknown): DuplicateBuildingCandidate[] | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;

  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;

  const candidates = (details as { candidates?: unknown }).candidates;
  return Array.isArray(candidates) ? (candidates as DuplicateBuildingCandidate[]) : null;
}

/** One unit already standing on the floor a new one is being added to. */
export interface DuplicateUnitCandidate {
  id: string;
  unitCode: string;
  unitType: UnitType;
  floor: number;
  side: string | null;
  unitArea: number | null;
  postedNumber: string | null;
  unitStatus: UnitStatus | null;
  surveyStatus: SurveyStatus;
  /**
   * Who is in it now. The fact that actually settles the question — a floor
   * with one محل whose مستأجر is already named is a floor where «إضافة وحدة»
   * is almost certainly the wrong button, and no amount of code and area says
   * that as directly as a name does.
   */
  occupants: Array<{ role: OccupancyRole; citizenName: string | null }>;
}

/**
 * The units carried by a duplicate-unit refusal, or null for any other error.
 *
 * The twin of `duplicateBuildingsOf`, and narrowed the same way for the same
 * reason. Told apart from it by shape — a building candidate carries `code`, a
 * unit carries `unitCode` — so a caller that asks the wrong question gets null
 * rather than a list it will render as the wrong thing.
 */
export function duplicateUnitsOf(caught: unknown): DuplicateUnitCandidate[] | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;

  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;

  const candidates = (details as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;

  return candidates.every(
    (row) => row && typeof row === 'object' && 'unitCode' in row && 'occupants' in row,
  )
    ? (candidates as DuplicateUnitCandidate[])
    : null;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(localizeApiError(payload));
    // `.message` is the text a screen shows: the translated code, or the
    // server's own message where there is no translation (`lib/api-errors.ts`).
    // It stays the plain, citizen/staff-facing text shown in the UI —
    // `.name` is what Error's own `toString()` (and every console.error /
    // uncaught-exception overlay) prefixes it with, so logging this anywhere
    // reads as "error (404): <message>" without a second formatted string to
    // keep in sync.
    this.name = status === 0 ? 'error (network)' : `error (${status})`;
  }

  /**
   * Field-level messages, keyed by path, for highlighting the offending input.
   *
   * Empty for a `details` that is not the array shape — a conflict's payload
   * describes what was collided with, not which input was wrong, and there is
   * no field on the form to attach it to.
   */
  /** The specific code, or the kind for an untranslated refusal. */
  get code(): string {
    return this.payload.code;
  }

  /**
   * What kind of refusal this is — `CONFLICT`, `VALIDATION_FAILED`, … Branch
   * on this, not on `code`: a converted throw site sends a specific code, and
   * an API from before the error codes sends the kind as the code.
   */
  get kind(): string {
    return this.payload.kind ?? this.payload.code;
  }

  get fieldErrors(): Record<string, string> {
    const details = this.payload.details;
    if (!Array.isArray(details)) return {};
    return Object.fromEntries(details.map((detail) => [detail.path, detail.message]));
  }
}

/**
 * Console-log any caught error in a consistent, scannable shape —
 * `error (404): <message>` for a failed request, or the error as-is for
 * anything that isn't an `ApiRequestError`. Call this at the top of every
 * catch block around a `getX`/`postX`/`deleteX` call: today those are caught
 * and turned straight into a UI banner with nothing printed anywhere, so a
 * failing request is invisible to whoever is debugging it unless they
 * reproduce it by hand.
 */
export function logApiError(caught: unknown): void {
  console.error(caught);
  reportApiError(caught);
}

/**
 * Forwards the failures that mean a bug, and drops the ones that mean the
 * system is working.
 *
 * `logApiError` is called from every catch block in the app, so it is the one
 * funnel every API failure already passes through — which makes it the right
 * place to report from, and the wrong place to report *everything* from. The
 * filtering below is the whole value of this function:
 *
 * - **`status === 0`** — no connection. This is the single most common error
 *   this app produces and it is not an error: the portal is built for officers
 *   working off a phone in a village with no signal, and the offline queue in
 *   `lib/offline-sync.ts` treats it as the expected case. Reporting it would
 *   bury everything else under the condition the app was designed around.
 * - **401** — an expired session. Handled everywhere by redirecting to the
 *   login page; it happens to every staff member every morning.
 * - **Other 4xx** — the server read the request and refused it. A 404 on a
 *   citizen who was never registered and a 409 on a duplicate filing are the
 *   rules working. They are also, by volume, almost all of what this sees.
 *
 * What is left is 5xx and anything that is not an `ApiRequestError` at all —
 * a `TypeError` from a bad assumption about a response shape, an IndexedDB
 * failure inside the queue. Those are bugs.
 *
 * The API reports its own 5xx from `DomainExceptionFilter`, so a server fault
 * arrives twice — once from each side. That is deliberate rather than
 * redundant: the two carry different halves of the story, and the pair is what
 * shows an error the API thinks it handled but the browser could not act on.
 */
function reportApiError(caught: unknown): void {
  if (caught instanceof ApiRequestError) {
    if (caught.status < 500) return;
  }

  /*
    Imported where it is used rather than at the top of the file.

    `api-client.ts` is imported by nearly every screen in the portal; a
    top-level `import * as Sentry` would put the SDK in the first chunk any of
    them loads, on an app whose users are frequently on a phone connection slow
    enough that the offline queue exists. This way the SDK is fetched when
    something has actually gone wrong, and a `void` on the promise keeps the
    caller's catch block synchronous — `logApiError` is called from paths that
    must not start awaiting anything.
  */
  void import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.captureException(caught);
    })
    .catch(() => {
      // The reporter failing has nowhere useful to report to. The
      // `console.error` above already happened, which is the floor.
    });
}

// ───────────────────────────  The staff session  ───────────────────────────

/**
 * What a screen sees when a session could not be renewed *for now*.
 *
 * Status 0 on purpose. It is the status every screen and the offline queue
 * already read as "no connection": the queue stops its drain and keeps the
 * record, a form keeps what was typed, and nothing clears the stored session on
 * it. That is the whole point. A refresh that timed out, was throttled or met a
 * 5xx says nothing about whether the session is still good, and reporting it as
 * the original 401 would sign a clerk out because the API was restarting.
 */
function refreshUnavailable(): ApiRequestError {
  return new ApiRequestError(0, {
    code: 'SESSION_REFRESH_UNAVAILABLE',
    message: 'تعذّر تجديد الجلسة. تحقّق من الاتصال وحاول مرة أخرى.',
  });
}

/**
 * `AbortSignal.timeout`, with a fallback for the browsers that lack it.
 *
 * Safari only gained it in version 16. On an older one the call would throw a
 * `TypeError` before the request left, the exchange would report that as
 * "unavailable", and the session could never be renewed on that device at all.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * The account a JWT names — its `sub`, read without verifying anything.
 *
 * Only ever used to *refuse*: an exchange whose failing token and stored session
 * name different accounts does nothing at all. Nothing is granted on the
 * strength of it, so an unverified read is enough; the server verifies the
 * token itself on every request. `null` for anything that does not parse.
 */
function tokenSubject(token: string): string | null {
  const claims = unverifiedClaims(token);
  return typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
}

/**
 * When the server minted `token` (its `iat`, seconds), read without verifying.
 *
 * Only ever used to prefer the newer of two tokens the same server issued, so
 * the comparison runs on the server's clock, never the device's. A wrong
 * answer costs one replay that 401s and one more exchange, nothing else.
 */
function tokenIssuedAt(token: string): number | null {
  const iat = unverifiedClaims(token)?.iat;
  return typeof iat === 'number' && Number.isFinite(iat) ? iat : null;
}

function unverifiedClaims(token: string): { sub?: unknown; iat?: unknown } | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return claims && typeof claims === 'object' ? (claims as { sub?: unknown; iat?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * Runs `fn` holding this municipality's refresh lock, across every tab.
 *
 * The refresh cookie is one per account per browser, and every exchange
 * replaces it. Two tabs exchanging at once both send the cookie they found; the
 * server serves the slower one as a retry — but only a few times, and only while
 * nothing the faster one received has been used. Past that it reads as a stolen
 * token and ends the whole session. Queuing the exchanges keeps the ordinary
 * case, five tabs waking together from a laptop's sleep, from spending that
 * allowance. Sign-in and sign-out take the lock too, so neither crosses another
 * tab's exchange mid-flight.
 *
 * Where the Web Locks API is missing — an insecure origin, an older browser —
 * this runs unlocked. The server's retry allowance covers that case, and a
 * missing lock must not become a missing session.
 *
 * The wait is bounded: a lock still held after 20 seconds (a tab frozen
 * mid-exchange) surfaces as `SESSION_REFRESH_UNAVAILABLE` rather than as a
 * screen that waits for ever.
 */
async function withRefreshLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== 'function') return fn();

  let granted = false;
  try {
    return await locks.request(
      `mechanization.refresh.${tenant}`,
      { signal: timeoutSignal(20_000) },
      () => {
        granted = true;
        return fn();
      },
    );
  } catch (caught) {
    // Only the wait is translated. Whatever `fn` threw is its caller's to read
    // — a refused sign-in is a 401, not a connection problem.
    if (!granted) throw refreshUnavailable();
    throw caught;
  }
}

/** A token to replay with, and whether it took a round trip to get. */
interface ExchangedToken {
  token: string;
  /**
   * `false` when the session had already been renewed — by another tab, or an
   * earlier call in this one — and the fresh token was simply read from
   * storage. `apiFetch` reads it to decide whether a second 401 is worth one
   * more exchange.
   */
  fromNetwork: boolean;
}

/**
 * Exchanges in flight, one per municipality *and failing token*.
 *
 * A staff screen fires several reads at once — the header badge, the table,
 * the filter options — so an expiry is met by all of them within the same tick.
 * They carry the same token, so they share one exchange rather than each
 * rotating the refresh cookie out from under the others. Keyed by the token as
 * well because two different failing tokens are two different questions: one
 * may already be answered by storage while the other needs the network.
 *
 * The `get` and the `set` in `exchangeStaffToken` run in one synchronous stretch,
 * before its first `await`. That is what makes the sharing airtight.
 */
const refreshInFlight = new Map<string, Promise<ExchangedToken | null>>();

/**
 * `./session`, imported on first use and then shared by every exchange.
 *
 * One promise rather than an `import()` per exchange: two exchanges for
 * different tokens can now be in flight together, and Vitest's module mocker
 * was seen handing one of two concurrent `import()`s the real module instead
 * of the mock — so the test for exactly that case exercised the wrong code.
 * A browser returns the same module either way, so nothing changes there.
 */
let sessionModule: Promise<typeof import('./session')> | undefined;
const importSession = () => (sessionModule ??= import('./session'));

// ─────────────────────  Handing a renewal to the other tabs  ─────────────────────

/**
 * A session one tab renewed, handed to the others so they do not renew it too.
 *
 * The cross-tab lock already stops two tabs exchanging the cookie at once, and
 * a «تذكّرني» session lives in `localStorage`, so a tab that takes the lock
 * after another finds the new token there. A session without «تذكّرني» lives
 * in each tab's own `sessionStorage`, though: the tabs queued behind the lock
 * would each still go to the server in turn, every one rotating the cookie.
 * Three tabs waking together would make three exchanges where one does.
 *
 * So the tab that renews announces the result on a `BroadcastChannel`, and a
 * tab waiting for the lock takes it from there and sends nothing. It adopts a
 * renewal only when all of these hold, and otherwise renews itself, which is
 * still correct, only slower:
 *
 * - it is for the account this tab's own failing token names;
 * - this tab's store still holds that account's session (not signed out, not
 *   somebody else's sign-in since);
 * - its token is newer than the failing one, by the server's `iat`.
 *
 * Same-origin only, like the storage it stands in for: a script that could
 * read the channel could already read this tab's `sessionStorage`. Nothing is
 * granted on the strength of a message; the server checks every token.
 */
const SESSION_CHANNEL = 'mechanization.session';

/**
 * Bumped in `localStorage` by every renewal. It holds no token, only a change
 * counter, so a tab that takes the lock can tell a renewal happened while it
 * waited and that its announcement is on the way.
 */
const renewalMarkKey = (tenant: string) => `mechanization.session-renewed.${tenant}`;

/**
 * How long such a tab waits for the announcement before renewing itself. The
 * message is posted before the lock is released, so it is normally already
 * there; this only covers the two arriving in the other order.
 */
const RENEWAL_HANDOFF_MS = 1_000;

interface RenewalNotice {
  type: 'staff-session-renewed';
  tenant: string;
  session: Session;
}

/** The latest renewal announced per municipality, by any tab. */
const announcedRenewals = new Map<string, Session>();
const renewalWaiters = new Map<string, Set<() => void>>();
let renewalChannelInstance: BroadcastChannel | null | undefined;

function renewalChannel(): BroadcastChannel | null {
  if (renewalChannelInstance !== undefined) return renewalChannelInstance;
  if (typeof BroadcastChannel !== 'function') return (renewalChannelInstance = null);

  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent) => {
    const notice = event.data as Partial<RenewalNotice> | null;
    if (notice?.type !== 'staff-session-renewed' || typeof notice.tenant !== 'string') return;
    if (typeof notice.session?.accessToken !== 'string' || !notice.session.user) return;
    announcedRenewals.set(notice.tenant, notice.session);
    for (const wake of [...(renewalWaiters.get(notice.tenant) ?? [])]) wake();
  });
  // Node, where the tests run, keeps a process alive while a channel is open;
  // browsers have no `unref` and need none.
  (channel as unknown as { unref?: () => void }).unref?.();
  return (renewalChannelInstance = channel);
}

// Listen from the first load in a browser, so a renewal announced before this
// tab's own token expires is already known when it does.
if (typeof window !== 'undefined' && typeof document !== 'undefined') renewalChannel();

function readRenewalMark(tenant: string): string | null {
  try {
    return localStorage.getItem(renewalMarkKey(tenant));
  } catch {
    return null;
  }
}

/** Tells the other tabs a renewal happened, and what it was. Called while holding the lock. */
function announceRenewal(tenant: string, session: Session): void {
  try {
    localStorage.setItem(renewalMarkKey(tenant), `${Date.now()}:${Math.random().toString(36).slice(2)}`);
  } catch {
    // Private modes may refuse the write; the message below still goes out.
  }
  const notice: RenewalNotice = { type: 'staff-session-renewed', tenant, session };
  renewalChannel()?.postMessage(notice);
}

/** An announced renewal this tab may adopt in place of `failingToken`, or null. */
function adoptableRenewal(tenant: string, subject: string, failingToken: string): Session | null {
  const session = announcedRenewals.get(tenant);
  if (!session || session.user.kind !== 'STAFF' || session.user.id !== subject) return null;
  if (session.accessToken === failingToken) return null;

  const announced = tokenIssuedAt(session.accessToken);
  const failing = tokenIssuedAt(failingToken);
  // Unknown issue times prove nothing, and an older token would only 401 again.
  if (announced === null || failing === null || announced < failing) return null;
  return session;
}

/** Resolves when a renewal for `tenant` is announced, or after `ms`, whichever comes first. */
function renewalAnnounced(tenant: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const waiters = renewalWaiters.get(tenant) ?? new Set<() => void>();
    renewalWaiters.set(tenant, waiters);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
  });
}

/**
 * Renews the staff session behind `failingToken`, the token that just met a 401.
 *
 * The refresh credential is an httpOnly cookie this code cannot read. A refresh
 * sends that cookie (`credentials: 'include'`) *and* the failing token as the
 * bearer. The server uses the token only to learn which account this tab
 * belongs to, so it reads the right cookie and can never hand this tab somebody
 * else's session; an expired token is fine for that, and it is never what gets
 * exchanged.
 *
 * In order:
 *
 * 1. The stored session must belong to the account the failing token names. If
 *    it does not — somebody else signed in to this municipality with «تذكّرني»,
 *    or nobody is signed in — then storage is not this tab's session, and
 *    adopting it would have this tab quietly act as another person. `null`.
 * 2. If storage holds a different token for that same account, the session was
 *    already renewed. Use it; nothing is rotated. No clock comparison: a
 *    phone's clock is not something to decide with, and if the stored token has
 *    died too, `apiFetch`'s second exchange comes back here holding it.
 * 3. Otherwise, under the cross-tab lock, look again — the tab that held the
 *    lock may have just written one — and only then ask the server.
 *
 * Resolves to `null` when the session is over: the server answered 401 or 403
 * because the cap passed, the account was dismissed or had its `tokenVersion`
 * bumped, or the session was signed out. The caller lets the original 401
 * through, and the screens send the clerk to sign in.
 *
 * **Throws** `SESSION_REFRESH_UNAVAILABLE` for everything else — no network, a
 * timeout, a 429, a 5xx. None of those says the session is over, and letting
 * the 401 through would have every screen clear it.
 */
async function exchangeStaffToken(
  tenant: string,
  failingToken: string,
): Promise<ExchangedToken | null> {
  const key = `${tenant}:${failingToken}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;

  // Read before anything waits: a change by the time the lock is ours means
  // another tab renewed meanwhile, and its announcement is worth waiting for.
  renewalChannel();
  const markBefore = readRenewalMark(tenant);

  const flight = (async (): Promise<ExchangedToken | null> => {
    const { loadSession, updateSession } = await importSession();
    const subject = tokenSubject(failingToken);

    /**
     * Another tab's renewal, taken into this tab's own store. Only while that
     * store holds this account's session: written into anything else it would
     * sign this tab in, or resurrect a session it had signed out of.
     */
    const adopt = (session: Session): ExchangedToken | null => {
      const own = loadSession(tenant);
      if (!own || own.user.kind !== 'STAFF' || own.user.id !== subject) return null;
      updateSession(tenant, session);
      return { token: session.accessToken, fromNetwork: false };
    };

    /** Step 3a. `undefined` means no other tab has answered: ask the server. */
    const fromAnotherTab = async (): Promise<ExchangedToken | null | undefined> => {
      if (!subject) return undefined;
      let announced = adoptableRenewal(tenant, subject, failingToken);
      if (!announced && readRenewalMark(tenant) !== markBefore) {
        await renewalAnnounced(tenant, RENEWAL_HANDOFF_MS);
        announced = adoptableRenewal(tenant, subject, failingToken);
      }
      return announced ? adopt(announced) : undefined;
    };

    /** Steps 1 and 2. `undefined` means storage cannot answer: ask the server. */
    const fromStorage = (): ExchangedToken | null | undefined => {
      const session = loadSession(tenant);
      if (!subject || !session || session.user.kind !== 'STAFF' || session.user.id !== subject) {
        return null;
      }
      if (session.accessToken !== failingToken) {
        return { token: session.accessToken, fromNetwork: false };
      }
      return undefined;
    };

    const stored = fromStorage();
    if (stored !== undefined) return stored;

    try {
      return await withRefreshLock(tenant, async () => {
        const storedNow = fromStorage();
        if (storedNow !== undefined) return storedNow;

        const handedOver = await fromAnotherTab();
        if (handedOver !== undefined) return handedOver;

        const refreshed = await apiFetch<Session>(tenant, '/auth/staff/refresh', {
          method: 'POST',
          token: failingToken,
          credentials: 'include',
          // A 401 from the exchange is the answer, not a reason to exchange again.
          skipTokenRefresh: true,
          signal: timeoutSignal(15_000),
        });

        // The server binds the refresh to this account, so this cannot differ.
        // If it ever does, storing it is the one thing that must not happen.
        if (refreshed.user.kind !== 'STAFF' || refreshed.user.id !== subject) return null;

        // Written and announced inside the lock, so the next tab to take it
        // reads this token — from `localStorage` with «تذكّرني», from the
        // announcement without — instead of exchanging the cookie this
        // response has just replaced.
        updateSession(tenant, refreshed);
        announceRenewal(tenant, refreshed);
        return { token: refreshed.accessToken, fromNetwork: true };
      });
    } catch (caught) {
      if (caught instanceof ApiRequestError && (caught.status === 401 || caught.status === 403)) {
        return null;
      }
      throw refreshUnavailable();
    }
  })();

  refreshInFlight.set(key, flight);
  try {
    return await flight;
  } finally {
    refreshInFlight.delete(key);
  }
}

/**
 * The session routes. A 401 from any of them is the answer — a wrong password,
 * a session that cannot be renewed, a sign-out with nothing to end — and never
 * a reason to exchange the token and try again.
 */
const SESSION_ROUTES = ['/auth/staff/login', '/auth/staff/refresh', '/auth/staff/logout'];

type ApiFetchInit = RequestInit & { token?: string; skipTokenRefresh?: boolean };

/**
 * Every call is tenant-scoped by construction: the municipality slug is part of
 * the path, so a request cannot be made without naming which municipality it
 * belongs to.
 */
export function apiFetch<T>(tenant: string, path: string, init: ApiFetchInit = {}): Promise<T> {
  return send<T>(tenant, path, init, 2);
}

/** `apiFetch`, carrying how many token exchanges this call may still spend. */
async function send<T>(
  tenant: string,
  path: string,
  init: ApiFetchInit,
  exchangesLeft: number,
): Promise<T> {
  const { token, headers, skipTokenRefresh, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/t/${tenant}${path}`, {
      ...rest,
      headers: {
        // FormData must set its own multipart boundary — forcing a content type
        // here silently breaks every file upload.
        ...(rest.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (caught) {
    /*
      A cancelled request is not a failed one.

      `fetch` rejects with an `AbortError` when its signal fires, and every
      query that supersedes another fires one — typing a new search term,
      moving to the next page, switching a status tab. Folding that into
      `NETWORK_ERROR` put «تعذّر الاتصال» on screen every time a clerk
      changed their mind quickly, on a connection that was working perfectly.
      Re-thrown as-is so the caller's own cancellation handling sees it; React
      Query discards it silently, which is the correct treatment.
    */
    if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;

    // A dropped connection mid-request is the normal case on the networks this
    // serves, not an exceptional one.
    throw new ApiRequestError(0, {
      code: 'NETWORK_ERROR',
      message: 'تعذّر الاتصال. تحقّق من الشبكة وحاول مرة أخرى.',
    });
  }

  /*
    A 401 that may simply mean "this token has aged out".

    Staff tokens are short and renewed as they age, so the ordinary way a
    working session meets a 401 is that it crossed the idle window between two
    clicks. Exchanging the token and replaying the request here is what makes
    that invisible — the alternative is what this replaced: a hard logout
    mid-form, with whatever was typed still on screen and now unsaveable.

    At most two exchanges per call, and the second only in one case. Screens
    hold their token in React state, so once another tab — or another read in
    this one — has renewed the session, this tab's next request still carries
    the old token, and the exchange answers it from storage without a round
    trip. If the stored token has died as well (the laptop slept past both),
    that replay 401s too, and one more exchange, now holding the stored token,
    goes to the network. After a network exchange the replay is final: a 401
    then means the session was revoked, and the error goes to the screens that
    already know what to do with it — there are two dozen of them, and none
    needed changing for this.

    Replaying is safe because `rest.body` is a string or a `FormData`, both of
    which can be sent twice. A streaming body could not, and nothing here uses
    one; if that changes, this is the line that has to know.
  */
  if (
    response.status === 401 &&
    token &&
    !skipTokenRefresh &&
    exchangesLeft > 0 &&
    !SESSION_ROUTES.some((route) => path.startsWith(route))
  ) {
    const fresh = await exchangeStaffToken(tenant, token);
    if (fresh && fresh.token !== token) {
      return send<T>(
        tenant,
        path,
        { ...init, token: fresh.token },
        fresh.fromNetwork ? 0 : exchangesLeft - 1,
      );
    }
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({
      code: 'UNKNOWN',
      message: 'تعذّر إتمام الطلب. حاول مرة أخرى.',
    }))) as ApiError;
    throw new ApiRequestError(response.status, payload);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// ─────────────────────────────  Endpoints  ─────────────────────────────

export interface PublicTenantConfig {
  slug: string;
  name: string;
  nameAr: string;
  enabledPropertyTypes: string[];
  requiredDocuments: string[];
  branding: { logoUrl?: string; primaryColor?: string; accentColor?: string };
  supportPhone?: string;
}

/**
 * The municipality's public branding and enabled property types.
 * Unauthenticated — the staff entry form reads it before a tenant is known.
 * Cached in localStorage for offline resiliency.
 */
export function getTenantConfig(tenant: string): Promise<PublicTenantConfig> {
  return cachedRequest(`tenant-config:${tenant}`, 5 * 60 * 1000, async () => {
    try {
      const config = await apiFetch<PublicTenantConfig>(tenant, '/tenant/config');
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem(`mechanization.tenant_config.${tenant}`, JSON.stringify(config));
        } catch {
          // Ignore quota / localStorage errors
        }
      }
      return config;
    } catch (caught) {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = localStorage.getItem(`mechanization.tenant_config.${tenant}`);
        if (stored) {
          try {
            return JSON.parse(stored) as PublicTenantConfig;
          } catch {
            // Ignore parse errors
          }
        }
      }
      // If network error / offline, return a safe fallback so the offline form can still render
      if (caught instanceof ApiRequestError && caught.status === 0) {
        return {
          slug: tenant,
          name: tenant,
          nameAr: tenant,
          enabledPropertyTypes: ['BUILDING', 'HOUSE', 'LAND', 'TENT'],
          requiredDocuments: [],
          branding: {},
        };
      }
      throw caught;
    }
  });
}

export interface PropertyNumberCheck {
  propertyNumber: string;
  /** In the municipality's cadastre. Null when the municipality has none. */
  inCadastre: boolean | null;
  location: { latitude: number; longitude: number; approximate: boolean } | null;
  /** Nearest real parcel numbers, offered only when the typed one is unknown. */
  suggestions: string[];
  /**
   * Neighbours already registered on this parcel. Informational only — a
   * building shares one cadastral number, so this never blocks an entry.
   */
  registeredCount: number;
}

/**
 * Blur-check for رقم العقار while it is being typed into the entry form.
 *
 * Remembered per parcel, because the answer is a property of the cadastre
 * rather than of this visit: the same عقار is checked again by every card of a
 * household on it, again when the card is unfolded, and again when the record
 * is opened to fix a phone number. Only `registeredCount` moves, and a citizen
 * write drops the entry (see `invalidateParcelChecks`).
 */
export function checkPropertyNumber(tenant: string, propertyNumber: string) {
  return cachedRequest(parcelCheckKey(tenant, propertyNumber), PARCEL_CHECK_TTL_MS, () =>
    apiFetch<PropertyNumberCheck>(
      tenant,
      `/registrations/property-number/${encodeURIComponent(propertyNumber)}/availability`,
    ),
  );
}

const PARCEL_CHECK_TTL_MS = 5 * 60 * 1000;

const parcelCheckKey = (tenant: string, propertyNumber: string) =>
  `parcel-check:${tenant}:${propertyNumber}`;

function invalidateParcelChecks(tenant: string): void {
  invalidateRequests(`parcel-check:${tenant}:`);
}

/**
 * The verdict already held for this parcel, for a field seeding its first
 * render. A control that re-mounts on an unchanged number should state what it
 * knows, not spend half a second saying «جارٍ التحقق» about it again.
 */
export function peekPropertyNumberCheck(tenant: string, propertyNumber: string) {
  return peekCachedRequest<PropertyNumberCheck>(parcelCheckKey(tenant, propertyNumber));
}

/**
 * What sign-in (and, for staff, every refresh) answers with — and what
 * `lib/session.ts` stores.
 *
 * For staff this holds only the short-lived access token (`JWT_STAFF_IDLE_TTL`,
 * 15 minutes by default). The credential that renews it is not here and never
 * reaches this code: it lives only in an httpOnly cookie on the API's own host,
 * set by the sign-in response and replaced by every refresh. A token copied
 * out of storage dies within its idle window; the session does not go with it.
 */
export interface Session {
  accessToken: string;
  expiresIn: string;
  /**
   * When `accessToken` stops being accepted, ISO — STAFF only.
   *
   * Short, and not the end of the session: see `sessionExpiresAt`. Nothing
   * reads this yet, because the exchange in `apiFetch` is driven by the 401
   * rather than by a clock; it is stored so that a proactive refresh can be
   * added later without another round of changes to what a session is.
   */
  expiresAt?: string;
  /**
   * When the session ends for good, ISO — STAFF only.
   *
   * The wall-clock moment the clerk signs in again, unchanged at 8h (or 7d
   * with "تذكّرني") and fixed at sign-in: a refresh renews the access token,
   * never this. No exchange is possible past it.
   */
  sessionExpiresAt?: string;
  user: { id: string; name: string; kind: 'STAFF' | 'CITIZEN'; role?: string };
}

export interface CitizenChoice {
  id: string;
  displayName: string;
  identityDocLastDigits: string;
}

export type VerifyOtpResponse =
  | Session
  | { status: 'CHOOSE_PROFILE'; phone: string; choices: CitizenChoice[] };

/**
 * Issues a login code. `attempt` is the resend counter: from the second
 * the server switches SMS route rather than retrying the one that failed.
 */
export function requestOtp(tenant: string, phone: string, attempt: number) {
  return apiFetch<{
    sent: boolean;
    /** False when the server has OTP switched off — skip straight to sign-in. */
    otpRequired: boolean;
    channel: string;
    expiresAt: string;
    resendAvailableAt: string;
    devCode?: string;
  }>(tenant, '/auth/citizen/otp/request', {
    method: 'POST',
    body: JSON.stringify({ phone, attempt }),
  });
}

/**
 * Exchanges the code for a session, or for a profile choice when one
 * phone belongs to several household members.
 */
export function verifyOtp(
  tenant: string,
  input: { phone: string; code?: string; citizenId?: string },
) {
  return apiFetch<VerifyOtpResponse>(tenant, '/auth/citizen/otp/verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * A session, or the second factor still owed.
 *
 * `status` is the discriminant, matching `verifyOtpResponseSchema`'s shape on
 * the citizen side. The server returns the challenge only after the password
 * has already been accepted, so reaching it means the credentials were right.
 */
export type StaffLoginResponse = Session | { status: 'TOTP_REQUIRED' };

/** Narrows the union above — a session has a token, a challenge does not. */
export function isTotpRequired(
  response: StaffLoginResponse,
): response is { status: 'TOTP_REQUIRED' } {
  return 'status' in response && response.status === 'TOTP_REQUIRED';
}

/**
 * Staff sign-in.
 *
 * `credentials: 'include'` is what lets the browser keep the refresh cookie the
 * response sets. The API is a different origin from the portal, and without it
 * a cross-origin response's `Set-Cookie` is silently dropped — the sign-in would
 * look fine, and the first expiry of the access token would sign the clerk out.
 * Held under the refresh lock so the new cookie does not land in the middle of
 * another tab's exchange of the old one.
 */
export function loginStaff(
  tenant: string,
  input: { email: string; password: string; totpToken?: string; remember?: boolean },
) {
  return withRefreshLock(tenant, () =>
    apiFetch<StaffLoginResponse>(tenant, '/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify(input),
      credentials: 'include',
    }),
  );
}

/**
 * Ends this tab's staff session on the server: the refresh family behind it,
 * and with it the access token, which the API checks against its family on
 * every request.
 *
 * Sends the tab's own token as the binding, exactly as a refresh does — without
 * one the server cannot tell which account's cookie to read, and does nothing.
 * So with no token there is nothing to send. The timeout is short because a
 * clerk is waiting to be signed out, and the local sign-out happens regardless.
 *
 * **May throw** — a dropped connection, a timeout, or the 404 an API from before
 * this route answers with. Callers ignore it and clear the local session anyway;
 * the server-side session is then left to run out at its cap, which is all that
 * signing out did before this route existed.
 */
export async function logoutStaff(tenant: string, accessToken?: string): Promise<void> {
  if (!accessToken) return;

  await withRefreshLock(tenant, () =>
    apiFetch<{ signedOut: boolean }>(tenant, '/auth/staff/logout', {
      method: 'POST',
      token: accessToken,
      credentials: 'include',
      // A 401 here means there was nothing to end, never "exchange and retry".
      skipTokenRefresh: true,
      signal: timeoutSignal(5_000),
    }),
  );
}

export interface DashboardCounters {
  total: number;
  byPropertyType: Record<string, number>;
  byResidentStatus: Record<string, number>;
  submittedLast7Days: number;
}

/** Headline totals for the dashboard cards. Cached. */
export function getDashboardCounters(tenant: string, token: string) {
  return cachedRequest(`dashboard-counters:${tenant}`, 30 * 1000, () =>
    apiFetch<DashboardCounters>(tenant, '/dashboard/counters', { token }),
  );
}

/** One month of the fee ledger, keyed by the month an invoice fell due. */
export interface MonthlyFees {
  /** `YYYY-MM`. */
  month: string;
  billed: number;
  collected: number;
  overdue: number;
}

/**
 * Everything the analytics dashboard plots, in one payload — so the KPI tiles
 * and the charts below them can never disagree.
 */
export interface DashboardAnalytics {
  /** Household records on file — one row per registered citizen. */
  citizenRecords: number;
  /**
   * العدد الفعلي لسكان البلدة — sum of every household's actual household
   * members, i.e. the real, deduplicated population as declared (excluding
   * married children counted under their own branched-off household).
   */
  populationTotal: number;
  /** إجمالي المسجلين في سجلات النفوس — sum of totalRegisteredMembers (gross). */
  grossRegisteredTotal: number;
  /**
   * Households with no declared actual household size. They contribute
   * nothing to `populationTotal`, so it is understated by at least this many
   * people — surfaced in the UI rather than silently rounded to zero.
   */
  householdsWithoutSize: number;
  familySizes: Array<{ size: number; households: number }>;

  /** Building stock by نوع العقار — مبنى / منزل / أرض / خيمة. */
  propertiesByType: Record<string, number>;
  propertyTotal: number;

  /**
   * Units by نوع الوحدة — شقة / عيادة / محل, counted across both places a
   * unit type is stored (a building's units, and properties registered as a
   * single unit). Counting only the first drops every standalone unit.
   */
  unitsByType: Record<string, number>;
  unitTotal: number;

  /**
   * How many property/unit rows were already excluded as duplicate filings —
   * a TENANT/FREE_OCCUPANT registration of a unit an OWNER already registered
   * under the same رقم العقار (the same apartment, filed twice).
   */
  duplicateFilingsExcluded: {
    properties: number;
    units: number;
  };

  billedTotal: number;
  collectedTotal: number;
  outstandingTotal: number;
  /** Unpaid and past its due date. */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;

  monthly: MonthlyFees[];
}

/** The analytics dashboard's whole dataset. Cached server-side. */
export function getDashboardAnalytics(tenant: string, token: string) {
  return apiFetch<DashboardAnalytics>(tenant, '/dashboard/analytics', { token });
}

export interface ParcelRegistrantFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/** One structure/card registered against a parcel. */
export interface ParcelStructure {
  id: string;
  propertyType: string;
  occupancyType: string;
  buildingName: string | null;
  unitCount: number;
  unitType?: string | null;
  unitArea?: number | null;
}

/** One citizen registered against a parcel, as the map drawer lists them. */
export interface ParcelRegistrant {
  citizenId: string;
  registrationId: string;
  fullName: string;
  phone: string | null;
  occupancyType: string;
  propertyType: string;
  buildingName: string | null;
  status?: string;
  registeredAt: string;
  unitCount: number;
  financials?: ParcelRegistrantFinancials;
  /** All structures registered by this citizen on this parcel */
  structures?: ParcelStructure[];
}

export interface ParcelFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  status: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/**
 * A parcel with at least one registration. The fullscreen map places an
 * interactive marker only on these — every other cadastral parcel is drawn
 * from the static GeoJSON with no dot, so a dot always means there is
 * citizen data to open.
 */
/**
 * A parcel that has at least one registration, with everyone attached to it.
 *
 * **One row per رقم العقار.** P5-T5 split it per censused structure and P5-T7
 * put it back: the map already draws a census layer with a pin per building at
 * its own entrance, so a registration dot on each of those said the same thing
 * twice. This layer is about the plot — everyone on it, one dot, at the
 * parcel's own point.
 */
export interface RegisteredParcel {
  propertyNumber: string;
  latitude: number;
  longitude: number;
  registrants: ParcelRegistrant[];
  financials?: ParcelFinancials;
  structureCount?: number;
}

/**
 * Parcels that have at least one registration, grouped for the map — one
 * marker per cadastral number, with everyone registered on it.
 */
export function getRegisteredParcels(tenant: string, token: string) {
  return apiFetch<{ parcels: RegisteredParcel[] }>(tenant, '/dashboard/map/parcels', { token });
}

// ───────────────────────────  Zones (القطاعات)  ───────────────────────────

/** A sector as the list and legend show it — membership summarised to a count. */
export interface ZoneSummary {
  id: string;
  name: string;
  code: string;
  color: string;
  description: string | null;
  parcelCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A sector opened for editing, carrying the parcel numbers it owns. */
export interface ZoneDetail extends ZoneSummary {
  parcelNumbers: string[];
}

export interface ZoneWriteInput {
  name: string;
  code: string;
  color: string;
  description?: string;
  parcelNumbers: string[];
}

/** Every sector with its parcel count, for the list and the map legend. */
export function getZones(tenant: string, token: string) {
  return cachedRequest(`zones:${tenant}`, 60 * 1000, () =>
    apiFetch<{ zones: ZoneSummary[] }>(tenant, '/zones', { token }),
  );
}

/** One sector including the parcel numbers it owns, for the editor. */
export function getZone(tenant: string, token: string, id: string) {
  return apiFetch<ZoneDetail>(tenant, `/zones/${encodeURIComponent(id)}`, { token });
}

/** SUPER_ADMIN only, server-enforced. */
export async function createZone(tenant: string, token: string, input: ZoneWriteInput) {
  const result = await apiFetch<ZoneDetail>(tenant, '/zones', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/** SUPER_ADMIN only. Omitted fields are left as they are. */
export async function updateZone(
  tenant: string,
  token: string,
  id: string,
  input: Partial<ZoneWriteInput>,
) {
  const result = await apiFetch<ZoneDetail>(tenant, `/zones/${encodeURIComponent(id)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/** SUPER_ADMIN only. Releases the sector's parcels rather than altering them. */
export async function deleteZone(tenant: string, token: string, id: string) {
  const result = await apiFetch<{ deleted: boolean }>(tenant, `/zones/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/**
 * The zone overlay both maps draw, as dissolved polygons.
 *
 * Served from the API rather than as a static file like the cadastre layers,
 * because zone membership changes whenever an admin saves the editor.
 */
export function getZonesGeoJson(tenant: string, token: string) {
  return apiFetch<GeoJSON.FeatureCollection>(tenant, '/zones/geojson', { token });
}

// ────────────────────────────────  Cases  ────────────────────────────────

/**
 * حالات — a field visit that could not become a citizen registration
 * (nobody home, gate locked, access refused…). Not linked to any citizen:
 * there is none to attach it to yet.
 */
export interface CaseSummary {
  id: string;
  notes: string;
  propertyNumber: string | null;
  neighborhood: string | null;
  propertyType: string | null;
  buildingName: string | null;
  floor: string | null;
  side: string | null;
  landType: string | null;
  tentLocation: string | null;
  /** «مجدولة» means a revisit date is already set — see `scheduledRevisitAt`. */
  status: CaseStatus;
  /** Why the visit did not complete. `GENERAL_NOTE` for anything logged before
   *  the column existed. There is deliberately no war-damage type (D6). */
  caseType: CaseType;
  /**
   * The resolved form of `buildingName`/`floor`, once the case can be pinned to
   * actual census rows. Both survive: the free text is what the officer wrote at
   * the door, and on a parcel with no surveyed buildings it is all there is.
   */
  buildingId: string | null;
  buildingCode: string | null;
  unitId: string | null;
  unitCode: string | null;
  /**
   * Who the census records on that unit now. Optional on the wire for an
   * older server. Non-empty means the flat is already somebody's — owned,
   * rented or lent — so the case is answered by linking it to them, and
   * «تسجيل المواطن» from the case is closed.
   */
  unitOccupants?: CaseUnitOccupant[];
  /** The unit's recorded status — `OWNER_OCCUPIED` when its recorded owner lives in it. */
  unitStatus?: string | null;
  /** The damage reading that prompted this case, if one did. A reference, not
   *  ownership — resolving the case says nothing about the damage (D6). */
  damageAssessmentId: string | null;
  /** When someone has agreed to go back. Meaningful under `SCHEDULED`. */
  scheduledRevisitAt: string | null;
  /** The citizen whose registration resolved this case, if any. */
  resolvedCitizenId: string | null;
  resolvedCitizenName: string | null;
  resolvedAt: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who on a case's unit actually lives there, registered: a tenant, a free
 * occupant, or an owner on a flat recorded «يشغلها المالك». Non-empty means
 * the household the case was waiting for is on file, so «تسجيل المواطن» from
 * the case is closed and the case is answered by linking it to them.
 *
 * An owner alone on a flat recorded «مؤجرة» is not that: the owner lets it,
 * and the tenant the case is asking for is exactly who is missing.
 */
export function caseResidents(item: Pick<CaseSummary, 'unitOccupants' | 'unitStatus'>): CaseUnitOccupant[] {
  return (item.unitOccupants ?? []).filter(
    (person) => person.role !== 'OWNER' || item.unitStatus === 'OWNER_OCCUPIED',
  );
}

/** A registered citizen the census records on a case's unit. */
export interface CaseUnitOccupant {
  citizenId: string;
  name: string;
  role: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT';
}

export interface CaseWriteInput {
  notes: string;
  propertyNumber?: string;
  neighborhood?: string;
  propertyType?: string;
  buildingName?: string;
  floor?: string;
  side?: string;
  landType?: string;
  tentLocation?: string;
  caseType?: CaseType;
  /** Pins the case to a censused structure — set when logged from the matrix. */
  buildingId?: string;
  unitId?: string;
  damageAssessmentId?: string;
  scheduledRevisitAt?: string;
}

export function getCases(
  tenant: string,
  token: string,
  filter: {
    propertyNumber?: string;
    status?: CaseStatus;
    caseType?: CaseType;
    /** Every case on this structure, however its units are spread. */
    buildingId?: string;
    unitId?: string;
    /** When the case was opened, inclusive. ISO instants. */
    from?: string;
    to?: string;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.propertyNumber) query.set('propertyNumber', filter.propertyNumber);
  if (filter.status) query.set('status', filter.status);
  if (filter.caseType) query.set('caseType', filter.caseType);
  if (filter.buildingId) query.set('buildingId', filter.buildingId);
  if (filter.unitId) query.set('unitId', filter.unitId);
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  const qs = query.toString();
  return apiFetch<{ cases: CaseSummary[] }>(tenant, `/cases${qs ? `?${qs}` : ''}`, {
    token,
    signal,
  });
}

export function getCase(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<CaseSummary>(tenant, `/cases/${encodeURIComponent(id)}`, { token, signal });
}

export function createCase(tenant: string, token: string, input: CaseWriteInput) {
  return apiFetch<CaseSummary>(tenant, '/cases', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateCase(
  tenant: string,
  token: string,
  id: string,
  input: Partial<CaseWriteInput> & {
    status?: CaseStatus;
    /** Setting this always resolves the case server-side; `null` only clears the link. */
    resolvedCitizenId?: string | null;
  },
) {
  return apiFetch<CaseSummary>(tenant, `/cases/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** SUPER_ADMIN only, server-enforced. */
export function deleteCase(tenant: string, token: string, id: string) {
  return apiFetch<{ deleted: boolean }>(tenant, `/cases/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

// ─────────────────────────  Buildings (سجل المباني)  ─────────────────────────

/**
 * The census, as the browser sees it.
 *
 * Every shape here is the server's own row with its `Date`s read back as the
 * ISO strings JSON actually carries — `createdAt` is typed `string` rather than
 * `Date` because that is what arrives, and typing it otherwise would have
 * `formatDate` handed something that only looks like a date until it is used.
 *
 * The rule that governs all of them: **the id is the identity and the code is
 * derived** (D9). Nothing here ever sends a `code`, a `unitCode` or a
 * `codeSuffix` — the server allocates them, and a client that could assert one
 * could assert one that contradicts the parcel it names.
 */
export interface BuildingSummary {
  id: string;
  parcelNumber: string;
  codeSuffix: string;
  /** `ZONE-PARCEL-SUFFIX` — `A-1042-B`. Display only; recomputed server-side. */
  code: string;
  name: string | null;
  /** What is painted on the building. Trusted over `code` in the field (D14). */
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — whether the structure is legally partitioned.
   *
   * Three states: `true` مفروزة, `false` غير مفروزة, `null` nobody asked.
   * Optional on the wire as well, so a response cached from a build before the
   * column existed reads as «لم يُسأل» rather than leaking `undefined` into a
   * control that would render it as a definite «لا».
   */
  isPartitioned?: boolean | null;
  /**
   * أرقام الأقسام the فرز produced, each with its own صحيفة عقارية.
   *
   * Empty unless `isPartitioned` is true — the server keeps the two in step,
   * because أقسام under a structure with no recorded فرز is a contradiction a
   * deed search would later read as fact.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on, beside `parcelNumber`.
   *
   * Optional for the same reason, and empty for the overwhelming majority of
   * buildings, which stand on exactly one parcel.
   */
  sharedParcelNumbers?: string[];
  structureType: StructureType;
  /**
   * Where the structure is in its own life — permitted, going up, standing,
   * abandoned, gone. The third axis beside *what it is* (`structureType`) and
   * *what happened to it* (its damage level).
   */
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  /**
   * How far the structure goes down, as a depth: 2 means B1 and B2.
   *
   * Optional on the wire so a response cached from a build before the column
   * existed reads as "no basement" rather than `undefined` leaking into a
   * floor count.
   */
  basementsCount?: number;
  /** Maintained by a database trigger — never written from the client. */
  unitsTotal: number;
  unitsSurveyed: number;
  notes: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A census ledger row — the building plus the two derived columns it shows. */
export interface BuildingLedgerRow extends BuildingSummary {
  zoneCode: string | null;
  zoneName: string | null;
  /** The *current* level, i.e. the newest assessment. Null = never assessed. */
  damageLevel: DamageLevel | null;
  /** With a search: the retired code the term matched — «كان Z-1-45-A». */
  matchedPreviousCode?: string;
}

/** One occupant of a unit. A `toDate` of null means they are there now (D2). */
export interface UnitOccupant {
  id: string;
  unitId: string;
  citizenId: string;
  citizenName: string | null;
  /** Their phone, shown on the unit. Optional for a server from before it. */
  citizenPhone?: string | null;
  role: OccupancyRole;
  /** أسهم out of 2400 — owners only. */
  shares: number | null;
  fromDate: string;
  toDate: string | null;
  /**
   * Why the spell ended, when an officer said so. `RECORDED_IN_ERROR` spells
   * are kept on the record and left out of the unit's visible history.
   * Optional on the wire for responses from before the field existed.
   */
  endReason?: OccupancyEndReason | null;
  registrationId: string | null;
  /**
   * Whether the citizen's own file claims this flat.
   *
   * `false` means the census records them here but their registration does
   * not name the property — the half-finished state «ربط شخص بالوحدة» can produce,
   * which is legitimate at the doorstep and needs finishing afterwards.
   * Billing reads the file, not this row, so an unbacked occupancy is a flat
   * nobody is charged for.
   *
   * Optional on the wire so a cached response from a build before the field
   * existed reads as "backed" rather than lighting up every occupant in the
   * matrix with a warning.
   */
  backedByFile?: boolean;
  /**
   * When the spell was entered in the register (not `fromDate`, which may be
   * back-dated). A tenant may be linked by picking only to an owner recorded
   * before them. Optional on the wire for responses from before it existed.
   */
  recordedAt?: string;
  /** Who a current tenant holds the flat from, per their own card. Null otherwise. */
  ownerLink?: OccupantOwnerLink | null;
}

/**
 * The tenancy card behind a current tenant's spell, and whether it names an
 * owner of this flat — see `OccupancyOwnerLink` on the server.
 */
export interface OccupantOwnerLink {
  state: 'LINKED' | 'LINKED_ELSEWHERE' | 'UNLINKED' | 'NO_CARD';
  propertyEntryId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  typedName: string | null;
}

/** One canonical unit. It exists whether or not anybody has been surveyed in it. */
export interface UnitRow {
  id: string;
  buildingId: string;
  /** Signed: basement negative, ground 0. `unitCode` is derived from it (D8). */
  floor: number;
  sequence: number;
  /** 1-based inclusive column span this unit was painted on, or both null if
   *  it was never painted on a grid (the blueprint generator, a hand-added
   *  single unit) — see `unit-grid-picker.tsx`'s `GridUnitDraft`. */
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: UnitType;
  side: string | null;
  unitArea: number | null;
  unitStatus: UnitStatus | null;
  surveyStatus: SurveyStatus;
  /**
   * «مسكن موسمي» — the months (1–12) its owners are usually present, when they
   * last stayed, and when a تصريح بالشغور was filed. Recorded for the council's
   * billing decision; nothing bills from them. Optional on the wire for
   * responses from before migration 0040.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One «تأكيد الشغور» — that a unit was found empty, on what basis, and by whom.
 *
 * `endedAt` null is the one standing: it is why the unit reads «شاغرة» and why
 * its owner is exempt from the occupancy fee. The rest are closed history, kept
 * rather than deleted — a vacancy withdrawn still records what the municipality
 * believed and for how long.
 *
 * `previousUnitStatus` / `previousSurveyStatus` are what the flat said before,
 * carried so the undo can state what it will restore *before* it is pressed.
 * Both null on a row migration 0043 backfilled, where nobody recorded either.
 */
export interface UnitVacancyConfirmation {
  id: string;
  unitId: string;
  /** Null only on a backfilled row — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
  notes: string | null;
  confirmedById: string | null;
  confirmedByName: string | null;
  previousUnitStatus: UnitStatus | null;
  previousSurveyStatus: SurveyStatus | null;
  endedAt: string | null;
  endReason: VacancyEndReason | null;
  endNotes: string | null;
  endedById: string | null;
  endedByName: string | null;
  createdAt: string;
}

/** A unit as the matrix draws it — with whoever is, and was, inside it. */
export interface UnitWithOccupants extends UnitRow {
  occupants: UnitOccupant[];
  /** The most recent attempts, newest first. Capped server-side at ten. */
  visits: UnitVisitRow[];
  /** Every attempt ever made, uncapped — this is «٣ محاولات» on the cell. */
  visitCount: number;
  /**
   * حالة الوحدة as the owner's own card states it, sent only when `unitStatus`
   * is unset. The unit's value wins where it has one — the order billing reads
   * them in — so the matrix shows `unitStatus ?? ownerDeclaredStatus`.
   */
  ownerDeclaredStatus?: UnitStatus | null;
  /**
   * «تأكيد الشغور» on this unit, newest first and capped server-side at five.
   *
   * Optional on the wire so a cached response from a build before migration
   * 0043 reads as "none" rather than throwing — a unit with no confirmations is
   * the ordinary case anyway.
   */
  vacancies?: UnitVacancyConfirmation[];
}

/** One building opened in the matrix drawer. */
export interface BuildingDetail extends BuildingSummary {
  /** Resolved from `Zone.parcelNumbers` at read time — never stored (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  /**
   * Codes this building carried before «تصحيح رقم العقار», newest first —
   * still found by search, never given to another building. Absent from a
   * server older than the correction.
   */
  previousCodes?: Array<{ code: string; parcelNumber: string; reason: string; retiredAt: string }>;
  units: UnitWithOccupants[];
}

/** One observation of a structure's condition. Append-only (D3). */
export interface DamageAssessmentRow {
  id: string;
  buildingId: string | null;
  unitId: string | null;
  level: DamageLevel;
  source: DamageSource;
  observations: string | null;
  /** When the visit happened, not when it was typed up — see the schema. */
  assessedAt: string;
  /** «موعد إعادة الكشف» — only on an UNINHABITABLE reading. Optional for an older server. */
  reinspectAt?: string | null;
  assessedById: string | null;
  assessedByName: string | null;
  createdAt: string;
}

/**
 * The census totals for whatever the filters currently select — computed by the
 * server over the whole filtered set, not over the page on screen.
 */
export interface CensusSummary {
  /** Every building the filters select, whatever its lifecycle state. */
  buildings: number;
  /**
   * Units in structures that can hold households only — a shell under
   * construction has matrix rows and no doors to knock on.
   */
  unitsTotal: number;
  unitsSurveyed: number;
  unitsUnsurveyed: number;
  /** Units the lifecycle exclusion removed from the three figures above. */
  unitsOutOfScope: number;
  /** Restricted-use, unsafe-evacuate or total-collapse, at the current level. */
  damaged: number;
  /**
   * Structures with no entrance pin — a queue of doors, not an error.
   *
   * A building may be created from a desk, and one created from the
   * registration form always is: no entrance is guessed for it (D19), because
   * the parcel centroid is the middle of a plot where no building stands and is
   * the same point for every structure on it.
   */
  withoutEntrance: number;
}

/**
 * What saving a citizen changed in the building census.
 *
 * Returned by both write paths so the form can say what it linked — an officer
 * who registered a household into a flat has no other way to tell the census
 * heard about it, and "did that work?" is what sends somebody to enter a record
 * a second time.
 *
 * `null` on the citizen response means the census write failed. The citizen is
 * saved either way; the link can be made from the ledger.
 */
export interface CensusSyncResult {
  occupanciesCreated: number;
  occupanciesRefreshed: number;
  /** Spells this registration used to claim and no longer does. */
  occupanciesEnded: number;
  /** Units lifted out of «غير ممسوحة» / «زيارة بلا رد» / «بيانات ناقصة». */
  unitsSurveyed: number;
  casesResolved: number;
  /**
   * Units whose confirmed vacancy this registration lifted, because it recorded
   * a household in a flat the municipality had called empty. Optional on the
   * wire for responses from before migration 0043.
   */
  vacanciesEnded?: number;
  /** Structures that had no name until this card supplied one. */
  buildingsNamed: number;
}

/** Every filter the ledger composes. All optional; any subset is valid. */
export interface BuildingListFilter {
  parcelNumber?: string;
  zoneId?: string;
  structureType?: StructureType;
  lifecycleStatus?: BuildingLifecycle;
  surveyStatus?: SurveyStatus;
  damageLevel?: DamageLevel;
  /** Matches code, name, posted number or parcel number. */
  search?: string;
  /** `false` selects the structures with no entrance recorded. */
  hasEntrance?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateBuildingInput {
  parcelNumber: string;
  name?: string;
  postedNumber?: string;
  /**
   * «هل الوحدة مفروزة على عقار» — omitted entirely when nobody established it.
   *
   * Absent and `null` are the same answer on a creation, so the wizard sends
   * the key only when the officer actually answered. The column is nullable and
   * the absence is the third state — see the schema.
   */
  isPartitioned?: boolean;
  /**
   * أرقام الأقسام, sent only alongside `isPartitioned: true`.
   *
   * The server drops them otherwise rather than refusing the request — a form
   * whose checkbox was ticked, filled in and then cleared is a correction, and
   * failing the save over the rows somebody abandoned would punish them for
   * changing their mind.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on.
   *
   * `parcelNumber` above names one and cannot name more: the code and the
   * per-parcel suffix derive from it (D9). The server drops the building's own
   * parcel from this list if it appears, so a structure can never be recorded
   * as straddling itself.
   */
  sharedParcelNumbers?: string[];
  structureType: StructureType;
  /** Defaults to `IN_USE` server-side — what an officer is looking at most days. */
  lifecycleStatus?: BuildingLifecycle;
  latitude?: number;
  longitude?: number;
  floorsCount?: number;
  /** Levels below ground, as a depth: 2 means B1 and B2. Omitted means none. */
  basementsCount?: number;
  notes?: string;
  /**
   * The suffix a phone showed while offline. Never trusted — the server
   * re-allocates under a lock (§4.4) and the response says whether the code the
   * officer has been quoting changed.
   */
  provisionalSuffix?: string;
  /** The browser's own id for this creation, which is also the row's id. */
  clientSubmissionId?: string;
  /**
   * «نعم، هذه منشأة مختلفة» — the officer has seen what already stands on this
   * parcel and is asserting this is not one of them.
   *
   * The server refuses a second structure on an occupied parcel without it, and
   * answers the refusal with the candidates (`duplicateBuildingsOf`). Never set
   * by default: the answer is always allowed to be yes, but it has to be given.
   */
  acknowledgedDuplicates?: boolean;
  /**
   * The officer's sentence behind `acknowledgedDuplicates` — what makes this a
   * separate structure. Written into the creation's audit row beside the
   * neighbours and their distances. The editor requires it; the server accepts
   * its absence so that creations already queued on phones still land.
   */
  duplicateReason?: string;
  /** Why the building is created with no entrance pin. See the schema. */
  noPinReason?: string;
  /**
   * The matrix, created in the same transaction as the shell.
   *
   * For the registration form, which creates a structure the officer is
   * standing in front of and must attach a household to it in the same save. A
   * shell alone would be worse than nothing there: the census claims a flat
   * only where the card line carries a `unitId`, so a building with no units
   * links the card and records no occupancy at all.
   *
   * Each unit may carry the id the browser minted, for the same reason the
   * building does — a phone with no signal has to put a `unitId` on a card
   * before the row exists. `sequence` is omitted and allocated server-side.
   */
  units?: Array<{
    id?: string;
    floor: number;
    sequence?: number;
    startCol?: number;
    endCol?: number;
    unitType: UnitType;
    postedNumber?: string;
    side?: string;
    unitArea?: number;
    unitStatus?: UnitStatus;
    surveyStatus?: SurveyStatus;
    notes?: string;
  }>;
}

export type UpdateBuildingInput = Partial<{
  /** The building's `updatedAt` as the editor loaded it — see the schema. */
  expectedUpdatedAt: string;
  name: string | null;
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — nullable here, unlike on a creation.
   *
   * An absent key leaves the column as it is; `null` unsets it back to
   * «غير محدد». Both are needed: an officer has to be able to withdraw a فرز
   * they ticked by mistake, and an edit that could only ever set it would make
   * the answer one-way.
   */
  isPartitioned: boolean | null;
  /**
   * Replaces the stored أقسام wholesale, and is cleared outright whenever the
   * فرز flag is not `true` — sending either field makes the server re-resolve
   * both, so a PATCH that unsets the flag cannot leave the numbers behind.
   */
  partitionNumbers: string[];
  /** Replaces the stored list wholesale — an empty array clears it. */
  sharedParcelNumbers: string[];
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  basementsCount: number;
  notes: string | null;
}>;

/**
 * How to fill a matrix. Two shapes, because officers arrive with two different
 * amounts of knowledge — "six floors, four flats each" from the pavement, or a
 * row per floor from someone who has walked the stairwell.
 */
export type UnitBlueprintInput =
  | {
      kind: 'uniform';
      fromFloor: number;
      toFloor: number;
      unitsPerFloor: number;
      unitType: UnitType;
    }
  | {
      kind: 'explicit';
      floors: Array<{ floor: number; unitCount: number; unitType: UnitType }>;
    };

export interface UpsertUnitInput {
  floor: number;
  /** Omitted on create: the server takes the next free spot on the floor. */
  sequence?: number;
  startCol?: number;
  endCol?: number;
  unitType: UnitType;
  postedNumber?: string;
  side?: string;
  unitArea?: number;
  unitStatus?: UnitStatus;
  surveyStatus?: SurveyStatus;
  notes?: string;
  /**
   * «نعم، هذه وحدة مختلفة» — the officer has seen what is already on this
   * floor and is asserting the unit they are adding is not one of them. The
   * server refuses a same-type addition without it; see `upsertUnitSchema`.
   */
  acknowledgedDuplicates?: boolean;
}

export interface RecordOccupancyInput {
  unitId: string;
  citizenId: string;
  role: OccupancyRole;
  /** Owners only — the server refuses shares on a tenant. */
  shares?: number;
  /**
   * حالة الوحدة — owners only, for the same reason shares are.
   *
   * A tenant or a شاغل بتسامح *is* the occupant of what is being recorded,
   * so their capacity settles the unit’s state and the server derives it. An
   * owner’s does not: they may live there, let it, lend it, or hold it empty,
   * and those are four different bills.
   */
  unitStatus?: UnitStatus;
  /**
   * «نعم، الوحدة لم تعد شاغرة».
   *
   * Recording somebody in a unit whose vacancy is standing is refused without
   * this — the server answers with the confirmation itself so the officer can
   * see when the flat was called empty and on what basis before overriding it.
   * With it, the vacancy is lifted as «لم تعد شاغرة» in the same request.
   *
   * Not needed to record an owner, who contradicts nothing by holding a deed.
   */
  endsVacancy?: boolean;
  /**
   * مساحة الوحدة — offered only where the census has none.
   *
   * The area belongs to the unit, not to the spell, and the server writes it
   * onto the `Unit` and only where that column is still null: a measured flat
   * is never overwritten by a side effect of recording who lives in it. It is
   * accepted *here* because this is the first moment anyone has been inside —
   * the matrix is painted from the street, so `generateUnits` and the grid both
   * create flats with no area at all, and the card `claimOnFile` then mints for
   * the citizen inherited that absence.
   */
  unitArea?: number;
  /** Why no area is being given for a unit the census has none for. See the schema. */
  unitAreaMissingReason?: string;
  /** Owners: why «ومن يشغلها؟» is left unanswered. See the schema. */
  unitStatusMissingReason?: string;
  fromDate?: string;
  toDate?: string;
  /**
   * «المالك» — non-owners only. One of the owners already recorded on this
   * unit, linked in the same request; among co-owners, the one the tenant deals
   * with. The server refuses an owner recorded after the tenant.
   */
  landlordCitizenId?: string;
  /** The owner as the tenant names them, when not recorded on the unit. */
  landlordName?: string;
  landlordPhone?: string;
}

/** What linking the picked owner did — see `LandlordLinkService.linkRecordedOwner`. */
export interface RecordedOwnerLink {
  linked: boolean;
  alreadyLinked: boolean;
  /** The flat moved onto a tenancy card of its own to carry this owner. */
  split: boolean;
  propertyEntryId: string | null;
  reason: 'TENANT_NO_FILE' | 'UNLINKABLE_STRUCTURE' | null;
}

/**
 * What recording the occupant did to that citizen’s own file.
 *
 * The server now links the two halves by default, so `backed` is true for
 * every citizen who has a file at all. `outcome` is what the officer is told
 * when it is not — and `'NO_FILE'` is the only ordinary way that happens.
 */
export interface OccupancyFileLink {
  backed: boolean;
  outcome:
    | 'ENTRY_CREATED'
    | 'UNIT_ADDED'
    | 'ALREADY_CLAIMED'
    | 'NO_FILE'
    | 'UNLINKABLE_STRUCTURE'
    | 'NO_BUILDING';
}

export interface RecordDamageInput {
  /** Exactly one of these two. Both, or neither, is refused server-side. */
  buildingId?: string;
  unitId?: string;
  level: DamageLevel;
  source?: DamageSource;
  observations?: string;
  assessedAt?: string;
  /** «موعد إعادة الكشف», "YYYY-MM-DD" — only with `UNINHABITABLE`; refused on any other level. */
  reinspectAt?: string;
}

/**
 * What «سجل المباني»'s selects may offer — every list is the set of values the
 * census actually holds, so choosing one can never return an empty table for
 * the reason that nothing was ever filed under it.
 */
export interface BuildingFilterOptions {
  structureTypes: StructureType[];
  lifecycleStatuses: BuildingLifecycle[];
  surveyStatuses: SurveyStatus[];
  damageLevels: DamageLevel[];
}

/**
 * Every building matching the filters, with the totals for that same set.
 *
 * Not cached: this is what an officer reloads after creating a building from
 * the map, and a stale ledger is how the same structure gets entered twice.
 */
export function getBuildings(
  tenant: string,
  token: string,
  filter: BuildingListFilter = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return apiFetch<{
    buildings: BuildingLedgerRow[];
    total: number;
    summary: CensusSummary;
    /**
     * With a `parcelNumber` filter: suffixes «تصحيح رقم العقار» retired on
     * that parcel, which a new building there never gets.
     */
    retiredSuffixes?: string[];
  }>(tenant, `/buildings${qs ? `?${qs}` : ''}`, { token, signal });
}

/**
 * The values «سجل المباني»'s filters may offer, as found in the census.
 *
 * A *reference* read, not a data read: it describes the municipality's
 * vocabulary — which kinds of structure it has entered, which conditions it
 * has assessed — rather than the rows on screen. It changes when somebody
 * records the first building of a kind, which is a handful of times in a
 * register's life, so the caller reads it once per session (see
 * `useStaffQuery`'s `reference` option) instead of on every visit to the page.
 */
export function getBuildingFilterOptions(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<BuildingFilterOptions>(tenant, '/buildings/filter-options', { token, signal });
}

/** One building with its whole unit matrix and each unit's occupants. */
export function getBuilding(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<BuildingDetail>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    signal,
  });
}

/*
  ── The census as a *form control* reads it ──────────────────────────

  The two readers below answer the same questions as `getBuildings` and
  `getBuilding` above, and differ only in that they remember the answer.

  The ledger screen must not: an officer reloads it precisely to see what a
  colleague just entered, and a stale ledger is how one structure gets created
  twice. `BuildingUnitPicker` is the opposite case. It asks the same two
  questions — "what stands on عقار 403" and "what flats are in this one" —
  every time it mounts, and it mounts far more often than anything changes:
  each card of a multi-property household, each fold and unfold, each open of
  the edit form on a record whose parcel was read a minute ago. Every one of
  those re-asks was a spinner over an answer the tab already had.

  Memory-only and dropped by any census write (see `invalidateCensus`), so the
  window in which this can be wrong is one officer's own tab, between their own
  changes — and a hard reload still goes to the network, which is what makes
  reloading the honest way to demand fresh data.
*/
const CENSUS_TTL_MS = 5 * 60 * 1000;

const parcelKey = (tenant: string, parcelNumber: string) =>
  `census:${tenant}:parcel:${parcelNumber}`;
const buildingKey = (tenant: string, id: string) => `census:${tenant}:building:${id}`;

/**
 * Dropped wholesale rather than surgically.
 *
 * A unit added to one building changes that building's matrix, the parcel
 * listing that counts its units, and — once occupancy is recorded — the
 * occupants on a unit two screens away. Working out which keys a given write
 * touched is a rule that has to be re-derived every time an endpoint grows a
 * field, and the failure mode of getting it wrong is a form showing an officer
 * their own edit as though it had not saved. The prefix is per-tenant, the map
 * holds a handful of entries, and re-reading is one request.
 */
function invalidateCensus(tenant: string): void {
  invalidateRequests(`census:${tenant}:`);
}

/**
 * Structures standing on one عقار, remembered for the life of the tab.
 *
 * «Standing on» includes a building filed under another parcel that lists this
 * one among its `sharedParcelNumbers` — the server matches both. A caller that
 * needs only the buildings *filed* here (the code-suffix preview) filters on
 * `row.parcelNumber` itself.
 */
export function getParcelBuildings(tenant: string, token: string, parcelNumber: string) {
  return cachedRequest(parcelKey(tenant, parcelNumber), CENSUS_TTL_MS, () =>
    getBuildings(tenant, token, { parcelNumber, limit: 50 }),
  );
}

/** `getBuilding`, remembered — the matrix a picker re-reads on every mount. */
export function getBuildingCached(tenant: string, token: string, id: string) {
  return cachedRequest(buildingKey(tenant, id), CENSUS_TTL_MS, () =>
    getBuilding(tenant, token, id),
  );
}

/**
 * What is already known, for a control seeding its first render.
 *
 * Without these a re-mount renders one frame of «جاري مراجعة سجل المباني…»
 * before the cached promise settles in the next microtask — brief, but it is
 * the frame the officer reads as the work being redone.
 */
export function peekParcelBuildings(tenant: string, parcelNumber: string) {
  return peekCachedRequest<{ buildings: BuildingLedgerRow[]; total: number; summary: CensusSummary }>(
    parcelKey(tenant, parcelNumber),
  );
}

export function peekBuilding(tenant: string, id: string) {
  return peekCachedRequest<BuildingDetail>(buildingKey(tenant, id));
}

/**
 * The condition log for one structure, newest first, plus the current level.
 *
 * Includes its units' own readings: "top three floors gone, ground floor shop
 * still trading" is two rows about one building.
 */
export function getBuildingDamage(
  tenant: string,
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return apiFetch<{ current: DamageLevel | null; history: DamageAssessmentRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/damage`,
    { token, signal },
  );
}

/**
 * Creates the shell. The suffix is allocated server-side, under a lock.
 *
 * `reconciled: true` means the provisional code the phone was showing is not
 * the one it got, and the officer has to be told — they will otherwise keep
 * quoting a code that names nothing. `deduplicated: true` means this exact
 * creation had already been delivered, so nothing new was made.
 */
export async function createBuilding(
  tenant: string,
  token: string,
  input: CreateBuildingInput,
) {
  const result = await apiFetch<{
    building: BuildingSummary;
    reconciled: boolean;
    deduplicated: boolean;
  }>(tenant, '/buildings', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/** Omitted fields are left alone. `parcelNumber` cannot be changed — see the schema. */
export async function updateBuilding(
  tenant: string,
  token: string,
  id: string,
  input: UpdateBuildingInput,
) {
  const result = await apiFetch<BuildingSummary>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «تصحيح رقم العقار»  ─────────────────────────────

/** What correcting a building's parcel would do — read before anything is asked. */
export interface ParcelCorrectionPreview {
  building: {
    id: string;
    code: string;
    parcelNumber: string;
    sharedParcelNumbers: string[];
    zoneCode: string | null;
    zoneName: string | null;
    hasPin: boolean;
    updatedAt: string;
  };
  next: {
    parcelNumber: string;
    /** Predicted: allocated under the parcel lock on save. */
    codeSuffix: string;
    code: string;
    zoneCode: string | null;
    zoneName: string | null;
    zoneChanged: boolean;
    /** Corrected back to a parcel it had left: it takes its own old code back. */
    reclaimsOwnCode: boolean;
    wasSharedParcel: boolean;
  };
  cadastre: {
    /** null: this municipality has no cadastre loaded. */
    known: boolean | null;
    point: { latitude: number; longitude: number } | null;
    /** null: no pin, or no outline known for the parcel. */
    pinInside: boolean | null;
  };
  neighbours: DuplicateBuildingCandidate[];
  cards: {
    toRewrite: number;
    current: number;
    citizenCount: number;
    citizens: Array<{ citizenId: string; name: string }>;
    underSharedParcel: number;
    otherNumber: number;
  };
  unlinkedOnOldParcel: number;
  unlinkedOnNewParcel: number;
  cases: number;
}

export interface ParcelCorrectionResult {
  building: {
    id: string;
    parcelNumber: string;
    codeSuffix: string;
    code: string;
    sharedParcelNumbers: string[];
    updatedAt: string;
  };
  previousCode: string;
  reclaimedOwnCode: boolean;
  cardsCorrected: number;
  citizensAffected: number;
  casesCorrected: number;
  pinInsideNewParcel: boolean | null;
}

export function getParcelCorrectionPreview(
  tenant: string,
  token: string,
  buildingId: string,
  parcelNumber: string,
  signal?: AbortSignal,
) {
  return apiFetch<ParcelCorrectionPreview>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction?parcelNumber=${encodeURIComponent(parcelNumber)}`,
    { token, signal },
  );
}

/** «تصحيح رقم العقار». Refused with the candidates when the right parcel already carries a structure. */
export async function correctBuildingParcel(
  tenant: string,
  token: string,
  buildingId: string,
  input: {
    parcelNumber: string;
    reason: string;
    acknowledgedDuplicates?: boolean;
    keepOldAsShared?: boolean;
    expectedUpdatedAt?: string;
  },
) {
  const result = await apiFetch<ParcelCorrectionResult>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** The building editor's save: the shell and the matrix difference, all or nothing. */
export interface BuildingMatrixSave {
  building: Omit<UpdateBuildingInput, 'expectedUpdatedAt'>;
  remove: string[];
  update: Array<{ id: string; floor: number; startCol?: number; endCol?: number; unitType: string }>;
  add: Array<{ floor: number; startCol?: number; endCol?: number; unitType: string }>;
  expectedUpdatedAt?: string;
  /** Do it all and roll back — what a save would do, or why it would be refused. */
  dryRun?: boolean;
}

export interface BuildingMatrixSaveResult {
  dryRun: boolean;
  building: BuildingSummary;
  /** Unit codes as they were. */
  removed: string[];
  /** Unit codes after the save. */
  updated: string[];
  added: string[];
}

export async function saveBuildingMatrix(tenant: string, token: string, id: string, input: BuildingMatrixSave) {
  const result = await apiFetch<BuildingMatrixSaveResult>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/matrix-save`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  if (!input.dryRun) invalidateCensus(tenant);
  return result;
}

/** SUPER_ADMIN only. Refused server-side once anyone is recorded as living in it. */
export async function deleteBuilding(tenant: string, token: string, id: string) {
  const result = await apiFetch<{ deleted: boolean }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Fills the matrix from a blueprint. Additive and idempotent — a floor that
 * already holds the requested number of units is topped up, never doubled, so a
 * re-tap on a slow connection cannot invent flats.
 */
export async function generateUnits(
  tenant: string,
  token: string,
  buildingId: string,
  blueprint: UnitBlueprintInput,
) {
  const result = await apiFetch<{ created: number; skipped: number; units: UnitRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units/generate`,
    { token, method: 'POST', body: JSON.stringify(blueprint) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Adds one unit by hand. Without a `sequence` the server takes the next free one. */
export async function addUnit(
  tenant: string,
  token: string,
  buildingId: string,
  input: UpsertUnitInput,
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Corrects one unit. Not nested under its building — a unit id is unique on its
 * own, and a path carrying both would let the two disagree.
 */
export async function updateUnit(
  tenant: string,
  token: string,
  unitId: string,
  input: Partial<UpsertUnitInput> & {
    /** «مسكن موسمي» facts — see `UnitRow.presenceMonths`. */
    presenceMonths?: number[];
    ownerLastStayAt?: string | null;
    vacancyDeclaredAt?: string | null;
  },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'PATCH', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «تعديل عرض الوحدة» — a unit's new edges on its floor's grid. The server
 * refuses drawing over a neighbour and pins the floor's unpositioned units
 * where the matrix drew them.
 */
export async function resizeUnitSpan(
  tenant: string,
  token: string,
  unitId: string,
  span: { startCol: number; endCol: number },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/span`,
    { token, method: 'PATCH', body: JSON.stringify(span) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Removes a flat the matrix says exists and the street does not — a blueprint
 * that overshot a floor, or a محل counted twice.
 *
 * Refused server-side the moment anything has been recorded against the unit:
 * an occupancy current or past, a field visit, a damage assessment, or a
 * citizen's card naming it. Those refusals arrive as a `ConflictError` whose
 * message names the remedy, so callers should surface it verbatim rather than
 * replacing it with a generic failure.
 */
export async function deleteUnit(tenant: string, token: string, unitId: string) {
  const result = await apiFetch<{ deleted: true }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Records who is in a unit — and closes whatever case was waiting to find out.
 *
 * `casesResolved` is why this returns anything at all: silently closing
 * somebody else's dispatch item is how a case list stops being believed, so the
 * number is surfaced to the officer who caused it.
 */
export async function recordOccupancy(
  tenant: string,
  token: string,
  input: RecordOccupancyInput,
) {
  const result = await apiFetch<{
    occupancy: UnitOccupant;
    casesResolved: number;
    fileLink: OccupancyFileLink;
    /** Null when no owner was picked. Optional for a server from before it. */
    ownerLink?: RecordedOwnerLink | null;
  }>(
    tenant,
    '/buildings/occupancies',
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «ربط بالمالك» — links a tenant already on the unit to one of its recorded
 * owners. `confirmRecordedAfter` is required when that owner was recorded on the
 * unit after the tenant, and is sent only once the officer confirmed it.
 */
export async function linkOccupancyOwner(
  tenant: string,
  token: string,
  occupancyId: string,
  landlordCitizenId: string,
  confirmRecordedAfter = false,
) {
  const result = await apiFetch<RecordedOwnerLink>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/owner-link`,
    {
      token,
      method: 'POST',
      body: JSON.stringify({ landlordCitizenId, ...(confirmRecordedAfter ? { confirmRecordedAfter } : {}) }),
    },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * What a flat is once its tenant has gone — asked with the ending, because
 * «مؤجرة» with nobody in it charges nobody. See `AFTER_TENANCY_STATUS`.
 */
export type AfterTenancyStatus = 'OWNER_OCCUPIED' | 'VACANT' | 'RENTED_TO_OTHER' | 'UNKNOWN';

export interface AfterTenancyAnswer {
  afterStatus?: AfterTenancyStatus;
  vacancyBasis?: VacancyBasis;
  vacancyNotes?: string;
}

/** What ending a tenancy changed. */
export interface EndTenancyResult {
  occupanciesEnded: number;
  rowsEnded: number;
  /** The card rows this ending closed. Optional for a server from before it. */
  endedRowIds?: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  casesOpened: number;
  vacanciesConfirmed: number;
  link: Array<{ propertyEntryId: string; ownerId: string; kept: boolean }>;
}

/**
 * Ends a spell without deleting it — the history is the point (D2).
 *
 * A tenant's spell ends their tenancy: their card is kept as an ended tenancy,
 * the owner stays owner, and the flat gets `afterStatus` when nobody else is
 * still recorded living there.
 */
export async function endOccupancy(
  tenant: string,
  token: string,
  occupancyId: string,
  input: { reason: OccupancyEndReason; toDate?: string; newOwnerId?: string } & AfterTenancyAnswer,
) {
  const { toDate, ...rest } = input;
  // An owner's spell ends an ownership — `EndOwnershipResult`; anyone else's, a tenancy.
  const result = await apiFetch<EndTenancyResult | EndOwnershipResult>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/end`,
    {
      token,
      method: 'PATCH',
      body: JSON.stringify(toDate ? { ...rest, toDate } : rest),
    },
  );
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «إنهاء الملكية»  ─────────────────────────────

/** A tenant whose card names this owner as the landlord of a flat. */
export interface OwnershipLinkedTenant {
  citizenId: string;
  name: string;
  propertyEntryId: string;
}

/**
 * What ending an ownership would touch — read before the dialog asks anything,
 * so it asks only what applies to these flats.
 */
export interface OwnershipPreview {
  owner: { id: string; name: string; nonResident: boolean };
  propertyType: string | null;
  propertyNumber: string | null;
  /** When the ownership was recorded — a sale cannot be dated before it. */
  startedAt: string | null;
  units: Array<{
    unitId: string;
    unitCode: string;
    buildingCode: string;
    /** Co-owners keep the flat, and its status. */
    otherOwners: string[];
    /** A buyer among these already owns the flat, and keeps that ownership as it is. */
    otherOwnerIds: string[];
    /** A buyer among these rents the flat: the sale ends that tenancy and records them living there. */
    occupantIds: string[];
    /** «يسكنها المالك» or «مسكن موسمي» — a status about this owner. */
    ownerLivedThere: boolean;
    /** On a sale, what the flat is now has to be said. */
    needsStatus: boolean;
    dwelling: boolean;
    linkedTenants: OwnershipLinkedTenant[];
  }>;
  /** Every current row on the card, in the form's order — what the dialog chooses from. */
  rows: Array<{
    rowId: string;
    unitId: string | null;
    unitCode: string | null;
    unitType: string | null;
    floor: string | null;
    unitArea: number | null;
    needsStatus: boolean;
    otherOwners: string[];
    linkedTenants: OwnershipLinkedTenant[];
  }>;
}

/** What ending an ownership changed. */
export interface EndOwnershipResult {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt: string;
  occupanciesEnded: number;
  rowsEnded: number;
  endedRowIds: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  newOwnerRecorded: boolean;
  casesOpened: number;
  vacanciesConfirmed: number;
  tenantsReleased: Array<{
    tenantId: string;
    tenantName: string;
    propertyEntryId: string;
    mode: 'RELEASED' | 'SPLIT';
  }>;
  /**
   * The flats the buyer rented until the sale — their tenancy ended there, as
   * history. Absent from a server older than the one-step purchase: the
   * frontend and the API deploy separately.
   */
  buyerTenancyEndedOn?: string[];
  /** The flats whose ownership ended — for «سجِّل المالك الجديد الآن». */
  units: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

export type EndOwnershipAnswer = {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt?: string;
  rowIds?: string[];
  newOwnerId?: string;
} & AfterTenancyAnswer;

/** Whether a result is an ownership's — the matrix's end returns either kind. */
export function isOwnershipResult(result: EndTenancyResult | EndOwnershipResult): result is EndOwnershipResult {
  return 'tenantsReleased' in result;
}

export function getOwnershipEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

export function getOccupancyOwnershipPreview(tenant: string, token: string, occupancyId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/ownership-preview`,
    { token },
  );
}

/** «إنهاء الملكية» on an owner's card — the same operation the unit matrix runs for an owner. */
export async function endOwnership(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: EndOwnershipAnswer,
) {
  const result = await apiFetch<EndOwnershipResult>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** What ending a tenancy card would touch — for the dialog's questions. */
export interface TenancyPreview {
  tenant: { id: string; name: string };
  occupancyType: string;
  propertyType?: string;
  landlordName: string | null;
  startedAt: string | null;
  /** The card's flats linked to سجل المباني. */
  units: Array<{
    unitId: string;
    unitCode: string;
    /** Nobody else lives there, so what it is now has to be said. */
    needsStatus: boolean;
    othersRemain: boolean;
    ownerNames: string[];
    ownerNonResident: boolean;
    dwelling: boolean;
  }>;
  /**
   * Every current row on the card, in the form's order — linked flats and
   * lines never linked to one alike. What the dialog chooses from. Optional for
   * a server from before it.
   */
  rows?: TenancyPreviewRow[];
}

export interface TenancyPreviewRow {
  rowId: string;
  unitId: string | null;
  unitCode: string | null;
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: number | null;
  needsStatus: boolean;
  othersRemain: boolean;
  ownerNames: string[];
  ownerNonResident: boolean;
  dwelling: boolean;
}

export function getTenancyEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<TenancyPreview>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

/** «إنهاء الإيجار» on a card — the same operation the unit matrix runs. */
export async function endTenancy(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: {
    reason: 'MOVED_OUT' | 'RECORDED_IN_ERROR';
    endedAt?: string;
    /** Exactly the rows left. Required by the server once a card has more than one. */
    rowIds?: string[];
    unitIds?: string[];
  } & AfterTenancyAnswer,
) {
  const result = await apiFetch<EndTenancyResult>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Appends one observation. There is no update and no delete: a building that
 * was unsafe in 2024 and repaired in 2026 is two facts, and the first is what a
 * compensation claim rests on (D3).
 */
export async function recordDamage(tenant: string, token: string, input: RecordDamageInput) {
  const result = await apiFetch<DamageAssessmentRow>(tenant, '/buildings/damage', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * One logged attempt to survey a unit (P4-T1, D10).
 *
 * `outcome` is a `SurveyStatus` because every state a visit can produce is
 * already in that enum — never `NOT_SURVEYED`, which means nobody went.
 */
export interface UnitVisitRow {
  id: string;
  unitId: string;
  officerId: string | null;
  officerName: string | null;
  visitedAt: string;
  outcome: SurveyStatus;
  notes: string | null;
  createdAt: string;
}

export interface LogVisitInput {
  unitId: string;
  outcome: SurveyStatus;
  visitedAt?: string;
  notes?: string;
  /** This officer already logged this unit in the last twelve hours, and means to again. */
  acknowledgedRepeat?: boolean;
}

/** How recently an officer's own visit makes another one worth a question — the server's window. */
export const REPEAT_VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Logs one attempt and moves the unit to what it found — two facts, one action.
 *
 * `visitCount` comes back because it is the number the matrix shows: «٣
 * محاولات» is the difference between assigning a door and escalating it.
 */
export async function logUnitVisit(tenant: string, token: string, input: LogVisitInput) {
  const result = await apiFetch<{
    visit: UnitVisitRow;
    visitCount: number;
    /**
     * The unit's confirmed vacancy was left standing, so its حالة المسح did
     * *not* move to this visit's outcome. A locked door on a flat already
     * confirmed empty is not news; a visit that found somebody home means the
     * confirmation needs lifting, and only a person can decide that.
     */
    vacancyStands?: boolean;
  }>(tenant, '/buildings/visits', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/**
 * Records that a unit was found empty, with what says so.
 *
 * Its own call rather than a `updateUnit({ unitStatus: 'VACANT', surveyStatus:
 * 'VACANT_CONFIRMED' })`, which is what this was and which the server now
 * refuses: a confirmed vacancy exempts the owner from the occupancy fee, so it
 * is recorded as a row carrying its basis, its date and whoever decided it —
 * and it can be lifted again at any time by `endVacancy`.
 *
 * Refused while a مستأجر or شاغل بتسامح is recorded in the unit, while the flat
 * is a مسكن موسمي, and while another confirmation is already standing. Each
 * refusal names its own remedy, so callers should surface it verbatim.
 */
export async function confirmVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { basis: VacancyBasis; observedAt?: string; notes?: string },
) {
  const result = await apiFetch<{
    vacancy: UnitVacancyConfirmation;
    unit: UnitRow;
    /** «شاغرة قيد التحقق» cases this answered and closed. */
    casesResolved: number;
  }>(tenant, `/buildings/units/${encodeURIComponent(unitId)}/vacancy`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * Lifts the vacancy standing on a unit — the undo, available at any time.
 *
 * `reason` decides what the flat goes back to: «سُجِّل بالخطأ» restores the
 * حالة the confirmation replaced, «لم تعد شاغرة» leaves it occupied by somebody
 * not yet recorded, which is what bills the owner again until they are.
 */
/**
 * «مراجعة حالة الوحدات» — SUPER_ADMIN. Applies the one status rule to every
 * flat whose records disagree, and opens a «تعارض في حالة الوحدة» case on each
 * one a person has to decide. Safe to run again.
 */
export async function settleAllUnitStatuses(tenant: string, token: string) {
  const result = await apiFetch<{
    unitsChecked: number;
    statusesChanged: number;
    casesOpened: number;
    casesResolved: number;
    stillUnderReview: number;
  }>(tenant, '/buildings/units/status-review', { token, method: 'POST' });
  invalidateCensus(tenant);
  return result;
}

export async function endVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { reason: VacancyEndReason; endedAt?: string; notes?: string },
) {
  const result = await apiFetch<{ vacancy: UnitVacancyConfirmation; unit: UnitRow }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/vacancy/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Every attempt on one unit, newest first — the panel behind the count. */
export function getUnitVisits(tenant: string, token: string, unitId: string) {
  return apiFetch<{ visits: UnitVisitRow[] }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/visits`,
    { token },
  );
}

/**
 * One building pin as the map draws it — three visual channels in one row: icon
 * from `structureType`, fill from `surveyRollup`, ring from `worstDamageLevel`.
 * Only buildings that have been given a location appear.
 */
export interface BuildingMapPin {
  id: string;
  code: string;
  name: string | null;
  latitude: number;
  longitude: number;
  parcelNumber: string;
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  unitsTotal: number;
  unitsSurveyed: number;
  /**
   * The **worst** survey status among the units, never the majority (D11).
   *
   * Null for a structure nobody can be inside. Its units really are
   * `NOT_SURVEYED`, and painting them in that colour would put "send an officer
   * here" on a building with no doors hung yet — so the server withholds the
   * channel and the map draws the lifecycle instead.
   */
  surveyRollup: SurveyStatus | null;
  worstDamageLevel: DamageLevel | null;
}

/** Building pins with their rollups, for the fullscreen map (P3-T5). */
export function getBuildingMapPins(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ buildings: BuildingMapPin[] }>(tenant, '/dashboard/map/buildings', {
    token,
    signal,
  });
}

/**
 * Which sector owns which parcel, keyed by parcel number.
 *
 * Built from the sector list plus one read per sector, because membership is
 * `Zone.parcelNumbers` and there is no parcel→sector endpoint to ask (D13). The
 * building editor needs it to preview a code before the building exists: the
 * zone half of `ZONE-PARCEL-SUFFIX` is the only part of that code the client
 * cannot derive from what it already has.
 *
 * Cached for five minutes. Sector membership changes when an administrator
 * saves the zone editor, which is not something that happens between two
 * keystrokes in a parcel field.
 */
export function getZoneParcelIndex(tenant: string, token: string) {
  return cachedRequest(`zone-parcels:${tenant}`, 5 * 60 * 1000, async () => {
    const { zones } = await getZones(tenant, token);
    const details = await Promise.all(zones.map((zone) => getZone(tenant, token, zone.id)));

    const index: Record<string, { id: string; code: string; name: string; color: string }> = {};
    for (const zone of details) {
      for (const parcelNumber of zone.parcelNumbers) {
        // First sector wins, matching the server's own `findFirst`.
        index[parcelNumber] ??= {
          id: zone.id,
          code: zone.code,
          name: zone.name,
          color: zone.color,
        };
      }
    }
    return index;
  });
}

/** One unit inside a BUILDING — شقة, عيادة or محل. */
/**
 * One «تأكيد الشغور» still standing on a unit — that the municipality found
 * this flat empty, when, and on what basis.
 *
 * Shown because it is the reason an owner is not being billed for the unit,
 * and therefore the row a person disputing that — in either direction — is
 * entitled to read. Optional on the wire so a response cached from before
 * migration 0043 reads as "none".
 */
export interface CitizenProfileVacancy {
  id: string;
  /** Null only on a row 0043 backfilled — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
}

export interface CitizenProfileUnit {
  id: string;
  /** This flat left the tenancy (migration 0046) — history, billed for nothing. */
  endedAt?: string | null;
  endReason?: string | null;
  /** The canonical `Unit` this line was linked to, if any. */
  unitId?: string | null;
  unitCode?: string | null;
  unitPostedNumber?: string | null;
  /**
   * Nullable since migration 0031: a per-unit «غير مؤكَّد» flag blanks the
   * field it excuses, so a flat the officer could not fully describe arrives
   * with no type, no floor and no area. Every reader has to render that as an
   * absence — «الطابق » with nothing after it is what the previous types,
   * which promised a value here, produced on screen.
   */
  unitType: string | null;
  floor: string | null;
  side: string | null;
  /**
   * م², or null where nobody has measured the flat.
   *
   * Nullable since `BuildingUnit.unitArea` became nullable (migration 0031),
   * and typed `number` here long after it stopped being one — the server was
   * coercing with `Number()`, which turns `null` into `0`, so an unmeasured
   * flat arrived claiming a measurement of zero. The commonest way to get one
   * is `claimOnFile`: linking an existing owner to a flat from the unit matrix
   * mints a card line from the canonical unit, which for a matrix painted from
   * the street has no area either.
   */
  unitArea: number | null;
  sharedRights: string[];
  /** حالة الوحدة as the owner's card states it. Null means nobody was asked. */
  unitStatus: string | null;
  /**
   * حالة الوحدة as سجل المباني holds it — which billing reads *first*.
   *
   * Reported alongside the card's own so a disagreement between them can be
   * seen rather than silently resolved: «مشغولة من المالك» on a card over
   * «شاغرة» in the census is either a vacancy to lift or a card to correct.
   * Null when this line was never linked to a censused unit.
   */
  censusUnitStatus?: string | null;
  /**
   * «مسكن موسمي» facts — the months (1–12) the owners are usually present,
   * when they last stayed, and when a تصريح بالشغور was filed.
   *
   * The owner bears the occupancy fee on a seasonal home anyway
   * (`OWNER_BILLED_WHILE_ABSENT`); these are the facts the council weighs when
   * deciding to shorten it. Empty and null on every other unit.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  /** The «تأكيد الشغور» standing on the censused unit, if one is. */
  vacancy?: CitizenProfileVacancy | null;
  /**
   * Everyone سجل المباني records as a current owner of the linked flat, with
   * their أسهم. On a tenancy card: the flat's whole ownership beside the one
   * co-owner the card is linked to. `citizenId` is absent on the citizen's own
   * portal view.
   */
  owners?: Array<{ citizenId?: string; name: string; phone?: string | null; shares: number | null }>;
}

export interface CitizenProfileProperty {
  id: string;
  /**
   * When this tenancy ended, and why (migration 0046). An ended card is kept on
   * the file as history, with its lease, and bills nothing. Optional on the wire
   * for a profile cached before it existed.
   */
  endedAt?: string | null;
  endReason?: string | null;
  /** Null when the officer recorded it as «غير مؤكَّد» — see the registration's flags. */
  neighborhood: string | null;
  propertyNumber: string | null;
  propertyType: string;
  occupancyType: string;
  /**
   * Non-owner occupancies. The phone is required of a tenant only.
   *
   * The confirmed owner's registered name while a link stands — resolved on the
   * server so every screen printing it shows the same person — and what the
   * tenant said otherwise. `landlordNameAsTyped` is always the tenant's words.
   */
  landlordName: string | null;
  landlordNameAsTyped?: string | null;
  landlordPhone: string | null;
  /**
   * The registered citizen this card's owner was confirmed to be, if anyone.
   *
   * Read back so an edit opens with the standing link showing — otherwise the
   * form asks «هل هو المالك؟» about a question somebody already answered, over
   * a name field it has left unlocked and editable.
   */
  landlordCitizenId?: string | null;
  landlordReferenceNumber?: string | null;
  /** HOUSE only, owner only. A BUILDING keeps this per unit. */
  unitStatus: string | null;
  buildingName: string | null;
  /** HOUSE/LAND carry these directly; a BUILDING keeps them per unit. */
  unitType: string | null;
  landType: string | null;
  floor: string | null;
  side: string | null;
  tentLocation: string | null;
  unitArea: number | null;
  /** LAND only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares: number | null;
  sharedRights: string[];
  latitude: number | null;
  longitude: number | null;
  /**
   * The censused structure behind this card, when one was linked.
   *
   * Two codes, and they are not interchangeable (D14): `buildingCode` is the
   * municipality's own `ZONE-PARCEL-SUFFIX`; `buildingPostedNumber` is what is
   * painted on the building. A notice prints both, because where they disagree
   * the collector in the street trusts the paint.
   */
  buildingId: string | null;
  buildingCode: string | null;
  buildingPostedNumber: string | null;
  /**
   * حالة المبنى, and the value this is here for is `WAR_DAMAGED_UNINHABITED`:
   * a structure still standing, war-damaged and established as empty. Its units
   * are recorded like any building's, so without this nothing on the card tells
   * a flat in it from a flat somebody lives in. Optional on the wire; null on a
   * card never linked to a censused building.
   */
  buildingLifecycleStatus?: string | null;
  unitCount: number;
  units: CitizenProfileUnit[];
}

export interface CitizenProfileDocument {
  id: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  propertyEntryId: string | null;
  createdAt: string;
}

export interface CitizenProfileRegistration {
  id: string;
  referenceNumber: string;
  submittedAt: string;
  /** `REQUIRES_REVIEW` when `flags` is non-empty; `PENDING` otherwise. */
  status: string;
  /**
   * Fields the officer could not establish, with the reason given for each.
   *
   * Shown on the profile, not only on the edit form: this is the page a
   * collector opens before setting out, and "no phone number, and here is
   * why" is something to know before knocking rather than to discover by
   * opening the record for editing.
   */
  flags: FieldFlag[];
  /**
   * «ملاحظات» — free text from the visit, or null.
   *
   * Beside the flags rather than among them, because it is a different kind of
   * statement. A flag says a required value is missing and why; a note says
   * something no field asked about, flags nothing, and changes no status.
   */
  notes: string | null;
  properties: CitizenProfileProperty[];
  documents: CitizenProfileDocument[];
}

/** One invoice on the citizen's profile. */
export interface CitizenProfilePayment {
  id: string;
  title: string;
  amount: number;
  /** Received so far — below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero: what is still owed. */
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived server-side from the due date, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟» — null on a flat charge, which explains
   * itself, and on every invoice raised before per-unit billing existed.
   */
  assessment?: FeeAssessment | null;
}

/**
 * Where a citizen stands with the municipality's fees.
 *
 * `overdueTotal` is the unpaid amount past its due date. The system levies no
 * penalty on top, so a late fee *is* the unpaid fee — it is reported as its own
 * total because "owes 400,000" and "owes 400,000, all of it late" are different
 * conversations at the counter.
 */
export interface CitizenFeeTotals {
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

export interface CitizenProfile {
  id: string;
  fullName: string;
  /**
   * اسم الأم وشهرتها.
   *
   * Optional on the wire and null on households filed before migration 0044 —
   * both mean «لم يُسأل», which every reader must render as such rather than as
   * a difference between two people.
   */
  motherName?: string | null;
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residencyNumber: string | null;
  residentStatus: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  maritalStatus: string | null;
  bloodType: string | null;
  referenceNumber: string | null;
  /** نوع الملف. Optional on the wire for cached responses from before 0040. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  registeredAt: string;
  /** False for a deactivated record — kept for its history, refused a session. */
  isActive: boolean;
  registrations: CitizenProfileRegistration[];
  /**
   * Tenancy cards other households filed that were confirmed as naming this
   * citizen as their landlord — the owner's side of every link. Optional on the
   * wire for a profile cached before it existed.
   */
  landlordOf?: CitizenProfileLandlordOf[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

/** One card naming this citizen as its confirmed landlord. */
export interface CitizenProfileLandlordOf {
  propertyEntryId: string;
  occupancyType: string;
  tenant: { id: string; name: string; referenceNumber: string | null };
  buildingName: string | null;
  buildingCode: string | null;
  propertyNumber: string | null;
  unitCodes: string[];
  linkedAt: string | null;
  /** Set when the tenancy ended — the link is then the record of who the landlord was. */
  endedAt?: string | null;
}

/**
 * One citizen and everything they have filed. Staff-only: the response
 * carries identity-document numbers and residency status.
 */
export function getCitizenProfile(tenant: string, token: string, citizenId: string) {
  return apiFetch<CitizenProfile>(tenant, `/citizens/${encodeURIComponent(citizenId)}`, { token });
}

/**
 * The signed-in citizen's own record: what they own and what they owe.
 *
 * Replaces `listMyRegistrations`, which reported the review status of each
 * طلب. Properties arrive flattened across filings — a citizen has no reason to
 * care that their four properties were entered in two sittings, which was an
 * artefact of the submission workflow rather than anything about the property.
 */
export interface MyCitizenSummary {
  fullName: string;
  referenceNumber: string | null;
  registeredAt: string;
  isActive: boolean;

  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residentStatus: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  identityDocType: string | null;
  /**
   * Tail only — `•••567`. The full number is never sent to this route; see the
   * note on `CitizenController.mySummary` for why.
   */
  identityDocNumberMasked: string | null;
  civilRecordNumberMasked: string | null;

  /**
   * اسم الأم وشهرتها — theirs to check, since it is now the register's only
   * identifying answer for a Lebanese household. Null means «لم يُسأل».
   */
  motherName?: string | null;
  /** نوع الملف, and what a «غير مقيم في البلدة» record holds instead of a household. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  /**
   * Field paths the register could not establish — «رقم الهاتف»,
   * «properties.0.propertyNumber». Paths only: the officer's reason for each
   * stays staff-side. Absent on a response from before this was sent.
   */
  unestablishedFields?: string[];

  properties: CitizenProfileProperty[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

export function getMySummary(tenant: string, token: string) {
  return apiFetch<MyCitizenSummary>(tenant, '/citizens/me/summary', { token });
}

// ─────────────────────  Citizens registry (staff CRUD)  ─────────────────────

/** One row of the admin citizens table — pre-aggregated, including fee totals. */
export interface CitizenListItem {
  id: string;
  fullName: string;
  /**
   * اسم الأم وشهرتها — the one thing on this row that tells two «محمد خليل»s
   * apart, which is why it travels with every list the UI offers people from.
   *
   * Optional and nullable on the wire: absent means «لم يُسأل» (a record filed
   * before migration 0044), never «a different mother».
   */
  motherName?: string | null;
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  referenceNumber: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  residentStatus: string | null;
  /** نوع الملف — a household file, or «غير مقيم في البلدة» (stored as NON_RESIDENT_OWNER). */
  residence?: CitizenResidence;
  isActive: boolean;
  /** The file «دمج ملفين» folded this one into — pickers skip it, the register points to it. */
  mergedIntoId?: string | null;
  registeredAt: string;

  registrationCount: number;
  propertyCount: number;
  /** When this citizen last filed, if ever. */
  latestSubmittedAt: string | null;
  /** Where their latest registration stands — `REQUIRES_REVIEW` or `PENDING`. */
  latestStatus: string | null;
  /**
   * How many fields on that registration were left «غير مؤكَّد».
   *
   * The registry shows the count; the record's own page shows which fields and
   * the reason given for each.
   */
  unestablishedFieldCount: number;

  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  /** The slice of `outstandingTotal` whose due date has passed — المتأخرات. */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/**
 * The citizen registry. `search` matches name, phone, رقم مرجعي or document
 * number server-side — the table's own search box narrows the page further in
 * the browser.
 */
export function listCitizens(
  tenant: string,
  token: string,
  filter: {
    search?: string;
    limit?: number;
    offset?: number;
    /** `REQUIRES_REVIEW` narrows to records with fields left «غير مؤكَّد». */
    status?: CitizenRecordStatus;
  } = {},
  /**
   * Cancels the request when a newer one supersedes it.
   *
   * Supplied by React Query, which fires it as soon as the query key changes —
   * a new search term, the next page, a different tab. Without it, two requests
   * for the same table race and the slower response wins, so a clerk who
   * corrects a search quickly is shown the results of the term they abandoned.
   */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  if (filter.status) query.set('status', filter.status);
  query.set('limit', String(filter.limit ?? 200));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{
    items: CitizenListItem[];
    total: number;
    /**
     * Computed over every matching citizen, not the returned page.
     *
     * `requiringReview` is deliberately *not* narrowed by the status filter —
     * it is the number the «يتطلب مراجعة» tab offers, so it has to keep saying
     * the same thing once that tab is the one you are on.
     */
    totals: {
      outstanding: number;
      overdue: number;
      inArrears: number;
      requiringReview: number;
    };
  }>(tenant, `/citizens?${query}`, { token, signal });
}

/**
 * One row of «يتطلب مراجعة» — `CitizensService.reviewQueue` on the server.
 * Only what the queue shows: no fee figures, no identity-document number.
 */
export interface ReviewQueueItem {
  id: string;
  fullName: string;
  /** Null on records filed before migration 0044 — «لم يُسأل», not a difference. */
  motherName: string | null;
  referenceNumber: string | null;
  phone: string | null;
  /** Always `REQUIRES_REVIEW` in this list. */
  status: CitizenRecordStatus;
  /** How many «غير مؤكَّد» fields the latest registration carries. */
  openFieldCount: number;
  submittedAt: string;
  /** Who filed it. Optional for an older server; null when unrecorded. */
  filedByName?: string | null;
}

/**
 * «يتطلب مراجعة» — citizens whose latest registration was filed with fields
 * left «غير مؤكَّد», oldest first. Narrowed on the server; `search` matches as
 * the registry's does.
 */
export function getReviewQueue(
  tenant: string,
  token: string,
  filter: { search?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  query.set('limit', String(filter.limit ?? 25));
  query.set('offset', String(filter.offset ?? 0));
  return apiFetch<{ items: ReviewQueueItem[]; total: number }>(
    tenant,
    `/citizens/review-queue?${query}`,
    { token, signal },
  );
}

/** One row of «وحدات غير ممسوحة» — `GET /buildings/unsurveyed-units`. */
export interface UnsurveyedUnitRow {
  unitId: string;
  unitCode: string;
  floor: number;
  unitType: UnitType;
  surveyStatus: SurveyStatus;
  /** Attempts so far — three unanswered doors are a different visit from none. */
  visitCount: number;
  lastVisitAt: string | null;
  buildingId: string;
  buildingCode: string;
  buildingName: string | null;
  parcelNumber: string;
  /** Who put the building on the census — shown to the roles that see everyone's. */
  addedByName: string | null;
}

/**
 * «وحدات غير ممسوحة» — units with no survey answer and nobody recorded on
 * them, in the buildings the viewer added; the roles that see all staff work
 * (`seesAllStaffWork`) get everyone's. Narrowed and paged on the server.
 */
export function getUnsurveyedUnits(
  tenant: string,
  token: string,
  filter: { search?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  query.set('limit', String(filter.limit ?? 25));
  query.set('offset', String(filter.offset ?? 0));
  return apiFetch<{ items: UnsurveyedUnitRow[]; total: number }>(
    tenant,
    `/buildings/unsurveyed-units?${query}`,
    { token, signal },
  );
}

/**
 * The three sections the admin form edits, exactly as it posts them back.
 *
 * `properties` carries only the citizen's most recent registration — the one
 * the form owns. Earlier claims stay visible on the profile page with their
 * own review state, so a name correction cannot silently reopen a claim
 * approved months ago.
 */
export interface CitizenFormData {
  id: string;
  registrationId: string | null;
  /** The filing's own number (رقم الطلب) — not the citizen's. */
  referenceNumber: string | null;
  /** The citizen's الرقم المرجعي, as the citizen file shows it. */
  citizenReferenceNumber?: string | null;
  status: string | null;
  /** نوع الملف the record was filed as. */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  /**
   * The «غير مؤكَّد» fields already on this record, with the reasons given.
   *
   * The edit form opens with these restored so whoever completes the record
   * sees which blanks were deliberate — and can clear a flag simply by filling
   * the field in, which is what takes the record out of «يتطلب مراجعة».
   */
  flags: FieldFlag[];
  /** «ملاحظات» on the most recent registration, or null for none. */
  notes: string | null;
  /**
   * Each card's place in the census, read-only: the building's code and
   * parcel, and each flat's unit code. Never sent back — the census owns it.
   */
  propertyRefs?: Array<{
    propertyId: string;
    buildingCode: string | null;
    parcelNumber: string | null;
    /** `unitId` is the census unit the flat is — what the drawing lights. */
    units: Array<{ id: string; unitCode: string | null; unitId: string | null }>;
    /**
     * The linked building's shape, for the elevation drawing, and its census
     * summary (`BuildingCensusSummary`) — no occupants.
     */
    building: {
      structureType: string;
      lifecycleStatus: string;
      floorsCount: number;
      basementsCount: number;
      parcelNumber: string;
      postedNumber: string | null;
      sharedParcelNumbers: string[];
      isPartitioned: boolean | null;
      partitionNumbers: string[];
      located: boolean;
      unitsTotal: number;
      unitsSurveyed: number;
      zoneCode: string | null;
      zoneName: string | null;
      units: Array<{
        id: string;
        floor: number;
        sequence: number;
        unitType: string | null;
        unitCode: string;
        startCol: number | null;
        endCol: number | null;
      }>;
    } | null;
  }>;
  /** The file as it stands now — sent back as `expectedVersion` on save. */
  version?: string;
  /** The last member of staff who changed this file, and whether it was the viewer. */
  lastStaffEdit?: { name: string | null; at: string; byViewer: boolean } | null;
}

/** Who changed a file after this form opened, carried by a refused save. */
export interface StaleEdit {
  version: string;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  byViewer: boolean;
}

/** The details of a save refused because the file changed since it was opened, or null. */
export function staleEditOf(caught: unknown): StaleEdit | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;
  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;
  const stale = (details as { staleEdit?: unknown }).staleEdit;
  return stale && typeof stale === 'object' ? (stale as StaleEdit) : null;
}

export function getCitizenForm(tenant: string, token: string, citizenId: string) {
  return apiFetch<CitizenFormData>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/form`,
    { token },
  );
}

export interface CitizenWriteInput {
  /** نوع الملف. Absent reads as a household file on the server. */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  /**
   * Fields the officer recorded as «غير مؤكَّد», each with their reason.
   *
   * Absent means "this record is complete", which is what every online save
   * from the counter sends and what the server validates strictly. The server
   * decides what a flag excuses — this only carries them.
   */
  flags?: FieldFlag[];
  /**
   * «ملاحظات» on the registration this submission writes.
   *
   * Stated here because a save *replaces* the note rather than merging it, so
   * anything editing a record outside the full form has to carry the stored one
   * back or silently delete what the last visit wrote. `CitizenForm` has always
   * sent it; it reached the wire through a spread, which is why the field was
   * missing from the type for so long.
   */
  notes?: string;
  /**
   * The browser's own id for this submission, sent only when it was queued
   * offline. It is what lets a retry after a lost response be recognised
   * rather than registering the household a second time.
   */
  clientSubmissionId?: string;
  /**
   * «اسألني إن بدا مسجَّلاً مسبقاً». Sent only on a save with a person at the
   * screen — never stored in the offline queue, whose deliveries must not be
   * refused on arrival. See `adminCreateCitizenSubmissionSchema`.
   */
  reviewDuplicates?: boolean;
  /** Set by the current form on every submission — see `submissionEnvelope.unitStatusAsked`. */
  unitStatusAsked?: boolean;
  /** The officer's answer to the duplicate question, when it was asked. */
  duplicateReview?: DuplicateReviewAnswer;
  /** On an edit: the version the form was opened at. See `CitizenFormData.version`. */
  expectedVersion?: string;
  /**
   * «سبب التعديل». Required by the server when the edit corrects a high-impact
   * field — see `CitizenEditReview.reasonRequired` — and kept on the audit row.
   */
  changeReason?: string;
}

/** One card's changes in a review or a history entry — see the server's `CardChange`. */
export interface CardChangeView {
  cardId: string;
  kind: 'added' | 'removed' | 'changed';
  propertyType: string | null;
  propertyNumber: string | null;
  occupancyType: string | null;
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
  sensitive?: string[];
  rows?: { added: number; removed: number; changed: number };
}

/** «مراجعة التعديلات» — what saving an edit would do, read and never written. */
export interface CitizenEditReview {
  version: string;
  changes: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    /** Every field that changes; sensitive ones appear here only, never with values. */
    changed: string[];
    cards: CardChangeView[];
  };
  /** High-impact fields this edit corrects: the save needs a reason. */
  reasonRequired: string[];
  blockers: Array<{
    code: 'STALE' | 'TENANTS_LINKED';
    message: string;
    tenants?: Array<{ citizenId: string; name: string; propertyEntryId: string }>;
  }>;
  impacts: {
    loginChanges: boolean;
    tenantsShowingName: Array<{ citizenId: string; name: string }>;
    openBills: { count: number; outstanding: number; currency: string } | null;
    cardsRemoved: number;
  };
}

export function reviewCitizenEdit(tenant: string, token: string, citizenId: string, input: CitizenWriteInput) {
  return apiFetch<CitizenEditReview>(tenant, `/citizens/${encodeURIComponent(citizenId)}/edit-review`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** A record already on file that looks like the person being registered. */
export interface DuplicateCandidate {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  motherName: string | null;
  phone: string | null;
  residence: string | null;
  propertyCount: number;
  registeredAt: string | null;
  registeredBy: string | null;
  matchedOn: DuplicateMatchedOn[];
  /**
   * The server is certain this is the same person: the save is refused for an
   * officer rather than asked about. See `DuplicateReviewDialog`.
   */
  certain?: boolean;
}

/** Which of the record's two numbers a match was on. `whatsapp` only when it differs from the phone. */
export type ContactNumberField = 'phone' | 'whatsapp';

/** Somebody this officer registered in the last two hours, on one of this record's numbers. */
export interface DuplicatePhoneOwner {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  phone: string | null;
  fields: ContactNumberField[];
  registeredAt: string;
  minutesAgo: number;
}

export interface DuplicateReviewFindings {
  possibleDuplicates: DuplicateCandidate[];
  phoneOwners: DuplicatePhoneOwner[];
  /** Cards of this record whose landlord number is one of the citizen's own numbers. */
  landlordPhoneCards: Array<{ index: number; landlordName: string | null; field: ContactNumberField }>;
}

export interface DuplicateReviewAnswer {
  differentFrom: string[];
  sharedPhoneWith: string[];
  sharedPhoneWithLandlord: boolean;
  reason: string;
}

export function hasDuplicateFindings(findings: DuplicateReviewFindings): boolean {
  return (
    findings.possibleDuplicates.length > 0 ||
    findings.phoneOwners.length > 0 ||
    findings.landlordPhoneCards.length > 0
  );
}

/**
 * «هل هو مسجَّل مسبقاً؟» asked before anything is written — the same question
 * `createCitizen` refuses on when sent `reviewDuplicates`.
 */
export async function reviewCitizenDuplicates(
  tenant: string,
  token: string,
  input: CitizenWriteInput,
): Promise<DuplicateReviewFindings> {
  return apiFetch<DuplicateReviewFindings>(tenant, '/citizens/duplicate-review', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The findings carried by a creation refused over a possible duplicate, or null. */
export function duplicateReviewOf(caught: unknown): DuplicateReviewFindings | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;
  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;
  const review = (details as { duplicateReview?: unknown }).duplicateReview;
  return review && typeof review === 'object' ? (review as DuplicateReviewFindings) : null;
}

/**
 * «قد يكون مسجَّلاً مسبقاً» while the form is typed — the save's own rule on
 * what has been typed so far, never the register's search box.
 */
export function checkPossibleDuplicates(tenant: string, token: string, query: PossibleDuplicatesQuery) {
  return apiFetch<PossibleDuplicateMatch[]>(tenant, '/citizens/possible-duplicates', {
    token,
    method: 'POST',
    body: JSON.stringify(query),
  });
}

// ─────────────────────────  «دمج ملفين» — SUPER_ADMIN only  ─────────────────────────

/** What folding `absorbId` into `keepId` would do. Read-only. */
export function previewCitizenMerge(tenant: string, token: string, pair: { keepId: string; absorbId: string }) {
  return apiFetch<CitizenMergePreview>(tenant, '/citizens/merge/preview', {
    token,
    method: 'POST',
    body: JSON.stringify(pair),
  });
}

/** The merge, refused if either file moved since the preview whose versions it sends. */
export async function mergeCitizens(
  tenant: string,
  token: string,
  input: { keepId: string; absorbId: string; reason: string; expected: { keep: string; absorb: string } },
) {
  const result = await apiFetch<CitizenMergeResult>(tenant, '/citizens/merge', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  // Occupants moved between people, so every census screen is stale.
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/** The file this one was folded into, and the ones folded into it. */
export function getCitizenMerges(tenant: string, token: string, citizenId: string) {
  return apiFetch<{ into: CitizenMergeRecord | null; from: CitizenMergeRecord[] }>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/merges`,
    { token },
  );
}

export function previewCitizenUnmerge(tenant: string, token: string, mergeId: string) {
  return apiFetch<CitizenUnmergePreview>(tenant, `/citizens/merges/${encodeURIComponent(mergeId)}/undo-preview`, {
    token,
  });
}

/** «التراجع عن الدمج» — refused once either file has changed since the merge. */
export async function undoCitizenMerge(tenant: string, token: string, mergeId: string, reason: string) {
  const result = await apiFetch<CitizenMergeRecord>(tenant, `/citizens/merges/${encodeURIComponent(mergeId)}/undo`, {
    token,
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/**
 * Bulk import from a spreadsheet, sent in batches.
 *
 * Sends the raw cells rather than a shaped payload: the branch rules that turn
 * a flat row into a registration live in `buildCitizenPayload` on the server,
 * next to the schema that validates the result. Shaping here would be a second
 * copy of those rules, free to drift from the one that decides what is valid.
 *
 * Batched because one request per file failed two ways at real sizes. Arabic
 * costs two bytes a character, so a few hundred rows across twenty-nine columns
 * overran the body limit and came back as a 500 `PayloadTooLargeError`; and
 * because each row opens its own transaction, a whole file in one request holds
 * the connection open for minutes. `startRow` keeps every reported row number
 * pointing at the clerk's file rather than at the batch.
 *
 * Batches run in sequence, not `Promise.all`: the server writes rows serially
 * anyway (the tenant pool is five connections), so firing them together would
 * only queue them somewhere less visible while making the progress meaningless.
 *
 * `dryRun` runs the identical path and writes nothing, which is what the
 * preview step reports.
 */
export async function importCitizens(
  tenant: string,
  token: string,
  input: {
    rows: ImportRow[];
    dryRun: boolean;
    /** Called after each batch with rows finished so far, for the progress bar. */
    onProgress?: (done: number, total: number) => void;
  },
): Promise<CitizenImportResult> {
  const merged: CitizenImportResult = {
    dryRun: input.dryRun,
    created: 0,
    failed: 0,
    results: [],
  };

  for (let offset = 0; offset < input.rows.length; offset += IMPORT_BATCH_SIZE) {
    const batch = input.rows.slice(offset, offset + IMPORT_BATCH_SIZE);

    const result = await apiFetch<CitizenImportResult>(tenant, '/citizens/import', {
      token,
      method: 'POST',
      body: JSON.stringify({
        rows: batch,
        // 1-based, and counted in the file the clerk is holding.
        startRow: offset + 1,
        dryRun: input.dryRun,
      }),
    });

    merged.created += result.created;
    merged.failed += result.failed;
    merged.results.push(...result.results);
    input.onProgress?.(Math.min(offset + batch.length, input.rows.length), input.rows.length);
  }

  return merged;
}

/**
 * Files a citizen and their first registration.
 *
 * Lands as PENDING like any claim — or as REQUIRES_REVIEW when the submission
 * carries «غير مؤكَّد» flags, which is what `status` reports back.
 *
 * `deduplicated` says the server already held this `clientSubmissionId` and
 * returned the registration it created the first time. The sync queue counts
 * that as delivered, because it is: the household is on the register, and the
 * only thing that ever went missing was a response.
 */
export async function createCitizen(tenant: string, token: string, input: CitizenWriteInput) {
  const result = await apiFetch<{
    citizenId: string;
    registrationId: string;
    referenceNumber: string;
    propertyCount: number;
    status: CitizenRecordStatus;
    deduplicated: boolean;
    /**
     * What a passport number did: `ATTACHED` to the person already holding it
     * (same name), or `CONFLICT` — held by someone with a different name, so a
     * separate citizen was created and the number left for review.
     */
    identity?: 'NEW' | 'ATTACHED' | 'CONFLICT' | null;
    census: CensusSyncResult | null;
    landlordLinks: LandlordLinkOffers | null;
  }>(tenant, '/citizens', { token, method: 'POST', body: JSON.stringify(input) });
  /*
    A registration is a census write too.

    `census` in the response is the proof: saving this card opened occupancies,
    moved units out of «غير ممسوحة» and possibly created the structure itself.
    Anything the tab remembered about the parcel or the building describes the
    moment before that, including the roster count the رقم العقار field prints.
  */
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/**
 * Replaces the citizen's details and reconciles the properties of their latest
 * registration: an entry with an `id` is updated, one without is created, and
 * a stored entry absent from the payload is deleted along with its documents.
 */
export async function updateCitizen(
  tenant: string,
  token: string,
  citizenId: string,
  input: CitizenWriteInput,
) {
  const result = await apiFetch<{
    updated: boolean;
    citizenId: string;
    status: CitizenRecordStatus;
    /** The file's version after the save. */
    version?: string;
    census: CensusSyncResult | null;
    landlordLinks: LandlordLinkOffers | null;
    /** Links the save undid or brought into line with the card — see the server. */
    landlordLinkChanges?: LandlordLinkChanges;
  }>(tenant, `/citizens/${encodeURIComponent(citizenId)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  // Same reasoning as `createCitizen`: the save re-ran the census sync.
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

// ──────────────────  Owner links (روابط المالكين)  ──────────────────
//
// Identifying the owner a مستأجر named among the register's own citizens. The
// match is computed from `landlordPhone`, never stored, and nothing links
// itself — see `LandlordLinkService` on the server for why both of those are
// deliberate.

/** A registered citizen a claimed landlord number belongs to. */
export interface LandlordCandidate {
  id: string;
  name: string;
  /** The middle name — the father's, which is what tells brothers apart. */
  fatherName: string | null;
  /** Read by a person comparing two records, never a key. */
  motherName: string | null;
  phone: string | null;
  referenceNumber: string | null;
  residence: string;
  registeredAt: string | null;
}

/**
 * Why a link cannot be made yet. Each code names the step that unblocks it,
 * and `message` is the server's Arabic sentence saying so.
 */
export type LinkBlockCode =
  | 'NOT_ON_SURVEY'
  | 'NO_UNITS'
  | 'UNIT_VACANT'
  | 'OWNER_NO_FILE'
  | 'OWNER_CARD_UNLINKED'
  | 'OWNER_OCCUPIES_UNIT'
  /** A flat on the card is recorded as owned by somebody other than this candidate. */
  | 'UNIT_OWNED_BY_OTHER'
  | 'RECONCILE_FAILED';

export interface LinkBlock {
  code: LinkBlockCode;
  message: string;
  unitCode: string | null;
}

/** What a link would do on the owner's file, stated before it is pressed. */
export type LinkOutcome = 'NEW_CARD' | 'ADDED_TO_CARD' | 'ALREADY_ON_FILE' | 'OCCUPANCY_ONLY';

export interface LandlordProposalCandidate extends LandlordCandidate {
  /**
   * `PHONE` — the card's number is theirs. `NAME` — only the name the tenant
   * typed is theirs; never preselected, and the card says so. `PROPERTY` —
   * the occupant gave no number, and this person is on the register as the
   * property's owner; never preselected either.
   */
  matchedBy: 'PHONE' | 'NAME' | 'PROPERTY';
  outcome: LinkOutcome | null;
  blocked: LinkBlock | null;
}

/** One unresolved claim, with whoever its number resolves to. */
export interface LandlordProposal {
  propertyEntryId: string;
  occupancyType: string;
  propertyType: string;
  /** What the tenant said, as typed. */
  landlordName: string | null;
  /** Null when the tenant gave only a name and the owner was found by it. */
  landlordPhone: string | null;
  propertyNumber: string | null;
  buildingName: string | null;
  buildingId: string | null;
  buildingCode: string | null;
  /** The flats a link would put the owner on. Empty when the card is blocked. */
  units: Array<{ unitId: string; unitCode: string | null }>;
  linkedUnitCount: number;
  filedAt: string;
  filedBy: {
    registrationId: string;
    referenceNumber: string;
    citizenId: string;
    name: string;
  } | null;
  /** Why no link can be made from this card yet, whoever the owner is. */
  blocked: LinkBlock | null;
  /** Oldest registration first. More than one is a shared household line. */
  candidates: LandlordProposalCandidate[];
}

/** What undoing a link reverted, and what it deliberately kept. */
export interface UnlinkResult {
  unlinked: boolean;
  /** Confirmed before links recorded what they wrote — nothing could be reverted precisely. */
  legacy: boolean;
  occupanciesEnded: number;
  rowsRemoved: number;
  cardsRemoved: number;
  casesReopened: number;
  kept: Array<{
    unitCode: string | null;
    reason: 'EDITED' | 'SHARED' | 'OWNER_FILE_CLAIMS' | 'HAS_DOCUMENTS' | 'FLAGGED';
    propertyEntryId?: string;
  }>;
  reviewUnits: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

/** What «إلغاء الربط» would do, read when its confirmation opens. */
export interface UnlinkPreview {
  linked: boolean;
  ownerId: string | null;
  ownerName: string | null;
  legacy: boolean;
  linkedAt: string | null;
  unitCodes: string[];
  cardsCreated: number;
  invoicesSinceLink: number;
}

/** Links a save of a household file changed. */
export interface LandlordLinkChanges {
  unlinked: Array<{ propertyEntryId: string; report: Omit<UnlinkResult, 'unlinked' | 'reviewUnits'> }>;
  reconciled: {
    updated: number;
    blocked: Array<{ propertyEntryId: string; block: LinkBlock }>;
  } | null;
}

/**
 * What a save turned up, in both directions.
 *
 * `filed` — this household named an owner the register already holds.
 * `naming` — this household *is* the owner other cards have been naming.
 *
 * Both are offers. Nothing has been linked, because a phone is not an identity
 * and a link can bill.
 */
export interface LandlordLinkOffers {
  filed: LandlordProposal[];
  naming: LandlordProposal[];
}

/** The standing queue — unresolved claims that match a citizen, a page at a time. */
export function getLandlordLinks(
  tenant: string,
  token: string,
  page: { limit: number; offset: number },
  signal?: AbortSignal,
) {
  return apiFetch<{ items: LandlordProposal[]; total: number }>(
    tenant,
    `/citizens/landlord-links?limit=${page.limit}&offset=${page.offset}`,
    { token, signal },
  );
}

/** One open claim — «فحص الرابط». 404 when it is no longer open. */
export function getLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  signal?: AbortSignal,
) {
  return apiFetch<LandlordProposal>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}`,
    { token, signal },
  );
}

/** How much ownership the register knows about and does not bill. */
export function getLandlordLinkSummary(tenant: string, token: string) {
  return apiFetch<{ units: number; owners: number }>(
    tenant,
    '/citizens/landlord-links/summary',
    { token },
  );
}

/**
 * Who is registered on this number? — the form's inline lookup.
 *
 * Everybody on it: a shared household line is where the officer standing with
 * the tenant is best placed to say which person was meant.
 */
export async function getLandlordCandidates(
  tenant: string,
  token: string,
  phone: string,
  signal?: AbortSignal,
) {
  const { candidates } = await apiFetch<{ candidates: LandlordCandidate[] }>(
    tenant,
    `/citizens/landlord-links/candidate?phone=${encodeURIComponent(phone)}`,
    { token, signal },
  );
  return candidates ?? [];
}

/**
 * «نعم، هذا هو المالك».
 *
 * Invalidates the census: confirming records an `OWNER` occupancy on every flat
 * the card names, so the matrix and the map pins this tab is holding describe
 * the moment before it.
 */
export async function confirmLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  citizenId: string,
) {
  const result = await apiFetch<{
    linked: boolean;
    occupanciesRecorded: number;
    unitsClaimed: number;
    /**
     * Whether the structure was added to the owner's own file by this link.
     *
     * False when they had already filed a card on it — the commoner case for an
     * owner the municipality knows — and the link is no less complete for it.
     */
    ownerCardCreated: boolean;
    rowsAdded?: number;
    outcome?: LinkOutcome | null;
  }>(tenant, `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/confirm`, {
    token,
    method: 'POST',
    body: JSON.stringify({ citizenId }),
  });
  invalidateCensus(tenant);
  return result;
}

/** «لا أحد منهم» — these citizens are not the card's owner. */
export function dismissLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  candidateIds: readonly string[],
) {
  return apiFetch<{ dismissed: boolean }>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/dismiss`,
    { token, method: 'POST', body: JSON.stringify({ candidateIds }) },
  );
}

/** The «تراجع» on a dismissal. */
export function restoreLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  candidateIds: readonly string[],
) {
  return apiFetch<{ restored: boolean }>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/restore`,
    { token, method: 'POST', body: JSON.stringify({ candidateIds }) },
  );
}

/** What undoing this card's link would revert — for the confirmation to state. */
export function getLandlordUnlinkPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<UnlinkPreview>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/unlink-preview`,
    { token },
  );
}

/**
 * Undoes a confirmation: the claim goes back to the queue and what the link
 * wrote into the owner's records is reverted. Invalidates the census, because
 * the owner's spells and cards just changed.
 */
export async function unlinkLandlord(tenant: string, token: string, propertyEntryId: string) {
  const result = await apiFetch<UnlinkResult>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Soft delete and its undo — a deactivated citizen is skipped by the biller.
 * `why` goes on the audit row: the reason, and the day they moved away when
 * that is why («تغيير الإقامة»).
 */
export function setCitizenActive(
  tenant: string,
  token: string,
  citizenId: string,
  isActive: boolean,
  why: { reason?: string; movedOn?: string } = {},
) {
  return apiFetch<{ isActive: boolean }>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/active`,
    { token, method: 'PATCH', body: JSON.stringify({ isActive, ...why }) },
  );
}

/**
 * Permanent. SUPER_ADMIN and ADMINISTRATIVE_OFFICER, and only for a citizen
 * nothing points at: the server refuses a filing, payment or fee
 * (`CITIZEN_HAS_RECORDS`) and any unit, landlord link, case, merge or
 * checkout (`CITIZEN_HAS_LINKS`).
 */
export function deleteCitizen(tenant: string, token: string, citizenId: string) {
  return apiFetch<{ deleted: boolean }>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}`,
    { token, method: 'DELETE' },
  );
}

/** Opens the signed URL in a new tab; the backend records who viewed what. */
export function getDocumentViewUrl(tenant: string, token: string, documentId: string) {
  return apiFetch<{ url: string; expiresInSeconds: number }>(
    tenant,
    `/documents/${encodeURIComponent(documentId)}/url`,
    { token },
  );
}

// ───────────────────────────  Staff accounts  ───────────────────────────

export interface StaffSummary {
  id: string;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  hasConfirmedTotp?: boolean;
  /** Performance & commission metrics for field inspectors */
  registeredCitizensCount?: number;
  registeredPropertiesCount?: number;
  totalEarnings?: number;
  paidBalance?: number;
  pendingBalance?: number;
  /** Paid over and above earned. `pendingBalance` clamps at zero and hides it. */
  overpaidBalance?: number;
  createdAt: string;
  lastLoginAt: string | null;
  /**
   * «آخر ظهور» — when this account last made a request, null if not since
   * migration 0070.
   *
   * A timestamp and not an `online` boolean, deliberately: the staff page
   * needs «آخر ظهور» for whoever is *not* here, and a server that answered
   * only yes/no would have thrown that away. `isStaffOnline` applies the
   * threshold. Older accounts and a backend before 0070 send null, which
   * reads as offline with nothing to say about when.
   */
  lastSeenAt?: string | null;
  /** Set only on a deleted account the earnings roster asked for. */
  deletedAt?: string | null;
}

/**
 * How recently a staff account must have been seen to read «متصل الآن».
 *
 * Mirrors `ONLINE_WITHIN_SECONDS` in the backend's `StaffPresenceService`,
 * which stamps the column at most once a minute — so the slack here is for
 * that throttle, not for taste. Changing one without the other makes the
 * label disagree with the data behind it.
 */
export const STAFF_ONLINE_WITHIN_MS = 5 * 60 * 1000;

/** Whether this account counts as here now. Null — never seen — is offline. */
export function isStaffOnline(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return false;
  return Date.now() - seen <= STAFF_ONLINE_WITHIN_MS;
}

/**
 * Every staff account that has not been deleted. `includeDeletedEarners` adds
 * the deleted accounts that earned or were paid commission — the earnings
 * roster's totals are history and must not shrink when an account is hidden.
 */
export function getStaff(
  tenant: string,
  token: string,
  signal?: AbortSignal,
  options: { includeDeletedEarners?: boolean } = {},
) {
  const query = options.includeDeletedEarners ? '?include=deleted-earners' : '';
  return apiFetch<{ items: StaffSummary[] }>(tenant, `/staff${query}`, { token, signal });
}

/**
 * Creates an account. `confirmPassword` is deliberately not sent — it is a
 * typo guard for whoever is typing, not something the server can verify.
 */
export function createStaff(
  tenant: string,
  token: string,
  input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: string;
  },
) {
  return apiFetch<{ id: string; totp?: { secret: string; keyUri: string } }>(tenant, '/staff', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Partial update. An omitted `password` leaves the current one alone. */
export function updateStaff(
  tenant: string,
  token: string,
  id: string,
  input: {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  },
) {
  return apiFetch<{ updated: boolean }>(tenant, `/staff/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Soft delete and its undo. */
export function setStaffActive(tenant: string, token: string, id: string, isActive: boolean) {
  return apiFetch<{ isActive: boolean }>(tenant, `/staff/${encodeURIComponent(id)}/active`, {
    token,
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
}

/** Permanent — the server refuses it for any account that has already acted. */
export function deleteStaff(tenant: string, token: string, id: string) {
  return apiFetch<{ deleted: boolean }>(tenant, `/staff/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

/** A staff account a super admin has deleted. */
export interface DeletedStaffSummary {
  id: string;
  email: string;
  fullName: string;
  role: string;
  deletedAt: string;
}

/** The deleted staff accounts, most recent first — what a restore is made from. */
export function getDeletedStaff(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: DeletedStaffSummary[] }>(tenant, '/staff/deleted', { token, signal });
}

/** Brings a deleted account back onto the staff list, still disabled. */
export function restoreStaff(tenant: string, token: string, id: string) {
  return apiFetch<{ restored: boolean }>(tenant, `/staff/${encodeURIComponent(id)}/restore`, {
    token,
    method: 'POST',
  });
}

/** Field Inspector self-service dashboard & performance summary */
export function getMyInspectorProfile(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<InspectorProfileResponse>(tenant, '/staff/inspector/me/profile', {
    token,
    signal,
  });
}

/** Super Admin (or Inspector) viewing an inspector profile dashboard */
export function getInspectorProfile(
  tenant: string,
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return apiFetch<InspectorProfileResponse>(
    tenant,
    `/staff/inspectors/${encodeURIComponent(id)}/profile`,
    {
      token,
      signal,
    },
  );
}

/** Super Admin records a commission payment made to an inspector */
export function recordInspectorPayout(
  tenant: string,
  token: string,
  id: string,
  input: RecordInspectorPayoutInput,
) {
  return apiFetch<InspectorPayoutItem>(
    tenant,
    `/staff/inspectors/${encodeURIComponent(id)}/payouts`,
    {
      token,
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  actorRole: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Sensitive values arrive already replaced with `[redacted]`. */
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
  /** Who did it, resolved by the server — a staff member's name, or «النظام». */
  actor?: {
    kind: 'STAFF' | 'CITIZEN' | 'SYSTEM';
    name: string | null;
    role: string | null;
    email: string | null;
  };
  /** What it was done to, as a person reads it, and where to open it. */
  target?: {
    type: string;
    id: string | null;
    label: string | null;
    secondary: string | null;
    link: { kind: 'citizen' | 'staff' | 'building' | 'case' | 'zone'; id: string } | null;
    missing: boolean;
  };
}

export interface AuditFacets {
  actions: string[];
  entityTypes: string[];
  actors: Array<{ id: string; name: string; role: string | null; isActive: boolean }>;
}

export function getAuditFacets(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<AuditFacets>(tenant, '/audit/facets', { token, signal });
}

/**
 * «سجل التعديلات» — one citizen's or building's own history: what was changed,
 * by whom, from what to what, and why. Open to everyone who can open the
 * record, unlike `getAuditLog`: the server leaves out who viewed it and how it
 * is being reviewed, and strips repair snapshots.
 */
export function getRecordHistory(
  tenant: string,
  token: string,
  record: { kind: 'citizen' | 'building'; id: string },
  page: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    limit: String(page.limit ?? 30),
    offset: String(page.offset ?? 0),
  });
  const path = record.kind === 'citizen' ? 'citizens' : 'buildings';
  return apiFetch<{ items: AuditEntry[]; total: number }>(
    tenant,
    `/${path}/${encodeURIComponent(record.id)}/history?${query.toString()}`,
    { token, signal },
  );
}

/** SUPER_ADMIN/AUDITOR only, server-enforced. Omitting `actorId` returns
 * every administrative action; passing it (e.g. the signed-in user's own id)
 * narrows the trail down to one admin's activity. */
export function getAuditLog(
  tenant: string,
  token: string,
  filter: {
    actorId?: string;
    entityType?: string;
    /** One record's own trail. Pairs with `entityType`; the server indexes both. */
    entityId?: string;
    /** Any of these action codes. */
    actions?: string[];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
  /** See `listCitizens`. */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.actorId) query.set('actorId', filter.actorId);
  if (filter.entityType) query.set('entityType', filter.entityType);
  if (filter.entityId) query.set('entityId', filter.entityId);
  if (filter.actions?.length) query.set('action', filter.actions.join(','));
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  query.set('limit', String(filter.limit ?? 50));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{ items: AuditEntry[]; total: number }>(tenant, `/audit?${query}`, {
    token,
    signal,
  });
}

/** One staff member's day in «التقرير اليومي». */
export interface AuditDaySummary {
  /** `YYYY-MM-DD`, bucketed in the zone this browser asked for. */
  day: string;
  actor: {
    id: string | null;
    kind: 'STAFF' | 'CITIZEN' | 'SYSTEM';
    name: string | null;
    role: string | null;
    email: string | null;
  };
  /** Commonest first. */
  actions: Array<{ action: string; count: number }>;
  total: number;
  lastAt: string;
}

/**
 * The same trail as `getAuditLog`, rolled up to one row per person per day.
 *
 * The day boundaries are the reader's, so the zone goes with the request —
 * grouping server-side in UTC would file an evening's work under the next
 * morning for everyone in Lebanon.
 */
export function getAuditDaily(
  tenant: string,
  token: string,
  filter: {
    actorId?: string;
    entityType?: string;
    actions?: string[];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.actorId) query.set('actorId', filter.actorId);
  if (filter.entityType) query.set('entityType', filter.entityType);
  if (filter.actions?.length) query.set('action', filter.actions.join(','));
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  query.set('timeZone', browserTimeZone());
  query.set('limit', String(filter.limit ?? 50));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{ items: AuditDaySummary[]; total: number }>(tenant, `/audit/daily?${query}`, {
    token,
    signal,
  });
}

/**
 * This browser's IANA zone, or nothing.
 *
 * The server falls back to Asia/Beirut on anything it does not recognise, so an
 * environment without `Intl` resolution loses an hour at the day boundary
 * rather than the screen.
 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export interface CadastreImportResult {
  parcelsImported: number;
  parcelsSkipped: number;
  linesImported: number;
}

/** SUPER_ADMIN only — rebuilds the parcel registry and the map's static
 * cartography layer from an uploaded GeoJSON file. */
export function importCadastre(tenant: string, token: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<CadastreImportResult>(tenant, '/cadastre/import', {
    method: 'POST',
    token,
    body: form,
  });
}

// ─────────────────────────  Fees & payments  ─────────────────────────

export interface MunicipalitySettings {
  /** The municipality's public number, printed on receipts. */
  contactPhone: string | null;
  /**
   * The office WhatsApp account: printed on the receipt for the citizen to
   * reply to, and the account a clerk should be signed into before sending
   * one. It cannot make a `wa.me` link send *from* this number — see the
   * settings screen.
   */
  whatsappNumber: string | null;
  whishMoneyNumber: string | null;
  cashOfficeHours: string | null;
  cashOfficeAddress: string | null;

  // ── Municipality profile ──────────────────────────────────────────────
  nameAr: string | null;
  nameEn: string | null;
  contactEmail: string | null;
  website: string | null;
  governorate: string | null;
  district: string | null;
  town: string | null;
  /** تاريخ ورقم قرار المجلس البلدي, if the council has issued one (§7 Q1). */
  councilDecisionRef: string | null;
  /**
   * Absent — not null — for a citizen.
   *
   * The crest is a data URI in the hundreds of kilobytes, and this endpoint is
   * read by everyone opening the pay dialog, so the server sends it to staff
   * only. The key being missing rather than null is deliberate: a client can
   * tell "not sent to you" from "no logo configured".
   */
  logoDataUri?: string | null;

  // ── Finance defaults ──────────────────────────────────────────────────
  defaultFeeFrequency: FeeFrequency;
  defaultDueDays: number;
  priceDisplay: 'compact' | 'exact';
  /** Percent. Display only — anything charging money must read the server's
   *  Decimal rather than this JSON number. */
  defaultRatePercent: number;
  baseCurrency: CurrencyCode;
  secondaryCurrency: CurrencyCode | null;
  exchangeRate: number | null;
  /** Stamped server-side, and only when the rate actually changes. */
  exchangeRateUpdatedAt: string | null;

  numberingSequences: Record<SequenceKey, NumberingSequence> | null;
  backupSchedule: BackupSchedule | null;

  updatedAt: string | null;
}

/** How long a settings read is reused. It changes a few times a year. */
const SETTINGS_TTL_MS = 60_000;

/**
 * Readable by any signed-in user — the portal prints these on the pay modal.
 *
 * De-duplicated and briefly cached, because six unrelated screens read it: the
 * fees ledger, the payments log, every citizen profile, the citizen pay dialog
 * and each settings tab as it opens. Concurrent callers share one request.
 *
 * `includeLogo` is opt-in and off by default. The crest is a data URI in the
 * hundreds of kilobytes, and every one of those screens except the settings
 * form wants a phone number and some opening hours — they were all downloading
 * it and using none of it.
 */
export function getMunicipalitySettings(
  tenant: string,
  token: string,
  options: { includeLogo?: boolean } = {},
) {
  const includeLogo = options.includeLogo === true;
  // The token is deliberately not part of the key — see `cachedRequest`.
  return cachedRequest(
    `settings:${tenant}:${includeLogo ? 'full' : 'lite'}`,
    SETTINGS_TTL_MS,
    () =>
      apiFetch<MunicipalitySettings>(
        tenant,
        `/fees/settings${includeLogo ? '?includeLogo=true' : ''}`,
        { token },
      ),
  );
}

/**
 * SUPER_ADMIN only, server-enforced.
 *
 * Every field is optional and only what is sent is written — which is what
 * lets one section of the settings screen save without clearing the fields
 * owned by the five it did not render. An empty string clears a text field; a
 * missing key leaves it alone. The two are not the same and the server does
 * not treat them as such.
 */
export async function updateMunicipalitySettings(
  tenant: string,
  token: string,
  input: Partial<{
    contactPhone: string;
    whatsappNumber: string;
    whishMoneyNumber: string;
    cashOfficeHours: string;
    cashOfficeAddress: string;

    nameAr: string;
    nameEn: string;
    contactEmail: string;
    website: string;
    governorate: string;
    district: string;
    town: string;
    councilDecisionRef: string;
    logoDataUri: string;

    defaultFeeFrequency: FeeFrequency;
    defaultDueDays: number;
    priceDisplay: 'compact' | 'exact';
    defaultRatePercent: number;
    baseCurrency: CurrencyCode;
    /** `null` clears it. Omitting leaves whatever is stored. */
    secondaryCurrency: CurrencyCode | null;
    exchangeRate: number | null;

    numberingSequences: Record<SequenceKey, NumberingSequence>;
    backupSchedule: BackupSchedule;
  }>,
) {
  const result = await apiFetch<MunicipalitySettings>(tenant, '/fees/settings', {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  // Both variants, before the caller sees the response. A clerk who saves and
  // is then shown the value they replaced — because another tab reads the
  // cached copy a moment later — reasonably concludes the save failed.
  invalidateRequests(`settings:${tenant}:`);
  return result;
}

export interface FeeNoticeSummary {
  id: string;
  title: string;
  /** Under FLAT the whole invoice; under the other two a rate. Read with `basis`. */
  amount: number;
  /** What `amount` is per. Absent on notices written before per-unit billing. */
  basis: FeeBasis;
  /** Who owes it — see `FEE_BEARER`. Meaningless under FLAT. */
  bearer: FeeBearer;
  currency: string;
  frequency: string;
  targetType: string;
  targetCategory: string | null;
  targetCitizenName: string | null;
  dueDate: string;
  instructions: string | null;
  /** How many citizens this notice actually billed. */
  issuedCount: number;
  /** False stops the recurring biller re-issuing it each period. */
  isActive: boolean;
  createdAt: string;
}

export function getFeeNotices(tenant: string, token: string) {
  return apiFetch<{ items: FeeNoticeSummary[] }>(tenant, '/fees/notices', { token });
}

/**
 * Everyone registered on one رقم العقار, and what each of them holds there.
 *
 * The parcel view of a citizen-keyed register — computed, never stored. Every
 * fee is raised against a citizen, so ownership lives on the citizen and this
 * is a projection over it; there is no second copy to drift.
 */
export interface ParcelRoster {
  propertyNumber: string;
  neighborhood: string | null;
  citizenCount: number;
  structureCount: number;
  citizens: Array<{
    citizenId: string;
    fullName: string;
    phone: string | null;
    referenceNumber: string | null;
    isActive: boolean;
    structures: Array<{
      propertyEntryId: string;
      propertyType: string;
      occupancyType: string;
      buildingName: string | null;
      units: Array<{
        id: string | null;
        unitType: string | null;
        floor: string | null;
        unitArea: number | null;
        /** حالة الوحدة. Null means nobody was asked — not that it is occupied. */
        unitStatus: string | null;
      }>;
    }>;
  }>;
}

export function getParcelRoster(tenant: string, token: string, propertyNumber: string) {
  return apiFetch<ParcelRoster>(
    tenant,
    `/citizens/parcel/${encodeURIComponent(propertyNumber)}`,
    { token },
  );
}

/** Writes the rule and bills every matching citizen in one transaction. */
export async function issueFeeNotice(
  tenant: string,
  token: string,
  input: {
    title: string;
    amount: number;
    /** What `amount` is per — see `FEE_BASIS`. */
    basis: FeeBasis;
    /** Who owes it. Omitted means OCCUPANT — see `FEE_BEARER`. */
    bearer?: FeeBearer;
    frequency: string;
    targetType: string;
    targetCategory?: string;
    targetCitizenId?: string;
    dueDate: string;
    instructions?: string;
  },
) {
  const result = await apiFetch<{
    noticeId: string;
    issued: number;
    /**
     * Targeted citizens whose holdings could not be measured — a building
     * whose units were never surveyed, or a unit with no recorded area. They
     * are not billed and not silently dropped: the caller names them so the
     * municipality can chase the survey.
     */
    unassessable?: Array<{ citizenId: string; name: string; reason: string }>;
    /**
     * Units this notice declined to charge anyone for — let to a tenant who is
     * billed for them directly, empty, still being built, or not owned by the
     * person assessed.
     *
     * Reported for the same reason `unassessable` is: revenue absent by design
     * is still revenue absent, and a clerk who can see how much of the town a
     * bearer rule left out has something to take to the council.
     */
    exemptedUnits?: number;
    /**
     * Flats whose occupancy fee this notice held because their records
     * disagree — see `FeeAssessment.heldUnitCount`. Not charged for this
     * notice's period; once the «تعارض في حالة الوحدة» is settled they are
     * charged from the next period a recurring notice runs. Recovering the held
     * period itself is a manual charge.
     */
    heldUnits?: number;
  }>(tenant, '/fees/notices', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

export interface FeeSummary {
  unpaidTotal: number;
  unpaidCount: number;
  pendingReviewCount: number;
  paidTotal: number;
  paidCount: number;
}

export function getFeeSummary(tenant: string, token: string) {
  return cachedRequest(`fee-summary:${tenant}`, 30 * 1000, () =>
    apiFetch<FeeSummary>(tenant, '/fees/summary', { token }),
  );
}

export interface PendingPayment {
  id: string;
  title: string;
  amount: number;
  currency: string;
  dueDate: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  isSeen?: boolean;
  citizenId: string;
  citizenName: string;
  citizenPhone: string | null;
  citizenReference: string | null;
}

/** The clerk's queue: money claimed but not yet confirmed. */
export function getPendingPayments(tenant: string, token: string, unseenOnly?: boolean) {
  const query = unseenOnly ? '?unseenOnly=true' : '';
  return apiFetch<{ items: PendingPayment[] }>(tenant, `/fees/payments/pending${query}`, { token });
}

/** Mark a pending payment notification as seen. */
export function markPaymentAsSeen(tenant: string, token: string, id: string) {
  return apiFetch<{ id: string; isSeen: boolean }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/seen`,
    { token, method: 'PATCH' },
  );
}

/** Mark all pending payment notifications as seen. */
export function markAllPendingPaymentsAsSeen(tenant: string, token: string) {
  return apiFetch<{ updatedCount: number }>(
    tenant,
    '/fees/payments/pending/mark-all-seen',
    { token, method: 'POST' },
  );
}

export async function reviewPayment(
  tenant: string,
  token: string,
  id: string,
  input: { confirmed: boolean; note?: string },
) {
  const result = await apiFetch<{ paymentStatus: string }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/review`,
    { token, method: 'PATCH', body: JSON.stringify(input) },
  );
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/** What a bill would be if it were raised today. */
export type BillFigure =
  | { kind: 'ASSESSED'; amount: number; assessment: FeeAssessment | null }
  | { kind: 'UNASSESSABLE'; reason: string }
  /** A flat charge to a category the citizen no longer holds any of. */
  | { kind: 'NOT_TARGETED' };

/** One open bill a correction affected — «فواتير تأثّرت بتصحيحات». */
export interface CorrectionAffectedBill {
  paymentId: string;
  citizenId: string;
  citizenName: string;
  title: string;
  periodKey: string;
  dueDate: string;
  status: string;
  raisedAt: string;
  amount: number;
  paidAmount: number;
  currency: string;
  billed: FeeAssessment | null;
  now: BillFigure;
  /** Today's figure minus the bill's; null when today's cannot be worked out. */
  difference: number | null;
  lines: { removed: FeeAssessmentLine[]; added: FeeAssessmentLine[] } | null;
  changes: Array<{
    /** CORRECTION: said to be one. DATED_CHANGE: a real change and its day. EDIT: anything else. */
    kind: 'CORRECTION' | 'DATED_CHANGE' | 'EDIT';
    effectiveOn: string | null;
    entry: AuditEntry;
  }>;
  review: { at: string; by: string | null; note: string; current: boolean } | null;
}

export interface CorrectionAffectedList {
  items: CorrectionAffectedBill[];
  total: number;
  totals: { billedTooMuch: number; billedTooLittle: number; unassessable: number; reviewed: number };
}

export function getCorrectionAffectedBills(
  tenant: string,
  token: string,
  query: { includeReviewed?: boolean; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 20),
    offset: String(query.offset ?? 0),
    ...(query.includeReviewed ? { includeReviewed: 'true' } : {}),
  });
  return apiFetch<CorrectionAffectedList>(tenant, `/fees/correction-affected?${params.toString()}`, {
    token,
    signal,
  });
}

/** The key a review records having seen — must match the server's `figureKey`. */
export function billFigureKey(figure: BillFigure): string {
  return figure.kind === 'ASSESSED' ? `ASSESSED:${figure.amount}` : figure.kind;
}

/** Records what the accountant decided. The bill itself is never changed. */
export function reviewBillBasis(
  tenant: string,
  token: string,
  paymentId: string,
  input: { note: string; figure: string },
) {
  return apiFetch<{ reviewedAt: string }>(
    tenant,
    `/fees/payments/${encodeURIComponent(paymentId)}/basis-review`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

export interface CitizenPaymentItem {
  id: string;
  title: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived server-side from the due date, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at — «6 محل تجاري × 100,000 ل.ل».
   *
   * The server has sent it on this route since per-unit billing existed
   * (`FeesService.listForCitizen`); the portal simply never read it, so the
   * person actually holding the bill was the one party shown the total with no
   * way to check it. Null on a flat charge, which explains itself.
   */
  assessment?: FeeAssessment | null;
}

/** The signed-in citizen's own bills. */
export function getMyPayments(tenant: string, token: string) {
  return apiFetch<{ items: CitizenPaymentItem[] }>(tenant, '/fees/payments/mine', { token });
}

/**
 * Opens a Whish checkout for one of the signed-in citizen's own bills.
 *
 * `redirectUrl` is where the browser goes next — the provider's hosted page
 * once credentials are configured, and back to the portal until then.
 * `pending` says which of those happened, so the UI can tell the citizen the
 * truth rather than claiming a payment that has not been taken.
 */
export function startWhishCheckout(tenant: string, token: string, paymentId: string) {
  return apiFetch<{ redirectUrl: string; pending: boolean }>(
    tenant,
    `/fees/payments/mine/${encodeURIComponent(paymentId)}/whish/checkout`,
    { token, method: 'POST' },
  );
}

/** Declares a payment — moves it to PENDING_REVIEW, never straight to PAID. */
export function declarePayment(
  tenant: string,
  token: string,
  id: string,
  input: { method: string; whishTransactionRef?: string },
) {
  return apiFetch<{ paymentStatus: string }>(
    tenant,
    `/fees/payments/mine/${encodeURIComponent(id)}/declare`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

/**
 * Citizen sign-in by رقم مرجعي + phone. Both are required — see the note on
 * `IdentityService.loginByReference`.
 */
export function loginByReference(
  tenant: string,
  input: { referenceNumber: string; phone: string },
) {
  return apiFetch<Session>(tenant, '/auth/citizen/reference/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Citizen sign-in by رقم مرجعي alone — the landing page's single field.
 *
 * A separate function against a separate route, not `loginByReference` with an
 * omitted phone: the payments portal still requires both, and the two bars are
 * meant to stay visibly different at every layer. See `referenceOnlyLoginSchema`
 * for what the municipality is accepting by using this one.
 */
export function openByReference(tenant: string, referenceNumber: string) {
  return apiFetch<Session>(tenant, '/auth/citizen/reference/open', {
    method: 'POST',
    body: JSON.stringify({ referenceNumber }),
  });
}

/** One invoice as the admin ledger shows it — who owes it, and where it stands. */
export interface AdminPaymentItem {
  id: string;
  title: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  currency: string;
  dueDate: string;
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  /**
   * Last write to the row. Stands in for the payment time on a *partial*
   * settlement, which never gets a `paidAt` — see the note on the server.
   */
  updatedAt: string;
  /** The محصّل holding the money — set only on a COLLECTOR payment. */
  collectedByName: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟» — null on a flat charge, which explains
   * itself, and on every invoice raised before per-unit billing existed.
   */
  assessment?: FeeAssessment | null;
  citizenId: string;
  citizenName: string;
  citizenPhone: string | null;
  citizenReference: string | null;
}

/**
 * Every invoice, filterable by status, method and by who owes it.
 *
 * `transactionsOnly` narrows it to rows where money moved (or is claimed to
 * have) and re-orders newest-first — the سجل العمليات view, as against the
 * fees ledger's "what is owed".
 */
export function getFeeTitles(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<string[]>(tenant, '/fees/titles', { token, signal });
}

/**
 * What the two money screens' filters may offer, as found in the ledger.
 *
 * The same kind of read as `getBuildingFilterOptions`: a vocabulary, not a
 * page. A municipality that has never taken a Whish transfer has no «Whish»
 * tab, because there is no answer behind it.
 */
export interface FeeFilterOptions {
  /**
   * Which status tabs the register can actually answer.
   *
   * Not simply "the stored values present". OVERDUE is never stored — nothing
   * writes it, it is derived from `dueDate` on read — and UNPAID is split
   * against the same boundary, so these two are counted rather than grouped.
   * See `paymentStatusWhere` on the server for the predicate behind each.
   *
   * Consequently this half of the read is time-dependent and must not be held
   * for the session the way `titles` and `methods` may be.
   */
  statuses: PaymentStatus[];
  /** Stored `paymentMethod` values present. Never null: an unpaid row has none. */
  methods: PaymentMethod[];
  /** Distinct bill titles, for the searchable «نوع الرسم» filter. */
  titles: string[];
}

export function getFeeFilterOptions(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<FeeFilterOptions>(tenant, '/fees/filter-options', { token, signal });
}

export function getAllPayments(
  tenant: string,
  token: string,
  filter: {
    status?: string;
    search?: string;
    feeTitle?: string;
    citizenId?: string;
    method?: string;
    transactionsOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  /** See `listCitizens`. */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.search) query.set('search', filter.search);
  if (filter.feeTitle) query.set('feeTitle', filter.feeTitle);
  if (filter.citizenId) query.set('citizenId', filter.citizenId);
  if (filter.method) query.set('method', filter.method);
  if (filter.transactionsOnly) query.set('transactionsOnly', 'true');
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  if (filter.offset !== undefined) query.set('offset', String(filter.offset));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<{
    items: AdminPaymentItem[];
    total: number;
    /** Computed over every matching row, not the returned page. */
    totals: {
      collected: number;
      cash: number;
      whish: number;
      collector: number;
      awaiting: number;
    };
  }>(tenant, `/fees/payments${suffix}`, { token, signal });
}

/**
 * One invoice, loaded directly by id.
 *
 * What تسجيل دفعة reads when it is its own page rather than a dialog opened
 * from an already-loaded row: a refresh, a bookmark, or a link from a receipt
 * arrives with nothing but this id.
 */
export function getPaymentById(tenant: string, token: string, id: string) {
  return apiFetch<AdminPaymentItem>(tenant, `/fees/payments/${encodeURIComponent(id)}`, {
    token,
  });
}

/** A one-off charge against a single citizen — no notice, no recurrence. */
export async function chargeCitizen(
  tenant: string,
  token: string,
  input: { citizenId: string; title: string; amount: number; dueDate: string },
) {
  const result = await apiFetch<{ id: string }>(tenant, '/fees/payments', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * Records money handed over in person. Goes straight to PAID — the clerk
 * confirming it is the clerk who took it.
 */
export async function settlePayment(
  tenant: string,
  token: string,
  id: string,
  /**
   * The shared schema's shape — method, amount or tender, the day, the reason
   * for any departure from the official rate or today's date, and the retry
   * key. Not re-declared here, so the page cannot drift from what the server
   * validates.
   */
  input: Partial<SettlePayment> = {},
) {
  const result = await apiFetch<{
    paymentStatus: string;
    received: number;
    paidAmount: number;
    remaining: number;
    /** The ledger's RCP-… number — what the receipt prints and a reprint looks up. */
    receiptNumber: string;
    /** When the money moved: today's time, or midday of a back-dated day. */
    occurredAt: string;
    /** Handed back from a larger note, in the bill's currency. */
    changeGiven: number;
    /** The rate the foreign notes were taken at, and the municipality's own. */
    exchangeRate: number | null;
    officialExchangeRate: number | null;
  }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/settle`,
    // The `CASH` default is kept ahead of the spread so an omitted method
    // still means cash, as it did before the counter could bank a transfer.
    { token, method: 'PATCH', body: JSON.stringify({ method: 'CASH', ...input }) },
  );
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * Runs the recurring biller now instead of waiting for the nightly cron.
 * Idempotent within a period — pressing it twice yields 0 new invoices.
 */
export function runRecurringBilling(tenant: string, token: string) {
  return apiFetch<{ tenants: number; invoicesCreated: number }>(
    tenant,
    '/fees/recurring/run',
    { token, method: 'POST' },
  );
}

/** Stops or resumes the recurring biller for one notice. */
export function setNoticeActive(
  tenant: string,
  token: string,
  id: string,
  isActive: boolean,
) {
  return apiFetch<{ isActive: boolean }>(
    tenant,
    `/fees/notices/${encodeURIComponent(id)}/active`,
    { token, method: 'PATCH', body: JSON.stringify({ isActive }) },
  );
}

// ─────────────────────────  Backup and restore  ─────────────────────────

export interface SnapshotManifest {
  version: number;
  tenantSlug: string;
  createdAt: string;
  migrations: string[];
  counts: Record<string, number>;
}

export interface RestoreReport {
  dryRun: boolean;
  manifest: SnapshotManifest;
  deleted: Record<string, number>;
  written: Record<string, number>;
}

/**
 * Downloads the restorable snapshot — real table rows, gzipped JSON.
 *
 * Not `apiFetch`, which parses every response as JSON: this one is a binary
 * file the municipality keeps on disk. SUPER_ADMIN only, server-enforced.
 */
export async function exportSnapshot(tenant: string, token: string): Promise<Blob> {
  const response = await fetch(`${API_URL}/t/${encodeURIComponent(tenant)}/backup/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({
      code: 'UNKNOWN',
      message: 'تعذّر إنشاء النسخة الاحتياطية.',
    }))) as ApiError;
    throw new ApiRequestError(response.status, payload);
  }
  return response.blob();
}

/**
 * Puts a snapshot back.
 *
 * `dryRun` defaults to true here as well as on the server. Two defaults for one
 * decision is deliberate: this is the call that replaces a municipality's
 * register, and a caller that forgets the flag should rehearse, not destroy.
 */
export async function restoreSnapshot(
  tenant: string,
  token: string,
  snapshot: Blob,
  options: { confirmTenantSlug: string; dryRun?: boolean },
): Promise<RestoreReport> {
  const query = new URLSearchParams({
    confirm: options.confirmTenantSlug,
    dryRun: String(options.dryRun !== false),
  });
  const response = await fetch(
    `${API_URL}/t/${encodeURIComponent(tenant)}/backup/restore?${query}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // Anything but application/json, so no body parser consumes the stream
        // before the controller reads it.
        'Content-Type': 'application/gzip',
      },
      body: snapshot,
    },
  );

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      (payload as ApiError) ?? { code: 'UNKNOWN', message: 'تعذّرت الاستعادة.' },
    );
  }
  return payload as RestoreReport;
}

export async function changeStaffPassword(
  tenant: string,
  token: string,
  input: { currentPassword: string; newPassword: string },
): Promise<{ changed: boolean }> {
  return apiFetch<{ changed: boolean }>(tenant, '/auth/staff/change-password', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function changeStaffEmail(
  tenant: string,
  token: string,
  input: { newEmail: string; currentPassword: string },
): Promise<{ email: string }> {
  return apiFetch<{ email: string }>(tenant, '/auth/staff/change-email', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function sendStaffPasswordResetEmail(
  tenant: string,
  token: string,
  redirectTo?: string,
): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(tenant, '/auth/staff/send-reset-password-email', {
    method: 'POST',
    token,
    body: JSON.stringify({ redirectTo }),
  });
}

/**
 * Public — reached from the reset-password landing page before any session
 * exists. `accessToken` is the Supabase recovery token the email link's own
 * redirect appends to that page's URL, not this app's session token.
 */
export async function confirmStaffPasswordReset(
  tenant: string,
  accessToken: string,
  newPassword: string,
): Promise<{ confirmed: boolean }> {
  return apiFetch<{ confirmed: boolean }>(tenant, '/auth/staff/confirm-password-reset', {
    method: 'POST',
    body: JSON.stringify({ accessToken, newPassword }),
  });
}

export async function beginStaffTotpEnrolment(
  tenant: string,
  token: string,
): Promise<{ secret: string; keyUri: string }> {
  return apiFetch<{ secret: string; keyUri: string }>(tenant, '/auth/staff/totp/enrol', {
    method: 'POST',
    token,
  });
}

export async function confirmStaffTotpEnrolment(
  tenant: string,
  token: string,
  input: { token: string },
): Promise<{ confirmed: boolean }> {
  return apiFetch<{ confirmed: boolean }>(tenant, '/auth/staff/totp/confirm', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function disableStaffTotp(
  tenant: string,
  token: string,
  input: { currentPassword?: string },
): Promise<{ disabled: boolean }> {
  return apiFetch<{ disabled: boolean }>(tenant, '/auth/staff/totp/disable', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}


// ── «حذف تصحيحي» (SUPER_ADMIN) ──────────────────────────────────────────────

import type {
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

export type {
  UnitCorrectionBlocker,
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

/** What deleting this unit would remove, close and change. Its `fingerprint` is what the delete must quote. */
export function getUnitCorrectionPreview(tenant: string, token: string, unitId: string, signal?: AbortSignal) {
  return apiFetch<UnitCorrectionPreview>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, signal },
  );
}

/**
 * Deletes the unit exactly as previewed, or changes nothing. Refused with
 * `details.reason` — see `unitCorrectionRefusal` — when the preview is stale,
 * a blocker appeared, or somebody else is writing the same records.
 */
export async function applyUnitCorrection(
  tenant: string,
  token: string,
  unitId: string,
  input: UnitCorrectionDeleteInput,
) {
  const result = await apiFetch<UnitCorrectionResult>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Why a correction delete was refused, when the server said in a way the dialog can act on. */
export function unitCorrectionRefusal(
  caught: unknown,
): 'PREVIEW_STALE' | 'BLOCKED' | 'BUSY' | 'UNVERIFIED' | 'CONFIRM_CODE' | null {
  if (!(caught instanceof ApiRequestError)) return null;
  const details = caught.payload.details as { reason?: unknown; confirmCode?: unknown } | undefined;
  if (caught.kind === 'VALIDATION_FAILED' && details && 'confirmCode' in details) return 'CONFIRM_CODE';
  const reason = details?.reason;
  return reason === 'PREVIEW_STALE' || reason === 'BLOCKED' || reason === 'BUSY' || reason === 'UNVERIFIED'
    ? reason
    : null;
}
