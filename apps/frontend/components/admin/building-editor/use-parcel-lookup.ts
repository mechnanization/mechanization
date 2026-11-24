import { useCallback, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import {
  formatBuildingCode,
  nextBuildingSuffix,
} from '@mechanization/shared-schemas';
import {
  checkPropertyNumber,
  getBuildings,
  getZoneParcelIndex,
  logApiError,
  type DuplicateBuildingCandidate,
  type ZoneSummary,
} from '@/lib/api-client';
import { pointInGeometry } from '@/lib/map-geometry';
import {
  footprintOf,
  loadParcelOutlines,
  outlineOf,
  parcelAt,
  parcelsOf,
} from '../parcel-pin-picker';
import {
  LOOKUP_DEBOUNCE_MS,
} from './constants';
import {
  cleanPartitionNumbers,
  cleanSharedParcels,
} from '@/lib/building-editor-rules';

/**
 * The parcel: the sectors and the map's layers, the debounced lookup of what stands on it, the code preview and the entrance pin.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useParcelLookup({
  zoneId,
  zoneIndex,
  parcelOutlines,
  parcelLabelPoints,
  resolvedParcel,
  zones,
  trimmedParcel,
  initialParcelNumber,
  setZoneId,
  partitionNumbers,
  isPartitioned,
  sharedParcels,
  setOutline,
  setResolvedParcel,
  setFallbackCentre,
  setOutlineChecked,
  setZoneCode,
  setZoneName,
  setCadastreHint,
  setDuplicates,
  setAcknowledgedDuplicates,
  setParcelFromMap,
  setSuffix,
  setResolving,
  tenant,
  token,
  editing,
  tEditor,
  en,
  setPin,
  pinParcelRef,
  setPinError,
  zoneCode,
  suffix,
  outline,
  setParcelNumber,
  pin,
}: {
  zoneId: string;
  zoneIndex: Record<string, { id: string; code: string; name: string; color: string; }>;
  parcelOutlines: FeatureCollection<Geometry, GeoJsonProperties> | null;
  parcelLabelPoints: FeatureCollection<Geometry, GeoJsonProperties> | null;
  resolvedParcel: string | null;
  zones: ZoneSummary[];
  trimmedParcel: string;
  initialParcelNumber: string | undefined;
  setZoneId: React.Dispatch<React.SetStateAction<string>>;
  partitionNumbers: string[];
  isPartitioned: boolean;
  sharedParcels: string[];
  setOutline: React.Dispatch<React.SetStateAction<Geometry | null>>;
  setResolvedParcel: React.Dispatch<React.SetStateAction<string | null>>;
  setFallbackCentre: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  setOutlineChecked: React.Dispatch<React.SetStateAction<boolean>>;
  setZoneCode: React.Dispatch<React.SetStateAction<string | null>>;
  setZoneName: React.Dispatch<React.SetStateAction<string | null>>;
  setCadastreHint: React.Dispatch<React.SetStateAction<string | null>>;
  setDuplicates: React.Dispatch<React.SetStateAction<DuplicateBuildingCandidate[] | null>>;
  setAcknowledgedDuplicates: React.Dispatch<React.SetStateAction<boolean>>;
  setParcelFromMap: React.Dispatch<React.SetStateAction<boolean>>;
  setSuffix: React.Dispatch<React.SetStateAction<string>>;
  setResolving: React.Dispatch<React.SetStateAction<boolean>>;
  tenant: string;
  token: string | undefined;
  editing: boolean;
  tEditor: ReturnType<typeof useTranslations<'buildingEditor'>>;
  en: boolean;
  setPin: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  pinParcelRef: React.MutableRefObject<string | null>;
  setPinError: React.Dispatch<React.SetStateAction<string | null>>;
  zoneCode: string | null;
  suffix: string;
  outline: Geometry | null;
  setParcelNumber: React.Dispatch<React.SetStateAction<string>>;
  pin: [number, number] | null;
}) {
  /**
   * The parcels the chosen sector owns — the map's «where to look» layer.
   *
   * Inverted out of `getZoneParcelIndex` rather than read from `getZone`, so
   * the sector layer and the code preview are computed from one answer: two
   * requests would be two caches, and a parcel drawn as belonging to the sector
   * while the code beside it named a different one is worse than either.
   *
   * It inherits that index's one rule — the *first* sector claiming a parcel
   * wins, matching the server's own `findFirst`. A parcel listed in two zones
   * is therefore drawn under only one of them. That is a defect in the zones,
   * not here, and it is the same parcel the derived code would name anyway.
   */
  const zoneParcelNumbers = useMemo(() => {
    if (!zoneId) return [];
    return Object.entries(zoneIndex)
      .filter(([, zone]) => zone.id === zoneId)
      .map(([parcel]) => parcel);
  }, [zoneIndex, zoneId]);

  const zoneParcelFeatures = useMemo(
    () => parcelsOf(parcelOutlines, zoneParcelNumbers),
    [parcelOutlines, zoneParcelNumbers],
  );

  const zoneFootprint = useMemo(() => footprintOf(zoneParcelFeatures), [zoneParcelFeatures]);

  /**
   * The numbers the map prints: the sector's parcels, and the resolved one
   * wherever it is.
   *
   * From the sector's membership rather than from its drawn outlines, so the
   * few parcels the tracer could not close still show their number where the
   * cadastre printed it — with no outline to tap, that number is what the
   * officer types instead. The resolved parcel is added because it is numbered
   * even when it lies outside the sector, or when there is no sector at all.
   */
  const mapParcelLabels = useMemo(
    () =>
      parcelsOf(
        parcelLabelPoints,
        resolvedParcel ? [...zoneParcelNumbers, resolvedParcel] : zoneParcelNumbers,
      ),
    [parcelLabelPoints, zoneParcelNumbers, resolvedParcel],
  );

  const selectedZone = useMemo(
    () => zones.find((zone) => zone.id === zoneId) ?? null,
    [zones, zoneId],
  );

  /** The sector this parcel actually belongs to — the authority, whatever is selected. */
  const parcelZone = trimmedParcel ? (zoneIndex[trimmedParcel] ?? null) : null;

  /*
    A building being corrected, or one reached from «إضافة مبنى على هذا العقار»,
    arrives with its parcel already known — so the sector is known too, and
    making somebody select the one their building is already in would be asking
    a question whose answer is on the screen.

    Only that parcel, though — the one the editor opened with. A parcel the
    officer *types*, or reads off the map, no longer fills the select: doing so
    moved the map out from under somebody in the middle of entering a building,
    which is a worse answer than leaving the sector blank. Nothing is lost by
    staying quiet, because the select only narrows the map (see `zoneId`) and
    the code's sector half is read off the parcel itself either way — so the
    sector that ends up on the record is identical whether this fires or not.

    Still only ever fills an empty selection. An officer who has chosen a sector
    and is typing a parcel from a different one gets the mismatch note below,
    not a silently switched map.
  */
  useEffect(() => {
    if (!parcelZone) return;
    if (trimmedParcel !== (initialParcelNumber ?? '').trim()) return;
    setZoneId((current) => current || parcelZone.id);
  }, [parcelZone, trimmedParcel, initialParcelNumber, setZoneId]);

  /**
   * The selected sector and the parcel's own sector disagree.
   *
   * Reported, never resolved. The code's zone half is derived from the parcel's
   * membership (D13) and this control cannot change that — so the officer is
   * told which sector the code will actually carry, and left to decide whether
   * the parcel is wrong or the sector was just where they started looking.
   */
  const zoneMismatch = Boolean(zoneId && parcelZone && parcelZone.id !== zoneId);

  /**
   * The shared parcels as they go on the wire: trimmed, de-duplicated, and
   * never containing the building's own عقار.
   *
   * The server applies the identical rules — it has to, since an offline
   * payload and a direct API call reach it without passing through here — so
   * this is what the officer sees rather than a second authority.
   */
  /**
   * أرقام الأقسام as they go on the wire: trimmed, de-duplicated, blanks gone —
   * and empty whenever the box is not ticked.
   *
   * The server resolves the same pairing (`partitionNumbersFor`), because an
   * offline payload and a direct API call reach it without passing through
   * here. This is what the officer sees, not a second authority.
   */
  const cleanedPartitionNumbers = useMemo(
    () => cleanPartitionNumbers(partitionNumbers, isPartitioned),
    [partitionNumbers, isPartitioned],
  );

  const cleanedSharedParcels = useMemo(
    () => cleanSharedParcels(sharedParcels, trimmedParcel),
    [sharedParcels, trimmedParcel],
  );

  // Debounced lookup on parcel change
  useEffect(() => {
    if (!trimmedParcel) {
      setOutline(null);
      setResolvedParcel(null);
      setFallbackCentre(null);
      setOutlineChecked(false);
      setZoneCode(null);
      setZoneName(null);
      setCadastreHint(null);
      setDuplicates(null);
      setAcknowledgedDuplicates(false);
      setParcelFromMap(false);
      setSuffix('A');
      return;
    }

    let cancelled = false;
    setResolving(true);

    const timer = setTimeout(() => {
      void Promise.all([
        loadParcelOutlines(tenant, token),
        token
          ? getZoneParcelIndex(tenant, token).catch(
              () => ({}) as Record<string, { code: string; name: string }>,
            )
          : Promise.resolve({} as Record<string, { code: string; name: string }>),
        /*
          Only a creation asks what else stands here. Editing a building that
          is *already* one of the structures on this parcel, the duplicate
          guard would hold the building up against itself — and the suffix it
          derives is the one this row was allocated years ago.
        */
        token && !editing
          ? getBuildings(tenant, token, { parcelNumber: trimmedParcel, limit: 100 }).catch(
              () => null,
            )
          : Promise.resolve(null),
        checkPropertyNumber(tenant, trimmedParcel).catch((caught) => {
          logApiError(caught);
          return null;
        }),
      ])
        .then(([outlines, zoneIndex, existing, check]) => {
          if (cancelled) return;

          const geometry = outlineOf(outlines, trimmedParcel);
          setOutline(geometry);
          setResolvedParcel(trimmedParcel);
          setOutlineChecked(true);

          const zone = zoneIndex[trimmedParcel];
          setZoneCode(zone?.code ?? null);
          setZoneName(zone?.name ?? null);

          if (existing) {
            /*
              The suffix comes from the buildings *filed* on this parcel only.
              The list also carries structures filed under a neighbouring parcel
              that cover this one (`sharedParcelNumbers`), and their letters
              belong to their own parcel's sequence, not this one's (D9) — the
              server allocates the same way.
            */
            setSuffix(
              nextBuildingSuffix([
                ...existing.buildings
                  .filter((row) => row.parcelNumber === trimmedParcel)
                  .map((row) => row.codeSuffix),
                // Retired by «تصحيح رقم العقار»: never given out again, so never predicted.
                ...(existing.retiredSuffixes ?? []),
              ]),
            );
            setDuplicates(
              existing.buildings.length > 0
                ? existing.buildings.map((row) => ({
                    id: row.id,
                    code: row.code,
                    name: row.name,
                    postedNumber: row.postedNumber,
                    structureType: row.structureType,
                    lifecycleStatus: row.lifecycleStatus,
                    unitsTotal: row.unitsTotal,
                    latitude: row.latitude,
                    longitude: row.longitude,
                    distanceMetres: null,
                    ownParcelNumber: row.parcelNumber,
                    sharesParcel: row.parcelNumber !== trimmedParcel,
                  }))
                : null,
            );
            if (existing.buildings.length === 0) setAcknowledgedDuplicates(false);
          }

          // `null` is a check that failed (a success is always an object): say so rather than
          // read it as «not taken, in the cadastre» (ERR-02).
          setCadastreHint(
            check === null
              ? tEditor('cadastreUnchecked')
              : check.inCadastre === false
              ? en
                ? 'This parcel number is not in the cadastre. It can still be saved — verify deed records first.'
                : 'رقم العقار غير موجود في المسح العقاري. يمكن الحفظ رغم ذلك — راجع سند الملكية أولاً.'
              : null,
          );

          setPin((current) => {
            if (current && pinParcelRef.current === trimmedParcel) return current;
            pinParcelRef.current = null;
            return null;
          });

          setFallbackCentre(
            geometry || !check?.location
              ? null
              : [check.location.longitude, check.location.latitude],
          );
          setPinError(null);
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedParcel, tenant, token, en, editing, tEditor, setResolving, setOutline, setResolvedParcel, setFallbackCentre, setOutlineChecked, setZoneCode, setZoneName, setCadastreHint, setDuplicates, setAcknowledgedDuplicates, setParcelFromMap, setSuffix, setPin, setPinError, pinParcelRef]);

  // Code preview derivation
  const codePreview = useMemo(
    () =>
      trimmedParcel
        ? formatBuildingCode({ zoneCode, parcelNumber: trimmedParcel, codeSuffix: suffix })
        : null,
    [trimmedParcel, zoneCode, suffix],
  );

  // Pin validation
  const validatePin = useCallback(
    (candidate: [number, number]): boolean | null => {
      if (!outline) return null;
      return pointInGeometry(candidate, outline);
    },
    [outline],
  );

  const applyPin = useCallback(
    (candidate: [number, number]) => {
      const verdict = validatePin(candidate);
      if (verdict === false) {
        setPinError(
          en
            ? 'That entrance point is outside this parcel. Place the entrance inside the boundary outline.'
            : 'هذه النقطة خارج حدود العقار. ضع دبوس المدخل داخل المخطط.',
        );
        return false;
      }
      setPinError(null);
      setPin(candidate);

      /*
        The parcel, read off the map — the half that makes location-first work.

        Only when the field is empty. An officer who has *named* a parcel is
        pinning a door inside it, and `validatePin` above has already refused
        anything outside its boundary; re-deriving the number there could only
        ever either agree or contradict a check that has just passed.

        A point that resolves to nothing leaves the field alone rather than
        guessing at the nearest — see `parcelAt`. About 1.4% of this cadastre
        could not be traced, and the gaps between parcels are real ground.

        `pinParcelRef` is set to whichever number now applies, and that matters:
        the debounced lookup below clears the pin whenever the parcel changes
        *unless* the ref already names the new one. Without this line, auto-filling
        the parcel would immediately delete the pin that produced it.
      */
      const resolved = trimmedParcel ? null : parcelAt(parcelOutlines, candidate);
      if (resolved) {
        pinParcelRef.current = resolved;
        setParcelNumber(resolved);
        setParcelFromMap(true);
      } else {
        pinParcelRef.current = trimmedParcel;
      }
      return true;
    },
    [validatePin, setPinError, setPin, trimmedParcel, parcelOutlines, en, pinParcelRef, setParcelNumber, setParcelFromMap],
  );

  const pinVerdict = pin ? validatePin(pin) : null;

  return {
    zoneParcelFeatures,
    zoneFootprint,
    mapParcelLabels,
    selectedZone,
    parcelZone,
    zoneMismatch,
    cleanedPartitionNumbers,
    cleanedSharedParcels,
    codePreview,
    applyPin,
    pinVerdict,
  };
}
