'use client';

import type { BuildingLifecycle, StructureType } from '@mechanization/shared-schemas';
// Type-only, so this erases at compile time and adds no runtime edge from
// `lib` back into `components`.
import type { GridUnitDraft } from '@/components/admin/unit-grid-picker';

/**
 * Keeps «سجل المباني»'s wizard alive across a locale switch.
 *
 * ## What was broken
 *
 * The locale is a *route segment* — `/[tenant]/[locale]/[adminPath]/…` — so
 * `LanguageSwitcher` changing `ar` to `en` is a navigation to a different
 * route, not a re-render of the current one. Next unmounts the page and mounts
 * a new tree, every `useState` in `BuildingEditor` initialises from scratch,
 * and an officer four fields into a building with a pin dropped and a matrix
 * painted lands on an empty step 1.
 *
 * The switch is already a client-side `router.push`; there is no full page
 * reload to remove. A remount loses React state whether or not the browser
 * reloaded, so the fix cannot be in the switcher — the state has to survive
 * outside the component that owns it.
 *
 * ## Why sessionStorage, where the citizen draft uses localStorage
 *
 * They are solving different problems and the storage follows from that.
 * `citizen-draft` is deliberately durable: a clerk leaves a half-typed
 * household to go and look something up, maybe comes back tomorrow, and the
 * draft has to still be there — so it persists across tabs and restarts, and
 * pays for that with an age check and an explicit «استُعيدت مسودة» notice.
 *
 * This one exists to survive a remount inside one tab, in the same second.
 * Scoping it to the tab is what makes it safe to restore *silently*: nothing
 * here can outlive the session that created it, so there is no stale draft to
 * re-apply over a colleague's correction days later — the exact hazard
 * `citizen-draft` refuses edits to avoid. That is why this one can cover edits
 * too.
 *
 * ## What is deliberately not stored
 *
 * Anything the server owns: the allocated code, the resolved zone, the parcel
 * outline, the duplicate list, the loaded baseline the save diffs against.
 * Those are re-derived on mount from the parcel number and the building id,
 * and a restored copy could only ever be a staler version of what the remount
 * is already fetching.
 */

const KEY_PREFIX = 'mechanization.building-draft.v1.';

/**
 * Drafts older than this are ignored.
 *
 * Generous for what it covers — a locale switch restores within a second — but
 * it is the same key an officer returns to after switching to «المواطنون» and
 * back inside the tab, and an hour is the length of a working session rather
 * than of a round trip.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

/** One draft per building being edited, and one for «مبنى جديد». */
const key = (tenant: string, buildingId: string | undefined) =>
  `${KEY_PREFIX}${tenant}.${buildingId ?? 'new'}`;

export interface BuildingDraft {
  step: 0 | 1 | 2;
  parcelNumber: string;
  name: string;
  postedNumber: string;
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  floorsCount: string;
  basementsCount: string;
  notes: string;
  pin: [number, number] | null;
  gridSize: number;
  gridUnits: GridUnitDraft[];
  acknowledgedDuplicates: boolean;
}

interface StoredDraft extends BuildingDraft {
  savedAt: number;
}

/**
 * Whether this wizard has anything worth keeping.
 *
 * Guards the *write*, so merely opening «مبنى جديد» and switching language
 * leaves nothing behind to restore — and an officer who deliberately starts
 * over is not handed back the form they just abandoned.
 *
 * `structureType` and `lifecycleStatus` are excluded because the wizard seeds
 * them: `RESIDENTIAL_BUILDING` and `IN_USE` are its defaults, not an answer
 * anybody gave. A painted unit, by contrast, counts on its own — it is the
 * most laborious thing on the screen and the least tolerable to lose.
 */
export function buildingDraftWorthKeeping(draft: BuildingDraft): boolean {
  return Boolean(
    draft.parcelNumber.trim() ||
      draft.name.trim() ||
      draft.postedNumber.trim() ||
      draft.notes.trim() ||
      draft.pin ||
      draft.gridUnits.length > 0,
  );
}

export function saveBuildingDraft(
  tenant: string,
  buildingId: string | undefined,
  draft: BuildingDraft,
): void {
  try {
    if (!buildingDraftWorthKeeping(draft)) {
      clearBuildingDraft(tenant, buildingId);
      return;
    }
    const payload: StoredDraft = { ...draft, savedAt: Date.now() };
    sessionStorage.setItem(key(tenant, buildingId), JSON.stringify(payload));
  } catch {
    // A private window, a full quota, storage disabled by policy. The wizard
    // works without this; it just loses state on a locale switch again, which
    // is where it started.
  }
}

export function loadBuildingDraft(
  tenant: string,
  buildingId: string | undefined,
): BuildingDraft | null {
  try {
    const raw = sessionStorage.getItem(key(tenant, buildingId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredDraft;
    if (typeof parsed?.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearBuildingDraft(tenant, buildingId);
      return null;
    }

    const { savedAt: _savedAt, ...draft } = parsed;
    return draft;
  } catch {
    // Unparseable is the same as absent: a draft written by an older shape of
    // the wizard is not worth migrating, and throwing here would take the
    // whole screen down over a stale string.
    return null;
  }
}

export function clearBuildingDraft(tenant: string, buildingId: string | undefined): void {
  try {
    sessionStorage.removeItem(key(tenant, buildingId));
  } catch {
    // See `saveBuildingDraft`.
  }
}
