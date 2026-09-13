'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Geometry } from 'geojson';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Hash,
  Info,
  Loader2,
  MapPin,
  Save,
  X,
} from 'lucide-react';
import {
  BUILDING_LIFECYCLE,
  formatBuildingCode,
  getLabels,
  isOccupiableLifecycle,
  isUnsurveyableShell,
  nextBuildingSuffix,
  STRUCTURE_TYPE,
  UNZONED_CODE,
  type BuildingLifecycle,
  type StructureType,
  type UnitType,
} from '@mechanization/shared-schemas';
import {
  addUnit,
  ApiRequestError,
  checkPropertyNumber,
  createBuilding,
  deleteUnit,
  duplicateBuildingsOf,
  getBuilding,
  getBuildings,
  getZoneParcelIndex,
  logApiError,
  updateBuilding,
  updateUnit,
  type BuildingDetail,
  type DuplicateBuildingCandidate,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { pointInGeometry } from '@/lib/map-geometry';
import { offlineStorageAvailable } from '@/lib/offline-db';
import { queueBuilding } from '@/lib/offline-sync';
import { loadSession, clearSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { loadParcelOutlines, outlineOf, ParcelPinPicker } from './parcel-pin-picker';
import {
  DEFAULT_GRID_SIZE,
  flattenGridUnits,
  MAX_HORIZONTAL_BLOCKS,
  UnitGridPicker,
  type GridUnitDraft,
} from './unit-grid-picker';

const LOOKUP_DEBOUNCE_MS = 350;
/** The grid's own physical ceiling (20×20) — a defensive assertion, not a
 *  real user-facing limit, since the grid itself can never produce more. */
const MAX_GRID_UNITS = 400;

const STEPS = [
  { en: 'Entrance Location', ar: 'موقع المدخل', icon: MapPin },
  { en: 'Facility Information', ar: 'معلومات المنشأة', icon: Building2 },
  { en: 'Unit Matrix', ar: 'مصفوفة الوحدات', icon: ClipboardCheck },
] as const;

function offlineNow(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** What the grid holds about a unit that already exists, as it was loaded —
 *  the baseline a save diffs against so an untouched cell writes nothing. */
interface UnitBaseline {
  unitCode: string;
  floor: number;
  startCol: number;
  endCol: number;
  unitType: UnitType;
}

/**
 * Why the census will refuse to delete this unit, in the officer's words.
 *
 * The same two facts `deleteUnit` guards on that the matrix carries: an
 * occupancy current *or* ended (D2 keeps the history precisely so the
 * municipality outlives the card) and a logged visit. The server also refuses
 * on a damage assessment or a citizen's card, which this payload cannot see —
 * so this hides the button where it is certainly futile, and the server's own
 * refusal is surfaced verbatim for the rest.
 */
function undeletableReason(unit: UnitWithOccupants, en: boolean): string | undefined {
  if (unit.occupants.length > 0) {
    return en
      ? `Unit ${unit.unitCode} has occupancy on record and cannot be removed. Correct it from the unit matrix instead.`
      : `الوحدة ${unit.unitCode} مسجَّل عليها إشغال ولا يمكن حذفها. صحّحها من مصفوفة الوحدات.`;
  }
  if (unit.visitCount > 0) {
    return en
      ? `Unit ${unit.unitCode} has field visits on record and cannot be removed.`
      : `الوحدة ${unit.unitCode} مسجَّلة عليها زيارات ميدانية ولا يمكن حذفها.`;
  }
  return undefined;
}

/**
 * The census matrix, redrawn on the wizard's grid.
 *
 * Units painted through the grid carry their exact span and keep it. Ones
 * created any other way — the hand-added unit on the matrix page, a card's
 * inline flat — have no span at all, and are laid out one column each in
 * `sequence` order beside whatever is already positioned. That is the same
 * honest default `building-unit-matrix-view.tsx` draws them with, rather than a
 * guess at a layout nobody ever drew.
 *
 * Basements are drawn like any other floor — the grid extends below ground by
 * `basementsCount` — and the depth they imply comes back beside the height.
 * Only what will not fit the grid's *width* comes back as `hidden`, because a
 * unit the grid cannot draw must never be one the save then treats as deleted.
 */
function gridFromUnits(
  units: UnitWithOccupants[],
  en: boolean,
): {
  drafts: GridUnitDraft[];
  hidden: UnitWithOccupants[];
  columns: number;
  floors: number;
  basements: number;
} {
  const drafts: GridUnitDraft[] = [];
  const hidden: UnitWithOccupants[] = [];

  const byFloor = new Map<number, UnitWithOccupants[]>();
  for (const unit of units) {
    byFloor.set(unit.floor, [...(byFloor.get(unit.floor) ?? []), unit]);
  }

  let colorIndex = 0;
  let columns = 0;
  let floors = 0;
  let basements = 0;

  for (const [floor, floorUnits] of [...byFloor.entries()].sort((a, b) => a[0] - b[0])) {
    const taken = new Set<number>();
    const ordered = [...floorUnits].sort((a, b) => a.sequence - b.sequence);
    const positioned = ordered.filter((unit) => unit.startCol != null && unit.endCol != null);
    const loose = ordered.filter((unit) => unit.startCol == null || unit.endCol == null);

    const place = (unit: UnitWithOccupants, startCol: number, endCol: number) => {
      for (let col = startCol; col <= endCol; col += 1) taken.add(col);
      drafts.push({
        clientId: crypto.randomUUID(),
        floor,
        startCol,
        endCol,
        unitType: unit.unitType,
        colorIndex: colorIndex++,
        existingId: unit.id,
        unitCode: unit.unitCode,
        undeletableReason: undeletableReason(unit, en),
      });
      columns = Math.max(columns, endCol);
      if (floor < 0) basements = Math.max(basements, -floor);
      else floors = Math.max(floors, floor + 1);
    };

    for (const unit of positioned) {
      const startCol = Math.min(Math.max(1, unit.startCol as number), MAX_HORIZONTAL_BLOCKS);
      const endCol = Math.min(Math.max(startCol, unit.endCol as number), MAX_HORIZONTAL_BLOCKS);
      let clashes = false;
      for (let col = startCol; col <= endCol; col += 1) if (taken.has(col)) clashes = true;
      // Two units drawn over one cell is not a layout. The later one falls back
      // to being placed beside the rest rather than on top of them.
      if (clashes) loose.push(unit);
      else place(unit, startCol, endCol);
    }

    for (const unit of loose) {
      let col = 1;
      while (col <= MAX_HORIZONTAL_BLOCKS && taken.has(col)) col += 1;
      if (col > MAX_HORIZONTAL_BLOCKS) hidden.push(unit);
      else place(unit, col, col);
    }
  }

  return {
    drafts,
    hidden,
    columns: Math.max(DEFAULT_GRID_SIZE, columns),
    floors: Math.max(1, floors),
    basements,
  };
}

export function BuildingEditor({
  tenant,
  locale,
  adminPath,
  initialParcelNumber,
  buildingId,
  initialStep = 0,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  initialParcelNumber?: string;
  /**
   * The structure being corrected, or absent to create a new one.
   *
   * One wizard for both, deliberately: a correction asks exactly the questions
   * a creation does — which door, what kind of structure, how many floors,
   * which flats are inside — and a second form that asked them differently is
   * how the two drift into disagreeing about what a building is.
   */
  buildingId?: string;
  /** `?step=units` lands an officer on the matrix, which is what an empty
   *  shell's «توليد المصفوفة» is asking for. */
  initialStep?: 0 | 1 | 2;
}) {
  const router = useRouter();
  const toast = useToast();
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const editing = Boolean(buildingId);

  const session = useMemo(() => loadSession(tenant), [tenant]);
  const token = session?.accessToken;

  // Wizard state
  const [step, setStep] = useState<0 | 1 | 2>(initialStep);

  // Form State
  const [parcelNumber, setParcelNumber] = useState(initialParcelNumber ?? '');
  const [name, setName] = useState('');
  const [postedNumber, setPostedNumber] = useState('');
  const [structureType, setStructureType] = useState<StructureType>('RESIDENTIAL_BUILDING');
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
  const [outline, setOutline] = useState<Geometry | null>(null);
  const [fallbackCentre, setFallbackCentre] = useState<[number, number] | null>(null);
  const [outlineChecked, setOutlineChecked] = useState(false);
  const [cadastreHint, setCadastreHint] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Submission State
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pinError, setPinError] = useState<string | null>(null);

  const trimmedParcel = parcelNumber.trim();

  /** Fills the whole wizard from the building on file. */
  const hydrate = useCallback(
    (detail: BuildingDetail) => {
      setParcelNumber(detail.parcelNumber);
      pinParcelRef.current = detail.parcelNumber;
      setName(detail.name ?? '');
      setPostedNumber(detail.postedNumber ?? '');
      setStructureType(detail.structureType);
      setLifecycleStatus(detail.lifecycleStatus);
      setNotes(detail.notes ?? '');
      setSuffix(detail.codeSuffix);
      setSavedCode(detail.code);
      setPin(
        detail.latitude != null && detail.longitude != null
          ? [detail.longitude, detail.latitude]
          : null,
      );

      const { drafts, hidden, columns, floors, basements } = gridFromUnits(detail.units, en);
      setGridUnits(drafts);
      setGridSize(columns);
      setHiddenUnits(hidden);
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
      setFloorsCount(String(Math.max(detail.floorsCount, floors)));
      setBasementsCount(String(Math.max(detail.basementsCount ?? 0, basements)));

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
            },
          ]),
      );
    },
    [en],
  );

  const loadDetail = useCallback(async () => {
    if (!buildingId || !token) return;
    setLoadingDetail(true);
    setLoadError(null);
    try {
      hydrate(await getBuilding(tenant, token, buildingId));
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
  }, [buildingId, token, tenant, hydrate, en, router, base]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Debounced lookup on parcel change
  useEffect(() => {
    if (!trimmedParcel) {
      setOutline(null);
      setFallbackCentre(null);
      setOutlineChecked(false);
      setZoneCode(null);
      setZoneName(null);
      setCadastreHint(null);
      setDuplicates(null);
      setAcknowledgedDuplicates(false);
      setSuffix('A');
      return;
    }

    let cancelled = false;
    setResolving(true);

    const timer = setTimeout(() => {
      void Promise.all([
        loadParcelOutlines(tenant),
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
  }, [trimmedParcel, tenant, token, en, editing]);

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
      pinParcelRef.current = trimmedParcel;
      return true;
    },
    [validatePin, en, trimmedParcel],
  );

  const pinVerdict = pin ? validatePin(pin) : null;

  const isHouse = structureType === 'INDEPENDENT_HOUSE';
  /**
   * A house being *created* is one unit, full stop — no floor count to ask
   * for, and no matrix step: the one unit it has is «منزل مستقل» by
   * definition, so there is nothing left to paint or choose.
   *
   * A house being *corrected* keeps both. What is on file may be a house with
   * two floors, or one whose matrix is empty and needs its unit added — and a
   * form that hid the only controls that could say so would make those states
   * unfixable from the one screen that exists to fix them.
   */
  const houseShortcut = isHouse && !editing;

  /** Units the census already holds for this building, as loaded. */
  const hasRecordedUnits = useMemo(
    () => gridUnits.some((unit) => unit.existingId),
    [gridUnits],
  );

  /**
   * A structure whose interior cannot be surveyed — «مهدوم» or «متضررة من
   * الحرب و غير مسكونة». There are no storeys to count and no flats to paint,
   * so the wizard stops asking for both.
   *
   * Withheld from a building that already has units on file, and that
   * exception is the important half. Marking a standing block war-damaged is
   * a correction about the shell; its twelve recorded flats still carry
   * occupancies, visits and codes, and hiding the only screen that can reach
   * them would strand them — findable by nobody, fixable from nowhere. The
   * officer gets the matrix, and decides unit by unit what became of each.
   */
  const shellShortcut = isUnsurveyableShell(lifecycleStatus) && !hasRecordedUnits;

  /**
   * Standing, damaged, empty — the full wizard, deliberately. The storeys are
   * countable from the pavement and the flats are what reconstruction is
   * costed on, so this building gets its floor fields and its matrix like any
   * other. Only the notes prompt changes, to ask for what was seen.
   */
  const warDamaged = lifecycleStatus === 'WAR_DAMAGED_UNINHABITED';

  /** Neither a new house nor an unsurveyable shell has a matrix to paint. */
  const skipsMatrix = houseShortcut || shellShortcut;
  /** The last real step — the matrix step doesn't exist for either of them. */
  const lastStep: 0 | 1 | 2 = skipsMatrix ? 1 : 2;
  const visibleSteps = skipsMatrix ? STEPS.slice(0, 2) : STEPS;

  /**
   * The wizard shrinking under the officer's feet must not leave them standing
   * on a step that no longer exists — on an edit every step is clickable, so
   * they can be on the matrix when they set the status to «مهدوم».
   */
  useEffect(() => {
    setStep((current) => (current > lastStep ? lastStep : current));
  }, [lastStep]);

  /**
   * The fields are hidden, so the values behind them have to be ones the
   * schema accepts rather than whatever was typed before: `floorsCount` is
   * `.min(1)` and would refuse a save with an empty box, and a 4 left over
   * from a guess at a collapsed building is a fabricated observation.
   *
   * 1 and 0 are not claims about the rubble. They are the schema's floor,
   * recorded because something must be, and the notes field below is where
   * what was actually seen goes.
   */
  useEffect(() => {
    if (!shellShortcut) return;
    setFloorsCount('1');
    setBasementsCount('0');
    setGridSize(DEFAULT_GRID_SIZE);
    setGridUnits((current) => current.filter((unit) => unit.existingId));
  }, [shellShortcut]);

  /** The reverse: a status corrected back to a standing building gets its
   *  floor count back rather than silently keeping the 1 this shortcut wrote.
   *  Skipped for a house, whose 1 is the truth and whose own effect owns it. */
  const wasShell = useRef(shellShortcut);
  useEffect(() => {
    if (wasShell.current && !shellShortcut && !houseShortcut) {
      setFloorsCount((current) => (current === '1' ? '3' : current));
    }
    wasShell.current = shellShortcut;
  }, [shellShortcut, houseShortcut]);

  useEffect(() => {
    if (!houseShortcut || shellShortcut) return;
    setFloorsCount('1');
    setGridSize(1);
    setGridUnits([
      {
        clientId: crypto.randomUUID(),
        floor: 0,
        startCol: 1,
        endCol: 1,
        unitType: 'INDEPENDENT_HOUSE',
        colorIndex: 0,
      },
    ]);
    /* `shellShortcut` is a dependency, not just a guard: a house marked
       «مهدوم» and then corrected back has had its one unit cleared, and
       without this the effect would not re-run to paint it again. */
  }, [houseShortcut, shellShortcut]);

  /** The reverse transition — leaving a structure type of "house" un-paints
   *  the auto-created unit rather than leaving it stranded as a stale 1×1
   *  grid the officer never drew. Units the census already holds survive it:
   *  a structure type is a correction about the shell, not about its flats. */
  const wasHouse = useRef(houseShortcut);
  useEffect(() => {
    if (wasHouse.current && !houseShortcut) {
      setGridSize(DEFAULT_GRID_SIZE);
      setGridUnits((current) => current.filter((unit) => unit.existingId));
      setFloorsCount((current) => (current === '1' ? '3' : current));
    }
    wasHouse.current = houseShortcut;
  }, [houseShortcut]);

  const topFloorAllowed = Math.max(0, (Number(floorsCount) || 1) - 1);
  const bottomFloorAllowed = -Math.max(0, Number(basementsCount) || 0);

  /** Confirmed grid units left stranded if the officer narrows the building
   *  past where they were painted — above the top floor or below the deepest
   *  basement. Never silently dropped. */
  const orphanedUnits = useMemo(
    () =>
      gridUnits.filter(
        (unit) => unit.floor > topFloorAllowed || unit.floor < bottomFloorAllowed,
      ),
    [gridUnits, topFloorAllowed, bottomFloorAllowed],
  );

  // ── Per-step validation gates ──
  const step1Valid = Boolean(trimmedParcel) && !(pin && pinVerdict === false);
  const step2Valid =
    !(duplicates?.length && !acknowledgedDuplicates) &&
    Number(floorsCount) >= 1 &&
    Number(basementsCount) >= 0 &&
    orphanedUnits.length === 0;

  const goNext = () =>
    setStep((current) => (current < lastStep ? ((current + 1) as 0 | 1 | 2) : current));
  const goBack = () => setStep((current) => (current > 0 ? ((current - 1) as 0 | 1 | 2) : current));

  /**
   * A correction: the shell in one PATCH, then the difference between the
   * matrix that was loaded and the one now on the grid.
   *
   * A diff rather than a re-send, because the units on a standing building are
   * not the wizard's to recreate — they carry occupancies, visits and codes
   * the server derived, and deleting and re-adding one would take a flat's
   * whole history down with it.
   *
   * Nothing here is transactional and nothing pretends to be: each refusal is
   * collected and reported by name rather than aborting the rest, because the
   * one the census refuses (a flat somebody lives in) must not stop the four
   * beside it that it would have allowed.
   */
  const saveEdit = async (id: string, activeToken: string): Promise<string[]> => {
    await updateBuilding(tenant, activeToken, id, {
      name: name.trim() || null,
      postedNumber: postedNumber.trim() || null,
      structureType,
      lifecycleStatus,
      latitude: pin ? pin[1] : null,
      longitude: pin ? pin[0] : null,
      floorsCount: Number(floorsCount) || 1,
      basementsCount: Number(basementsCount) || 0,
      notes: notes.trim() || null,
    });

    const baseline = baselineRef.current;
    const failures: string[] = [];
    const refused = (caught: unknown, fallback: string) => {
      logApiError(caught);
      failures.push(caught instanceof ApiRequestError ? caught.payload.message : fallback);
    };

    // Removals first — a freed position is one the additions below can take.
    for (const [unitId, was] of baseline) {
      if (gridUnits.some((unit) => unit.existingId === unitId)) continue;
      try {
        await deleteUnit(tenant, activeToken, unitId);
      } catch (caught) {
        refused(
          caught,
          en
            ? `Unit ${was.unitCode} could not be removed.`
            : `تعذّر حذف الوحدة ${was.unitCode}.`,
        );
      }
    }

    for (const unit of gridUnits) {
      const was = unit.existingId ? baseline.get(unit.existingId) : undefined;
      if (!was) continue;
      if (
        was.floor === unit.floor &&
        was.startCol === unit.startCol &&
        was.endCol === unit.endCol &&
        was.unitType === unit.unitType
      ) {
        continue;
      }
      try {
        await updateUnit(tenant, activeToken, unit.existingId as string, {
          floor: unit.floor,
          startCol: unit.startCol,
          endCol: unit.endCol,
          unitType: unit.unitType,
        });
      } catch (caught) {
        refused(
          caught,
          en
            ? `Unit ${was.unitCode} could not be corrected.`
            : `تعذّر تعديل الوحدة ${was.unitCode}.`,
        );
      }
    }

    // New flats last, lowest floor and leftmost column first, so each floor's
    // server-allocated sequences run the way the grid reads.
    const additions = gridUnits
      .filter((unit) => !unit.existingId)
      .sort((a, b) => a.floor - b.floor || a.startCol - b.startCol);

    for (const unit of additions) {
      try {
        await addUnit(tenant, activeToken, id, {
          floor: unit.floor,
          startCol: unit.startCol,
          endCol: unit.endCol,
          unitType: unit.unitType,
          /*
            The grid drew every unit already on this floor before the officer
            painted beside them, so the duplicate prompt has nothing left to
            show them — it would be asking whether they noticed what they were
            looking at.
          */
          acknowledgedDuplicates: true,
        });
      } catch (caught) {
        refused(
          caught,
          en
            ? `A unit on floor ${unit.floor} could not be added.`
            : `تعذّرت إضافة وحدة على الطابق ${unit.floor}.`,
        );
      }
    }

    return failures;
  };

  // Save handler
  const handleSave = async () => {
    if (!trimmedParcel) {
      setFieldErrors({ parcelNumber: en ? 'Parcel number is required' : 'رقم العقار مطلوب' });
      setStep(0);
      return;
    }
    if (pin && pinVerdict === false) {
      setPinError(
        en
          ? 'The entrance pin is outside the parcel boundary. Relocate it or clear it before saving.'
          : 'دبوس المدخل خارج حدود العقار. حرّكه أو احذفه قبل الحفظ.',
      );
      setStep(0);
      return;
    }
    if (orphanedUnits.length > 0) {
      setError(
        en
          ? `${orphanedUnits.length} unit(s) are on floors above the current floor count (${floorsCount}). Raise the floor count or remove them from the matrix.`
          : `${orphanedUnits.length} وحدة موضوعة على طوابق أعلى من عدد الطوابق الحالي (${floorsCount}). ارفع عدد الطوابق أو احذف هذه الوحدات من المصفوفة.`,
      );
      setStep(1);
      return;
    }

    /** Only the flats this save has to create — an edit's existing units are
     *  already rows and are diffed, not re-sent. */
    const units = flattenGridUnits(gridUnits.filter((unit) => !unit.existingId));
    if (units.length > MAX_GRID_UNITS) {
      setError(
        en
          ? `${units.length} units is more than the maximum of ${MAX_GRID_UNITS} allowed at once.`
          : `عدد الوحدات (${units.length}) يتجاوز الحد الأقصى ${MAX_GRID_UNITS} في العملية الواحدة.`,
      );
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      if (editing && buildingId) {
        if (!token) {
          throw new Error(
            en ? 'Session expired. Please sign in again.' : 'انتهت الجلسة. يرجى تسجيل الدخول مجدداً.',
          );
        }

        const failures = await saveEdit(buildingId, token);

        if (failures.length > 0) {
          /*
            Reported, then the grid is re-read from the server.

            A half-applied save is the one state in which what is on screen and
            what is on file disagree, and leaving the officer looking at their
            own intention would have them save it again into the same refusal.
          */
          setError(
            en
              ? `The building was saved, but ${failures.length} unit change(s) were refused: ${failures.join(' · ')}`
              : `حُفظ المبنى، لكن رُفض ${failures.length} تعديل على الوحدات: ${failures.join(' · ')}`,
          );
          await loadDetail();
          setStep(2);
          return;
        }

        toast.success(
          en ? `Building ${savedCode ?? ''} updated` : `تم تحديث المبنى ${savedCode ?? ''}`,
        );
        router.push(`${base}/buildings/${encodeURIComponent(buildingId)}/matrix`);
        return;
      }

      // 1. Offline branch
      if (offlineNow() && offlineStorageAvailable()) {
        await queueBuilding({
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
            basementsCount: Number(basementsCount) || 0,
            notes: notes.trim() || undefined,
            acknowledgedDuplicates: true,
            units,
          },
          blueprint: null,
        });

        toast.info(en ? 'Saved on this device' : 'حُفظ على هذا الجهاز', {
          description: en
            ? `${codePreview ?? trimmedParcel} is provisional until network sync restores.`
            : `الرمز ${codePreview ?? trimmedParcel} مؤقت وسيُرسل للخادم فور توفّر الاتصال.`,
        });

        router.push(`${base}/buildings`);
        return;
      }

      if (!token) {
        throw new Error(en ? 'Session expired. Please sign in again.' : 'انتهت الجلسة. يرجى تسجيل الدخول مجدداً.');
      }

      // 2. Online: create the building shell and its units in one transactional call
      const response = await createBuilding(tenant, token, {
        parcelNumber: trimmedParcel,
        name: name.trim() || undefined,
        postedNumber: postedNumber.trim() || undefined,
        structureType,
        lifecycleStatus,
        latitude: pin ? pin[1] : undefined,
        longitude: pin ? pin[0] : undefined,
        floorsCount: Number(floorsCount) || 1,
        basementsCount: Number(basementsCount) || 0,
        notes: notes.trim() || undefined,
        provisionalSuffix: suffix,
        acknowledgedDuplicates: acknowledgedDuplicates || undefined,
        units,
      });

      const saved = response.building;
      const reconciled = response.reconciled;

      if (reconciled) {
        toast.warning(en ? 'Building code allocated' : 'تغيّر رمز المبنى عند الحفظ', {
          description: en
            ? `Another building already claimed that letter. Allocated code: ${saved.code}.`
            : `تم اعتماد الرمز النهائي المخصّص من الخادم: ${saved.code}.`,
        });
      } else {
        toast.success(
          en ? `Building ${saved.code} created` : `تم إنشاء المبنى ${saved.code}`,
          {
            description:
              units.length > 0
                ? en
                  ? `${units.length} units created at «not surveyed».`
                  : `تم إنشاء ${units.length} وحدة بحالة «غير ممسوحة».`
                : undefined,
          },
        );
      }

      // Land on the full-page unit matrix — the tool for filling in any
      // floors the chosen grid size didn't cover.
      router.push(`${base}/buildings/${encodeURIComponent(saved.id)}/matrix`);
    } catch (caught) {
      logApiError(caught);

      const candidates = duplicateBuildingsOf(caught);
      if (candidates) {
        setDuplicates(candidates);
        setAcknowledgedDuplicates(false);
        setError((caught as ApiRequestError).payload.message);
        setStep(1);
        return;
      }

      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setFieldErrors(caught.fieldErrors);
        setError(caught.payload.message);
      } else {
        setError(en ? 'Could not save the building.' : 'تعذّر حفظ المبنى.');
      }
    } finally {
      setSaving(false);
    }
  };

  const cancelHref = `${base}/buildings`;
  const canGoNext = step === 0 ? step1Valid : step === 1 ? step2Valid : true;
  /** What the code line says: an allocated code on an edit, the provisional
   *  preview on a creation. */
  const displayCode = editing ? (savedCode ?? codePreview) : codePreview;
  const saveLabel = editing
    ? en
      ? 'Save Changes'
      : 'حفظ التعديلات'
    : shellShortcut
      ? /* «حفظ المبنى» rather than «إنشاء المبنى» on a shortened wizard: the
           officer is on step 2 of 2 and the button is where «التالي» stood a
           moment ago, so it has to read as the end of the form, not as a
           second way of starting one. */
        en
        ? 'Save Building'
        : 'حفظ المبنى'
      : en
        ? 'Create Building'
        : 'إنشاء المبنى';

  if (editing && loadingDetail) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {en ? 'Loading the building…' : 'جاري تحميل المبنى…'}
      </div>
    );
  }

  if (editing && loadError) {
    return (
      <div className="mx-auto max-w-lg space-y-3 py-20 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadDetail()}>
            {en ? 'Retry' : 'إعادة المحاولة'}
          </Button>
          <Link href={cancelHref} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {en ? 'Building Census' : 'سجل المباني'}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-7xl mx-auto space-y-6 px-4 py-6 sm:px-6 lg:px-8 pb-28 sm:pb-12">
      {/* ── Breadcrumb & Navigation ── */}
      <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
        <Link
          href={cancelHref}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground font-medium"
        >
          <ArrowLeft className="size-3.5 sm:size-4 rtl:rotate-180" aria-hidden />
          <span>{en ? 'Building Census' : 'سجل المباني'}</span>
        </Link>
        <ChevronRight className="size-3.5 rtl:rotate-180 text-muted-foreground/60" aria-hidden />
        {editing && buildingId ? (
          <>
            <Link
              href={`${base}/buildings/${encodeURIComponent(buildingId)}/matrix`}
              className="font-mono transition-colors hover:text-foreground"
              dir="ltr"
            >
              {savedCode ?? '—'}
            </Link>
            <ChevronRight className="size-3.5 rtl:rotate-180 text-muted-foreground/60" aria-hidden />
            <span className="text-foreground font-semibold">{en ? 'Edit' : 'تعديل'}</span>
          </>
        ) : (
          <span className="text-foreground font-semibold">{en ? 'New Building' : 'مبنى جديد'}</span>
        )}
      </div>

      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/80 pb-5">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex size-11 sm:size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-xs">
            <Building2 className="size-6" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
                {editing
                  ? en
                    ? 'Edit Building'
                    : 'تعديل المبنى'
                  : en
                    ? 'New Building'
                    : 'إضافة مبنى جديد'}
              </h1>
              {displayCode ? (
                <Badge variant="outline" className="font-mono text-xs px-2 py-0.5 border-primary/40 bg-primary/5 text-primary">
                  {displayCode}
                </Badge>
              ) : null}
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground">
              {editing
                ? en
                  ? 'Correct the structure and its matrix — floors and units can be added here at any time.'
                  : 'صحّح بيانات المنشأة ومصفوفتها — يمكن إضافة الطوابق والوحدات من هنا في أي وقت.'
                : en
                  ? 'Record the structure first — the units inside it are surveyed afterwards.'
                  : 'سجّل المنشأة أولاً — أما الوحدات داخلها فتُمسح لاحقاً.'}
            </p>
          </div>
        </div>

        {/* Desktop Action Buttons */}
        <div className="hidden sm:flex items-center gap-2.5 shrink-0">
          <Link href={cancelHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {en ? 'Cancel' : 'إلغاء'}
          </Link>
          {step > 0 ? (
            <Button variant="outline" size="sm" onClick={goBack} className="gap-1.5">
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              {en ? 'Back' : 'السابق'}
            </Button>
          ) : null}
          {step < lastStep ? (
            <Button
              size="sm"
              onClick={goNext}
              disabled={!canGoNext}
              className="gap-1.5 min-w-28 shadow-xs"
            >
              {en ? 'Next' : 'التالي'}
              <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
          ) : (
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !canGoNext}
              size="sm"
              className="gap-1.5 min-w-32 shadow-xs"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Save className="size-4" aria-hidden />
              )}
              <span>{saveLabel}</span>
            </Button>
          )}
        </div>
      </div>

      {/* ── Step Indicator ── */}
      <ol className="flex items-center gap-2 sm:gap-4">
        {visibleSteps.map((item, index) => {
          const Icon = item.icon;
          const state = index < step ? 'done' : index === step ? 'current' : 'upcoming';
          /*
            A creation unlocks its steps in order — there is nothing to see on
            the matrix of a building whose parcel has not been typed yet. A
            correction has every answer already, so all three are reachable and
            an officer opening «تعديل» to fix the floor count is one tap away
            from it rather than three.
          */
          const reachable = editing || index < step;
          return (
            <li key={item.en} className="flex flex-1 items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => reachable && setStep(index as 0 | 1 | 2)}
                disabled={!reachable}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors sm:size-9',
                  state === 'done' && 'border-primary bg-primary text-primary-foreground cursor-pointer',
                  state === 'current' && 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30',
                  state === 'upcoming' && 'border-border bg-muted/40 text-muted-foreground',
                  state === 'upcoming' && reachable && 'cursor-pointer hover:bg-muted',
                )}
              >
                {state === 'done' ? <Check className="size-4" /> : <Icon className="size-4" />}
              </button>
              <span
                className={cn(
                  'hidden text-xs font-medium sm:inline',
                  state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {en ? item.en : item.ar}
              </span>
              {index < visibleSteps.length - 1 ? (
                <div className={cn('h-px flex-1', index < step ? 'bg-primary' : 'bg-border')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Mobile Current Step Bar */}
      <div className="sm:hidden flex items-center justify-between text-xs px-1 text-muted-foreground">
        <span className="font-semibold text-foreground">
          {en ? `Step ${step + 1}: ${visibleSteps[step]?.en}` : `الخطوة ${step + 1}: ${visibleSteps[step]?.ar}`}
        </span>
        <span className="font-mono text-muted-foreground">
          {step + 1} / {visibleSteps.length}
        </span>
      </div>

      {/* Global Error Banner */}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">{en ? 'Unable to save building' : 'تعذّر حفظ المبنى'}</p>
            <p className="text-xs">{error}</p>
          </div>
        </div>
      ) : null}

      {/* ── Active Wizard Step Content ── */}
      <div className="space-y-6">
        {step === 0 ? (
          <Card className="shadow-xs border-border/80">
            <CardHeader className="border-b bg-muted/15 pb-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <MapPin className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {en ? 'Entrance Location' : 'موقع مدخل المبنى'}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {en
                        ? 'Property plot number and where the officer will point at the door'
                        : 'رقم العقار وموقع مدخل المبنى على الخريطة'}
                    </CardDescription>
                  </div>
                </div>
                {pin ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPin(null);
                      pinParcelRef.current = null;
                      setPinError(null);
                    }}
                    className="h-8 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    {en ? 'Clear pin' : 'حذف الدبوس'}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              {/*
                The parcel is read-only on a correction, because moving a
                building to another parcel is not an edit — the suffix was
                allocated against the old one and the whole code derives from
                it. `updateBuildingSchema` does not accept the field at all.
              */}
              <Field
                label={en ? 'Parcel Number (رقم العقار)' : 'رقم العقار'}
                htmlFor="building-parcel"
                required
                error={fieldErrors.parcelNumber}
                hint={
                  editing
                    ? en
                      ? 'A building cannot be moved to another parcel — its code derives from this one.'
                      : 'لا يمكن نقل المبنى إلى عقار آخر — رمزه مشتق من هذا العقار.'
                    : en
                      ? 'Enter the cadastral parcel number (e.g. 1042)'
                      : 'أدخل رقم العقار في السجل العقاري (مثال: 1042)'
                }
              >
                {editing ? (
                  <p
                    id="building-parcel"
                    dir="ltr"
                    className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-start font-mono text-base font-medium text-foreground"
                  >
                    {trimmedParcel || '—'}
                  </p>
                ) : (
                  <div className="relative" dir="ltr">
                    <Input
                      id="building-parcel"
                      value={parcelNumber}
                      onChange={(event) => setParcelNumber(event.target.value)}
                      dir="ltr"
                      className="text-start font-mono text-base font-medium pe-9"
                      placeholder="1042"
                      inputMode="numeric"
                    />
                    {trimmedParcel ? (
                      <button
                        type="button"
                        onClick={() => setParcelNumber('')}
                        className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full"
                        aria-label={en ? 'Clear parcel number' : 'مسح رقم العقار'}
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                )}
              </Field>

              <div className="rounded-xl border bg-muted/30 p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Hash className="size-3.5" />
                    {en ? 'Derived Census Code' : 'رمز المبنى المشتق'}
                  </span>
                  {resolving && !editing ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      {en ? 'Resolving…' : 'جاري التحقق…'}
                    </span>
                  ) : editing ? (
                    <Badge variant="soft-success" className="text-[11px] px-2 py-0.5">
                      {en ? 'Allocated' : 'معتمد'}
                    </Badge>
                  ) : (
                    <Badge variant="soft-warning" className="text-[11px] px-2 py-0.5">
                      {en ? 'Provisional' : 'مؤقت'}
                    </Badge>
                  )}
                </div>

                <p className="font-mono text-xl sm:text-2xl font-bold tracking-tight text-foreground" dir="ltr">
                  {displayCode ?? '—'}
                </p>

                <div className="text-[11px] leading-relaxed text-muted-foreground space-y-1 border-t border-border/40 pt-2">
                  <p>
                    {zoneName
                      ? en
                        ? `Sector ${zoneCode} — ${zoneName}`
                        : `القطاع ${zoneCode} — ${zoneName}`
                      : trimmedParcel
                        ? en
                          ? `This parcel is currently in no sector, so the code begins with ${UNZONED_CODE}.`
                          : `هذا العقار غير مضاف إلى أي قطاع بعد، لذلك يبدأ الرمز بـ ${UNZONED_CODE}.`
                        : en
                          ? 'Enter a parcel number to compute sector and code.'
                          : 'أدخل رقم العقار لعرض القطاع ورمز المبنى.'}
                  </p>
                  {trimmedParcel ? (
                    <p className="text-muted-foreground/80">
                      {en
                        ? 'The final letter suffix is confirmed on save to guarantee zero collisions.'
                        : 'يُخصَّص الحرف النهائي تلقائياً عند الحفظ لضمان عدم تكرار الرمز.'}
                    </p>
                  ) : null}
                </div>
              </div>

              {cadastreHint ? (
                <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
                  <p>{cadastreHint}</p>
                </div>
              ) : null}

              <ParcelPinPicker
                outline={outline}
                outlineChecked={outlineChecked}
                fallbackCentre={fallbackCentre}
                pin={pin}
                onPick={applyPin}
                locale={locale}
                className="relative h-64 sm:h-72 lg:h-80 overflow-hidden rounded-xl border border-border"
              />

              {pinError ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
                >
                  <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
                  <p>{pinError}</p>
                </div>
              ) : null}

              {pin ? (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    {en ? 'Entrance pinned:' : 'تم تثبيت المدخل:'}
                  </span>
                  <span dir="ltr" className="font-mono font-medium text-foreground">
                    {pin[1].toFixed(6)}, {pin[0].toFixed(6)}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  <Info className="size-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                  <p>
                    {en
                      ? 'No entrance pinned yet. Saving without a pin is permitted (residents will be represented at the parcel level).'
                      : 'لم يُحدَّد مدخل بعد. يمكن الحفظ دون دبوس (سيُعرض سكان المبنى على موقع العقار).'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card className="shadow-xs border-border/80">
            <CardHeader className="border-b bg-muted/15 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-semibold">
                    {en ? 'Facility Information' : 'بيانات المنشأة'}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {en
                      ? 'Structure type, construction status, and physical attributes'
                      : 'نوع المنشأة، الحالة الإنشائية، والمواصفات الفيزيائية'}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              <div className="grid gap-4 sm:grid-cols-2">
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
                    <SelectTrigger id="building-structure-type" className="h-10">
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
                  hint={
                    isOccupiableLifecycle(lifecycleStatus)
                      ? en
                        ? 'Units count towards census survey metrics'
                        : 'تُحتسب وحداته ضمن أرقام المسح'
                      : en
                        ? 'Under construction or unoccupiable — units excluded from survey'
                        : 'قيد الإنشاء أو غير مسكون — تُستثنى وحداته من المسح'
                  }
                >
                  <Select
                    value={lifecycleStatus}
                    onValueChange={(value) => setLifecycleStatus(value as BuildingLifecycle)}
                  >
                    <SelectTrigger id="building-lifecycle" className="h-10">
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
              </div>

              {/*
                Said out loud, because two things vanish at once — the floor
                fields above and the matrix step in the rail — and a form that
                quietly drops half of itself reads as a bug. The second line is
                the one that matters on an edit: it explains why a building
                that already has flats keeps its matrix while this one loses it.
              */}
              {isUnsurveyableShell(lifecycleStatus) ? (
                <div className="flex items-start gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 p-3.5 text-xs text-sky-700 dark:text-sky-400">
                  <Info className="size-4 shrink-0 mt-0.5" aria-hidden />
                  <div className="space-y-1">
                    <p className="font-semibold">
                      {en
                        ? 'Structure classified as demolished — there are no storeys left to count, so the floor fields and the unit matrix are skipped automatically.'
                        : 'المنشأة مصنَّفة مهدومة — لم يبقَ طوابق تُعدّ، لذا يُتخطّى عدد الطوابق ومصفوفة الوحدات تلقائياً.'}
                    </p>
                    {hasRecordedUnits ? (
                      <p className="opacity-80">
                        {en
                          ? 'This building already has units on file, so the matrix stays available — record what became of each one there.'
                          : 'لهذا المبنى وحدات مسجَّلة مسبقاً، لذا تبقى المصفوفة متاحة — سجِّل مصير كل وحدة فيها.'}
                      </p>
                    ) : (
                      <p className="opacity-80">
                        {en
                          ? 'Describe what was observed in the field notes below.'
                          : 'دوِّن ما شوهد ميدانياً في الملاحظات أدناه.'}
                      </p>
                    )}
                  </div>
                </div>
              ) : null}

              {duplicates && duplicates.length > 0 ? (
                <div className="space-y-3 rounded-xl border border-warning/50 bg-warning/10 p-3.5">
                  <div className="flex items-start gap-2 text-xs font-semibold text-warning">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
                    <span>
                      {en
                        ? `${duplicates.length === 1 ? 'A structure is' : `${duplicates.length} structures are`} already recorded on parcel ${trimmedParcel}.`
                        : `${duplicates.length === 1 ? 'توجد منشأة مسجَّلة مسبقاً' : `توجد ${duplicates.length} منشآت مسجَّلة مسبقاً`} على العقار ${trimmedParcel}.`}
                    </span>
                  </div>

                  <ul className="divide-y divide-border/30 rounded-lg border border-border/40 bg-background/50 text-xs">
                    {duplicates.map((row) => (
                      <li key={row.id} className="p-2.5 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span dir="ltr" className="font-mono font-bold text-primary">
                            {row.code}
                          </span>
                          {row.name ? <span className="font-medium text-foreground">{row.name}</span> : null}
                          <span className="text-muted-foreground text-[11px]">
                            ({labels.structureType[row.structureType]})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          {row.postedNumber ? (
                            <span>{en ? 'Posted:' : 'مكتوب:'} <span dir="ltr" className="font-mono">{row.postedNumber}</span></span>
                          ) : null}
                          <span>{en ? `${row.unitsTotal} units` : `${row.unitsTotal} وحدة`}</span>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/30 bg-background/60 p-2.5 text-xs text-foreground">
                    <Checkbox
                      checked={acknowledgedDuplicates}
                      onCheckedChange={(checked) => setAcknowledgedDuplicates(checked === true)}
                      className="mt-0.5"
                    />
                    <span className="font-medium leading-relaxed">
                      {en
                        ? 'I have verified in the field: this is a different structure from the existing ones above.'
                        : 'تحقَّقت ميدانياً: هذه منشأة منفصلة ومختلفة عن المنشآت المذكورة أعلاه.'}
                    </span>
                  </label>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={en ? 'Building Name (Optional)' : 'اسم المبنى (اختياري)'}
                  htmlFor="building-name"
                  error={fieldErrors.name}
                  hint={en ? 'Common name used by locals' : 'الاسم الشائع بين أهالي الحي'}
                >
                  <Input
                    id="building-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={en ? 'Al-Nour Building' : 'بناية النور'}
                    className="h-10"
                  />
                </Field>

                <Field
                  label={en ? 'Posted Number on Door (Optional)' : 'الرقم المكتوب على المبنى (اختياري)'}
                  htmlFor="building-posted"
                  error={fieldErrors.postedNumber}
                  hint={en ? 'Physical plaque or painted door number' : 'رقم اللوحة أو المدوّن على الباب'}
                >
                  <Input
                    id="building-posted"
                    value={postedNumber}
                    onChange={(event) => setPostedNumber(event.target.value)}
                    dir="ltr"
                    className="text-start h-10 font-mono"
                    placeholder="12"
                  />
                </Field>
              </div>

              {skipsMatrix ? null : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={en ? 'Floors Count' : 'عدد الطوابق'}
                    htmlFor="building-floors"
                    required
                    error={fieldErrors.floorsCount}
                    hint={en ? 'Total storeys above ground' : 'إجمالي عدد الطوابق فوق الأرض'}
                  >
                    <Input
                      id="building-floors"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={floorsCount}
                      onChange={(event) => setFloorsCount(event.target.value)}
                      dir="ltr"
                      className="text-start h-10 font-mono"
                    />
                  </Field>

                  {/*
                    A depth, not a signed floor: 2 means B1 and B2. Asked
                    separately from the height because they are two different
                    observations — one made from the pavement, one from the
                    stairwell — and because «عدد الطوابق» has always meant
                    storeys above ground everywhere else in the system.
                  */}
                  <Field
                    label={en ? 'Basement Levels' : 'عدد الطوابق تحت الأرض'}
                    htmlFor="building-basements"
                    error={fieldErrors.basementsCount}
                    hint={
                      en
                        ? 'Levels below ground — 2 means B1 and B2. Leave at 0 for none.'
                        : 'الطوابق تحت الأرض — 2 تعني B1 و B2. اتركه صفراً إن لم يوجد قبو.'
                    }
                  >
                    <Input
                      id="building-basements"
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={basementsCount}
                      onChange={(event) => setBasementsCount(event.target.value)}
                      dir="ltr"
                      className="text-start h-10 font-mono"
                    />
                  </Field>
                </div>
              )}

              {orphanedUnits.length > 0 ? (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {en
                    ? `${orphanedUnits.length} unit(s) in the matrix are on floors above this count. Raise it, or remove them in the next step.`
                    : `${orphanedUnits.length} وحدة في المصفوفة موضوعة على طوابق أعلى من هذا العدد. ارفع العدد، أو احذفها في الخطوة التالية.`}
                </p>
              ) : null}

              <Field
                label={en ? 'Field Notes (Optional)' : 'ملاحظات ميدانية (اختياري)'}
                htmlFor="building-notes"
                error={fieldErrors.notes}
                hint={
                  /* On a demolished plot this field stops being optional in
                     practice: the floor count and the matrix are gone, so it
                     is the only place left that can say what was seen. */
                  shellShortcut
                    ? en
                      ? 'The only record of what was observed — the floor count and matrix are skipped'
                      : 'السجل الوحيد لما شوهد — عدد الطوابق والمصفوفة متخطَّاة'
                    : warDamaged
                      ? en
                        ? 'Record the damage — the storeys and units are still entered normally'
                        : 'دوِّن الأضرار — عدد الطوابق والوحدات تُدخَل كالمعتاد'
                      : en
                        ? 'Useful guidance for upcoming field visits'
                        : 'إرشادات تفيد فرق المسح الميداني القادمة'
                }
              >
                <Textarea
                  id="building-notes"
                  rows={shellShortcut || warDamaged ? 3 : 2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder={
                    shellShortcut
                      ? en
                        ? 'e.g. Structure cleared after shelling; plot empty at the time of the visit…'
                        : 'مثال: أُزيلت المنشأة بعد القصف؛ العقار خالٍ وقت الزيارة…'
                      : warDamaged
                        ? en
                          ? 'e.g. Severe structural damage from shelling, uninhabitable, residents displaced; storeys counted from the street…'
                          : 'مثال: أضرار إنشائية بالغة من القصف، غير صالحة للسكن، السكان نازحون؛ عُدّت الطوابق من الخارج…'
                        : en
                          ? 'e.g. Side entrance via garden stairs…'
                          : 'مثال: المدخل من الدرج الجانبي عبر الحديقة…'
                  }
                  className="resize-none"
                />
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card className="shadow-xs border-border/80">
            <CardHeader className="border-b bg-muted/15 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <ClipboardCheck className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-semibold">
                    {en ? 'Unit Matrix' : 'مصفوفة الوحدات'}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {editing
                      ? en
                        ? 'Raise the floor count and paint the new units — they are added at «not surveyed»'
                        : 'ارفع عدد الطوابق وارسم الوحدات الجديدة — تُضاف بحالة «غير ممسوحة»'
                      : en
                        ? 'Paint out each unit on the floors below — created at «not surveyed»'
                        : 'حدّد كل وحدة على الطوابق أدناه — تُنشأ بحالة «غير ممسوحة»'}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              <UnitGridPicker
                locale={locale}
                structureType={structureType}
                floorsCount={Number(floorsCount) || 1}
                onFloorsCountChange={(newFloors) => setFloorsCount(String(newFloors))}
                basementsCount={Number(basementsCount) || 0}
                onBasementsCountChange={(next) => setBasementsCount(String(next))}
                gridSize={gridSize}
                onGridSizeChange={setGridSize}
                units={gridUnits}
                onUnitsChange={setGridUnits}
              />

              {/*
                Units the grid has no row for — basements, which it does not
                draw, and anything past its width. Named rather than omitted:
                an officer who cannot see a flat here must still know it is on
                file, and the save leaves every one of them untouched.
              */}
              {hiddenUnits.length > 0 ? (
                <p className="flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    {en
                      ? `${hiddenUnits.length} unit(s) are not drawn on this grid (${hiddenUnits
                          .map((unit) => unit.unitCode)
                          .join(', ')}) — they are left exactly as they are. Correct them from the unit matrix.`
                      : `${hiddenUnits.length} وحدة غير معروضة على هذه المصفوفة (${hiddenUnits
                          .map((unit) => unit.unitCode)
                          .join('، ')}) — تبقى كما هي دون تغيير. صحّحها من صفحة مصفوفة الوحدات.`}
                  </span>
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ── Structure Summary (ملخص المنشأة) at the bottom ── */}
        <Card className="shadow-xs border-border/80 bg-muted/15">
          <CardHeader className="pb-3 border-b bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ClipboardCheck className="size-4 text-primary" />
                <span>{en ? 'Structure Summary' : 'ملخص المنشأة'}</span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {en
                    ? `Step ${step + 1} of ${visibleSteps.length}`
                    : `الخطوة ${step + 1} من ${visibleSteps.length}`}
                </span>
                <Badge variant="outline" className="text-xs font-mono border-primary/40 bg-primary/5 text-primary">
                  {codePreview ?? '—'}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="rounded-lg border bg-background/70 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Parcel Number' : 'رقم العقار'}</p>
                <p dir="ltr" className="font-mono font-bold text-sm sm:text-base text-foreground truncate">
                  {trimmedParcel || '—'}
                </p>
              </div>

              <div className="rounded-lg border bg-background/70 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Building Code' : 'رمز المبنى'}</p>
                <p dir="ltr" className="font-mono font-bold text-sm sm:text-base text-primary truncate">
                  {codePreview || '—'}
                </p>
              </div>

              <div className="rounded-lg border bg-background/70 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Sector' : 'القطاع'}</p>
                <p className="font-semibold text-xs sm:text-sm text-foreground truncate">
                  {zoneCode ? `${zoneCode} · ${zoneName ?? ''}` : trimmedParcel ? UNZONED_CODE : '—'}
                </p>
              </div>

              <div className="rounded-lg border bg-background/70 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Structure Type' : 'نوع المنشأة'}</p>
                <p className="font-semibold text-xs sm:text-sm text-foreground truncate">
                  {labels.structureType[structureType]}
                </p>
              </div>

              <div className="rounded-lg border bg-background/70 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Floors & Units' : 'الطوابق والوحدات'}</p>
                <p className="font-semibold text-xs sm:text-sm text-foreground truncate">
                  {houseShortcut
                    ? `1 ${en ? 'floor' : 'طابق'}`
                    : `${floorsCount} ${en ? 'floors' : 'طوابق'}`}
                  {!houseShortcut && Number(basementsCount) > 0
                    ? ` + B${Number(basementsCount)}`
                    : ''}{' '}
                  · {gridUnits.length + hiddenUnits.length} {en ? 'units' : 'وحدة'}
                </p>
              </div>

              <div className="rounded-lg border bg-background/70 p-3 space-y-1 col-span-2 sm:col-span-1">
                <p className="text-[11px] text-muted-foreground font-medium">{en ? 'Entrance Location' : 'موقع المدخل'}</p>
                <div className="pt-0.5 flex items-center gap-1.5 flex-wrap">
                  {pin ? (
                    <Badge variant="soft-success" className="text-[11px] px-2">
                      {en ? 'Pinned' : 'مُثبت'}
                    </Badge>
                  ) : (
                    <Badge variant="soft-muted" className="text-[11px] px-2">
                      {en ? 'Desk entry' : 'غير مُثبت'}
                    </Badge>
                  )}
                  {name ? (
                    <span className="text-[11px] text-muted-foreground truncate hidden lg:inline">
                      · {name}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Desktop Bottom Step Navigation */}
        <div className="hidden sm:flex items-center justify-between pt-2">
          <Link
            href={cancelHref}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Link>
          <div className="flex items-center gap-3">
            {step > 0 ? (
              <Button variant="outline" size="sm" onClick={goBack} className="gap-1.5 min-w-24">
                <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
                {en ? 'Back' : 'السابق'}
              </Button>
            ) : null}
            {step < lastStep ? (
              <Button
                size="sm"
                onClick={goNext}
                disabled={!canGoNext}
                className="gap-1.5 min-w-28 shadow-xs"
              >
                {en ? 'Next' : 'التالي'}
                <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
              </Button>
            ) : (
              <Button
                onClick={() => void handleSave()}
                disabled={saving || !canGoNext}
                size="sm"
                className="gap-1.5 min-w-36 shadow-xs"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-4" aria-hidden />
                )}
                <span>{saveLabel}</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky Mobile Action Bar ── */}
      <div className="sm:hidden fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur-md border-t p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] z-40 flex items-center gap-3 shadow-lg">
        {step > 0 ? (
          <Button variant="outline" onClick={goBack} className="h-11 px-4 text-xs gap-1.5">
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            {en ? 'Back' : 'السابق'}
          </Button>
        ) : (
          <Link
            href={cancelHref}
            className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 h-11 text-xs')}
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Link>
        )}
        {step < lastStep ? (
          <Button onClick={goNext} disabled={!canGoNext} className="flex-1 h-11 text-xs gap-1.5 shadow-xs">
            {en ? 'Next' : 'التالي'}
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        ) : (
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !canGoNext}
            className="flex-1 h-11 text-xs gap-1.5 shadow-xs"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Save className="size-4" aria-hidden />
            )}
            <span>{saveLabel}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
