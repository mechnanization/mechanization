import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import {
  type BuildingLifecycle,
  type StructureType,
} from '@mechanization/shared-schemas';
import {
  type BuildingDetail,
  type DuplicateBuildingCandidate,
  type UnitWithOccupants,
  type ZoneSummary,
} from '@/lib/api-client';
import {
} from '@/lib/building-draft';
import { systemTypeOf, typesToOffer, useBuildingTypes } from '@/lib/building-types';
import {
  DEFAULT_GRID_SIZE,
  type GridUnitDraft,
} from '../unit-grid-picker';
import { type UnitBaseline } from './grid-units';

/**
 * What the wizard holds: every field, the pin, the grid, the draft's refs and the creation key's scope.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useBuildingFields({
  initialStep,
  initialParcelNumber,
  buildingTypes,
  editing,
}: {
  initialStep: 0 | 1 | 2;
  initialParcelNumber: string | undefined;
  buildingTypes: ReturnType<typeof useBuildingTypes>;
  editing: boolean;
}) {
  // Wizard state
  const [step, setStep] = useState<0 | 1 | 2>(initialStep);

  // Form State
  const [parcelNumber, setParcelNumber] = useState(initialParcelNumber ?? '');
  /**
   * The قطاع the officer chose to look in — a way into the map, never a stored
   * field.
   *
   * A building's sector is *derived* from its parcel's membership at read time
   * (D13) and must stay that way: `Zone.parcelNumbers` is the single statement
   * of which عقار belongs where, and a second copy on the building would be a
   * second answer that could disagree with it. So this narrows the map and
   * nothing else, and the code preview goes on reading the zone off the parcel
   * — which is why a mismatch between the two is reported rather than silently
   * preferred either way.
   */
  const [zoneId, setZoneId] = useState<string>('');
  const [zones, setZones] = useState<ZoneSummary[]>([]);
  /** Every traced parcel, held so a dropped pin can be resolved to one. */
  const [parcelOutlines, setParcelOutlines] = useState<FeatureCollection | null>(null);
  /** Where the cadastre prints each parcel's number — what the map labels. */
  const [parcelLabelPoints, setParcelLabelPoints] = useState<FeatureCollection | null>(null);
  /** parcel number → its sector, from the same five-minute cache the code preview uses. */
  const [zoneIndex, setZoneIndex] = useState<
    Record<string, { id: string; code: string; name: string; color: string }>
  >({});
  /** Whether رقم العقار was read off the map rather than typed — see `applyPin`. */
  const [parcelFromMap, setParcelFromMap] = useState(false);
  /**
   * «مفروزة» — ticked, or silent.
   *
   * A checkbox, and the asymmetry is deliberate: a tick is an officer asserting
   * a فرز, and an untouched box is «لم يُسأل» rather than «غير مفروزة». That is
   * why the save sends `true` or `null` and never `false` — فرز decides whether
   * a flat inside can carry a deed of its own, and an unticked box on every
   * building ever created is not a finding about title anybody made.
   *
   * The column keeps room for `false` (see `Building.isPartitioned`) so a form
   * that one day records «we read the صحيفة and there is no فرز» has somewhere
   * to put it. This control is not that form.
   */
  const [isPartitioned, setIsPartitioned] = useState(false);
  /**
   * أرقام الأقسام — asked only once the box is ticked.
   *
   * Kept as a list including blanks so a half-typed row survives a re-render;
   * blanks are dropped on save. A فرز with no numbers recorded is still a فرز,
   * so an empty list is allowed — «مفروزة، والأرقام لم تُجمع بعد» is an ordinary
   * state for a building surveyed from the street.
   */
  const [partitionNumbers, setPartitionNumbers] = useState<string[]>([]);
  /**
   * «إن كانت الوحدة مشتركة على أكثر من عقار» — the other عقارات it stands on.
   *
   * Kept as a list including blanks so a half-typed row survives a re-render;
   * blanks are dropped on save. `parcelNumber` itself is never one of these —
   * the server filters it out too, since a building that straddles itself is a
   * figure that would then be counted.
   */
  const [sharedParcels, setSharedParcels] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [postedNumber, setPostedNumber] = useState('');
  const [structureType, setStructureType] = useState<StructureType>('RESIDENTIAL_BUILDING');
  /** «نوع المبنى» (0106): '' until chosen; the structure follows it, and the server takes the type's. */
  const [buildingTypeId, setBuildingTypeId] = useState('');
  const offeredTypes = useMemo(
    () => typesToOffer(buildingTypes.data ?? [], buildingTypeId),
    [buildingTypes.data, buildingTypeId],
  );
  const chosenTypeId = buildingTypeId || systemTypeOf(buildingTypes.data ?? [], structureType)?.id || '';
  const chosenType = offeredTypes.find((type) => type.id === chosenTypeId);
  const chooseType = (id: string) => {
    const type = offeredTypes.find((candidate) => candidate.id === id);
    setBuildingTypeId(id);
    if (type) setStructureType(type.structureType);
  };
  const [floorsCount, setFloorsCount] = useState('3');
  /** How far the structure goes down, as a depth: '2' means B1 and B2. */
  const [basementsCount, setBasementsCount] = useState('0');
  const [notes, setNotes] = useState('');
  const [pin, setPin] = useState<[number, number] | null>(null);
  const pinParcelRef = useRef<string | null>(initialParcelNumber ?? null);

  // Unit matrix grid state
  const [gridSize, setGridSize] = useState(DEFAULT_GRID_SIZE);
  const [gridUnits, setGridUnits] = useState<GridUnitDraft[]>([]);
  /**
   * The matrix as it was loaded, keyed by unit id — what the save diffs
   * against. An untouched cell is in here unchanged and writes nothing; one
   * that is here and no longer on the grid is a deletion; one on the grid and
   * not here is a new flat.
   */
  const baselineRef = useRef<Map<string, UnitBaseline>>(new Map());
  /** Units the grid cannot draw — basements, or a floor already full. Listed
   *  rather than silently dropped, and never touched by the save. */
  const [hiddenUnits, setHiddenUnits] = useState<UnitWithOccupants[]>([]);

  // Edit-mode load state
  const [loadingDetail, setLoadingDetail] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The code the server allocated — shown instead of a provisional preview. */
  const [savedCode, setSavedCode] = useState<string | null>(null);

  // Resolution State
  const [zoneCode, setZoneCode] = useState<string | null>(null);
  const [zoneName, setZoneName] = useState<string | null>(null);
  const [suffix, setSuffix] = useState('A');
  const [lifecycleStatus, setLifecycleStatus] = useState<BuildingLifecycle>('IN_USE');
  const [duplicates, setDuplicates] = useState<DuplicateBuildingCandidate[] | null>(null);
  const [acknowledgedDuplicates, setAcknowledgedDuplicates] = useState(false);
  /** «لماذا هي منشأة منفصلة؟» — required beside the tick. See `duplicateReason` in the schema. */
  const [duplicateReason, setDuplicateReason] = useState('');
  /**
   * «تعذّر تثبيت المدخل» — ticked, with a reason, when a new building is saved
   * without a pin. Null while unticked. See `noPinReason` in the schema.
   */
  const [noPinReason, setNoPinReason] = useState<string | null>(null);
  const [outline, setOutline] = useState<Geometry | null>(null);
  /**
   * The parcel `outline` was looked up for.
   *
   * Not `trimmedParcel`: that changes on every keystroke, and the lookup runs
   * after a debounce. Numbering the map from the field would move the
   * highlighted number through «1», «12», «125» while the outline still showed
   * the parcel before — this changes in the same render as the outline does.
   */
  const [resolvedParcel, setResolvedParcel] = useState<string | null>(null);
  const [fallbackCentre, setFallbackCentre] = useState<[number, number] | null>(null);
  const [outlineChecked, setOutlineChecked] = useState(false);
  const [cadastreHint, setCadastreHint] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Submission State
  const [saving, setSaving] = useState(false);
  /*
    Synchronous, unlike `saving`, which lands a render after a fast second
    press — and a second press on «حفظ» created a second building (STA-4).
    Never released after a save that landed: the page stays mounted until the
    next route is ready, and the button must not come back on meanwhile.
  */
  const inFlight = useRef(false);
  /*
    The creation's `clientSubmissionId`, which the server makes the building's
    id, is a held key (`heldKey`, lib/request-id.ts), one per parcel
    (`building:<parcel>`): a retry after an answer that never arrived goes
    under the same id and is answered with the building the lost attempt made
    (`deduplicated`), not a second one on the parcel — queued offline too.

    Held there, not in this form: a key in a ref died with the form, and the
    draft did not — a locale switch or a look at «سجل المباني» brought back the
    ticked «مبنى منفصل» with a new id, and the server, seeing the tick, made a
    second building. Per parcel, because the server refuses an id it knows on
    another parcel. Kept across every failure, as every retry key is
    (`keyIsSpent`): a 400 proves only that this attempt wrote nothing. Spent
    once the building is on file or handed to the queue.
  */
  const creationScope = `building:${parcelNumber.trim()}` as const;
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pinError, setPinError] = useState<string | null>(null);

  const trimmedParcel = parcelNumber.trim();

  /** The wizard's outermost element — what a step change scrolls back to. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The page heading: where the focus goes once the stale-draft question, which held it, is answered (A11Y-6). */
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  /**
   * Restoring across a locale switch.
   *
   * The locale is a route segment, so switching language is a navigation to a
   * different route: this component unmounts and a fresh one mounts with every
   * `useState` back at its initial value. Without this, changing language four
   * fields into a building — pin dropped, matrix painted — empties the form.
   *
   * Runs once, before the edit-mode fetch resolves, and `restoredRef` stops the
   * autosave below from writing the blank initial state over a good draft in
   * the same tick. See `lib/building-draft.ts` for why this is session-scoped,
   * and `loadDetail` for the draft of an edit the server has moved past.
   */
  const restoredRef = useRef(false);
  /** Whether the values on screen came from a draft rather than the server —
   *  read by `loadDetail` so the refetch does not overwrite them. A ref, not
   *  state: `loadDetail` must not be rebuilt when it flips. */
  const draftRestoredRef = useRef(false);
  /**
   * On an edit, the building's `updatedAt` the values on screen were made
   * against — stored with the draft (`baseUpdatedAt`) so a restore can tell
   * whether a colleague has saved since. State for the autosave, mirrored in a
   * ref for `loadDetail`, which must not be rebuilt when it changes.
   */
  const [draftBase, setDraftBase] = useState<string | null>(null);
  const draftBaseRef = useRef<string | null>(null);
  const markDraftBase = useCallback((updatedAt: string | null) => {
    draftBaseRef.current = updatedAt;
    setDraftBase(updatedAt);
  }, []);
  /**
   * The server's copy, while a restored draft was made against an older
   * version of it and the officer has not yet said which one to keep. Nothing
   * is saved meanwhile (`handleSave`).
   */
  const [staleDraft, setStaleDraft] = useState<BuildingDetail | null>(null);
  const staleDraftRef = useRef<HTMLDivElement | null>(null);
  /**
   * The edit as loaded, as `editDraftFingerprint` writes it — taken by
   * `hydrate` from the very values it puts on screen. The autosave writes no
   * draft of an edit that still matches it.
   */
  const pristineRef = useRef<string | null>(null);

  return {
    step,
    setStep,
    parcelNumber,
    setParcelNumber,
    zoneId,
    setZoneId,
    zones,
    setZones,
    parcelOutlines,
    setParcelOutlines,
    parcelLabelPoints,
    setParcelLabelPoints,
    zoneIndex,
    setZoneIndex,
    parcelFromMap,
    setParcelFromMap,
    isPartitioned,
    setIsPartitioned,
    partitionNumbers,
    setPartitionNumbers,
    sharedParcels,
    setSharedParcels,
    name,
    setName,
    postedNumber,
    setPostedNumber,
    structureType,
    setStructureType,
    buildingTypeId,
    setBuildingTypeId,
    offeredTypes,
    chosenTypeId,
    chosenType,
    chooseType,
    floorsCount,
    setFloorsCount,
    basementsCount,
    setBasementsCount,
    notes,
    setNotes,
    pin,
    setPin,
    pinParcelRef,
    gridSize,
    setGridSize,
    gridUnits,
    setGridUnits,
    baselineRef,
    hiddenUnits,
    setHiddenUnits,
    loadingDetail,
    setLoadingDetail,
    loadError,
    setLoadError,
    savedCode,
    setSavedCode,
    zoneCode,
    setZoneCode,
    zoneName,
    setZoneName,
    suffix,
    setSuffix,
    lifecycleStatus,
    setLifecycleStatus,
    duplicates,
    setDuplicates,
    acknowledgedDuplicates,
    setAcknowledgedDuplicates,
    duplicateReason,
    setDuplicateReason,
    noPinReason,
    setNoPinReason,
    outline,
    setOutline,
    resolvedParcel,
    setResolvedParcel,
    fallbackCentre,
    setFallbackCentre,
    outlineChecked,
    setOutlineChecked,
    cadastreHint,
    setCadastreHint,
    resolving,
    setResolving,
    saving,
    setSaving,
    inFlight,
    creationScope,
    error,
    setError,
    fieldErrors,
    setFieldErrors,
    pinError,
    setPinError,
    trimmedParcel,
    rootRef,
    headingRef,
    restoredRef,
    draftRestoredRef,
    draftBase,
    draftBaseRef,
    markDraftBase,
    staleDraft,
    setStaleDraft,
    staleDraftRef,
    pristineRef,
  };
}
