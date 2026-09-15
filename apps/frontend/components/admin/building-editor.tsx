'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FeatureCollection, Geometry } from 'geojson';
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
  Plus,
  Save,
  X,
} from 'lucide-react';
import {
  BUILDING_LIFECYCLE,
  defaultUnitTypeFor,
  formatBuildingCode,
  getLabels,
  isOccupiableLifecycle,
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
  getZones,
  logApiError,
  updateBuilding,
  updateUnit,
  type BuildingDetail,
  type DuplicateBuildingCandidate,
  type UnitWithOccupants,
  type ZoneSummary,
} from '@/lib/api-client';
import { pointInGeometry } from '@/lib/map-geometry';
import { offlineStorageAvailable } from '@/lib/offline-db';
import { queueBuilding } from '@/lib/offline-sync';
import { loadSession, clearSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { BackLink } from '@/components/ui/back-link';
import { cn } from '@/lib/utils';
import {
  footprintOf,
  loadParcelOutlines,
  outlineOf,
  parcelAt,
  parcelsOf,
  ParcelPinPicker,
} from './parcel-pin-picker';
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_VERTICAL_BLOCKS,
  flattenGridUnits,
  MAX_HORIZONTAL_BLOCKS,
  UnitGridPicker,
  type GridUnitDraft,
} from './unit-grid-picker';

const LOOKUP_DEBOUNCE_MS = 350;

/**
 * What a منزل becomes when the officer says it is a building.
 *
 * Named rather than inlined because two things have to agree about it — the
 * structure type written to the shell, and the unit type
 * `defaultUnitTypeFor` derives for every block being re-typed — and they are
 * several lines apart.
 *
 * «بناية سكنية» and not «متعدد الاستعمالات»: the officer has told us there is
 * more than one dwelling and nothing more, and a residential block is what
 * that is nineteen times out of twenty. Every other type is one tap away on
 * the step they were just on.
 */
const PROMOTED_STRUCTURE_TYPE = 'RESIDENTIAL_BUILDING' as const;
/** The grid's own physical ceiling (20×20) — a defensive assertion, not a
 *  real user-facing limit, since the grid itself can never produce more. */
const MAX_GRID_UNITS = 400;

