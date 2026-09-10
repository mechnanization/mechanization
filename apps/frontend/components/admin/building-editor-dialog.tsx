'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
// Type-only: the runtime module is imported inside the picker's effect so this
// file stays renderable on the server and the map bundle stays off the page.
import type mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  AlertTriangle,
  Building2,
  Crosshair,
  Layers3,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  BUILDING_LIFECYCLE,
  formatBuildingCode,
  getLabels,
  isOccupiableLifecycle,
  nextBuildingSuffix,
  STRUCTURE_TYPE,
  STRUCTURE_TYPE_MAP,
  UNIT_TYPE,
  UNZONED_CODE,
  type BuildingLifecycle,
  type StructureType,
  type UnitType,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  checkPropertyNumber,
  createBuilding,
  duplicateBuildingsOf,
  generateUnits,
  getBuildings,
  getZoneParcelIndex,
  logApiError,
  updateBuilding,
  type BuildingSummary,
  type DuplicateBuildingCandidate,
  type UnitBlueprintInput,
} from '@/lib/api-client';
import { geometryBounds, pointInGeometry } from '@/lib/map-geometry';
import { offlineStorageAvailable } from '@/lib/offline-db';
import { queueBuilding } from '@/lib/offline-sync';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Creating the shell before anybody has been surveyed in it.
 *
 * That inversion is the whole census (D1): a building is a row that exists
 * because a structure stands on a parcel, not because a citizen filed a card
 * about it. So this dialog asks for what somebody standing on the pavement can
 * actually see — which parcel, what kind of structure, how many floors, where
 * the entrance is — and nothing about who lives inside. The units come next, as
 * a matrix of empty flats at «غير ممسوحة», which is the state the map colours
 * and the dispatch list is built from.
 *
 * Three things here are worth reading before changing them:
 *
 *  - **The code is a preview, never an input.** `ZONE-PARCEL-SUFFIX` is derived
 *    (D9) and the suffix is allocated server-side under a lock (§4.4), because
 *    two officers on the same parcel will both compute `A`. What is shown is
 *    marked «مؤقت» and the saved building's real code is read back from the
 *    response.
 *  - **A pin outside the parcel is refused.** An entrance dot is what a
 *    collector navigates to, and one dropped on the neighbour's roof sends them
 *    to the wrong door — see `pointInGeometry`.
 *  - **The blueprint asserts that flats exist, not that anyone has been in
 *    them.** Every generated unit lands at `NOT_SURVEYED`.
 */

const FALLBACK_CENTER: [number, number] = [35.2654, 33.2539];

/** How long the parcel field rests before its four lookups fire. */
const LOOKUP_DEBOUNCE_MS = 350;

/**
 * Whether the browser believes it is offline.
 *
 * `navigator.onLine` is famously optimistic — it reports a connection to a
 * network, not to a reachable server — so this decides only whether to *try*.
 * A send that fails anyway is still caught and reported; what this avoids is
 * making an officer in a settlement wait out a timeout before their record is
 * stored.
 */
