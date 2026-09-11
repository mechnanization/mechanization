'use client';

import type { CitizenFormValues } from '@/components/admin/citizen-form';

/**
 * Keeps the «تسجيل مواطن جديد» form alive across a navigation.
 *
 * ## What was broken
 *
 * The form held everything in React state and nothing else. A clerk half way
 * through a household who opened «المواطنون» to check whether the father was
 * already registered — or «سجل المباني» to find the building code the form is
 * asking them for — came back to a blank form. The two lookups the form most
 * often sends people to do are the two that destroyed the answer, so the
 * sensible way to use the screen was also the way to lose ten minutes of
 * typing. Staff learned to open a second tab, which is a workaround for a bug,
 * not a feature.
 *
 * Now the form writes here on every keystroke and reads back on mount, so
 * leaving the page is no longer a decision about the work in progress. Only
 * «حفظ» and «إلغاء» clear it — the two acts where the officer has actually
 * said what should happen to the draft.
 *
 * ## Why localStorage and not IndexedDB
 *
 * `offline-db` already runs an IndexedDB queue, and it would be a reasonable
 * place for this. It is the wrong one. That store holds *finished* records —
 * thirty completed registrations taken with no signal, each of which is a
 * household's afternoon and must survive eviction, so it is transactional and
 * indexed and costs an upgrade dance on every schema change. This is one
 * in-progress form per device, it is worth a few kilobytes, and losing it to a
 * cleared browser is an inconvenience rather than a loss. localStorage is
 * synchronous, which is what lets the form seed its first render from the
 * draft rather than flashing blank and filling in a tick later.
 *
 * The distinction matters because conflating the two is how a draft ends up
 * queued for delivery: a half-typed household is not a submission, and nothing
 * in here is ever sent anywhere.
 *
 * ## What is deliberately not stored
 *
 * Edits to a citizen who already exists on the server. A draft of a
 * *correction* is a read-modify-write against a row a colleague may have
 * changed since — restoring it a day later would silently re-apply stale
 * values over their work. Registering someone new has no such conflict,
 * because there is nothing yet to overwrite. This is the same line
 * `CitizenEditor` already draws for offline queueing, and it is drawn here for
 * the same reason.
 */

/**
 * Versioned, and the version is part of the key rather than a field inside it.
 *
 * A stored draft is a snapshot of `CitizenFormValues`, whose shape is the
 * form's own business and changes with it. Bumping this abandons every draft
 * in the field rather than restoring someone into a form that has since grown
 * a required field or renamed a section — cheap, because a draft is hours old,
 * not months.
 */
const KEY_PREFIX = 'mechanization.citizen-draft.v1.';

/**
 * Drafts older than this are abandoned.
 *
 * Two days rather than the two weeks a filed report gets: this is a form
 * somebody walked away from, and if they have not come back by the day after
 * next, silently restoring a household they have most likely already entered
 * by hand is worse than showing them a clean form.
 */
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

const key = (tenant: string) => `${KEY_PREFIX}${tenant}`;

/**
 * The wire shape.
 *
 * `flags` and `unverified` are `Map`s in the form and arrays here, because
 * `JSON.stringify` turns a Map into `{}` without complaining — a draft that
 * round-tripped through the obvious implementation would come back having
 * quietly dropped every «غير مؤكَّد» the officer had set, which is exactly the
 * kind of loss that is noticed only after the record is filed.
 */
interface StoredDraft {
  savedAt: number;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: CitizenFormValues['properties'];
  flags: [string, string][];
  unverified: [string, string][];
  blanketFlagReason?: string;
  /** «ملاحظات» — kept in the autosaved draft like every other typed value. */
  notes?: string;
}

/**
 * Whether this form has anything worth keeping.
 *
 * Guards the *write*, so an officer who merely opens the form and navigates
 * away leaves nothing behind — and therefore is not greeted by «استُعيدت
 * مسودة» the next time they open it, over a form identical to the blank one.
 * A restore notice that fires on an empty form teaches people to ignore
 * restore notices.
 *
 * `isLebanese` and `whatsappSameAsPhone` are excluded because `emptyCitizen()`
 * sets them: they are the form's defaults, not the officer's answers.
 */
export function draftWorthKeeping(values: CitizenFormValues): boolean {
  const typed = (section: Record<string, unknown>, defaulted: string[]) =>
    Object.entries(section).some(
      ([field, entry]) =>
        !defaulted.includes(field) && entry !== '' && entry !== null && entry !== undefined,
    );

  return (
    typed(values.personal, ['isLebanese']) ||
    typed(values.contact, ['whatsappSameAsPhone']) ||
    values.properties.length > 0 ||
    values.flags.size > 0 ||
    Boolean(values.blanketFlagReason) ||
    // A note alone is worth keeping. It is frequently the *first* thing typed
    // at a door and, being optional, the one an officer would least expect the
    // form to have thrown away.
    Boolean(values.notes?.trim())
  );
}

export function saveCitizenDraft(tenant: string, values: CitizenFormValues): void {
  try {
    const payload: StoredDraft = {
      savedAt: Date.now(),
      personal: values.personal,
      contact: values.contact,
      properties: values.properties,
      flags: [...values.flags],
      unverified: [...values.unverified],
      blanketFlagReason: values.blanketFlagReason,
      notes: values.notes,
    };
    localStorage.setItem(key(tenant), JSON.stringify(payload));
  } catch {
    /*
      Quota exceeded, or storage disabled by policy. Losing autosave is not
      worth interrupting somebody mid-form over — the form still works exactly
      as it did before this file existed, it just forgets again on navigation.
    */
  }
}

/** The draft for this municipality, or `null` when there is nothing usable. */
export function loadCitizenDraft(
  tenant: string,
): { values: CitizenFormValues; savedAt: Date } | null {
  try {
    const raw = localStorage.getItem(key(tenant));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredDraft;
    if (typeof parsed?.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearCitizenDraft(tenant);
      return null;
    }

    return {
      values: {
        personal: parsed.personal ?? {},
        contact: parsed.contact ?? {},
        properties: parsed.properties ?? [],
        flags: new Map(parsed.flags ?? []),
        unverified: new Map(parsed.unverified ?? []),
        blanketFlagReason: parsed.blanketFlagReason,
        notes: parsed.notes,
      },
      savedAt: new Date(parsed.savedAt),
    };
  } catch {
    // Written by an older build, or truncated by a browser that ran out of
    // room mid-write. Drop it rather than crashing the page it was meant to
    // help.
    clearCitizenDraft(tenant);
    return null;
  }
}

/** Called on «حفظ» and on «إلغاء» — the two answers that settle the draft. */
export function clearCitizenDraft(tenant: string): void {
  try {
    localStorage.removeItem(key(tenant));
  } catch {
    /* nothing to clean up */
  }
}