const STEPS = [
  /*
    Renamed from «موقع المدخل», because the step no longer only asks for a pin.

    It now runs sector → map → رقم العقار → فرز → shared parcels, which is the
    order an officer actually has the answers in: they know where they are
    standing long before they know the cadastral number of the ground under
    them. The old order asked for the number first and then offered the map,
    which is the one sequence in which the map cannot help.
  */
  { en: 'Location & Parcel', ar: 'الموقع والعقار', icon: MapPin },
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
      setIsPartitioned(detail.isPartitioned === true);
      setPartitionNumbers(detail.partitionNumbers ?? []);
      setSharedParcels(detail.sharedParcelNumbers ?? []);
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

  /*
    The two things the sector step needs, fetched once per mount.

    Both are already cached at the module level — `loadParcelOutlines` keeps one
    promise per tenant for the life of the tab, and `getZoneParcelIndex` a
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

    void loadParcelOutlines(tenant).then((collection) => {
      if (!cancelled) setParcelOutlines(collection);
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
  }, [tenant, token]);

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
  }, [parcelZone, trimmedParcel, initialParcelNumber]);

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
  const cleanedPartitionNumbers = useMemo(() => {
    if (!isPartitioned) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of partitionNumbers) {
      const value = raw.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }, [partitionNumbers, isPartitioned]);

  const cleanedSharedParcels = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of sharedParcels) {
      const value = raw.trim();
      if (!value || value === trimmedParcel || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }, [sharedParcels, trimmedParcel]);

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
      setParcelFromMap(false);
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
    [validatePin, en, trimmedParcel, parcelOutlines],
  );

  const pinVerdict = pin ? validatePin(pin) : null;

  const isHouse = structureType === 'INDEPENDENT_HOUSE';
  /**
   * A house being *created* is seeded as a single painted block.
   *
   * It used to be seeded and then *hidden*: the matrix step did not exist for a
   * new منزل, on the reasoning that its one unit is «منزل مستقل» by definition
   * and there is nothing left to choose. That reasoning held for the unit and
   * not for the officer. A house has a floor count, it may have a basement, and
   * — far more often than the shortcut allowed for — the thing in front of them
   * turns out not to be a house at all once they have walked round it.
   *
   * So the block is still painted for them, and the step is still shown. One
   * block *is* the house; painting a second one is the officer discovering it
   * is a building, and `requestUnits` below turns that into a question rather
   * than into a save the server refuses.
   */
  const houseShortcut = isHouse && !editing;
  /** Every structure has all three steps now — see `houseShortcut`. */
  const lastStep: 0 | 1 | 2 = 2;
  const visibleSteps = STEPS;

  useEffect(() => {
    if (!houseShortcut) return;
    setFloorsCount('1');
    /*
      One painted block on a grid with room beside it — not a 1×1 grid.

      What makes it a house is the single *unit*, not a canvas with nowhere to
      draw. Seeded at 1×1 the promotion was unreachable: every cell was already
      taken, so an officer who walked round the back and found a second door had
      to work out that the «أفقي (الأعمدة)» stepper was what stood between them
      and recording it. The question this editor now asks — «هل تريد تحويلها من
      منزل إلى بناية؟» — can only be asked if there is somewhere to paint the
      block that triggers it.

      The height stays at one storey, which is the honest default for a منزل and
      is a stepper away from anything else.
    */
    setGridSize(DEFAULT_GRID_SIZE);
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
  }, [houseShortcut]);

  /**
   * The officer answered «نعم، هي بناية», so the reset below must not fire.
   *
   * The promotion changes نوع المنشأة, which flips `houseShortcut`, which is
   * exactly the transition the reset watches for — and the reset drops every
   * unpainted unit, which on that commit is the whole floor plan they just
   * confirmed. They would tap «نعم» and watch their matrix collapse to one
   * square, with the structure type silently changed underneath it.
   *
   * A ref rather than state because it must be readable by the effect on the
   * *same* commit that sets it, and it is not something anything renders.
   */
  const promotedFromHouse = useRef(false);

  /** The reverse transition — leaving a structure type of "house" un-paints
   *  the auto-created unit rather than leaving it stranded as a stale 1×1
   *  grid the officer never drew. Units the census already holds survive it:
   *  a structure type is a correction about the shell, not about its flats. */
  const wasHouse = useRef(houseShortcut);
  useEffect(() => {
    if (wasHouse.current && !houseShortcut) {
      if (promotedFromHouse.current) {
        // The grid *is* the reason the type changed. Keep it exactly as drawn.
        promotedFromHouse.current = false;
      } else {
        setGridSize(DEFAULT_GRID_SIZE);
        setGridUnits((current) => current.filter((unit) => unit.existingId));
        setFloorsCount((current) => (current === '1' ? '3' : current));
      }
    }
    wasHouse.current = houseShortcut;
  }, [houseShortcut]);

  /**
   * The grid the officer has painted but not yet been allowed to keep.
   *
   * Held while «هل تريد تحويلها من منزل إلى بناية؟» is on screen — see
   * `requestUnits`.
   */
  const [pendingUnits, setPendingUnits] = useState<GridUnitDraft[] | null>(null);

  /**
   * Every change the matrix makes passes through here, so that one of them can
   * be turned into a question.
   *
   * A منزل مستقل is one dwelling — `assertUnitFits` refuses a second unit on
   * one server-side, and refuses it at *save* time, which is the worst possible
   * moment: the officer has painted a floor plan, walked to the end of the
   * wizard and pressed «إنشاء المبنى», and is told the structure type they
   * chose three screens ago contradicts it.
   *
   * Painting a second block is not a mistake, though. It is the commonest
   * correction there is — the officer walked round the back and found a second
   * door — and the only thing wrong with it is that نوع المنشأة still says
   * «منزل مستقل». So it is asked, here, at the moment it becomes true, and a
   * yes changes the type along with the grid.
   *
   * Only ever intercepts the 1 → 2 crossing. Every other edit — moving a block,
   * widening one, deleting back down — goes straight through, because a
   * question asked on every paint stroke is a question people learn to dismiss.
   */
  const requestUnits = useCallback(
    (next: GridUnitDraft[]) => {
      if (isHouse && next.length > 1) {
        setPendingUnits(next);
        return;
      }
      setGridUnits(next);
    },
    [isHouse],
  );

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
  /*
    What stops «التالي» on the facility step.

    `orphanedUnits` used to be part of this and no longer is, because the two
    things that resolve it — the floor count and the matrix — are both on the
    step this gate guards the way *to*. Holding an officer on the previous
    screen until they fix something they can only reach by leaving it is a dead
    end, and the save still refuses the same condition with a message that now
    sends them to the right place.

    The height and depth checks stay as assertions rather than as live gates:
    nothing on this step can set them any more, so they can only fail if some
    other path has put nonsense in the state.
  */
  const step2Valid =
    !(duplicates?.length && !acknowledgedDuplicates) &&
    Number(floorsCount) >= 1 &&
    Number(basementsCount) >= 0;

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
      /*
        `null` and not `false` for an unticked box — «لم يُسأل», not a denial.

        Sent rather than omitted because an officer must be able to withdraw a
        فرز they ticked by mistake, and an omitted key would leave it set for
        ever. The numbers travel with it; the server clears them whenever the
        flag is not true, so the two cannot drift.
      */
      isPartitioned: isPartitioned ? true : null,
      partitionNumbers: cleanedPartitionNumbers,
      sharedParcelNumbers: cleanedSharedParcels,
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
      // The matrix step, because that is where the floor count now lives —
      // both halves of the fix this message asks for are on the same screen.
      setStep(2);
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
            // Omitted when the box was not ticked, matching the create schema:
            // an absent key and a null mean the same thing on a *creation*, and
            // the queue's payload is replayed through `createBuilding`.
            ...(isPartitioned
              ? { isPartitioned: true, partitionNumbers: cleanedPartitionNumbers }
              : {}),
            ...(cleanedSharedParcels.length > 0
              ? { sharedParcelNumbers: cleanedSharedParcels }
              : {}),
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
        ...(isPartitioned
          ? { isPartitioned: true, partitionNumbers: cleanedPartitionNumbers }
          : {}),
        ...(cleanedSharedParcels.length > 0
          ? { sharedParcelNumbers: cleanedSharedParcels }
          : {}),
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
      {/*
        Wraps rather than overflows. On a phone this row can carry «رجوع», the
        section, a building code and the current step at once — more than 343px
        of gutter-less screen holds — and a breadcrumb that runs off the edge
        takes the page's horizontal scroll with it.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-muted-foreground">
        <BackLink fallbackHref={cancelHref} label={en ? 'Back' : 'رجوع'} />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <Link
          href={cancelHref}
          className="transition-colors hover:text-foreground font-medium"
        >
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
                      {en ? 'Location & Parcel' : 'الموقع والعقار'}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {en
                        ? 'Pick the sector, place the building on the map, then confirm its parcel'
                        : 'اختر القطاع، ثم حدّد موقع المبنى على الخريطة، ثم أكّد رقم العقار'}
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
            <CardContent className="space-y-5 pt-5">
              {/*
                ── 1. القطاع ──────────────────────────────────────────────

                First, and not stored anywhere.

                A building's sector is derived from its parcel's membership at
                read time (D13) — `Zone.parcelNumbers` is the one statement of
                which عقار belongs where — so this control cannot and must not
                write it. What it does is narrow the map from the whole
                municipality to a few hundred parcels somebody can actually aim
                at, which is what makes the rest of this step possible.

                Offered only while creating, and only when the register has
                sectors to offer. A correction already knows its parcel, so it
                knows its sector, and asking would be a question whose answer is
                printed two fields down.
              */}
              {!editing && zones.length > 0 ? (
                <StepField
                  en={en}
                  ordinal={1}
                  title={en ? 'Sector (القطاع)' : 'القطاع'}
                  hint={
                    en
                      ? 'Narrows the map to that sector so the building can be placed on it. The code’s sector is still read from the parcel itself.'
                      : 'يحصر الخريطة ضمن القطاع لتحديد موقع المبنى عليه. أما قطاع الرمز فيُقرأ من العقار نفسه.'
                  }
                  htmlFor="building-zone"
                >
                  <Select value={zoneId} onValueChange={setZoneId}>
                    <SelectTrigger id="building-zone" className="h-10">
                      <SelectValue placeholder={en ? 'Select a sector…' : 'اختر القطاع…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {zones.map((zone) => (
                        <SelectItem key={zone.id} value={zone.id}>
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: zone.color }}
                            />
                            <span dir="ltr" className="font-mono text-xs">
                              {zone.code}
                            </span>
                            <span>{zone.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {selectedZone && zoneParcelNumbers.length > 0 ? (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {en
                        ? `${zoneParcelNumbers.length} parcel(s) in this sector are drawn on the map below.`
                        : `تم رسم ${zoneParcelNumbers.length} عقاراً من هذا القطاع على الخريطة أدناه.`}
                    </p>
                  ) : selectedZone ? (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {en
                        ? 'None of this sector’s parcels have a traced outline, so it cannot be drawn. Enter the parcel number directly.'
                        : 'لا يوجد مخطط مرسوم لأي من عقارات هذا القطاع، لذا يتعذّر عرضه. أدخل رقم العقار مباشرة.'}
                    </p>
                  ) : null}
                </StepField>
              ) : null}

              {/*
                ── 2. The map ─────────────────────────────────────────────

                Before رقم العقار rather than after it, which is the whole point
                of this reordering: an officer standing at a door knows where
                they are and not the cadastral number of the ground under them.
                The number is a fact about the map, and asking for it first was
                asking them to index the cadastre from memory.

                The pin does double duty — it is still the entrance (D19), and
                it is now also what `parcelAt` reads the parcel off. See
                `applyPin`.
              */}
              <StepField
                en={en}
                ordinal={!editing && zones.length > 0 ? 2 : 1}
                title={en ? 'Building location on the map' : 'موقع المبنى على الخريطة'}
                hint={
                  editing
                    ? en
                      ? 'The pin is the entrance — the point a collector navigates to.'
                      : 'الدبوس هو المدخل — النقطة التي يقصدها المحصّل.'
                    : en
                      ? 'Tap where the building stands. Its parcel number is read off the cadastre below.'
                      : 'انقر على موقع المبنى. ويُقرأ رقم العقار من المسح العقاري أدناه.'
                }
              >
                <ParcelPinPicker
                  outline={outline}
                  outlineChecked={outlineChecked}
                  fallbackCentre={fallbackCentre}
                  zoneOutline={zoneFootprint}
                  zoneParcels={zoneParcelFeatures}
                  zoneColor={selectedZone?.color}
                  pin={pin}
                  onPick={applyPin}
                  locale={locale}
                  className="relative h-64 sm:h-72 lg:h-80 overflow-hidden rounded-xl border border-border"
                />

                {pinError ? (
                  <div
                    role="alert"
                    className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
                  >
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
                    <p>{pinError}</p>
                  </div>
                ) : null}

                {pin ? (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5 text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <CheckCircle2 className="size-3.5 text-success" />
                      {en ? 'Entrance pinned:' : 'تم تثبيت المدخل:'}
                    </span>
                    <span dir="ltr" className="font-mono font-medium text-foreground">
                      {pin[1].toFixed(6)}, {pin[0].toFixed(6)}
                    </span>
                  </div>
                ) : (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    <Info className="size-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                    <p>
                      {en
                        ? 'No entrance pinned yet. Saving without a pin is permitted (residents will be represented at the parcel level).'
                        : 'لم يُحدَّد مدخل بعد. يمكن الحفظ دون دبوس (سيُعرض سكان المبنى على موقع العقار).'}
                    </p>
                  </div>
                )}
              </StepField>

              {/*
                ── 3. رقم العقار ──────────────────────────────────────────

                Read-only on a correction, because moving a building to another
                parcel is not an edit — the suffix was allocated against the old
                one and the whole code derives from it.
                `updateBuildingSchema` does not accept the field at all.
              */}
              <StepField
                en={en}
                ordinal={!editing && zones.length > 0 ? 3 : 2}
                title={en ? 'Parcel Number (رقم العقار)' : 'رقم العقار'}
                htmlFor="building-parcel"
                required={!editing}
                error={fieldErrors.parcelNumber}
                hint={
                  editing
                    ? en
                      ? 'A building cannot be moved to another parcel — its code derives from this one.'
                      : 'لا يمكن نقل المبنى إلى عقار آخر — رمزه مشتق من هذا العقار.'
                    : parcelFromMap
                      ? en
                        ? 'Read off the cadastre from the point you tapped. Correct it here if the survey disagrees.'
                        : 'قُرئ من المسح العقاري حسب النقطة التي حدّدتها. صحّحه هنا إن خالف السجل.'
                      : en
                        ? 'Place the building on the map above and this fills itself — or type the number if you know it.'
                        : 'حدّد موقع المبنى على الخريطة أعلاه ليُملأ تلقائياً — أو اكتب الرقم إن كنت تعرفه.'
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
                      onChange={(event) => {
                        setParcelNumber(event.target.value);
                        // Typed over: the note must stop claiming the cadastre
                        // supplied this, or a wrong number would read as the
                        // survey's answer rather than as somebody's correction.
                        setParcelFromMap(false);
                      }}
                      dir="ltr"
                      className="text-start font-mono text-base font-medium pe-9"
                      placeholder="1042"
                      inputMode="numeric"
                    />
                    {trimmedParcel ? (
                      <button
                        type="button"
                        onClick={() => {
                          setParcelNumber('');
                          setParcelFromMap(false);
                        }}
                        className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full"
                        aria-label={en ? 'Clear parcel number' : 'مسح رقم العقار'}
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                )}

                {parcelFromMap ? (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-success">
                    <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                    {en ? 'Read from the cadastre' : 'مأخوذ من المسح العقاري'}
                  </p>
                ) : null}

                {/*
                  The parcel belongs to a different sector from the one being
                  looked in. Said, never settled: the code's sector half comes
                  from the parcel (D13), so this reports which one the code will
                  actually carry and leaves the officer to decide which of the
                  two is wrong.
                */}
                {zoneMismatch ? (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-[11px] leading-relaxed text-warning">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
                    <p>
                      {en
                        ? `Parcel ${trimmedParcel} is in sector ${parcelZone!.code} — ${parcelZone!.name}, not the one selected above. The code will carry ${parcelZone!.code}.`
                        : `العقار ${trimmedParcel} يقع في القطاع ${parcelZone!.code} — ${parcelZone!.name}، لا القطاع المختار أعلاه. سيحمل الرمز ${parcelZone!.code}.`}
                    </p>
                  </div>
                ) : null}

                {cadastreHint ? (
                  <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
                    <p>{cadastreHint}</p>
                  </div>
                ) : null}

                <div className="mt-3 rounded-xl border bg-muted/30 p-3.5 space-y-2">
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
                            ? 'Place the building on the map, or enter a parcel number, to compute sector and code.'
                            : 'حدّد موقع المبنى على الخريطة أو أدخل رقم العقار لعرض القطاع ورمز المبنى.'}
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
              </StepField>

              {/*
                ── 4. الفرز ───────────────────────────────────────────────

                One checkbox, and the أقسام only once it is ticked.

                It was a three-way choice — «غير محدد / مفروزة / غير مفروزة» —
                and two of those three answers earned nothing. What a transfer,
                a deed search or a resident at the counter is actually asking is
                «which قسم?», and a form that could only say "yes, partitioned"
                sent them to the survey office anyway. So the yes now opens the
                field that answers the real question.

                The asymmetry in what the box means is deliberate. Ticked is an
                officer asserting a فرز; unticked is «لم يُسأل», not «غير
                مفروزة» — so the save sends `true` or `null` and never `false`.
                An unticked box on every building ever created is not a finding
                about title that anybody made, and فرز decides whether a flat
                inside can carry a deed of its own.

                An empty list under a ticked box is allowed, and is ordinary: a
                block surveyed from the street is visibly مفروزة long before
                anyone has the قسم numbers off the صحيفة.
              */}
              <StepField
                en={en}
                ordinal={!editing && zones.length > 0 ? 4 : 3}
                title={en ? 'Partitioned on a parcel?' : 'هل الوحدة مفروزة على عقار؟'}
                hint={
                  en
                    ? 'Optional. Partitioning (فرز) splits one parcel into separately titled units. Leave it unticked if it has not been established.'
                    : 'اختياري. الفرز يقسّم العقار إلى وحدات ذات صحائف عقارية مستقلة. اتركه دون تحديد إن لم يُتحقَّق منه.'
                }
              >
                <div className="space-y-3">
                  <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:bg-accent/40">
                    <Checkbox
                      checked={isPartitioned}
                      onCheckedChange={(checked) => {
                        const next = checked === true;
                        setIsPartitioned(next);
                        /*
                          Un-ticking clears the أقسام rather than parking them.

                          The server discards them for an untick anyway, so
                          leaving the rows on screen would show the officer
                          numbers that are not going to be saved — and a field
                          that silently disagrees with what it will store is
                          worse than one that is simply empty. Re-ticking starts
                          from one blank row, which is where they were anyway.
                        */
                        if (!next) setPartitionNumbers([]);
                      }}
                    />
                    <span>{en ? 'Partitioned (مفروزة)' : 'مفروزة'}</span>
                  </label>

                  {isPartitioned ? (
                    <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
                      <p className="text-[11px] font-medium text-foreground/80">
                        {en ? 'Partition numbers (أرقام الأقسام)' : 'أرقام الأقسام'}
                      </p>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {en
                          ? 'One per titled unit, as written on the صحيفة عقارية. Leave empty if the numbers have not been collected yet — the partition is still recorded.'
                          : 'رقم لكل قسم كما هو مدوَّن في الصحيفة العقارية. اتركها فارغة إن لم تُجمع الأرقام بعد — يبقى الفرز مسجَّلاً.'}
                      </p>

                      {partitionNumbers.map((value, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <Input
                            value={value}
                            onChange={(event) =>
                              setPartitionNumbers((current) =>
                                current.map((row, position) =>
                                  position === index ? event.target.value : row,
                                ),
                              )
                            }
                            dir="ltr"
                            inputMode="numeric"
                            placeholder="12"
                            aria-label={
                              en ? `Partition number ${index + 1}` : `رقم القسم ${index + 1}`
                            }
                            className="h-10 flex-1 text-start font-mono"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              setPartitionNumbers((current) =>
                                current.filter((_row, position) => position !== index),
                              )
                            }
                            aria-label={en ? 'Remove this partition' : 'حذف هذا القسم'}
                            className="size-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      ))}

                      <button
                        type="button"
                        onClick={() => setPartitionNumbers((current) => [...current, ''])}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-dashed border-primary/50 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
                      >
                        <Plus className="size-3.5 shrink-0" aria-hidden />
                        {partitionNumbers.length === 0
                          ? en
                            ? 'Add a partition number'
                            : 'إضافة رقم قسم'
                          : en
                            ? 'Add another'
                            : 'إضافة رقم آخر'}
                      </button>
                    </div>
                  ) : null}
                </div>
              </StepField>

              {/*
                ── 5. العقارات المشتركة ───────────────────────────────────

                A building standing on two or three adjacent عقارات is ordinary
                here, and `parcelNumber` can name only one of them: the code and
                the per-parcel suffix are derived from it (D9). Recorded here
                rather than entered as a *second building*, which is the
                duplicate §4.4's acknowledgement guard exists to catch.
              */}
              <StepField
                en={en}
                ordinal={!editing && zones.length > 0 ? 5 : 4}
                title={
                  en
                    ? 'Shared across more than one parcel'
                    : 'إن كانت الوحدة مشتركة على أكثر من عقار'
                }
                hint={
                  en
                    ? 'Optional. Add the other parcel numbers the structure stands on — its own is already recorded above.'
                    : 'اختياري. أضف أرقام العقارات الأخرى التي يقوم عليها المبنى — أما عقاره الأساسي فمسجَّل أعلاه.'
                }
              >
                <div className="space-y-2">
                  {sharedParcels.map((value, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={value}
                        onChange={(event) =>
                          setSharedParcels((current) =>
                            current.map((row, position) =>
                              position === index ? event.target.value : row,
                            ),
                          )
                        }
                        dir="ltr"
                        inputMode="numeric"
                        placeholder="1043"
                        aria-label={en ? `Shared parcel ${index + 1}` : `عقار مشترك ${index + 1}`}
                        className="h-10 flex-1 text-start font-mono"
                        invalid={Boolean(value.trim()) && value.trim() === trimmedParcel}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setSharedParcels((current) =>
                            current.filter((_row, position) => position !== index),
                          )
                        }
                        aria-label={en ? 'Remove this parcel' : 'حذف هذا العقار'}
                        className="size-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}

                  {/*
                    Flagged rather than silently dropped. Both this form and the
                    server remove the building's own عقار from the list, and an
                    officer who typed it there believes they have recorded
                    something — telling them why the row will vanish is cheaper
                    than letting them find out it did.
                  */}
                  {sharedParcels.some((value) => value.trim() && value.trim() === trimmedParcel) ? (
                    <p role="alert" className="text-[11px] leading-relaxed text-destructive">
                      {en
                        ? 'The building’s own parcel is already recorded above — that row will not be saved.'
                        : 'عقار المبنى الأساسي مسجَّل أعلاه — لن يُحفظ هذا السطر.'}
                    </p>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => setSharedParcels((current) => [...current, ''])}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-dashed border-primary/50 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
                  >
                    <Plus className="size-3.5 shrink-0" aria-hidden />
                    {sharedParcels.length === 0
                      ? en
                        ? 'Add a shared parcel'
                        : 'إضافة عقار مشترك'
                      : en
                        ? 'Add another'
                        : 'إضافة عقار آخر'}
                  </button>
                </div>
              </StepField>
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

              {/*
                «عدد الطوابق» and «عدد الطوابق تحت الأرض» are not asked here.

                They were two number inputs on this step *and* two steppers on
                the matrix, and the duplication was the defect rather than the
                clutter: an officer typed «٦» here and then painted five floors
                there, and the two disagreed with nothing on either screen to
                say which one the save would believe. (It believed neither
                outright — `create` reconciles the count upward from the units,
                so the typed number only ever mattered when it was *larger*,
                which is the case nobody could see.)

                A floor count is a fact about the matrix. It is now asked where
                the matrix is, by the control that moves the grid — so what the
                officer is looking at is what gets saved, and there is no second
                number to contradict it.
              */}

              <Field
                label={en ? 'Field Notes (Optional)' : 'ملاحظات ميدانية (اختياري)'}
                htmlFor="building-notes"
                error={fieldErrors.notes}
                hint={en ? 'Useful guidance for upcoming field visits' : 'إرشادات تفيد فرق المسح الميداني القادمة'}
              >
                <Textarea
                  id="building-notes"
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder={
                    en ? 'e.g. Side entrance via garden stairs…' : 'مثال: المدخل من الدرج الجانبي عبر الحديقة…'
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
                // Not `setGridUnits` — a house gaining a second block is a
                // question before it is a change. See `requestUnits`.
                onUnitsChange={requestUnits}
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
                  {`${floorsCount} ${en ? 'floors' : 'طوابق'}`}
                  {Number(basementsCount) > 0 ? ` + B${Number(basementsCount)}` : ''}{' '}
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

        {/*
        «هل تريد تحويلها من منزل إلى بناية؟»

        Not destructive — nothing is lost and the answer is very often yes, so
        it gets the neutral treatment rather than the red one. What it is, is
        *consequential*: نوع المنشأة decides which property card the citizen's
        file gets (`STRUCTURE_TYPE_MAP`), whether a card can itemise flats at
        all, and — through `assertUnitFits` — whether this save is accepted.

        Declining keeps the house and drops the paint stroke, which is the
        honest outcome: the grid cannot show two units under a type that
        permits one, so there is no half-state to leave the officer in.
      */}
      <ConfirmDialog
        open={pendingUnits !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnits(null);
        }}
        destructive={false}
        title={
          en
            ? 'Change this from a house to a building?'
            : 'هل تريد تحويلها من منزل مستقل إلى بناية؟'
        }
        description={
          en ? (
            <>
              A standalone house is a single dwelling, so it can hold only one unit. You have
              painted {pendingUnits?.length ?? 0}. Confirming changes نوع المنشأة to
              «بناية سكنية» and keeps what you drew.
            </>
          ) : (
            <>
              المنزل المستقل مسكن واحد ولا يقبل أكثر من وحدة، وقد رسمت{' '}
              {pendingUnits?.length ?? 0} وحدات. التأكيد يغيّر «نوع المنشأة» إلى «بناية سكنية»
              ويُبقي ما رسمته.
            </>
          )
        }
        confirmLabel={en ? 'Yes, it is a building' : 'نعم، هي بناية'}
        cancelLabel={en ? 'No, keep it a house' : 'لا، أبقِها منزلاً'}
        onConfirm={() => {
          const next = pendingUnits;
          setPendingUnits(null);
          if (!next) return;
          /*
            Flagged before the type changes, because changing it is what runs
            the reset that would otherwise throw this grid away — see
            `promotedFromHouse`.
          */
          promotedFromHouse.current = true;
          setStructureType(PROMOTED_STRUCTURE_TYPE);
          /*
            The units are re-typed, not just carried across.

            The block this house was seeded with — and the one the officer
            painted beside it, since the picker defaults from the *current*
            structure type — are both «منزل مستقل». That is not a unit a
            building can contain: `BUILDING_UNIT_TYPES` excludes it precisely
            because a منزل مستقل is what a whole منزل card *is*, and
            `PropertyEntry` refuses it on a مبنى. Left alone, the promotion
            would produce a residential block whose flats are each a standalone
            house — rejected by the card the moment anyone registered a
            household in one, and unselectable in the grid's own edit sheet, so
            the officer could not even correct it by hand.

            Only the ones that say «منزل مستقل» are touched. A محل or a مستودع
            the officer deliberately chose is their answer, and re-typing it
            would be this dialog overruling a decision it was not asked about.

            `defaultUnitTypeFor` rather than a literal «شقة», so a basement
            block comes out as مستودع — the same suggestion the picker would
            have made had the type been right from the start.
          */
          setGridUnits(
            next.map((unit) =>
              unit.unitType === 'INDEPENDENT_HOUSE'
                ? { ...unit, unitType: defaultUnitTypeFor(PROMOTED_STRUCTURE_TYPE, unit.floor) }
                : unit,
            ),
          );
          // The grid has to be at least as wide as what was painted on it: the
          // house seeded a single column, and the second block the officer drew
          // is in the second one.
          setGridSize((current) =>
            Math.max(current, DEFAULT_GRID_SIZE, ...next.map((unit) => unit.endCol)),
          );
          setFloorsCount((current) => (current === '1' ? String(DEFAULT_VERTICAL_BLOCKS) : current));
        }}
      />

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

/**
 * One numbered question in the wizard's first step.
 *
 * ## Why a number rather than just a label
 *
 * This step now asks five things in a fixed order, and the order is the
 * instruction: pick a sector, place the building, confirm what parcel that
 * turned out to be, say whether it is partitioned, list any other parcels it
 * stands on. Each answer narrows the next. A flat stack of labelled fields
 * would present them as five independent questions an officer may answer in
 * any order — and answering the third first is precisely the sequence the old
 * form imposed and this one exists to undo.
 *
 * The ordinals are computed by the caller rather than by a counter here,
 * because the first one disappears on a correction: a building being edited
 * already has a parcel, so it already has a sector, and «اختر القطاع» would be
 * a question whose answer is printed below it.
 *
 * ## Why it does not wrap `Field`
 *
 * `Field` requires an `htmlFor`, which three of these five have no single
 * input to point at — the map, the partition choice and the repeatable parcel
 * list are all sections rather than controls. A `<label>` aimed at an id that
 * does not exist is worse than a heading: it announces to a screen reader that
 * activating it will focus something, and nothing is focused.
 */
function StepField({
  ordinal,
  title,
  hint,
  error,
  required,
  htmlFor,
  en,
  children,
}: {
  ordinal: number;
  title: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Present only where the section really is one control. */
  htmlFor?: string;
  /**
   * Passed rather than read from a context, unlike `Field`'s own copy of this.
   *
   * `Field` falls back to Arabic when it is rendered outside a
   * `FieldFlagProvider`, which is correct for a form that is Arabic by default
   * — but this wizard is rendered at `/en/` too and provides no flag context at
   * all, so an inherited default would print «(اختياري)» in the middle of an
   * English form.
   */
  en: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="relative ps-9 sm:ps-10">
      {/*
        `aria-hidden`, because the number is the visual account of an order a
        screen reader already gets from the document: the sections are in the
        DOM in the order they are asked. Announcing "1" before every label would
        add a digit to each heading and no information to any of them.
      */}
      <span
        aria-hidden
        className="absolute start-0 top-0 flex size-7 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-[11px] font-bold tabular-nums text-primary"
      >
        {ordinal}
      </span>

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-1.5">
          {htmlFor ? (
            <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground/90">
              {title}
            </Label>
          ) : (
            <p className="text-xs font-medium text-foreground/90">{title}</p>
          )}
          {required ? (
            <span
              className="text-xs font-bold text-destructive"
              aria-label={en ? 'Required field' : 'حقل إلزامي'}
            >
              *
            </span>
          ) : (
            <span className="text-xs font-normal text-muted-foreground">
              {en ? '(optional)' : '(اختياري)'}
            </span>
          )}
        </div>

        {children}

        {error ? (
          <p role="alert" className="text-[11px] font-medium text-destructive">
            {error}
          </p>
        ) : null}

        {hint ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </section>
  );
}