function offlineNow(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
const SATELLITE_STYLE = 'mapbox://styles/mapbox/satellite-v9';

/** Amber, the same "you chose this" colour the zone editor reserves. */
const PIN_COLOR = '#F59E0B';

export interface BuildingEditorResult {
  building: BuildingSummary;
  /** True when the server handed back a different suffix than the preview showed. */
  reconciled: boolean;
  unitsCreated: number;
  /**
   * Stored on this device rather than sent — there was no connection.
   *
   * The building in the result is the one the phone minted, code and all, and
   * its code is provisional until the queue drains (§4.4). The caller says so
   * rather than announcing a creation that has not happened yet.
   */
  queued?: boolean;
}

interface BlueprintFloor {
  /** A row key that survives reordering — `floor` itself is edited. */
  key: string;
  floor: number;
  unitCount: number;
  unitType: UnitType;
}

/**
 * The parcel outlines, fetched once per tenant and shared by every dialog open.
 *
 * A 1.2 MB asset that does not change between two openings of the same form.
 * Held as the in-flight promise rather than the resolved value so two rapid
 * opens share one request instead of racing two.
 */
const outlineCache = new Map<string, Promise<FeatureCollection | null>>();

function loadParcelOutlines(tenant: string): Promise<FeatureCollection | null> {
  const cached = outlineCache.get(tenant);
  if (cached) return cached;

  const slug = encodeURIComponent(tenant);
  const apiBase = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/t/${slug}/cadastre/assets`;

  const request = (async (): Promise<FeatureCollection | null> => {
    for (const url of [`/tenants/${slug}/parcel-polygons.geojson`, `${apiBase}/parcel-polygons.geojson`]) {
      try {
        const response = await fetch(url);
        if (response.ok) return (await response.json()) as FeatureCollection;
      } catch {
        // Try the next source; a missing static asset is not an error worth
        // surfacing while the API still serves the same file.
      }
    }
    return null;
  })();

  outlineCache.set(tenant, request);
  return request;
}

function outlineOf(collection: FeatureCollection | null, parcelNumber: string): Geometry | null {
  if (!collection || !parcelNumber) return null;
  const wanted = parcelNumber.trim();
  const feature = collection.features.find(
    (candidate: Feature) => String(candidate.properties?.parcelNumber ?? '').trim() === wanted,
  );
  return feature?.geometry ?? null;
}

export function BuildingEditorDialog({
  open,
  onOpenChange,
  tenant,
  token,
  building,
  /** Pre-fills the parcel when opened from a map click or a parcel drawer. */
  initialParcelNumber,
  onSaved,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  /** The building being corrected, or null to create a new one. */
  building?: BuildingSummary | null;
  initialParcelNumber?: string;
  onSaved: (result: BuildingEditorResult) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const editing = Boolean(building);

  const [parcelNumber, setParcelNumber] = useState('');
  const [name, setName] = useState('');
  const [postedNumber, setPostedNumber] = useState('');
  const [structureType, setStructureType] = useState<StructureType>('RESIDENTIAL_BUILDING');
  const [floorsCount, setFloorsCount] = useState('1');
  const [notes, setNotes] = useState('');
  const [pin, setPin] = useState<[number, number] | null>(null);
  /**
   * Which parcel the pin on screen belongs to.
   *
   * A pin is a doorway on a specific plot. Correct the parcel number from 1042
   * to 1043 and the dot left behind is not a partial answer — it is the
   * neighbour's entrance, and it would be saved as this building's.
   */
  const pinParcelRef = useRef<string | null>(null);

  /** Off for a correction: an existing matrix is edited from its own drawer. */
  const [withBlueprint, setWithBlueprint] = useState(true);
  const [blueprintKind, setBlueprintKind] = useState<'uniform' | 'explicit'>('uniform');
  const [fromFloor, setFromFloor] = useState('0');
  const [toFloor, setToFloor] = useState('2');
  const [unitsPerFloor, setUnitsPerFloor] = useState('2');
  const [unitType, setUnitType] = useState<UnitType>('APARTMENT');
  const [floors, setFloors] = useState<BlueprintFloor[]>([]);

  const [zoneCode, setZoneCode] = useState<string | null>(null);
  const [zoneName, setZoneName] = useState<string | null>(null);
  const [suffix, setSuffix] = useState('A');
  const [lifecycleStatus, setLifecycleStatus] = useState<BuildingLifecycle>('IN_USE');
  /**
   * The structures already standing on this parcel, when the server has
   * refused a creation because of them.
   *
   * Held rather than merely displayed: the officer's answer to «هل هذه منشأة
   * مختلفة؟» is what unlocks the retry, and the list is what makes that answer
   * an informed one. Cleared whenever the parcel changes, since the question
   * was about the old parcel.
   */
  const [duplicates, setDuplicates] = useState<DuplicateBuildingCandidate[] | null>(null);
  const [acknowledgedDuplicates, setAcknowledgedDuplicates] = useState(false);
  const [outline, setOutline] = useState<Geometry | null>(null);
  /**
   * Where to centre the picker when the parcel has no traced outline.
   *
   * Deliberately not a pin. The ~1.4% of parcels `parcel-geometry.ts` cannot
   * close have nothing to frame, and a map showing open sea is worse than one
   * pointed at roughly the right place — but pointing a camera is not the same
   * act as asserting where a building's door is, and the two used to share a
   * variable.
   */
  const [fallbackCentre, setFallbackCentre] = useState<[number, number] | null>(null);
  const [outlineChecked, setOutlineChecked] = useState(false);
  const [cadastreHint, setCadastreHint] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pinError, setPinError] = useState<string | null>(null);

  // ── Reset on open ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setParcelNumber(building?.parcelNumber ?? initialParcelNumber ?? '');
    setName(building?.name ?? '');
    setPostedNumber(building?.postedNumber ?? '');
    setStructureType((building?.structureType as StructureType) ?? 'RESIDENTIAL_BUILDING');
    setFloorsCount(String(building?.floorsCount ?? 1));
    setNotes(building?.notes ?? '');
    setPin(
      building?.latitude != null && building?.longitude != null
        ? [building.longitude, building.latitude]
        : null,
    );
    pinParcelRef.current = building?.parcelNumber ?? initialParcelNumber ?? null;
    /*
      Offered when there is no matrix to offer it against.

      A new building obviously has none. An existing one with `unitsTotal === 0`
      is the same situation arrived at differently — a shell created from a desk,
      or one whose drawer sent the officer here precisely because it was empty —
      and landing them on a form with the generator switched off would answer the
      button they just pressed with nothing. A building that already has a matrix
      does not get it: those units are corrected one at a time from the drawer,
      where the officer can see what they are changing.
    */
    setWithBlueprint(!building || building.unitsTotal === 0);
    setBlueprintKind('uniform');
    setFromFloor('0');
    setToFloor('2');
    setUnitsPerFloor('2');
    setFloors([]);
    setSuffix(building?.codeSuffix ?? 'A');
    setLifecycleStatus((building?.lifecycleStatus as BuildingLifecycle) ?? 'IN_USE');
    setDuplicates(null);
    setAcknowledgedDuplicates(false);
    setZoneCode(null);
    setZoneName(null);
    setOutline(null);
    setFallbackCentre(null);
    setOutlineChecked(false);
    setCadastreHint(null);
    setError(null);
    setFieldErrors({});
    setPinError(null);
  }, [open, building, initialParcelNumber]);

  /**
   * A structure type carries a default unit type (§3.6) — a مجمع تجاري fills
   * with محلات, not flats. A default, never a constraint: changing the type
   * re-suggests, and the officer can still say otherwise per floor.
   */
  useEffect(() => {
    setUnitType(STRUCTURE_TYPE_MAP[structureType].defaultUnitType);
  }, [structureType]);

  // ── Resolve everything that hangs off the parcel number ───────────
  const trimmedParcel = parcelNumber.trim();

  useEffect(() => {
    if (!open || !trimmedParcel) {
      setOutline(null);
      setFallbackCentre(null);
      setOutlineChecked(false);
      setZoneCode(null);
      setZoneName(null);
      setCadastreHint(null);
      return;
    }

    let cancelled = false;
    setResolving(true);

    /*
      Four questions about one parcel, asked together — and only once the typing
      stops.

      The outline draws the map and decides whether a pin is acceptable; the
      zone supplies the first third of the code; the existing buildings supply
      the suffix preview; the cadastre check supplies a starting position when
      the parcel has no traced outline. Sequencing them would put four network
      round trips between typing a parcel number and seeing a code.

      The delay is what stops «1042» from being four sets of those, three of
      them about parcels 1, 10 and 104 — each a real lookup whose answer would
      briefly paint a code and a boundary for the wrong plot.
    */
    const timer = setTimeout(() => {
      void Promise.all([
        loadParcelOutlines(tenant),
        getZoneParcelIndex(tenant, token).catch(
          () => ({}) as Record<string, { code: string; name: string }>,
        ),
        editing
          ? Promise.resolve(null)
          : getBuildings(tenant, token, { parcelNumber: trimmedParcel, limit: 100 }).catch(
              () => null,
            ),
        checkPropertyNumber(tenant, trimmedParcel).catch(() => null),
      ])
        .then(([outlines, zoneIndex, existing, check]) => {
          if (cancelled) return;

          const geometry = outlineOf(outlines, trimmedParcel);
          setOutline(geometry);
          setOutlineChecked(true);

          const zone = zoneIndex[trimmedParcel];
          setZoneCode(zone?.code ?? null);
          setZoneName(zone?.name ?? null);

          if (existing) {
            setSuffix(nextBuildingSuffix(existing.buildings.map((row) => row.codeSuffix)));
            /*
              What is already here, shown before the officer saves rather than
              after the server refuses.

              Same list the guard uses; asking early just means the question
              arrives while they are still looking at the parcel rather than as
              a rejection of a form they had finished filling in.
            */
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
                  }))
                : null,
            );
            if (existing.buildings.length === 0) setAcknowledgedDuplicates(false);
          }

          setCadastreHint(
            check && check.inCadastre === false
              ? en
                ? 'This parcel number is not in the cadastre. It can still be saved — check the deed first.'
                : 'رقم العقار غير موجود في المسح العقاري. يمكن الحفظ رغم ذلك — راجع سند الملكية أولاً.'
              : null,
          );

          /*
            The entrance is placed by a person, never guessed from the parcel.

            This used to auto-fill the parcel's centroid, and that one line is
            what put every household in the municipality on the wrong dot:

              * The centroid is the middle of the *plot*. No building stands
                there, so a pin at it is a coordinate nobody can navigate to —
                and `Building.latitude` is documented as "the entrance, not the
                centroid" precisely because the difference is the whole point.
              * Offered to every building on a parcel it produced *byte-identical*
                coordinates for all of them. Three blocks then drew as one dot
                at every zoom, which no clustering rule can separate because
                they are not near each other, they are equal.
              * And it was indistinguishable from a placed pin. A guess stored
                in the same column as a surveyed fact is a guess nobody can find
                again to correct.

            A building may still be created from a desk with no pin at all —
            `latitude`/`longitude` are nullable and the offline flow depends on
            it. Such a building simply has no dot of its own, and its households
            are drawn on the parcel-level marker instead, which is the honest
            rendering of "nobody has located this yet".

            A pin somebody placed survives, but only while it still belongs to
            this parcel: see `pinParcelRef`.
          */
          setPin((current) => {
            if (current && pinParcelRef.current === trimmedParcel) return current;
            pinParcelRef.current = null;
            return null;
          });

          /*
            Where to *point the map*, which is a different question.

            With an outline the picker fits the parcel's own bounds and needs
            nothing from here. Without one — the ~1.4% of parcels the tracer
            could not close — there is nothing to frame, so the cadastre's point
            is used to centre the view. Framing, not placing: no marker is
            created and nothing is saved from it.
          */
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
  }, [open, trimmedParcel, tenant, token, editing, en]);

  /** The code as it will read — «مؤقت» until the server allocates for real. */
  const codePreview = useMemo(
    () =>
      trimmedParcel
        ? formatBuildingCode({ zoneCode, parcelNumber: trimmedParcel, codeSuffix: suffix })
        : null,
    [trimmedParcel, zoneCode, suffix],
  );

  /**
   * Whether a pin may be placed here at all.
   *
   * A parcel with no traced outline — about 1.4% of this cadastre, the faces
   * the tracer could not close — returns `null` rather than `false`. That is
   * "unverifiable", not "outside": refusing every building on those parcels
   * would make them permanently uncensusable over a gap in the geometry.
   */
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
            ? 'That point is outside this parcel. Place the entrance inside the outline.'
            : 'هذه النقطة خارج حدود العقار. ضع دبوس المدخل داخل المخطط.',
        );
        return false;
      }
      setPinError(null);
      setPin(candidate);
      pinParcelRef.current = trimmedParcel;
      return true;
    },
    [validatePin, en, trimmedParcel],
  );

  const pinVerdict = pin ? validatePin(pin) : null;

  // ── Blueprint ─────────────────────────────────────────────────────
  const blueprint = useMemo<UnitBlueprintInput | null>(() => {
    if (!withBlueprint) return null;
    if (blueprintKind === 'uniform') {
      const from = Number(fromFloor);
      const to = Number(toFloor);
      const per = Number(unitsPerFloor);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(per)) return null;
      if (to < from || per < 1) return null;
      return { kind: 'uniform', fromFloor: from, toFloor: to, unitsPerFloor: per, unitType };
    }
    if (floors.length === 0) return null;
    return {
      kind: 'explicit',
      floors: floors.map((row) => ({
        floor: row.floor,
        unitCount: row.unitCount,
        unitType: row.unitType,
      })),
    };
  }, [withBlueprint, blueprintKind, fromFloor, toFloor, unitsPerFloor, unitType, floors]);

  /** What the blueprint will actually produce, shown before it is committed. */
  const plannedUnits = useMemo(() => {
    if (!blueprint) return 0;
    if (blueprint.kind === 'uniform') {
      return (blueprint.toFloor - blueprint.fromFloor + 1) * blueprint.unitsPerFloor;
    }
    return blueprint.floors.reduce((sum, row) => sum + row.unitCount, 0);
  }, [blueprint]);

  /**
   * A duplicate floor is an editing slip the server refuses outright, so it is
   * caught here — at the row that carries it, while the officer is looking at
   * both of them.
   */
  const duplicateFloors = useMemo(() => {
    const seen = new Set<number>();
    const repeated = new Set<number>();
    for (const row of floors) {
      if (seen.has(row.floor)) repeated.add(row.floor);
      seen.add(row.floor);
    }
    return repeated;
  }, [floors]);

  const addFloorRow = () => {
    const next = floors.length === 0 ? 0 : Math.max(...floors.map((row) => row.floor)) + 1;
    setFloors((prev) => [
      ...prev,
      { key: `${Date.now()}-${prev.length}`, floor: next, unitCount: 2, unitType },
    ]);
  };

  const setFloorRow = (key: string, patch: Partial<BlueprintFloor>) =>
    setFloors((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  // ── Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!trimmedParcel) {
      setFieldErrors({ parcelNumber: en ? 'Parcel number is required' : 'رقم العقار مطلوب' });
      return;
    }
    if (pin && pinVerdict === false) {
      setPinError(
        en
          ? 'The entrance pin is outside the parcel. Move it or clear it before saving.'
          : 'دبوس المدخل خارج حدود العقار. حرّكه أو احذفه قبل الحفظ.',
      );
      return;
    }
    if (blueprintKind === 'explicit' && withBlueprint && duplicateFloors.size > 0) {
      setError(en ? 'A floor is listed more than once.' : 'هناك طابق مذكور أكثر من مرة.');
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      let saved: BuildingSummary;
      let reconciled = false;

      /*
        No connection: the creation is stored on this device and delivered later
        (§4.4, P3-T8).

        Only a *creation*. An edit needs the row it is editing, which by
        definition already exists on the server — queueing one would be a patch
        against a version this device cannot see, and the officer is better told
        plainly that the correction has to wait.
      */
      if (!building && offlineNow() && offlineStorageAvailable()) {
        const provisionalId = await queueBuilding({
          tenant,
          parcelNumber: trimmedParcel,
          provisionalCode: codePreview ?? trimmedParcel,
          provisionalSuffix: suffix,
          payload: {
            parcelNumber: trimmedParcel,
            name: name.trim() || undefined,
            postedNumber: postedNumber.trim() || undefined,
            structureType,
            lifecycleStatus,
            latitude: pin ? pin[1] : undefined,
            longitude: pin ? pin[0] : undefined,
            floorsCount: Number(floorsCount) || 1,
            notes: notes.trim() || undefined,
            /*
              The phone showed the officer what else is on this parcel before
              it queued this, so the question has already been put and
              answered. Without the flag the server would refuse the creation
              on delivery — hours later, with nobody at the screen to answer.
            */
            acknowledgedDuplicates: true,
          },
          blueprint,
        });

        onSaved({
          building: {
            // The id the phone minted is the id the row will have, so the rest
            // of the app can reference it before it has been delivered.
            id: provisionalId,
            parcelNumber: trimmedParcel,
            codeSuffix: suffix,
            code: codePreview ?? '',
            name: name.trim() || null,
            postedNumber: postedNumber.trim() || null,
            structureType,
            lifecycleStatus,
            latitude: pin ? pin[1] : null,
            longitude: pin ? pin[0] : null,
            floorsCount: Number(floorsCount) || 1,
            unitsTotal: 0,
            unitsSurveyed: 0,
            notes: notes.trim() || null,
            createdById: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          reconciled: false,
          unitsCreated: 0,
          queued: true,
        });
        onOpenChange(false);
        return;
      }

      if (building) {
        saved = await updateBuilding(tenant, token, building.id, {
          name: name.trim() || null,
          postedNumber: postedNumber.trim() || null,
          structureType,
          lifecycleStatus,
          latitude: pin ? pin[1] : null,
          longitude: pin ? pin[0] : null,
          floorsCount: Number(floorsCount) || 1,
          notes: notes.trim() || null,
        });
      } else {
        const response = await createBuilding(tenant, token, {
          parcelNumber: trimmedParcel,
          name: name.trim() || undefined,
          postedNumber: postedNumber.trim() || undefined,
          structureType,
          lifecycleStatus,
          latitude: pin ? pin[1] : undefined,
          longitude: pin ? pin[0] : undefined,
          floorsCount: Number(floorsCount) || 1,
          notes: notes.trim() || undefined,
          // The preview the officer has been looking at. The server re-allocates
          // under its lock and tells us whether what they read still holds.
          provisionalSuffix: suffix,
          /*
            Only ever true because a person ticked the box below, having been
            shown what already stands on this parcel. Defaulting it would turn
            the duplicate guard into a line of dead code with a comment.
          */
          acknowledgedDuplicates: acknowledgedDuplicates || undefined,
        });
        saved = response.building;
        // The server's own verdict, not a second copy of the rule: it compared
        // `provisionalSuffix` against what it actually allocated, under the lock
        // that decided it.
        reconciled = response.reconciled;
      }

      /*
        The matrix is filled after the shell exists, and a failure here does not
        undo the shell. That is deliberate: the building is the row the map and
        the ledger need, and losing it because a blueprint was mistyped would
        cost the officer the whole visit. The matrix can be filled again from
        its own drawer, and `generateUnits` is idempotent per floor.
      */
      let unitsCreated = 0;
      if (blueprint) {
        const generated = await generateUnits(tenant, token, saved.id, blueprint);
        unitsCreated = generated.created;
      }

      onSaved({ building: saved, reconciled, unitsCreated });
      onOpenChange(false);
    } catch (caught) {
      logApiError(caught);

      /*
        The duplicate guard, answered with what it collided with.

        Not an error to correct — nothing on the form is wrong — so it replaces
        the candidate list with the server's own (which carries distances the
        client could not compute) and leaves everything the officer typed in
        place. Ticking the box and pressing save again is the whole recovery.
      */
      const candidates = duplicateBuildingsOf(caught);
      if (candidates) {
        setDuplicates(candidates);
        setAcknowledgedDuplicates(false);
        setError((caught as ApiRequestError).payload.message);
        return;
      }

      if (caught instanceof ApiRequestError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.payload.message);
      } else {
        setError(en ? 'Could not save the building.' : 'تعذّر حفظ المبنى.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={en ? 'Close' : 'إغلاق'}
        className="max-w-3xl lg:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers3 className="size-5 text-primary" aria-hidden />
            {editing
              ? en
                ? 'Edit Building'
                : 'تعديل المبنى'
              : en
                ? 'New Building'
                : 'مبنى جديد'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'Record the structure first — the units inside it are surveyed afterwards.'
              : 'سجّل المنشأة أولاً — أما الوحدات داخلها فتُمسح لاحقاً.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* ── The record ─────────────────────────────────────────── */}
          <Section icon={Building2} title={en ? 'The structure' : 'المنشأة'}>
            <Field
              label={en ? 'Parcel Number (رقم العقار)' : 'رقم العقار'}
              htmlFor="building-parcel"
              required
              error={fieldErrors.parcelNumber}
              hint={
                editing
                  ? en
                    ? 'A building cannot be moved between parcels — its code is derived from this one.'
                    : 'لا يمكن نقل المبنى بين العقارات — رمزه مشتق من هذا الرقم.'
                  : undefined
              }
            >
              <Input
                id="building-parcel"
                value={parcelNumber}
                onChange={(event) => setParcelNumber(event.target.value)}
                disabled={editing}
                dir="ltr"
                className="text-start"
                placeholder="1042"
                inputMode="numeric"
              />
            </Field>

            {/* The code, as a statement of what it will be — never an input. */}
            <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {en ? 'Building code' : 'رمز المبنى'}
                </p>
                {resolving ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                ) : editing ? null : (
                  <Badge variant="soft-warning">{en ? 'Provisional' : 'مؤقت'}</Badge>
                )}
              </div>
              <p
                className="break-all font-mono text-lg font-bold leading-tight tracking-tight"
                dir="ltr"
              >
                {editing ? building?.code : (codePreview ?? '—')}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {zoneName
                  ? en
                    ? `Sector ${zoneCode} — ${zoneName}`
                    : `القطاع ${zoneCode} — ${zoneName}`
                  : trimmedParcel
                    ? en
                      ? `This parcel is in no sector yet, so the code starts with ${UNZONED_CODE}.`
                      : `هذا العقار غير مضاف إلى أي قطاع بعد، لذلك يبدأ الرمز بـ ${UNZONED_CODE}.`
                    : en
                      ? 'Enter a parcel number to see the code.'
                      : 'أدخل رقم العقار لعرض الرمز.'}
              </p>
              {!editing && trimmedParcel ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {en
                    ? 'The final suffix is allocated on save — two officers on one parcel cannot both be A.'
                    : 'يُخصَّص الحرف النهائي عند الحفظ — لا يمكن أن يحصل موظفان على الحرف نفسه في العقار ذاته.'}
                </p>
              ) : null}
            </div>

            {cadastreHint ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {cadastreHint}
              </p>
            ) : null}

            <Field
              label={en ? 'Structure Type' : 'نوع المنشأة'}
              htmlFor="building-structure-type"
              required
              error={fieldErrors.structureType}
            >
              <Select
                value={structureType}
                onValueChange={(value) => setStructureType(value as StructureType)}
              >
                <SelectTrigger id="building-structure-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRUCTURE_TYPE.map((type) => (
                    <SelectItem key={type} value={type}>
                      {labels.structureType[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label={en ? 'Construction Status' : 'الحالة الإنشائية'}
              htmlFor="building-lifecycle"
              required
              error={fieldErrors.lifecycleStatus}
              /*
                The third axis, and the one an officer previously had to lie
                about. A poured foundation is not a `RESIDENTIAL_BUILDING` with
                a matrix nobody can survey, and it is not damage either (D5).
              */
              hint={
                isOccupiableLifecycle(lifecycleStatus)
                  ? en
                    ? 'Its units count towards the survey figures.'
                    : 'تُحتسب وحداته ضمن أرقام المسح.'
                  : en
                    ? 'Nobody can live here yet, so its units are left out of the survey figures.'
                    : 'لا يمكن السكن فيه، لذا تُستثنى وحداته من أرقام المسح.'
              }
            >
              <Select
                value={lifecycleStatus}
                onValueChange={(value) => setLifecycleStatus(value as BuildingLifecycle)}
              >
                <SelectTrigger id="building-lifecycle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUILDING_LIFECYCLE.map((status) => (
                    <SelectItem key={status} value={status}>
                      {labels.buildingLifecycle[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* ── What is already standing here (P5-T3) ─────────────── */}
            {!editing && duplicates && duplicates.length > 0 ? (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                <p className="flex items-start gap-2 text-xs font-medium leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {en
                    ? `${duplicates.length === 1 ? 'A structure is' : `${duplicates.length} structures are`} already recorded on parcel ${trimmedParcel}.`
                    : `${duplicates.length === 1 ? 'توجد منشأة مسجَّلة' : `توجد ${duplicates.length} منشآت مسجَّلة`} على العقار ${trimmedParcel}.`}
                </p>

                <ul className="space-y-1">
                  {duplicates.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span dir="ltr" className="font-mono font-semibold">
                        {row.code}
                      </span>
                      {row.name ? <span>{row.name}</span> : null}
                      <span className="text-muted-foreground">
                        {labels.structureType[row.structureType]}
                      </span>
                      {row.postedNumber ? (
                        <span className="text-muted-foreground">
                          {en ? 'posted' : 'الرقم المكتوب'} <span dir="ltr">{row.postedNumber}</span>
                        </span>
                      ) : null}
                      <span className="text-muted-foreground">
                        {en ? `${row.unitsTotal} units` : `${row.unitsTotal} وحدة`}
                      </span>
                      {/*
                        Only where both pins exist. A missing distance is left
                        unsaid rather than rendered as zero — "we cannot tell"
                        and "they are in the same place" are opposite findings,
                        and the second would talk an officer out of recording a
                        building that really is there.
                      */}
                      {row.distanceMetres != null ? (
                        <span className="text-muted-foreground">
                          {en ? `~${row.distanceMetres} m away` : `على بعد ~${row.distanceMetres} م`}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>

                <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed">
                  <Checkbox
                    checked={acknowledgedDuplicates}
                    onCheckedChange={(checked) => setAcknowledgedDuplicates(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    {en
                      ? 'I have checked, and this is a different structure from the ones above.'
                      : 'تحقَّقت، وهذه منشأة مختلفة عن المذكورة أعلاه.'}
                  </span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
              <Field
                label={en ? 'Building Name' : 'اسم المبنى'}
                htmlFor="building-name"
                error={fieldErrors.name}
                hint={en ? 'What residents call it' : 'ما يسميه السكان'}
              >
                <Input
                  id="building-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={en ? 'Al-Nour Building' : 'بناية النور'}
                />
              </Field>

              <Field
                label={en ? 'Posted Number' : 'الرقم المكتوب على المبنى'}
                htmlFor="building-posted"
                error={fieldErrors.postedNumber}
                hint={
                  en
                    ? 'Trusted over our code in the field'
                    : 'يُعتمد عليه ميدانياً قبل رمزنا'
                }
              >
                <Input
                  id="building-posted"
                  value={postedNumber}
                  onChange={(event) => setPostedNumber(event.target.value)}
                  dir="ltr"
                  className="text-start"
                  placeholder="12"
                />
              </Field>
            </div>

            <Field
              label={en ? 'Floors' : 'عدد الطوابق'}
              htmlFor="building-floors"
              required
              error={fieldErrors.floorsCount}
            >
              <Input
                id="building-floors"
                type="number"
                min={1}
                max={100}
                value={floorsCount}
                onChange={(event) => setFloorsCount(event.target.value)}
                dir="ltr"
                className="text-start"
              />
            </Field>

            <Field
              label={en ? 'Notes' : 'ملاحظات'}
              htmlFor="building-notes"
              error={fieldErrors.notes}
            >
              <Textarea
                id="building-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={
                  en ? 'Anything the next visit should know' : 'ما ينبغي أن تعرفه الزيارة القادمة'
                }
              />
            </Field>
          </Section>

          {/* ── The pin ────────────────────────────────────────────── */}
          {/*
            Kept in view while the rest of the form is filled: on a wide screen
            the record column runs to roughly twice the height of this one, and
            a pin placed against an outline the officer can no longer see is a
            pin placed from memory.
          */}
          <Section
            icon={MapPin}
            title={en ? 'Entrance location' : 'موقع المدخل'}
            className="lg:sticky lg:top-2"
            action={
              pin ? (
                <button
                  type="button"
                  onClick={() => {
                    setPin(null);
                    pinParcelRef.current = null;
                    setPinError(null);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  {en ? 'Clear pin' : 'حذف الدبوس'}
                </button>
              ) : null
            }
          >
            <ParcelPinPicker
              outline={outline}
              outlineChecked={outlineChecked}
              fallbackCentre={fallbackCentre}
              pin={pin}
              onPick={applyPin}
              locale={locale}
            />

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {en
                ? 'Tap inside the parcel to place the entrance — the dot a collector navigates to, not the centre of the roof. Optional: a building may be created from a desk.'
                : 'انقر داخل حدود العقار لتحديد المدخل — النقطة التي يقصدها المحصّل، لا مركز السطح. اختياري: يمكن إنشاء المبنى من المكتب.'}
            </p>

            {/*
              Why nothing was placed for them, and what it costs to skip it.

              The dialog used to arrive with the parcel's centroid already
              pinned, so an officer never had to think about this — and every
              building on the parcel inherited the same coordinate, which is
              what drew a town's worth of households onto one dot per plot.
              With the guess gone, an empty map needs a sentence or it reads as
              a feature that failed to load.
            */}
            {!pin ? (
              <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {en
                  ? 'No entrance recorded yet. Nothing is placed for you, because the middle of the parcel is not where any building stands — and two structures sharing that point draw as one dot. Saving without it is allowed: this building will have no pin of its own on the map, and its residents will show on the parcel instead.'
                  : 'لم يُسجَّل مدخل بعد. لا يوضَع الموقع تلقائياً لأن مركز العقار ليس مكان أي مبنى — ووضع النقطة نفسها لمنشأتين يجعلهما نقطة واحدة. يمكن الحفظ بدونه: عندها لن يكون لهذا المبنى نقطة خاصة على الخريطة، وسيظهر سكانه على العقار بدلاً من ذلك.'}
              </p>
            ) : null}

            {pinError ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {pinError}
              </p>
            ) : null}

            {pin ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" aria-hidden />
                  <span dir="ltr" className="font-mono">
                    {pin[1].toFixed(6)}, {pin[0].toFixed(6)}
                  </span>
                </span>
                {pinVerdict === null && outlineChecked ? (
                  <Badge variant="soft-muted">
                    {en ? 'No outline on file' : 'لا يوجد مخطط لهذا العقار'}
                  </Badge>
                ) : null}
              </p>
            ) : null}
          </Section>
        </div>

        {/* ── The matrix blueprint ─────────────────────────────────── */}
        <Section icon={Layers3} title={en ? 'Unit matrix' : 'مصفوفة الوحدات'}>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-muted/40 p-2.5 transition-colors hover:bg-muted/60">
            <input
              type="checkbox"
              checked={withBlueprint}
              onChange={(event) => setWithBlueprint(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {en ? 'Generate the unit matrix now' : 'توليد مصفوفة الوحدات الآن'}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {en
                  ? 'Creates the flats as rows at «not surveyed». It asserts that they exist, not that anyone has been inside.'
                  : 'ينشئ الوحدات كسجلات بحالة «غير ممسوحة». هذا إثبات بوجودها، لا بأن أحداً دخلها.'}
              </span>
            </span>
          </label>

          {withBlueprint ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2" role="group">
                {(['uniform', 'explicit'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setBlueprintKind(kind)}
                    aria-pressed={blueprintKind === kind}
                    className={cn(
                      // Full-width halves on a phone, where these are the two
                      // thumb targets that decide the shape of the rest of the
                      // section; intrinsic width once there is room for it.
                      'min-w-0 flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors sm:flex-none',
                      blueprintKind === kind
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-accent',
                    )}
                  >
                    {kind === 'uniform'
                      ? en
                        ? 'Same on every floor'
                        : 'متطابق في كل الطوابق'
                      : en
                        ? 'Floor by floor'
                        : 'طابقاً بطابق'}
                  </button>
                ))}
              </div>

              {blueprintKind === 'uniform' ? (
                /*
                  Two by two on a phone rather than four in a row: at 360px a
                  four-up row leaves each number input about 60px wide, which
                  is narrower than the value «100» it has to hold.
                */
                <div className="grid grid-cols-2 gap-3 sm:items-end lg:grid-cols-4">
                  <Field
                    label={en ? 'From floor' : 'من الطابق'}
                    htmlFor="blueprint-from"
                    required
                    hint={en ? 'Ground = 0' : 'الأرضي = 0'}
                  >
                    <Input
                      id="blueprint-from"
                      type="number"
                      min={-10}
                      max={100}
                      value={fromFloor}
                      onChange={(event) => setFromFloor(event.target.value)}
                      dir="ltr"
                      className="text-start"
                    />
                  </Field>
                  <Field label={en ? 'To floor' : 'إلى الطابق'} htmlFor="blueprint-to" required>
                    <Input
                      id="blueprint-to"
                      type="number"
                      min={-10}
                      max={100}
                      value={toFloor}
                      onChange={(event) => setToFloor(event.target.value)}
                      dir="ltr"
                      className="text-start"
                    />
                  </Field>
                  <Field
                    label={en ? 'Units per floor' : 'وحدات لكل طابق'}
                    htmlFor="blueprint-per"
                    required
                  >
                    <Input
                      id="blueprint-per"
                      type="number"
                      min={1}
                      max={20}
                      value={unitsPerFloor}
                      onChange={(event) => setUnitsPerFloor(event.target.value)}
                      dir="ltr"
                      className="text-start"
                    />
                  </Field>
                  <Field label={en ? 'Unit type' : 'نوع الوحدة'} htmlFor="blueprint-type" required>
                    <Select value={unitType} onValueChange={(value) => setUnitType(value as UnitType)}>
                      <SelectTrigger id="blueprint-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UNIT_TYPE.map((type) => (
                          <SelectItem key={type} value={type}>
                            {labels.unitType[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              ) : (
                <div className="space-y-2">
                  {floors.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">
                      {en
                        ? 'No floors listed yet — add the ones you walked.'
                        : 'لم تُضف أي طوابق بعد — أضف ما عاينته منها.'}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {floors.map((row) => (
                        <li
                          key={row.key}
                          className="grid grid-cols-2 gap-2.5 rounded-lg border bg-muted/20 p-2.5 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end"
                        >
                          <Field label={en ? 'Floor' : 'الطابق'} htmlFor={`floor-${row.key}`} required>
                            <Input
                              id={`floor-${row.key}`}
                              type="number"
                              min={-10}
                              max={100}
                              value={row.floor}
                              onChange={(event) =>
                                setFloorRow(row.key, { floor: Number(event.target.value) })
                              }
                              dir="ltr"
                              className={cn(
                                'text-start',
                                duplicateFloors.has(row.floor) && 'border-destructive',
                              )}
                            />
                          </Field>
                          <Field label={en ? 'Units' : 'وحدات'} htmlFor={`count-${row.key}`} required>
                            <Input
                              id={`count-${row.key}`}
                              type="number"
                              min={1}
                              max={20}
                              value={row.unitCount}
                              onChange={(event) =>
                                setFloorRow(row.key, { unitCount: Number(event.target.value) })
                              }
                              dir="ltr"
                              className="text-start"
                            />
                          </Field>
                          <div className="col-span-2 sm:col-span-1">
                            <Field label={en ? 'Type' : 'النوع'} htmlFor={`type-${row.key}`} required>
                              <Select
                                value={row.unitType}
                                onValueChange={(value) =>
                                  setFloorRow(row.key, { unitType: value as UnitType })
                                }
                              >
                                <SelectTrigger id={`type-${row.key}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {UNIT_TYPE.map((type) => (
                                    <SelectItem key={type} value={type}>
                                      {labels.unitType[type]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          </div>
                          {/*
                            A labelled full-width control on a phone and a bare
                            icon once the row is four-up: an unlabelled 36px
                            icon at the end of a stack of number inputs is not
                            recognisably «delete this floor» on a touch screen.
                          */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="col-span-2 w-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:col-span-1 sm:w-9 sm:px-0"
                            aria-label={en ? `Remove floor ${row.floor}` : `حذف الطابق ${row.floor}`}
                            onClick={() =>
                              setFloors((prev) => prev.filter((entry) => entry.key !== row.key))
                            }
                          >
                            <Trash2 className="size-4" aria-hidden />
                            <span className="sm:hidden">
                              {en ? 'Remove floor' : 'حذف الطابق'}
                            </span>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addFloorRow}
                    className="w-full sm:w-auto"
                  >
                    <Plus className="size-4" aria-hidden />
                    {en ? 'Add floor' : 'إضافة طابق'}
                  </Button>

                  {duplicateFloors.size > 0 ? (
                    <p role="alert" className="text-xs text-destructive">
                      {en
                        ? 'A floor is listed more than once.'
                        : 'هناك طابق مذكور أكثر من مرة.'}
                    </p>
                  ) : null}
                </div>
              )}

              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {plannedUnits > 0 ? (
                  <>
                    <strong className="text-foreground">{plannedUnits}</strong>{' '}
                    {en ? 'units will be created.' : 'وحدة ستُنشأ.'}
                  </>
                ) : en ? (
                  'Nothing to generate yet.'
                ) : (
                  'لا شيء لتوليده بعد.'
                )}
              </p>
            </div>
          ) : null}
        </Section>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {/*
          Pinned to the bottom of the panel rather than sitting at the end of
          it. On a phone this form is some three screens long, and «حفظ» at the
          foot of the third is a button an officer has to go looking for after
          every correction they make near the top.
        */}
        <DialogFooter className="sticky bottom-0 -mx-4 -mb-4 gap-2 border-t bg-background px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6 sm:py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="w-full sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void handleSave()}
            /*
              The duplicate question is answered here rather than by the server
              bouncing the save. The guard is enforced server-side regardless —
              an offline queue delivers straight to it — but making the officer
              press save to discover a question they can already see would waste
              a round trip and read as a failure rather than a prompt.
            */
            disabled={
              saving ||
              !trimmedParcel ||
              (!editing && Boolean(duplicates?.length) && !acknowledgedDuplicates)
            }
            className="w-full sm:w-auto"
          >
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {editing
              ? en
                ? 'Save Changes'
                : 'حفظ التعديلات'
              : en
                ? 'Create Building'
                : 'إنشاء المبنى'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One labelled band of the form.
 *
 * The dialog asks for three unrelated things — which plot this is, where its
 * door is, and what the unit matrix should contain — and undivided they arrive
 * on a phone as a single 900px scroll with no seams in it. A heading per band
 * is what tells an officer halfway down which of the three questions the field
 * under their thumb belongs to.
 */
function Section({
  icon: Icon,
  title,
  action,
  className,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** A control belonging to the band as a whole, e.g. «حذف الدبوس». */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('space-y-3 rounded-xl border bg-card p-3 sm:p-4', className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * How long the style is given to arrive before the map is called broken.
 *
 * Generous on purpose: this is a form filled on a phone on a hillside, and a
 * style that takes eight seconds over a bad connection is still a map. What it
 * bounds is the case where nothing is coming at all.
 */
const MAP_LOAD_TIMEOUT_MS = 12_000;

/**
 * The parcel outline with one draggable entrance pin on it.
 *
 * Mapbox is imported inside the effect rather than at the top of the module, so
 * the dialog itself stays renderable on the server and the 800 kB map bundle is
 * only fetched by someone who actually opened it. That is also why this is a
 * component here rather than a separate `next/dynamic` island: the dialog is
 * already lazy from the page's point of view, and splitting it further would
 * add a loading state between a click and a form.
 *
 * Three things here exist because a blank rectangle was this picker's real
 * failure mode, and a blank rectangle explains nothing to the person holding
 * the phone:
 *
 *  - **The canvas is sized to its container explicitly, and again whenever the
 *    container changes.** Mapbox measures the element once, in the constructor,
 *    and keeps that pixel size for the life of the map. Measured while the
 *    dialog is still animating open it can come back at zero — at which point
 *    nothing is drawn, and `fitBounds` declines the parcel because it cannot
 *    fit a polygon into a viewport with no width. `FullscreenMap` and the zone
 *    editor both carry the same observer for the same reason.
 *  - **A style that never loads says so.** Nothing listened for `error`, so a
 *    rejected token or a blocked `api.mapbox.com` left `load` unfired and the
 *    overlay spinning behind the form indefinitely. Now it names what went
 *    wrong and offers to try again — and a building can still be saved without
 *    a pin, which is the sentence that actually unblocks the visit.
 *  - **Cooperative gestures.** The map sits midway down a panel that scrolls.
 *    A one-finger drag landing on it has to scroll the form, or every field
 *    below the map is unreachable on a touch screen; panning takes two fingers,
 *    and the zoom buttons exist because desktop scroll-zoom now wants a
 *    modifier.
 */
function ParcelPinPicker({
  outline,
  outlineChecked,
  fallbackCentre,
  pin,
  onPick,
  locale,
}: {
  outline: Geometry | null;
  /** False until the outline lookup has run — distinguishes "none" from "not yet". */
  outlineChecked: boolean;
  /**
   * Where to point the camera when the parcel has no traced outline.
   *
   * A view, never a value: nothing here is saved, and no marker is drawn from
   * it. See the note on `fallbackCentre` in the dialog above.
   */
  fallbackCentre: [number, number] | null;
  pin: [number, number] | null;
  onPick: (point: [number, number]) => boolean;
  locale: string;
}) {
  const en = locale === 'en';
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{
    map: mapboxgl.Map;
    marker: mapboxgl.Marker;
    /** The last position the form accepted — where a refused drag snaps back to. */
    lastAccepted?: [number, number];
    /** Whether the view has been framed on the pin; see the effect below. */
    framed?: boolean;
  } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const [ready, setReady] = useState(false);
  /** Why there is no map, when there is no map. */
  const [failure, setFailure] = useState<'token' | 'auth' | 'load' | null>(null);
  /** Bumped by «إعادة المحاولة»; rebuilds the map from scratch. */
  const [attempt, setAttempt] = useState(0);

  const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  useEffect(() => {
    if (!token) {
      setFailure('token');
      return;
    }
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setReady(false);
    setFailure(null);

    void (async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = token;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: SATELLITE_STYLE,
        center: FALLBACK_CENTER,
        zoom: 15,
        attributionControl: false,
        cooperativeGestures: true,
        locale: en
          ? undefined
          : {
              'NavigationControl.ZoomIn': 'تكبير',
              'NavigationControl.ZoomOut': 'تصغير',
              'ScrollZoomBlocker.CtrlMessage': 'استخدم Ctrl + التمرير لتكبير الخريطة',
              'ScrollZoomBlocker.CmdMessage': 'استخدم ⌘ + التمرير لتكبير الخريطة',
              'TouchPanBlocker.Message': 'استخدم إصبعين لتحريك الخريطة',
            },
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');

      const marker = new mapboxgl.Marker({ color: PIN_COLOR, draggable: true });

      map.on('click', (event) => {
        onPickRef.current([event.lngLat.lng, event.lngLat.lat]);
      });

      marker.on('dragend', () => {
        const next = marker.getLngLat();
        // A rejected drag is not a silent no-op: the marker snaps back to where
        // it was, because a pin left sitting where the form refuses to save it
        // reads as accepted.
        if (!onPickRef.current([next.lng, next.lat])) {
          const accepted = mapRef.current?.lastAccepted;
          if (accepted) marker.setLngLat(accepted);
        }
      });

      /*
        Only a refused key is worth blanking the map over on sight. Every other
        error class Mapbox reports — one tile that 404s, a sprite that arrives
        late — is survivable and routinely fires on a map that is drawing
        perfectly well; treating those as fatal would replace a working map with
        an apology. Anything that is genuinely never arriving is caught by the
        watchdog instead.
      */
      map.on('error', (event) => {
        const status = (event.error as unknown as { status?: number } | undefined)?.status;
        if (!cancelled && (status === 401 || status === 403)) setFailure('auth');
      });

      const watchdog = window.setTimeout(() => {
        if (!cancelled && !map.isStyleLoaded()) setFailure('load');
      }, MAP_LOAD_TIMEOUT_MS);

      map.on('load', () => {
        if (cancelled) return;
        // The size this container had while the dialog was animating open is
        // not the size it has now.
        map.resize();
        setFailure(null);
        setReady(true);
      });

      mapRef.current = { map, marker };

      // And once before that, too: the first `fitBounds` runs against whatever
      // the canvas measured at construction, and a zero-width one refuses the
      // parcel it is handed.
      const frame = requestAnimationFrame(() => {
        if (!cancelled) map.resize();
      });

      cleanup = () => {
        window.clearTimeout(watchdog);
        cancelAnimationFrame(frame);
        marker.remove();
        map.remove();
      };
    })().catch(() => {
      // A chunk that never arrives, or a browser with no WebGL 2.
      if (!cancelled) setFailure('load');
    });

    return () => {
      cancelled = true;
      cleanup?.();
      mapRef.current = null;
    };
  }, [token, attempt, en]);

  // ── The canvas follows the container ──────────────────────────────
  // Same fix as FullscreenMap and the zone editor: Mapbox keeps its last pixel
  // size until told otherwise, and this container changes size for reasons the
  // map never hears about — the dialog's open animation, the `lg:` two-up
  // splitting, a phone rotating.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => mapRef.current?.map.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── The outline, redrawn whenever the parcel changes ──────────────
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;
    const { map } = handle;

    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: outline ? [{ type: 'Feature', geometry: outline, properties: {} }] : [],
    };

    const source = map.getSource('parcel-outline') as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      map.addSource('parcel-outline', { type: 'geojson', data });
      map.addLayer({
        id: 'parcel-outline-fill',
        type: 'fill',
        source: 'parcel-outline',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: 'parcel-outline-line',
        type: 'line',
        source: 'parcel-outline',
        paint: { 'line-color': '#38bdf8', 'line-width': 2.5 },
      });
    }

    const bounds = geometryBounds(outline);
    if (bounds) {
      map.fitBounds(bounds, { padding: 32, duration: 400, maxZoom: 19 });
      return;
    }

    /*
      No outline to frame — the ~1.4% of parcels face-tracing could not close.

      The cadastre's own point centres the view so the officer has the right
      rooftops in front of them to tap. Nothing is drawn at it and nothing is
      saved from it: it says where to look, not where the door is.
    */
    if (fallbackCentre) map.easeTo({ center: fallbackCentre, zoom: 18, duration: 400 });
  }, [outline, ready, fallbackCentre]);

  // ── The pin follows the form's state, never the other way round ───
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;

    if (pin) {
      handle.marker.setLngLat(pin).addTo(handle.map);
      handle.lastAccepted = pin;

      /*
        Frame the pin only when there is no outline to frame instead, and only
        the first time. With an outline the fitBounds above already shows both;
        without one — a parcel the tracer could not close — the pin is the only
        thing on the map, and a map centred somewhere else shows nothing at all.
        Re-centring on every change would yank the view back each time the
        officer nudged the marker.
      */
      if (!geometryBounds(outline) && !handle.framed) {
        handle.map.easeTo({ center: pin, zoom: 18, duration: 400 });
        handle.framed = true;
      }
    } else {
      handle.marker.remove();
      handle.lastAccepted = undefined;
    }
  }, [pin, ready, outline]);

  const recentre = useCallback(() => {
    const bounds = geometryBounds(outline);
    if (bounds) mapRef.current?.map.fitBounds(bounds, { padding: 32, duration: 400, maxZoom: 19 });
  }, [outline]);

  /*
    The container stays mounted through every one of these states rather than
    being swapped for a message. Unmounting it was what made a failure
    unrecoverable: the element the effect needs would be gone by the time
    anyone pressed «إعادة المحاولة».
  */
  return (
    <div className="relative h-52 overflow-hidden rounded-lg border sm:h-64 lg:h-[19rem]">
      <div
        ref={containerRef}
        className="h-full w-full"
        aria-label={en ? 'Building entrance map' : 'خريطة مدخل المبنى'}
      />

      {failure ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-muted px-4 text-center">
          <AlertTriangle className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            {failure === 'auth'
              ? en
                ? 'The map key was refused. The building can still be saved — the entrance can be pinned later from the census ledger.'
                : 'رُفض مفتاح الخريطة. يمكن حفظ المبنى رغم ذلك — ويُحدَّد المدخل لاحقاً من سجل المباني.'
              : failure === 'token'
                ? en
                  ? 'The map is unavailable. Coordinates can be added later from the census ledger.'
                  : 'الخريطة غير متاحة. يمكن إضافة الإحداثيات لاحقاً من سجل المباني.'
                : en
                  ? 'The map could not be loaded — check the connection. The building can be saved without a pin.'
                  : 'تعذّر تحميل الخريطة — تحقّق من الاتصال. يمكن حفظ المبنى دون دبوس.'}
          </p>
          {failure === 'token' ? null : (
            <Button variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {en ? 'Try again' : 'إعادة المحاولة'}
            </Button>
          )}
        </div>
      ) : !ready ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/40 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {en ? 'Preparing the map…' : 'جاري تهيئة الخريطة…'}
        </div>
      ) : null}

      {/*
        These two are mutually exclusive — one parcel either has an outline or
        it does not — so they share the bottom edge and never collide, and both
        stay clear of the zoom buttons in the opposite corner.
      */}
      {ready && !failure && outlineChecked && !outline ? (
        <p className="absolute inset-x-2 bottom-2 rounded-md bg-background/90 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur-sm">
          <Crosshair className="me-1 inline size-3" aria-hidden />
          {en
            ? 'This parcel has no traced outline, so the pin cannot be checked against it.'
            : 'لا يوجد مخطط مرسوم لهذا العقار، لذا يتعذّر التحقق من موقع الدبوس ضمنه.'}
        </p>
      ) : null}

      {ready && !failure && outline ? (
        <button
          type="button"
          onClick={recentre}
          className="absolute bottom-2 end-2 inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1.5 text-[11px] font-medium text-foreground shadow-sm ring-1 ring-border backdrop-blur-sm transition-colors hover:bg-background"
        >
          <Crosshair className="size-3.5" aria-hidden />
          {en ? 'Recentre on parcel' : 'إعادة التوسيط على العقار'}
        </button>
      ) : null}
    </div>
  );
}
