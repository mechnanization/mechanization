import { BACKGROUND_REQUEST_HEADER, type ErrorParams, type OccupancyRole, type BuildingLifecycle, type StructureType, type SurveyStatus, type UnitStatus, type UnitType } from '@mechanization/shared-schemas';
import { localizeApiError } from '../api-errors';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

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
  details?: { path: string; message: string; code?: string }[] | Record<string, unknown>;
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

/**
 * «هذا المنزل يصبح مبنى» — what the server asks before a house on somebody's
 * file gets a second unit (decision D28, `HOUSE_GROWTH_UNANSWERED`).
 */
export interface HouseGrowthQuestion {
  unitId: string;
  unitCode: string;
  unitType: UnitType;
  levels: number;
  /** The floor «طابق إضافي من المسكن نفسه» would add — directly above the home. */
  nextLevelFloor: number;
  /** Whose file the answer changes; empty on a bare «منزل مستقل». */
  holders: Array<{ name: string; capacity: OccupancyRole }>;
}

/** The question carried by a `HOUSE_GROWTH_UNANSWERED` refusal, or null for any other error. */
export function houseGrowthQuestionOf(caught: unknown): HouseGrowthQuestion | null {
  if (!(caught instanceof ApiRequestError) || caught.payload.code !== 'HOUSE_GROWTH_UNANSWERED') return null;
  const details = caught.payload.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const question = details as Partial<HouseGrowthQuestion>;
  if (typeof question.unitCode !== 'string' || typeof question.nextLevelFloor !== 'number') return null;
  return {
    unitId: question.unitId ?? '',
    unitCode: question.unitCode,
    unitType: question.unitType as UnitType,
    levels: question.levels ?? 1,
    nextLevelFloor: question.nextLevelFloor,
    holders: Array.isArray(question.holders) ? question.holders : [],
  };
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
export function timeoutSignal(ms: number): AbortSignal {
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
export async function withRefreshLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
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
let sessionModule: Promise<typeof import('../session')> | undefined;
const importSession = () => (sessionModule ??= import('../session'));

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
export async function exchangeStaffToken(
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

/**
 * 401s that answer the request, not the session: the current password typed to
 * confirm a change to one's own account («أمان الحساب») is wrong, or the code
 * typed to confirm an authenticator is (`TOTP_CODE_INVALID`). Exchanged and
 * replayed like an expiry, each wrong guess rotated the refresh cookie and had
 * the server check it twice. A 401 with any other code on those routes is
 * still an expired session and renewed as one.
 */
export const ANSWERED_401 = new Set<string>(['STAFF_CURRENT_PASSWORD_INCORRECT', 'TOTP_CODE_INVALID']);

type ApiFetchInit = RequestInit & {
  token?: string;
  skipTokenRefresh?: boolean;
  /**
   * A request the screen makes by itself — a poll, an interval refresh — not
   * because somebody did something. Sent with `BACKGROUND_REQUEST_HEADER`, so
   * the API does not count it as the account being at the system («متصل الآن»).
   */
  background?: boolean;
};

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
  const { token, headers, skipTokenRefresh, background, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/t/${tenant}${path}`, {
      ...rest,
      headers: {
        // FormData must set its own multipart boundary — forcing a content type
        // here silently breaks every file upload.
        ...(rest.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(background ? { [BACKGROUND_REQUEST_HEADER]: '1' } : {}),
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
  /** The 401's body, read once to tell an expiry from an answer (`ANSWERED_401`), and reused below. */
  let refusal: ApiError | undefined;
  if (
    response.status === 401 &&
    token &&
    !skipTokenRefresh &&
    exchangesLeft > 0 &&
    !SESSION_ROUTES.some((route) => path.startsWith(route))
  ) {
    refusal = (await response.json().catch(() => undefined)) as ApiError | undefined;
    if (!(refusal?.code && ANSWERED_401.has(refusal.code))) {
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
  }

  if (!response.ok) {
    const payload =
      refusal ??
      ((await response.json().catch(() => ({
        code: 'UNKNOWN',
        message: 'تعذّر إتمام الطلب. حاول مرة أخرى.',
      }))) as ApiError);
    throw new ApiRequestError(response.status, payload);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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

