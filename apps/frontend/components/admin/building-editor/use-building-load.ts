import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import {
  type BuildingLifecycle,
  type HouseGrowth,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getBuilding,
  getZoneParcelIndex,
  getZones,
  logApiError,
  type BuildingDetail,
  type BuildingMatrixSave,
  type BuildingMatrixSaveResult,
  type HouseGrowthQuestion,
  type ParcelCorrectionResult,
  type UnitWithOccupants,
  type ZoneSummary,
} from '@/lib/api-client';
import {
  clearBuildingDraft,
  draftIsCurrent,
  editDraftFingerprint,
  redrawRemovedFlats,
  type EditDraftFields,
} from '@/lib/building-draft';
import { clearSession } from '@/lib/session';
import {
  loadParcelLabelPoints,
  loadParcelOutlines,
} from '../parcel-pin-picker';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';
import { gridFromUnits, type UnitBaseline } from './grid-units';

/**
 * Loading a building to correct: the fetch, what the form takes from it, the stale-draft question and «تصحيح رقم العقار».
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useBuildingLoad({
  pinParcelRef,
  setParcelNumber,
  setSharedParcels,
  setSuffix,
  setSavedCode,
  markDraftBase,
  en,
  setHiddenUnits,
  setName,
  setPostedNumber,
  setIsPartitioned,
  setPartitionNumbers,
  setStructureType,
  setBuildingTypeId,
  setLifecycleStatus,
  setNotes,
  setPin,
  setGridUnits,
  setGridSize,
  setFloorsCount,
  setBasementsCount,
  pristineRef,
  baselineRef,
  buildingId,
  token,
  setLoadingDetail,
  setLoadError,
  tenant,
  draftRestoredRef,
  draftBaseRef,
  setStaleDraft,
  router,
  base,
  staleDraft,
  setAcknowledgedDuplicates,
  setDuplicateReason,
  setNoPinReason,
  setStep,
  initialStep,
  headingRef,
  setParcelOutlines,
  setParcelLabelPoints,
  setZones,
  setZoneIndex,
}: {
  pinParcelRef: React.MutableRefObject<string | null>;
  setParcelNumber: React.Dispatch<React.SetStateAction<string>>;
  setSharedParcels: React.Dispatch<React.SetStateAction<string[]>>;
  setSuffix: React.Dispatch<React.SetStateAction<string>>;
  setSavedCode: React.Dispatch<React.SetStateAction<string | null>>;
  markDraftBase: (updatedAt: string | null) => void;
  en: boolean;
  setHiddenUnits: React.Dispatch<React.SetStateAction<UnitWithOccupants[]>>;
  setName: React.Dispatch<React.SetStateAction<string>>;
  setPostedNumber: React.Dispatch<React.SetStateAction<string>>;
  setIsPartitioned: React.Dispatch<React.SetStateAction<boolean>>;
  setPartitionNumbers: React.Dispatch<React.SetStateAction<string[]>>;
  setStructureType: React.Dispatch<React.SetStateAction<"INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION">>;
  setBuildingTypeId: React.Dispatch<React.SetStateAction<string>>;
  setLifecycleStatus: React.Dispatch<React.SetStateAction<"UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED">>;
  setNotes: React.Dispatch<React.SetStateAction<string>>;
  setPin: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  setGridUnits: React.Dispatch<React.SetStateAction<GridUnitDraft[]>>;
  setGridSize: React.Dispatch<React.SetStateAction<number>>;
  setFloorsCount: React.Dispatch<React.SetStateAction<string>>;
  setBasementsCount: React.Dispatch<React.SetStateAction<string>>;
  pristineRef: React.MutableRefObject<string | null>;
  baselineRef: React.MutableRefObject<Map<string, UnitBaseline>>;
  buildingId: string | undefined;
  token: string | undefined;
  setLoadingDetail: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadError: React.Dispatch<React.SetStateAction<string | null>>;
  tenant: string;
  draftRestoredRef: React.MutableRefObject<boolean>;
  draftBaseRef: React.MutableRefObject<string | null>;
  setStaleDraft: React.Dispatch<React.SetStateAction<BuildingDetail | null>>;
  router: ReturnType<typeof useRouter>;
  base: string;
  staleDraft: BuildingDetail | null;
  setAcknowledgedDuplicates: React.Dispatch<React.SetStateAction<boolean>>;
  setDuplicateReason: React.Dispatch<React.SetStateAction<string>>;
  setNoPinReason: React.Dispatch<React.SetStateAction<string | null>>;
  setStep: React.Dispatch<React.SetStateAction<0 | 1 | 2>>;
  initialStep: 0 | 1 | 2;
  headingRef: React.MutableRefObject<HTMLHeadingElement | null>;
  setParcelOutlines: React.Dispatch<React.SetStateAction<FeatureCollection<Geometry, GeoJsonProperties> | null>>;
  setParcelLabelPoints: React.Dispatch<React.SetStateAction<FeatureCollection<Geometry, GeoJsonProperties> | null>>;
  setZones: React.Dispatch<React.SetStateAction<ZoneSummary[]>>;
  setZoneIndex: React.Dispatch<React.SetStateAction<Record<string, { id: string; code: string; name: string; color: string; }>>>;
}) {
  /**
   * The building's `updatedAt` as last loaded, sent with the save so a colleague's
   * change made since is not silently replaced. Refreshed on every load — except
   * under a restored draft made against an older version, where it stays that
   * version until the officer chooses (`loadDetail`, `staleDraft`).
   */
  const loadedUpdatedAtRef = useRef<string | null>(null);
  /** The building as loaded — what «مراجعة التعديلات» compares the save with. */
  const loadedDetailRef = useRef<BuildingDetail | null>(null);
  /** A rehearsed save waiting for the officer to confirm — see `handleSave`. */
  const [buildingReview, setBuildingReview] = useState<{
    save: BuildingMatrixSave;
    result: BuildingMatrixSaveResult;
  } | null>(null);
  /**
   * «هذا المنزل يصبح مبنى» (D28): asked by the server's rehearsal when this save
   * would give a house on somebody's file a second unit, and the answer sent
   * with every rehearsal and save after it.
   */
  const [growthQuestion, setGrowthQuestion] = useState<HouseGrowthQuestion | null>(null);
  const [houseGrowth, setHouseGrowth] = useState<HouseGrowth | null>(null);
  /**
   * The lifecycle as loaded, and how many people are recorded in the units
   * right now — so moving a lived-in building to «مهدوم» says what it leaves
   * behind. See the notice under «الحالة الإنشائية».
   */
  const [loadedLifecycle, setLoadedLifecycle] = useState<BuildingLifecycle | null>(null);
  const [liveOccupants, setLiveOccupants] = useState(0);
  /** Codes retired by «تصحيح رقم العقار», newest first — shown under the code. */
  const [previousCodes, setPreviousCodes] = useState<NonNullable<BuildingDetail['previousCodes']>>([]);
  const [correctingParcel, setCorrectingParcel] = useState(false);

  /*
    A correction landed. Only what the server changed is applied — the parcel,
    the code, the shared parcels and the version — so anything else the officer
    has typed in the form stays theirs to save. The pin is claimed for the new
    parcel *before* the parcel changes, or the parcel lookup below would drop it
    as a pin left on another parcel.
  */
  const applyParcelCorrection = useCallback(
    (result: ParcelCorrectionResult, oldParcel: string) => {
      pinParcelRef.current = result.building.parcelNumber;
      setParcelNumber(result.building.parcelNumber);
      setSharedParcels(result.building.sharedParcelNumbers);
      setSuffix(result.building.codeSuffix);
      setSavedCode(result.building.code);
      loadedUpdatedAtRef.current = result.building.updatedAt;
      // The officer made this version, on top of what is on screen.
      markDraftBase(result.building.updatedAt);
      setPreviousCodes((current) => [
        { code: result.previousCode, parcelNumber: oldParcel, reason: '', retiredAt: new Date().toISOString() },
        ...current.filter((row) => row.code !== result.building.code),
      ]);
    },
    [markDraftBase, pinParcelRef, setParcelNumber, setSavedCode, setSharedParcels, setSuffix],
  );

  /**
   * Fills the whole wizard from the building on file.
   *
   * `keepEdits` is the locale-switch case. The remount refetches the building,
   * and this would then write the server's copy over the corrections the
   * officer had already typed — so when a draft was restored, only the parts
   * the server owns are applied: the allocated code, the suffix, the baseline
   * the save diffs against, and the units the grid cannot draw. What the
   * officer typed stays theirs. Whether the draft may be kept without asking
   * is `loadDetail`'s question (`draftIsCurrent`), not this one's.
   */
  const hydrate = useCallback(
    (detail: BuildingDetail, keepEdits = false) => {
      loadedUpdatedAtRef.current = detail.updatedAt ?? null;
      if (!keepEdits) markDraftBase(detail.updatedAt ?? null);
      loadedDetailRef.current = detail;
      setLoadedLifecycle(detail.lifecycleStatus);
      setLiveOccupants(
        detail.units.reduce(
          (count, unit) => count + unit.occupants.filter((occupant) => !occupant.toDate).length,
          0,
        ),
      );
      /*
        The parcel is the server's, even when a draft is kept: this form cannot
        edit it, and a draft saved before «تصحيح رقم العقار» would otherwise put
        the old number back on screen and centre the map on the wrong parcel.
      */
      setParcelNumber(detail.parcelNumber);
      pinParcelRef.current = detail.parcelNumber;
      setPreviousCodes(detail.previousCodes ?? []);
      setSuffix(detail.codeSuffix);
      setSavedCode(detail.code);

      const { drafts, hidden, columns, floors, basements } = gridFromUnits(detail.units, en);
      setHiddenUnits(hidden);
      if (!keepEdits) {
        const loaded: EditDraftFields = {
          name: detail.name ?? '',
          postedNumber: detail.postedNumber ?? '',
          isPartitioned: detail.isPartitioned === true,
          partitionNumbers: detail.partitionNumbers ?? [],
          sharedParcels: detail.sharedParcelNumbers ?? [],
          structureType: detail.structureType,
          buildingTypeId: detail.buildingTypeId ?? '',
          lifecycleStatus: detail.lifecycleStatus,
          notes: detail.notes ?? '',
          pin: detail.latitude != null && detail.longitude != null ? [detail.longitude, detail.latitude] : null,
          gridUnits: drafts,
          gridSize: columns,
          /*
            The taller of the two answers wins. A matrix carrying a unit on floor 5
            of a building recorded as three storeys is a building whose floor count
            is behind its own units, and a grid that only drew three rows would
            strand the other two outside it.

            The same reconciliation downward: a building declaring no basement but
            holding a unit on B2 has two levels the register has not caught up with.
            This is the case that made the column worth adding — those units existed
            long before anywhere could say the basement did.
          */
          floorsCount: String(Math.max(detail.floorsCount, floors)),
          basementsCount: String(Math.max(detail.basementsCount ?? 0, basements)),
        };
        setName(loaded.name);
        setPostedNumber(loaded.postedNumber);
        setIsPartitioned(loaded.isPartitioned);
        setPartitionNumbers(loaded.partitionNumbers);
        setSharedParcels(loaded.sharedParcels);
        setStructureType(loaded.structureType);
        setBuildingTypeId(loaded.buildingTypeId ?? '');
        setLifecycleStatus(loaded.lifecycleStatus);
        setNotes(loaded.notes);
        setPin(loaded.pin);
        setGridUnits(loaded.gridUnits);
        setGridSize(loaded.gridSize);
        setFloorsCount(loaded.floorsCount);
        setBasementsCount(loaded.basementsCount);
        // The building as it is on file: what «nothing typed» means to the autosave.
        pristineRef.current = editDraftFingerprint(loaded);
      }

      baselineRef.current = new Map(
        drafts
          .filter((draft) => draft.existingId)
          .map((draft) => [
            draft.existingId as string,
            {
              unitCode: draft.unitCode ?? '',
              floor: draft.floor,
              startCol: draft.startCol,
              endCol: draft.endCol,
              unitType: draft.unitType,
              unitTypeId: draft.unitTypeId,
            },
          ]),
      );
    },
    [baselineRef, en, markDraftBase, pinParcelRef, pristineRef, setBasementsCount, setBuildingTypeId, setFloorsCount, setGridSize, setGridUnits, setHiddenUnits, setIsPartitioned, setLifecycleStatus, setName, setNotes, setParcelNumber, setPartitionNumbers, setPin, setPostedNumber, setSavedCode, setSharedParcels, setStructureType, setSuffix],
  );

  const loadDetail = useCallback(async () => {
    if (!buildingId || !token) return;
    setLoadingDetail(true);
    setLoadError(null);
    try {
      const detail = await getBuilding(tenant, token, buildingId);
      const keepEdits = draftRestoredRef.current;
      hydrate(detail, keepEdits);
      /*
        A restored draft made against an older version than the server holds:
        a colleague has saved this building since. Keeping it silently, with
        the fresh `updatedAt` as the save's `expectedUpdatedAt`, overwrote their
        change without a word. The draft stays on screen, the save still names
        the version the draft was made against (so it is refused as stale), and
        the officer is asked which to keep (`staleDraft`).
      */
      if (keepEdits && !draftIsCurrent({ baseUpdatedAt: draftBaseRef.current }, detail.updatedAt)) {
        /*
          A draft from before `baseUpdatedAt` existed names no version: the
          fresh one stays, so «تصحيح رقم العقار» still sends a version to be
          checked against. The save waits for the answer either way.
        */
        loadedUpdatedAtRef.current = draftBaseRef.current ?? detail.updatedAt;
        setStaleDraft(detail);
      }
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      setLoadError(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not load the building.'
            : 'تعذّر تحميل المبنى.',
      );
    } finally {
      setLoadingDetail(false);
    }
  }, [buildingId, token, setLoadingDetail, setLoadError, tenant, draftRestoredRef, hydrate, draftBaseRef, setStaleDraft, en, router, base]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  /**
   * «حمّل النسخة الأحدث»: the draft is dropped and the building read again, as
   * on a fresh open — read, not taken from the copy the question was asked
   * about, which a third save may have passed since.
   */
  const loadLatestVersion = () => {
    if (!staleDraft) return;
    clearBuildingDraft(tenant, buildingId);
    draftRestoredRef.current = false;
    setAcknowledgedDuplicates(false);
    setDuplicateReason('');
    setNoPinReason(null);
    setStep(initialStep);
    setStaleDraft(null);
    void loadDetail();
    headingRef.current?.focus();
  };

  /**
   * «أبقِ مسودتي»: an informed choice — the draft stays, and its save makes the
   * building what is on screen. `hydrate` rebuilt the baseline from the newer
   * version, so a flat removed since is drawn again as new (`redrawRemovedFlats`).
   */
  const keepDraftOverLatest = () => {
    if (!staleDraft) return;
    loadedUpdatedAtRef.current = staleDraft.updatedAt;
    markDraftBase(staleDraft.updatedAt);
    const baseline = baselineRef.current;
    setGridUnits((current) => redrawRemovedFlats(current, baseline));
    setStaleDraft(null);
    headingRef.current?.focus();
  };

  /*
    The two things the sector step needs, fetched once per mount.

    Both are already cached at the module level — `loadParcelOutlines` keeps one
    promise per tenant for the life of the tab once it has found the outlines
    (a miss is asked again, with the token once there is one), and `getZoneParcelIndex` a
    five-minute one — so this is not a second copy of anything. What it adds is
    holding them in state, because the pin→parcel lookup has to be able to
    answer synchronously the moment somebody taps the map.

    A failure here is deliberately silent and non-blocking. Without the outlines
    the officer types رقم العقار exactly as they always have; without the zone
    list the sector select is simply not offered. Neither is a reason to stop
    somebody recording a building.
  */
  useEffect(() => {
    let cancelled = false;

    void loadParcelOutlines(tenant, token).then((collection) => {
      if (!cancelled) setParcelOutlines(collection);
    });

    void loadParcelLabelPoints(tenant, token).then((collection) => {
      if (!cancelled) setParcelLabelPoints(collection);
    });

    if (!token) return () => { cancelled = true; };

    void getZones(tenant, token)
      .then(({ zones: rows }) => {
        if (!cancelled) setZones(rows);
      })
      .catch(logApiError);

    void getZoneParcelIndex(tenant, token)
      .then((index) => {
        if (!cancelled) setZoneIndex(index);
      })
      .catch(logApiError);

    return () => {
      cancelled = true;
    };
  }, [setParcelLabelPoints, setParcelOutlines, setZoneIndex, setZones, tenant, token]);

  return {
    loadedUpdatedAtRef,
    loadedDetailRef,
    buildingReview,
    setBuildingReview,
    growthQuestion,
    setGrowthQuestion,
    houseGrowth,
    setHouseGrowth,
    loadedLifecycle,
    liveOccupants,
    previousCodes,
    correctingParcel,
    setCorrectingParcel,
    applyParcelCorrection,
    loadDetail,
    loadLatestVersion,
    keepDraftOverLatest,
  };
}
