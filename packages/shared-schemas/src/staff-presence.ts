/**
 * «متصل الآن» / «آخر ظهور» — staff presence, one rule for the server that
 * stamps it and the screen that labels it.
 *
 * The threshold used to live twice, a backend constant and a frontend one kept
 * in step by a comment; the backend's copy had no caller. One copy now.
 */

/**
 * How often, at most, the server writes «آخر ظهور» for one account.
 *
 * The throttle, and the only thing standing between presence and a write to
 * `users` on every authenticated request: an officer clicking through the
 * register costs one UPDATE a minute, not one per click. It must stay well
 * inside `STAFF_ONLINE_WITHIN_SECONDS`, or the staleness shows as «غير متصل»
 * for somebody who is in fact there.
 */
export const STAFF_PRESENCE_STAMP_EVERY_SECONDS = 60;

/**
 * How recently an account must have been seen to read «متصل الآن».
 *
 * Five minutes, against a stamp written at most once a minute: the slack is for
 * that throttle and a slow request. Short enough that «متصل» means "at the
 * system now", long enough that reading one long page between two citizens at
 * the counter does not flicker somebody offline while they are sitting there.
 *
 * Deliberately not the token lifetime: a fifteen-minute access token says how
 * long a session may go unrefreshed, nothing about whether anyone is holding
 * the keyboard.
 */
export const STAFF_ONLINE_WITHIN_SECONDS = 5 * 60;

/**
 * Whether an account last seen at `lastSeenAt` counts as here at `now`.
 *
 * `now` MUST be the server's clock — the instant the presence read was
 * answered — never the browser's: an office PC whose clock runs ten minutes
 * fast would otherwise show nobody online, and one running slow would keep
 * people «متصل» long after they left. Null (never seen) is offline.
 */
export function isStaffOnline(
  lastSeenAt: string | Date | null | undefined,
  now: string | Date | number,
): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  const at = typeof now === 'number' ? now : new Date(now).getTime();
  if (Number.isNaN(seen) || Number.isNaN(at)) return false;
  return at - seen <= STAFF_ONLINE_WITHIN_SECONDS * 1000;
}

/** One account's presence, as `GET staff/presence` answers it. */
export interface StaffPresenceItem {
  id: string;
  /** When this account last made a request (not a background poll); null if never since 0070. */
  lastSeenAt: string | null;
}

/** The presence read, stamped with the server's own clock so the screen can compare against it. */
export interface StaffPresenceResponse {
  /** The server's clock when this was answered, ISO 8601. */
  now: string;
  items: StaffPresenceItem[];
}

/**
 * The header a screen sends on a request it makes by itself — a poll, an
 * interval refresh — rather than because somebody did something. The API does
 * not stamp presence for it: a tab left open on a lit screen with nobody there
 * would otherwise read «متصل الآن» all day.
 */
export const BACKGROUND_REQUEST_HEADER = 'x-background-request';
