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
 * This one exists to survive a remount inside one tab — a locale switch, a
 * look at «سجل المباني» and back — and is ignored after an hour. Being scoped
 * to the tab keeps it from outliving the session that wrote it, but not from
 * going stale: inside that hour a colleague can save the same building. So a
 * draft of an *edit* carries the version it was made against
 * (`baseUpdatedAt`), and is restored silently only while the server still
 * holds that version (`draftIsCurrent`). Otherwise the editor says the record
 * changed since and lets the officer choose: the latest version, or the draft
 * saved over it. An edit nobody has touched leaves no draft at all
 * (`editDraftFingerprint`), so the question is only ever about real edits.
 *
 * ## What is deliberately not stored
 *
 * Anything the server owns: the allocated code, the resolved zone, the parcel
 * outline, the duplicate list, the loaded baseline the save diffs against.
 * Those are re-derived on mount from the parcel number and the building id,
 * and a restored copy could only ever be a staler version of what the remount
 * is already fetching.
 */

/**
 * `v2` since the wizard's first step gained a sector, «مفروزة» with its أقسام,
 * and the shared parcels. A `v1` draft has none of them, and restoring one on
 * an edit would reset all three to empty — which the next save then writes,
 * erasing what was on file. Abandoning drafts that are at most an hour old and
 * scoped to one tab costs nothing by comparison.
 */
const KEY_PREFIX = 'mechanization.building-draft.v2.';

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
  /** The sector the officer chose to look in — a map filter, never stored on the building. */
  zoneId: string;
  /** «مفروزة» as ticked; see `BuildingEditor`'s `isPartitioned`. */
  isPartitioned: boolean;
  /** أرقام الأقسام as typed, blanks included. */
  partitionNumbers: string[];
  /** The other عقارات, as typed, blanks included. */
  sharedParcels: string[];
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  floorsCount: string;
  basementsCount: string;
  notes: string;
  pin: [number, number] | null;
  gridSize: number;
  gridUnits: GridUnitDraft[];
  acknowledgedDuplicates: boolean;
  /**
   * The reason typed beside that tick. Optional so a draft written by the
   * previous build still restores; it simply comes back empty.
   */
  duplicateReason?: string;
  /** «تعذّر تثبيت المدخل» and its reason, as typed. */
  noPinReason?: string;
  /**
   * On an edit, the building's `updatedAt` the edits on screen were made
   * against — the version loaded, or the newer one the officer chose to save
   * over. Null on a new building, and absent from a draft written before this
   * field, which `draftIsCurrent` treats as made against an unknown version.
   */
  baseUpdatedAt?: string | null;
}

interface StoredDraft extends BuildingDraft {
  savedAt: number;
}

/**
 * Whether a restored draft of an edit may be applied without asking: only when
 * it was made against the version the server holds now.
 *
 * The save sends the version it was made against as `expectedUpdatedAt`, and
 * the editor used to send the *freshly loaded* one while keeping the draft's
 * values on screen — so a colleague's save made since the draft was silently
 * overwritten by it. A draft with no recorded version (written before
 * `baseUpdatedAt` existed) is not current: nothing says what it was made
 * against.
 *
 * Compared as instants, as the server's own check does, so the same moment
 * written two ways is the same version.
 */
export function draftIsCurrent(
  draft: Pick<BuildingDraft, 'baseUpdatedAt'>,
  serverUpdatedAt: string,
): boolean {
  if (!draft.baseUpdatedAt) return false;
  const base = Date.parse(draft.baseUpdatedAt);
  const server = Date.parse(serverUpdatedAt);
  if (Number.isNaN(base) || Number.isNaN(server)) return draft.baseUpdatedAt === serverUpdatedAt;
  return base === server;
}

/**
 * What an edit's save sends from this draft — the building's fields and its
 * grid — as one string, so two drafts that would save the same are equal.
 *
 * The building editor compares it with the building as loaded and keeps no
 * draft of an edit nobody has made: the form holds the building from the moment
 * it loads, so every visit used to leave one, and the next visit asked which
 * version to keep about edits that did not exist (`draftIsCurrent`). Left out:
 * where the wizard stands (`step`), the sector that only narrows the map
 * (`zoneId`), and the duplicate questions, which a save of an edit does not send.
 */
export type EditDraftFields = Pick<
  BuildingDraft,
  | 'name'
  | 'postedNumber'
  | 'isPartitioned'
  | 'partitionNumbers'
  | 'sharedParcels'
  | 'structureType'
  | 'lifecycleStatus'
  | 'floorsCount'
  | 'basementsCount'
  | 'notes'
  | 'pin'
  | 'gridSize'
  | 'gridUnits'
>;

export function editDraftFingerprint(draft: EditDraftFields): string {
  return JSON.stringify([
    draft.name,
    draft.postedNumber,
    draft.isPartitioned,
    draft.partitionNumbers,
    draft.sharedParcels,
    draft.structureType,
    draft.lifecycleStatus,
    draft.floorsCount,
    draft.basementsCount,
    draft.notes,
    draft.pin,
    draft.gridSize,
    draft.gridUnits,
  ]);
}

/**
 * The grid of a draft kept over a newer version («أبقِ مسودتي»), redrawn so the
 * save is what is on screen.
 *
 * The save diffs the grid against the newer version's units (`existing`, the
 * baseline): a flat added since is removed and one moved since moved back. A
 * flat removed since, which the draft still draws, carries an id the baseline
 * no longer has, so it was neither updated nor added — left out of the save
 * without a word. It is drawn again as a new flat (no id, no code).
 */
export function redrawRemovedFlats(
  gridUnits: readonly GridUnitDraft[],
  existing: { has(id: string): boolean },
): GridUnitDraft[] {
  return gridUnits.map((unit) =>
    unit.existingId && !existing.has(unit.existingId)
      ? { ...unit, existingId: undefined, unitCode: undefined }
      : unit,
  );
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
      draft.isPartitioned ||
      draft.partitionNumbers.some((value) => value.trim()) ||
      draft.sharedParcels.some((value) => value.trim()) ||
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
