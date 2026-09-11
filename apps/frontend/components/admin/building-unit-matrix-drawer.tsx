'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  ClipboardList,
  DoorClosed,
  Footprints,
  Loader2,
  MapPin,
  Pencil,
  Search,
  ShieldAlert,
  Trash2,
  UserPlus,
  UserRound,
  UserRoundPlus,
} from 'lucide-react';
import {
  CASE_TYPE,
  DAMAGE_LEVEL,
  DAMAGE_SOURCE,
  getLabels,
  OCCUPANCY_ROLE,
  isOccupiableLifecycle,
  STRUCTURE_TYPE_MAP,
  SURVEY_STATUS,
  type CaseType,
  type DamageLevel,
  type DamageSource,
  type OccupancyRole,
  type SurveyStatus,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import {
  addUnit,
  ApiRequestError,
  createCase,
  deleteUnit,
  endOccupancy,
  getBuilding,
  getBuildingDamage,
  listCitizens,
  logApiError,
  logUnitVisit,
  recordDamage,
  recordOccupancy,
  updateUnit,
  type BuildingDetail,
  type CitizenListItem,
  type DamageAssessmentRow,
  type UnitOccupant,
  type UnitVisitRow,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';

/**
 * One building's units, floor by floor, with the four things an officer
 * standing in its stairwell actually does.
 *
 * The grid is the point. A list of units sorted by code tells you nothing you
 * could not get from a table; a floor-by-floor elevation tells you *where the
 * gaps are* — that the third floor is done and the fourth has never been
 * answered — which is the shape of the next visit. Floors run top-down, the way
 * the building stands, so the ground floor is where the eye expects it.
 *
 * Every cell is a real row whether or not anyone has been inside it (D1). A
 * «غير ممسوحة» flat is not an absence of data, it is a datum: nobody has been,
 * and somebody should go.
 *
 * The four actions are here rather than on their own pages because each one is
 * something learned at the door and lost by the time a form is found: who
 * answered, why nobody did, that the flat is empty, that the ceiling is down.
 */

const SEARCH_DEBOUNCE_MS = 350;

/**
 * What an attempt can have produced.
 *
 * `SURVEY_STATUS` minus `NOT_SURVEYED`, which means nobody went — a visit
 * carrying it is a contradiction, and `logVisitSchema` refuses it server-side
 * for the same reason. Derived rather than retyped so a status added to the
 * enum shows up here without anyone remembering to add it.
 */
/**
 * The three levels that mean a structure's use is impaired.
 *
 * The same set the server's `DAMAGED_LEVELS` counts and the ledger's tile
 * shows: an assessment finding a building *undamaged* is still an assessment,
 * and colouring it as damage would make the figure rise every time an officer
 * confirmed one was fine.
 */
const DAMAGED_LEVELS: readonly DamageLevel[] = [
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
];

const VISIT_OUTCOMES = SURVEY_STATUS.filter(
  (status): status is Exclude<SurveyStatus, 'NOT_SURVEYED'> => status !== 'NOT_SURVEYED',
);

/** Which unit action is open, if any. `null` = just the matrix. */
type ActionKind = 'occupant' | 'case' | 'damage' | 'visit' | null;

/**
 * The badge a cell wears, in the officer's own vocabulary.
 *
 * Occupancy outranks survey status deliberately: a flat with somebody recorded
 * in it is answered, and the name is the most useful thing the cell can carry —
 * it is what makes «الطابق الثالث» resolve to a person rather than a number.
 * Below that the survey status speaks for itself, and «غير ممسوحة» is left
 * plain rather than tinted a warning colour, because on a freshly generated
 * matrix every cell is that and a wall of amber says nothing.
 */
function cellBadge(
  unit: UnitWithOccupants,
  labels: ReturnType<typeof getLabels>,
  en: boolean,
): { text: string; variant: 'soft-success' | 'soft-warning' | 'soft-destructive' | 'soft-info' | 'soft-muted' } {
  /*
    Named after whoever is *inside*, not whoever registered most recently.

    This took the first current spell the server happened to return, ordered by
    `toDate` then `fromDate`. So a flat with an owner and a tenant on it was
    labelled with whichever of the two filed last, and two identical situations
    on one floor read as two different kinds of record — «مسجلة (المستأجر)»
    beside «مسجلة (المالك)», with nothing to say why they differed.

    A مستأجر or a شاغل بتسامح outranks a مالك because the cell answers «من في
    هذه الوحدة؟», and an owner in the occupancy table has not said they live
    there — the deed is not a statement of residence (D2). Where the only
    current spell is an owner's, they are the answer.
  */
  const current = unit.occupants
    .filter((occupant) => occupant.toDate === null)
    .sort((a, b) => {
      const rank = (role: string) => (role === 'OWNER' ? 1 : 0);
      if (rank(a.role) !== rank(b.role)) return rank(a.role) - rank(b.role);
      // Within one rank the newest spell wins — a flat re-let this month is
      // described by its present tenant, not the one before them.
      return a.fromDate < b.fromDate ? 1 : -1;
    })[0];

  if (current) {
    const who = current.citizenName
      ? `${labels.occupancyRole[current.role]}: ${current.citizenName}`
      : labels.occupancyRole[current.role];
    return {
      text: en ? `Registered (${who})` : `مسجلة (${who})`,
      variant: 'soft-success',
    };
  }

  switch (unit.surveyStatus) {
    case 'VACANT_CONFIRMED':
      return { text: en ? 'Vacant' : 'شاغرة', variant: 'soft-info' };
    case 'VISITED_NO_ANSWER':
      return { text: en ? 'Revisit' : 'إعادة زيارة', variant: 'soft-warning' };
    case 'REFUSED':
    case 'INACCESSIBLE':
      return { text: labels.surveyStatus[unit.surveyStatus], variant: 'soft-destructive' };
    case 'DEMOLISHED':
      return { text: labels.surveyStatus[unit.surveyStatus], variant: 'soft-destructive' };
    case 'PARTIAL':
      return { text: labels.surveyStatus[unit.surveyStatus], variant: 'soft-warning' };
    case 'COMPLETE':
      return { text: labels.surveyStatus[unit.surveyStatus], variant: 'soft-success' };
    default:
      return { text: en ? 'Not surveyed' : 'غير ممسوحة', variant: 'soft-muted' };
  }
}

/** «الطابق الثالث» / «القبو ١» — the floor as it is spoken, not as it is stored. */
function floorLabel(floor: number, en: boolean): string {
  if (en) {
    if (floor === 0) return 'Ground floor';
    if (floor < 0) return `Basement ${Math.abs(floor)}`;
    return `Floor ${floor}`;
  }
  if (floor === 0) return 'الطابق الأرضي';
  if (floor < 0) return `القبو ${Math.abs(floor)}`;
  return `الطابق ${floor}`;
}

export function BuildingUnitMatrixDrawer({
  open,
  onClose,
  tenant,
  token,
  buildingId,
  canWrite,
  onChanged,
  onEditBuilding,
  registerHref,
  citizenHref,
  locale = 'ar',
}: {
  open: boolean;
  onClose: () => void;
  tenant: string;
  token: string;
  /** Null while the drawer is closing — nothing is fetched. */
  buildingId: string | null;
  /** AUDITOR and ACCOUNTANT read the matrix; they do not write to it. */
  canWrite: boolean;
  /** Fired after any write, so the ledger behind the drawer re-reads its rows. */
  onChanged?: () => void;
  /** Opens the building editor — the only route to a matrix for an empty shell. */
  onEditBuilding?: (building: BuildingDetail) => void;
  /**
   * Where «تسجيل أسرة في هذه الوحدة» goes.
   *
   * A URL the caller builds, rather than a router push from in here: this
   * drawer is opened from two different routes (the ledger and the map) whose
   * admin base paths it has no business reconstructing.
   */
  registerHref?: (buildingId: string, unitId: string) => string;
  /**
   * Where an occupant's name goes — their own record.
   *
   * Built by the caller for the same reason `registerHref` is: three routes
   * open this drawer and none of their admin base paths are this component's
   * to reconstruct. Optional, and where it is absent the name renders as plain
   * text rather than a link that goes nowhere.
   *
   * The occupancy list is the one place in the census that names a person, and
   * it was a dead end: an officer reading «مستأجر: فلان» had to memorise the
   * name, leave the matrix, and search the citizens page for it.
   */
  citizenHref?: (citizenId: string) => string;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();

  const [building, setBuilding] = useState<BuildingDetail | null>(null);
  const [damage, setDamage] = useState<{
    current: DamageLevel | null;
    history: DamageAssessmentRow[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!buildingId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, condition] = await Promise.all([
        getBuilding(tenant, token, buildingId),
        // A failed damage read must not take the matrix down with it: the units
        // are the reason the drawer was opened, the condition log is context.
        getBuildingDamage(tenant, token, buildingId).catch(() => null),
      ]);
      setBuilding(detail);
      setDamage(condition);
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not load the building.'
            : 'تعذّر تحميل المبنى.',
      );
    } finally {
      setLoading(false);
    }
  }, [tenant, token, buildingId, en]);

  useEffect(() => {
    if (!open || !buildingId) {
      setBuilding(null);
      setDamage(null);
      setSelectedUnitId(null);
      setAction(null);
      setActionError(null);
      return;
    }
    void load();
  }, [open, buildingId, load]);

  /** Floors top-down, so the matrix stands the way the building does. */
  const floors = useMemo(() => {
    const grouped = new Map<number, UnitWithOccupants[]>();
    for (const unit of building?.units ?? []) {
      grouped.set(unit.floor, [...(grouped.get(unit.floor) ?? []), unit]);
    }
    return [...grouped.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([floor, units]) => ({
        floor,
        units: [...units].sort((a, b) => a.sequence - b.sequence),
      }));
  }, [building]);

  const selectedUnit = useMemo(
    () => building?.units.find((unit) => unit.id === selectedUnitId) ?? null,
    [building, selectedUnitId],
  );

  /**
   * The spells running in the open unit **right now**.
   *
   * Deliberately not the same question the delete guard asks. That one tests
   * `occupants.length === 0` — every spell ever, ended ones included — because
   * `deleteUnit` refuses on a historical occupancy too: D2 keeps ended spells
   * precisely so the municipality outlives the card, and a cascade would erase
   * them. Narrowing it to live spells would show «حذف الوحدة» on a unit the
   * server will refuse to delete.
   *
   * «تأكيد الشغور» is the opposite: a flat whose last tenant moved out *is*
   * empty and may be marked so. Only a live spell contradicts it.
   */
  const liveOccupants = useMemo(
    () => (selectedUnit?.occupants ?? []).filter((occupant) => occupant.toDate === null),
    [selectedUnit],
  );

  /** Which floor's «إضافة وحدة» row is open, and the type chosen in it. */
  const [addingFloor, setAddingFloor] = useState<number | null>(null);
  const [addingType, setAddingType] = useState('');

  const surveyed = building?.unitsSurveyed ?? 0;
  const total = building?.unitsTotal ?? 0;

  /** Every write funnels through here so the reload and the toast are never forgotten. */
  const run = useCallback(
    async (task: () => Promise<string>, failure: string) => {
      setBusy(true);
      setActionError(null);
      try {
        const message = await task();
        await load();
        onChanged?.();
        setAction(null);
        toast.success(message);
      } catch (caught) {
        logApiError(caught);
        const message = caught instanceof ApiRequestError ? caught.payload.message : failure;
        setActionError(message);
        toast.error(failure, { description: message });
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged, toast],
  );

  /**
   * Adds a flat to one floor of the matrix.
   *
   * The counterpart to the blueprint, which can only state a floor *range* and
   * a count per floor. Real buildings are not uniform — a ground floor with one
   * محل under three flats a storey, a fourth floor added since the survey — and
   * until now the only way to record the odd one out was to re-run a blueprint
   * wide enough to cover it, which tops every other floor up to the same count
   * and invents flats that do not exist.
   *
   * Only the type is asked. The floor comes from the row the button sits in,
   * and `unitCode` is the server's to derive — `floor × 100 + sequence`, under
   * an advisory lock so two officers filling one matrix cannot both claim the
   * same position.
   */
  const addOnFloor = (floor: number, unitType: string) => {
    if (!building || !unitType) return;
    return run(
      async () => {
        const created = await addUnit(tenant, token, building.id, {
          floor,
          unitType: unitType as UpsertUnitInput['unitType'],
        });
        setAddingFloor(null);
        setAddingType('');
        return en ? `Unit ${created.unitCode} added` : `تمت إضافة الوحدة ${created.unitCode}`;
      },
      en ? 'Could not add the unit.' : 'تعذّرت إضافة الوحدة.',
    );
  };

  /**
   * Removes a flat the matrix says exists and the street does not.
   *
   * The server refuses the moment anything has been recorded against the unit —
   * an occupancy current or past, a visit, a damage assessment, a citizen's
   * card naming it — and each refusal names its own remedy. Those messages are
   * surfaced verbatim by `run`, which is the point: «عليها كشف ضرر» tells the
   * officer something a generic failure would not, and the alternative to
   * deleting is different in each case.
   */
  const removeUnit = (unit: UnitWithOccupants) =>
    run(
      async () => {
        await deleteUnit(tenant, token, unit.id);
        setSelectedUnitId(null);
        return en ? `Unit ${unit.unitCode} removed` : `تم حذف الوحدة ${unit.unitCode}`;
      },
      en ? 'Could not remove the unit.' : 'تعذّر حذف الوحدة.',
    );

  const markVacant = (unit: UnitWithOccupants) =>
    run(
      async () => {
        await updateUnit(tenant, token, unit.id, {
          surveyStatus: 'VACANT_CONFIRMED',
          unitStatus: 'VACANT',
        });
        return en ? `Unit ${unit.unitCode} confirmed vacant` : `تم تأكيد شغور الوحدة ${unit.unitCode}`;
      },
      en ? 'Could not update the unit.' : 'تعذّر تحديث الوحدة.',
    );

  /*
    Ending a spell also releases the citizen's own claim on the flat — see
    `BuildingsService.endOccupancy` — and the message says so, because that
    half happens inside a file the officer is not looking at. Told plainly
    rather than left to be discovered from a bill that stopped arriving.
  */
  const closeSpell = (occupant: UnitOccupant) =>
    run(
      async () => {
        await endOccupancy(tenant, token, occupant.id);
        return en
          ? "Occupancy ended, and the property released from their file"
          : 'تم إنهاء الإشغال وفصل العقار عن ملف المواطن';
      },
      en ? 'Could not end the occupancy.' : 'تعذّر إنهاء الإشغال.',
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      className="max-w-3xl"
      title={building ? building.code : en ? 'Building' : 'المبنى'}
      description={
        building
          ? [
              building.name,
              en ? `Parcel ${building.parcelNumber}` : `عقار ${building.parcelNumber}`,
              building.zoneName,
            ]
              .filter(Boolean)
              .join(' — ')
          : undefined
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {en ? 'Loading…' : 'جاري التحميل…'}
        </div>
      ) : error ? (
        <div className="space-y-3 py-8 text-center">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {en ? 'Retry' : 'إعادة المحاولة'}
          </Button>
        </div>
      ) : building ? (
        <div className="space-y-5">
          {/* ── What the structure is ─────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="soft-default">{labels.structureType[building.structureType]}</Badge>
            {/*
              Shown only when it is not «قائم ومستعمل».

              The ordinary answer on nineteen buildings in twenty, and a badge
              that appears on all of them stops being read. Here it earns its
              place: this drawer is where an officer decides whether to walk the
              stairwell, and «قيد الإنشاء» is the answer that means not yet.
            */}
            {building.lifecycleStatus !== 'IN_USE' ? (
              <Badge variant="soft-warning">
                {labels.buildingLifecycle[building.lifecycleStatus]}
              </Badge>
            ) : null}
            <Badge variant="soft-muted">
              {en
                ? `${building.floorsCount} floors`
                : `${building.floorsCount} طابق`}
            </Badge>
            <Badge
              variant={
                !isOccupiableLifecycle(building.lifecycleStatus)
                  ? 'soft-muted'
                  : total > 0 && surveyed === total
                    ? 'soft-success'
                    : 'soft-muted'
              }
            >
              {/*
                A matrix on a structure nobody can be inside is an inventory,
                not outstanding work — and the ledger's figures leave it out.
                Saying «٠ من ٦ ممسوحة» here beside a total the census does not
                count would read as six doors somebody is failing to knock on.
              */}
              {!isOccupiableLifecycle(building.lifecycleStatus)
                ? en
                  ? `${total} units recorded — not counted as survey work`
                  : `${total} وحدة مسجَّلة — غير محتسبة ضمن أعمال المسح`
                : en
                  ? `${surveyed} of ${total} units surveyed`
                  : `${surveyed} من ${total} وحدة ممسوحة`}
            </Badge>
            {building.postedNumber ? (
              <Badge variant="soft-info">
                {en ? `Posted: ${building.postedNumber}` : `مكتوب: ${building.postedNumber}`}
              </Badge>
            ) : null}
            {damage?.current ? (
              <Badge variant="soft-destructive" className="gap-1">
                <ShieldAlert className="size-3" aria-hidden />
                {labels.damageLevel[damage.current]}
              </Badge>
            ) : null}
            {building.latitude != null ? (
              <Badge variant="soft-muted" className="gap-1">
                <MapPin className="size-3" aria-hidden />
                {en ? 'Located' : 'محدَّد الموقع'}
              </Badge>
            ) : null}
          </div>

          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedUnitId(null);
                  setActionError(null);
                  setAction('damage');
                }}
              >
                <ShieldAlert className="size-4" aria-hidden />
                {en ? 'Assess the building' : 'كشف ضرر على المبنى'}
              </Button>
              {onEditBuilding ? (
                <Button variant="outline" size="sm" onClick={() => onEditBuilding(building)}>
                  <Pencil className="size-4" aria-hidden />
                  {en ? 'Edit building' : 'تعديل المبنى'}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* ── The matrix ────────────────────────────────────────── */}
          {floors.length === 0 ? (
            <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
              <Building2 className="mx-auto size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">
                {en ? 'No units recorded yet' : 'لم تُسجَّل أي وحدة بعد'}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'The shell exists but its matrix is empty. Generate the floors from the building editor — the flats are recorded as existing, not as surveyed.'
                  : 'المبنى مسجَّل لكن مصفوفة وحداته فارغة. ولّد الطوابق من محرّر المبنى — تُسجَّل الوحدات كموجودة، لا كممسوحة.'}
              </p>
              {canWrite && onEditBuilding ? (
                <Button size="sm" onClick={() => onEditBuilding(building)}>
                  {en ? 'Generate the matrix' : 'توليد المصفوفة'}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              {floors.map(({ floor, units }) => (
                <div key={floor} className="rounded-lg border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1.5">
                    <p className="text-xs font-semibold">{floorLabel(floor, en)}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        {en ? `${units.length} units` : `${units.length} وحدة`}
                      </p>
                      {/*
                        Per floor, because the floor is the thing the officer is
                        looking at. The blueprint in the building editor can only
                        state a range and a count per floor, so recording a
                        ground-floor محل under three flats a storey meant running
                        a blueprint wide enough to cover it — which tops every
                        other floor up to the same count and invents flats.
                      */}
                      {canWrite && addingFloor !== floor ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setAddingFloor(floor);
                            // What this structure is made of, per
                            // `STRUCTURE_TYPE_MAP` — the same default the
                            // building editor's blueprint starts from.
                            setAddingType(
                              STRUCTURE_TYPE_MAP[building.structureType].defaultUnitType,
                            );
                            setActionError(null);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                        >
                          <UserPlus className="size-3" aria-hidden />
                          {en ? 'Add unit' : 'إضافة وحدة'}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {addingFloor === floor ? (
                    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
                      <Select value={addingType} onValueChange={setAddingType}>
                        <SelectTrigger className="h-8 w-44 text-xs">
                          <SelectValue placeholder={en ? 'Unit type…' : 'نوع الوحدة…'} />
                        </SelectTrigger>
                        <SelectContent>
                          {BUILDING_UNIT_TYPES.map((option) => (
                            <SelectItem key={option} value={option}>
                              {labels.unitType[option]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        disabled={busy || !addingType}
                        onClick={() => void addOnFloor(floor, addingType)}
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                        {en ? 'Add' : 'إضافة'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setAddingFloor(null);
                          setAddingType('');
                        }}
                      >
                        {en ? 'Cancel' : 'إلغاء'}
                      </Button>
                      <span className="text-[11px] text-muted-foreground">
                        {en
                          ? 'The code is assigned from the floor.'
                          : 'يُشتق رمز الوحدة من الطابق.'}
                      </span>
                    </div>
                  ) : null}
                  <ul className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3">
                    {units.map((unit) => {
                      const badge = cellBadge(unit, labels, en);
                      const selected = unit.id === selectedUnitId;
                      return (
                        <li key={unit.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedUnitId(selected ? null : unit.id);
                              setAction(null);
                              setActionError(null);
                            }}
                            aria-pressed={selected}
                            className={cn(
                              'w-full rounded-md border p-2.5 text-start transition-colors',
                              selected
                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                : 'hover:bg-accent/50',
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-sm font-bold" dir="ltr">
                                {unit.unitCode}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {labels.unitType[unit.unitType]}
                              </span>
                            </div>
                            <Badge variant={badge.variant} className="mt-1.5 max-w-full truncate">
                              {badge.text}
                            </Badge>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                              {unit.postedNumber ? (
                                <span>
                                  {en ? 'Door: ' : 'الباب: '}
                                  <span dir="ltr">{unit.postedNumber}</span>
                                </span>
                              ) : null}
                              {/*
                                The count, not the status (D10). «٣ محاولات» is
                                the difference between assigning a door and
                                escalating it, and the status alone cannot say
                                it — three fruitless visits and one read the
                                same `VISITED_NO_ANSWER`.
                              */}
                              {unit.visitCount > 0 ? (
                                <span className="flex items-center gap-1">
                                  <Footprints className="size-3 shrink-0" aria-hidden />
                                  {en
                                    ? `${unit.visitCount} attempt${unit.visitCount === 1 ? '' : 's'}`
                                    : `${unit.visitCount} محاولة`}
                                </span>
                              ) : null}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* ── The selected unit, and the four things to do with it ─ */}
          {selectedUnit ? (
            <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/[0.03] p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">
                  <span dir="ltr" className="font-mono">
                    {building.code}-{selectedUnit.unitCode}
                  </span>
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {floorLabel(selectedUnit.floor, en)} · {labels.unitType[selectedUnit.unitType]}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {labels.surveyStatus[selectedUnit.surveyStatus]}
                </p>
              </div>

              {/*
                Current occupants and past ones, told apart at a glance.

                They used to render identically — same weight, same badge, the
                only difference a date range instead of «منذ». So a flat whose
                owner had been moved out and replaced showed two rows that
                looked equally live, and the honest reading of the panel was
                that both people held the unit. Naming a former spell «سابق»
                and dimming it makes the answer to «من في هذه الوحدة الآن؟» the
                thing the eye lands on.
              */}
              {selectedUnit.occupants.length > 0 ? (
                <ul className="space-y-1.5">
                  {selectedUnit.occupants.map((occupant) => {
                    const current = occupant.toDate === null;
                    /*
                      The census has them here; their own registration does not
                      name the property. «تسجيل شاغل» records the first without
                      the second, which is right at the doorstep and wrong left
                      alone: billing reads the file, so an unbacked occupant is
                      a household nobody charges, and their file still names
                      whatever property it did name — possibly a different
                      building entirely.

                      Only said of a *current* occupant. A former spell whose
                      link was released on the way out is not missing anything.
                    */
                    const unbacked = current && occupant.backedByFile === false;

                    return (
                      <li
                        key={occupant.id}
                        className={cn(
                          'flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs',
                          current ? 'bg-background' : 'bg-muted/40 text-muted-foreground',
                        )}
                      >
                        <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {/*
                          The name opens their record.

                          This list is the one place the census names a person,
                          and it was a dead end: «مستأجر: فلان» with no way
                          through meant memorising the name, leaving the matrix
                          and searching the citizens page for it — which is also
                          how an officer ends up filing a second record for
                          somebody already registered.

                          A former occupant's name is a link too. Their spell
                          ended; their file did not, and it is frequently the
                          record somebody is looking for.
                        */}
                        {citizenHref ? (
                          <Link
                            href={citizenHref(occupant.citizenId)}
                            className={cn(
                              'underline-offset-2 hover:underline',
                              current ? 'font-medium' : 'font-normal line-through',
                            )}
                          >
                            {occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}
                          </Link>
                        ) : (
                          <span className={cn(current ? 'font-medium' : 'font-normal line-through')}>
                            {occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}
                          </span>
                        )}
                        <Badge variant="soft-muted">{labels.occupancyRole[occupant.role]}</Badge>
                        {!current ? (
                          <Badge variant="outline">{en ? 'Former' : 'سابق'}</Badge>
                        ) : null}
                        {occupant.shares ? (
                          <span className="text-muted-foreground">
                            {en ? `${occupant.shares}/2400 shares` : `${occupant.shares}/٢٤٠٠ سهم`}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground">
                          {occupant.toDate
                            ? `${formatDate(occupant.fromDate)} — ${formatDate(occupant.toDate)}`
                            : `${en ? 'since' : 'منذ'} ${formatDate(occupant.fromDate)}`}
                        </span>
                        {unbacked ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-500"
                            title={
                              en
                                ? "Recorded on the matrix only. Add this property to the citizen's file so it can be billed."
                                : 'مسجَّل على المصفوفة فقط. أضف هذا العقار إلى ملف المواطن ليُحتسب في الرسوم.'
                            }
                          >
                            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                            {en ? 'Not in their file' : 'غير مرتبط بملفه'}
                          </span>
                        ) : null}
                        {canWrite && current ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void closeSpell(occupant)}
                            className="ms-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                          >
                            {en ? 'End tenancy' : 'إنهاء الإشغال'}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={action === 'occupant' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setAction(action === 'occupant' ? null : 'occupant');
                    }}
                  >
                    <UserPlus className="size-4" aria-hidden />
                    {en ? 'Register occupant' : 'تسجيل شاغل'}
                  </Button>
                  <Button
                    size="sm"
                    variant={action === 'case' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setAction(action === 'case' ? null : 'case');
                    }}
                  >
                    <ClipboardList className="size-4" aria-hidden />
                    {en ? 'Log a case' : 'تسجيل حالة'}
                  </Button>
                  {/*
                    A flat cannot be empty and lived in at the same time.

                    This was enabled over live occupancies and wrote «شاغرة»
                    straight across them — leaving a unit that says nobody is
                    there beside the rows naming who is, and quietly dropping
                    the owner's occupancy fee, because `isUnoccupied` exempts a
                    vacant flat. `updateUnit` now refuses it outright; the
                    button says why rather than letting an officer discover it
                    from an error, and «إنهاء الإشغال» directly above is the
                    action that actually means what they want.
                  */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      selectedUnit.surveyStatus === 'VACANT_CONFIRMED' ||
                      liveOccupants.length > 0
                    }
                    title={
                      liveOccupants.length > 0
                        ? en
                          ? 'End the occupancies first — this unit has people recorded in it'
                          : 'أنهِ الإشغال أولاً — يوجد شاغل مسجَّل في هذه الوحدة'
                        : undefined
                    }
                    onClick={() => void markVacant(selectedUnit)}
                  >
                    <DoorClosed className="size-4" aria-hidden />
                    {en ? 'Mark vacant' : 'تأكيد الشغور'}
                  </Button>
                  <Button
                    size="sm"
                    variant={action === 'damage' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setAction(action === 'damage' ? null : 'damage');
                    }}
                  >
                    <ShieldAlert className="size-4" aria-hidden />
                    {en ? 'Assess damage' : 'كشف ضرر'}
                  </Button>
                  <Button
                    size="sm"
                    variant={action === 'visit' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setAction(action === 'visit' ? null : 'visit');
                    }}
                  >
                    <Footprints className="size-4" aria-hidden />
                    {en ? 'Log a visit' : 'تسجيل زيارة'}
                  </Button>
                  {/*
                    The full registration form, pre-pointed at this flat.

                    A link rather than a fifth inline form: registering a
                    household is the citizen form's whole job — identity,
                    contact, household size, documents — and reproducing any of
                    it here would be a second, thinner version of the one screen
                    that must not drift. `registerHref` carries the building and
                    the unit so the officer does not re-find them.
                  */}
                  {registerHref ? (
                    <a
                      href={registerHref(building.id, selectedUnit.id)}
                      className={cn(
                        'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent',
                      )}
                    >
                      <UserRoundPlus className="size-4" aria-hidden />
                      {en ? 'Register a household here' : 'تسجيل أسرة في هذه الوحدة'}
                    </a>
                  ) : null}

                  {/*
                    Offered only for a flat nothing has been recorded against.

                    The condition mirrors the server's refusals rather than
                    trusting them to arrive: a unit with an occupant — current
                    or historical — a visit, or a damage assessment is one whose
                    deletion would cascade that history away, and the server
                    says no. Hiding the button in the cases it would be refused
                    keeps «حذف الوحدة» meaning "this flat does not exist" rather
                    than "try and find out".

                    The remaining refusal, a citizen's card naming the unit, is
                    not visible from here — so it still arrives as a message,
                    and `run` surfaces it verbatim.
                  */}
                  {canWrite &&
                  selectedUnit.occupants.length === 0 &&
                  selectedUnit.visitCount === 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void removeUnit(selectedUnit)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {en ? 'Delete unit' : 'حذف الوحدة'}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {action === 'occupant' ? (
                <OccupantForm
                  tenant={tenant}
                  token={token}
                  busy={busy}
                  locale={locale}
                  onSubmit={(citizen, role, shares) =>
                    void run(
                      async () => {
                        const result = await recordOccupancy(tenant, token, {
                          unitId: selectedUnit.id,
                          citizenId: citizen.id,
                          role,
                          shares,
                        });
                        // The count is surfaced, never swallowed: closing
                        // somebody else's dispatch item silently is how a case
                        // list stops being believed.
                        return result.casesResolved > 0
                          ? en
                            ? `${citizen.fullName} recorded — ${result.casesResolved} case(s) resolved`
                            : `تم تسجيل ${citizen.fullName} — أُغلقت ${result.casesResolved} حالة`
                          : en
                            ? `${citizen.fullName} recorded in unit ${selectedUnit.unitCode}`
                            : `تم تسجيل ${citizen.fullName} في الوحدة ${selectedUnit.unitCode}`;
                      },
                      en ? 'Could not record the occupancy.' : 'تعذّر تسجيل الإشغال.',
                    )
                  }
                />
              ) : null}

              {action === 'case' ? (
                <CaseForm
                  busy={busy}
                  locale={locale}
                  onSubmit={(values) =>
                    void run(
                      async () => {
                        await createCase(tenant, token, {
                          notes: values.notes,
                          caseType: values.caseType,
                          buildingId: building.id,
                          unitId: selectedUnit.id,
                          propertyNumber: building.parcelNumber,
                          buildingName: building.name ?? undefined,
                          scheduledRevisitAt: values.revisitAt || undefined,
                        });
                        /*
                          A logged case is a promise to come back, so the unit
                          says so too. Only from the two states that mean "we
                          still do not know" — a flat already marked vacant or
                          demolished carries a finding this must not overwrite.
                        */
                        if (
                          selectedUnit.surveyStatus === 'NOT_SURVEYED' &&
                          values.caseType === 'UNIT_UNREACHABLE'
                        ) {
                          await updateUnit(tenant, token, selectedUnit.id, {
                            surveyStatus: 'VISITED_NO_ANSWER',
                          });
                        }
                        return en ? 'Case logged' : 'تم تسجيل الحالة';
                      },
                      en ? 'Could not log the case.' : 'تعذّر تسجيل الحالة.',
                    )
                  }
                />
              ) : null}

              {action === 'visit' ? (
                <VisitForm
                  busy={busy}
                  locale={locale}
                  attempts={selectedUnit.visitCount}
                  visits={selectedUnit.visits}
                  onSubmit={(values) =>
                    void run(
                      async () => {
                        const result = await logUnitVisit(tenant, token, {
                          unitId: selectedUnit.id,
                          outcome: values.outcome,
                          visitedAt: values.visitedAt || undefined,
                          notes: values.notes || undefined,
                        });
                        return en
                          ? `Visit logged — ${result.visitCount} attempt(s) on this unit`
                          : `تم تسجيل الزيارة — ${result.visitCount} محاولة على هذه الوحدة`;
                      },
                      en ? 'Could not log the visit.' : 'تعذّر تسجيل الزيارة.',
                    )
                  }
                />
              ) : null}

              {action === 'damage' ? (
                <DamageForm
                  busy={busy}
                  locale={locale}
                  target={en ? `unit ${selectedUnit.unitCode}` : `الوحدة ${selectedUnit.unitCode}`}
                  onSubmit={(values) =>
                    void run(
                      async () => {
                        await recordDamage(tenant, token, {
                          unitId: selectedUnit.id,
                          level: values.level,
                          source: values.source,
                          observations: values.observations || undefined,
                          assessedAt: values.assessedAt || undefined,
                        });
                        return en ? 'Assessment recorded' : 'تم تسجيل الكشف';
                      },
                      en ? 'Could not record the assessment.' : 'تعذّر تسجيل الكشف.',
                    )
                  }
                />
              ) : null}

              {actionError ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {actionError}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Building-level assessment, when no unit is selected. */}
          {!selectedUnit && action === 'damage' && canWrite ? (
            <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/[0.03] p-3">
              <DamageForm
                busy={busy}
                locale={locale}
                target={en ? `building ${building.code}` : `المبنى ${building.code}`}
                onSubmit={(values) =>
                  void run(
                    async () => {
                      await recordDamage(tenant, token, {
                        buildingId: building.id,
                        level: values.level,
                        source: values.source,
                        observations: values.observations || undefined,
                        assessedAt: values.assessedAt || undefined,
                      });
                      return en ? 'Assessment recorded' : 'تم تسجيل الكشف';
                    },
                    en ? 'Could not record the assessment.' : 'تعذّر تسجيل الكشف.',
                  )
                }
              />
              {actionError ? (
                <p role="alert" className="text-xs text-destructive">
                  {actionError}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ── The damage history panel (P4-T2) ──────────────────── */}
          {damage && damage.history.length > 0 ? (
            <div className="space-y-2 rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <ShieldAlert className="size-3.5 text-muted-foreground" aria-hidden />
                  {en ? 'Damage history' : 'سجل الأضرار'}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {en
                    ? `${damage.history.length} assessment(s) · current: ${
                        damage.current ? labels.damageLevel[damage.current] : '—'
                      }`
                    : `${damage.history.length} كشف · الحالي: ${
                        damage.current ? labels.damageLevel[damage.current] : '—'
                      }`}
                </p>
              </div>

              {/*
                Append-only, newest first, and the first row is labelled as the
                current one (D3).

                A building assessed unsafe in 2024 and repaired in 2026 keeps
                both rows, and that is the entire point of the table: the 2024
                row is what a compensation claim rests on, while the 2026 row is
                what decides whether anyone may enter today. Showing only the
                latest would answer the second question and destroy the first.
              */}
              <ul className="divide-y">
                {damage.history.map((row, position) => {
                  const unit = row.unitId
                    ? building.units.find((candidate) => candidate.id === row.unitId)
                    : null;
                  return (
                    <li key={row.id} className="space-y-1 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            DAMAGED_LEVELS.includes(row.level) ? 'soft-destructive' : 'soft-success'
                          }
                        >
                          {labels.damageLevel[row.level]}
                        </Badge>
                        {position === 0 ? (
                          <Badge variant="soft-default">{en ? 'Current' : 'الحالي'}</Badge>
                        ) : null}
                        <span className="text-muted-foreground">{formatDate(row.assessedAt)}</span>
                        <Badge variant="soft-muted">{labels.damageSource[row.source]}</Badge>
                        {/*
                          Which part of the structure this reading is about.
                          "Top three floors gone, ground floor shop still
                          trading" is two rows on one building, and a panel that
                          did not say which was which would read as a
                          contradiction.
                        */}
                        <Badge variant="soft-muted">
                          {row.unitId
                            ? en
                              ? `Unit ${unit?.unitCode ?? '—'}`
                              : `الوحدة ${unit?.unitCode ?? '—'}`
                            : en
                              ? 'Whole building'
                              : 'المبنى بكامله'}
                        </Badge>
                      </div>

                      {row.observations ? (
                        <p className="leading-relaxed text-muted-foreground">{row.observations}</p>
                      ) : null}

                      {row.assessedByName ? (
                        <p className="text-[11px] text-muted-foreground">
                          {en ? 'Assessed by ' : 'الكاشف: '}
                          {row.assessedByName}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {building.notes ? (
            <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {building.notes}
            </p>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Who is in the flat — searched for, because the person at the door is very
 * often already on file from a different property.
 */
function OccupantForm({
  tenant,
  token,
  busy,
  locale,
  onSubmit,
}: {
  tenant: string;
  token: string;
  busy: boolean;
  locale: string;
  onSubmit: (citizen: CitizenListItem, role: OccupancyRole, shares?: number) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<CitizenListItem | null>(null);
  const [role, setRole] = useState<OccupancyRole>('OWNER');
  const [shares, setShares] = useState('');

  useEffect(() => {
    if (!term.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: term.trim(), limit: 6 })
        .then((result) => {
          if (!cancelled) setResults(result.items);
        })
        .catch((caught) => {
          logApiError(caught);
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, tenant, token]);

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      {chosen ? (
        <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2.5 py-2 text-sm">
          <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">{chosen.fullName}</span>
          {chosen.phone ? (
            <span dir="ltr" className="text-xs text-muted-foreground">
              {chosen.phone}
            </span>
          ) : null}
          <button
            type="button"
            className="ms-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setChosen(null)}
          >
            {en ? 'Change' : 'تغيير'}
          </button>
        </div>
      ) : (
        <>
          <Field label={en ? 'Find the citizen' : 'ابحث عن المواطن'} htmlFor="occupant-search" required>
            <div className="relative">
              <Search
                className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="occupant-search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                className="ps-9"
                placeholder={en ? 'Name, phone or reference…' : 'الاسم أو الهاتف أو رقم القيد…'}
              />
            </div>
          </Field>

          {searching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {en ? 'Searching…' : 'جاري البحث…'}
            </p>
          ) : results.length > 0 ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {results.map((citizen) => (
                <li key={citizen.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(citizen)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-sm transition-colors hover:bg-accent"
                  >
                    <span className="font-medium">{citizen.fullName}</span>
                    {citizen.phone ? (
                      <span dir="ltr" className="text-xs text-muted-foreground">
                        {citizen.phone}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : term.trim() ? (
            <p className="text-xs text-muted-foreground">
              {en
                ? 'No match. Register the citizen first, then come back to this unit.'
                : 'لا نتيجة. سجّل المواطن أولاً ثم عد إلى هذه الوحدة.'}
            </p>
          ) : null}
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={en ? 'Capacity' : 'صفة الإشغال'} htmlFor="occupant-role" required>
          <Select value={role} onValueChange={(value) => setRole(value as OccupancyRole)}>
            <SelectTrigger id="occupant-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OCCUPANCY_ROLE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.occupancyRole[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Shares are a fraction of ownership — the server refuses them on a
            tenant, so the field is not offered to one. */}
        {role === 'OWNER' ? (
          <Field
            label={en ? 'Shares (of 2400)' : 'الأسهم (من ٢٤٠٠)'}
            htmlFor="occupant-shares"
            hint={en ? 'Leave empty if not known' : 'اتركه فارغاً إن لم يكن معروفاً'}
          >
            <Input
              id="occupant-shares"
              type="number"
              min={1}
              max={2400}
              value={shares}
              onChange={(event) => setShares(event.target.value)}
              dir="ltr"
              className="text-start"
            />
          </Field>
        ) : null}
      </div>

      <Button
        size="sm"
        disabled={busy || !chosen}
        onClick={() => {
          if (!chosen) return;
          const parsed = Number(shares);
          onSubmit(
            chosen,
            role,
            role === 'OWNER' && shares.trim() && Number.isFinite(parsed) ? parsed : undefined,
          );
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {en ? 'Record occupancy' : 'تسجيل الإشغال'}
      </Button>
    </div>
  );
}

/**
 * One attempt, logged from the door (P4-T1, D10).
 *
 * The outcome doubles as the unit's new survey status, and that is the point:
 * an officer who has just stood at a door knows both facts, and asking them to
 * state each separately is how a unit ends up reading «مكتملة» with no visit
 * behind it, or three visits under a status nobody moved.
 *
 * `NOT_SURVEYED` is absent from the choices because it means *nobody went* — a
 * visit carrying it is a contradiction, and the schema refuses it too.
 */
function VisitForm({
  busy,
  locale,
  attempts,
  visits,
  onSubmit,
}: {
  busy: boolean;
  locale: string;
  /** Every attempt ever made, uncapped — the number the cell shows. */
  attempts: number;
  /** The recent ones, newest first. */
  visits: UnitVisitRow[];
  onSubmit: (values: { outcome: SurveyStatus; visitedAt: string; notes: string }) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [outcome, setOutcome] = useState<SurveyStatus>('VISITED_NO_ANSWER');
  const [visitedAt, setVisitedAt] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      {attempts > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold">
            {en
              ? `${attempts} attempt${attempts === 1 ? '' : 's'} on this unit`
              : `${attempts} محاولة على هذه الوحدة`}
          </p>
          <ul className="space-y-1">
            {visits.map((visit) => (
              <li
                key={visit.id}
                className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2 py-1 text-[11px]"
              >
                <span className="text-muted-foreground">{formatDate(visit.visitedAt)}</span>
                <Badge variant="soft-muted">{labels.surveyStatus[visit.outcome]}</Badge>
                {visit.officerName ? (
                  <span className="text-muted-foreground">{visit.officerName}</span>
                ) : null}
                {visit.notes ? <span className="w-full text-muted-foreground">{visit.notes}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={en ? 'What happened' : 'نتيجة الزيارة'} htmlFor="visit-outcome" required>
          <Select value={outcome} onValueChange={(value) => setOutcome(value as SurveyStatus)}>
            <SelectTrigger id="visit-outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VISIT_OUTCOMES.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.surveyStatus[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={en ? 'Visited on' : 'تاريخ الزيارة'}
          htmlFor="visit-date"
          hint={en ? 'Defaults to today' : 'الافتراضي اليوم'}
        >
          <Input
            id="visit-date"
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={visitedAt}
            onChange={(event) => setVisitedAt(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
      </div>

      <Field label={en ? 'Notes' : 'ملاحظات'} htmlFor="visit-notes">
        <Textarea
          id="visit-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={
            en
              ? 'A neighbour says they return in the evening'
              : 'أفاد الجيران بأنهم يعودون مساءً'
          }
        />
      </Field>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {en
          ? 'The unit moves to this outcome — one visit, one status, recorded together.'
          : 'تنتقل حالة الوحدة إلى هذه النتيجة — زيارة واحدة وحالة واحدة تُسجَّلان معاً.'}
      </p>

      <Button
        size="sm"
        disabled={busy}
        onClick={() => onSubmit({ outcome, visitedAt, notes: notes.trim() })}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Footprints className="size-4" aria-hidden />}
        {en ? 'Log the visit' : 'تسجيل الزيارة'}
      </Button>
    </div>
  );
}

/** Why this visit did not become a registration, pinned to this exact unit. */
function CaseForm({
  busy,
  locale,
  onSubmit,
}: {
  busy: boolean;
  locale: string;
  onSubmit: (values: { notes: string; caseType: CaseType; revisitAt: string }) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [caseType, setCaseType] = useState<CaseType>('UNIT_UNREACHABLE');
  const [notes, setNotes] = useState('');
  const [revisitAt, setRevisitAt] = useState('');

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={en ? 'What happened' : 'نوع الحالة'} htmlFor="case-type" required>
          <Select value={caseType} onValueChange={(value) => setCaseType(value as CaseType)}>
            <SelectTrigger id="case-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CASE_TYPE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.caseType[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={en ? 'Revisit on' : 'موعد إعادة الزيارة'}
          htmlFor="case-revisit"
          hint={
            en
              ? 'Optional — records the promise to come back'
              : 'اختياري — يسجّل موعد العودة المتفق عليه'
          }
        >
          <Input
            id="case-revisit"
            type="date"
            value={revisitAt}
            onChange={(event) => setRevisitAt(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
      </div>

      <Field label={en ? 'Notes' : 'الملاحظات'} htmlFor="case-notes" required>
        <Textarea
          id="case-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={
            en
              ? 'What the next officer needs to know'
              : 'ما يحتاج الموظف القادم إلى معرفته'
          }
        />
      </Field>

      <Button
        size="sm"
        disabled={busy || !notes.trim()}
        onClick={() => onSubmit({ notes: notes.trim(), caseType, revisitAt })}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CalendarClock className="size-4" aria-hidden />}
        {en ? 'Log the case' : 'تسجيل الحالة'}
      </Button>
    </div>
  );
}

/**
 * One observation, appended to the log. There is no edit and no delete: a
 * building that was unsafe in 2024 and repaired in 2026 is two facts (D3).
 */
function DamageForm({
  busy,
  locale,
  target,
  onSubmit,
}: {
  busy: boolean;
  locale: string;
  /** What is being assessed, named in the button so the two cannot be confused. */
  target: string;
  onSubmit: (values: {
    level: DamageLevel;
    source: DamageSource;
    observations: string;
    assessedAt: string;
  }) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [level, setLevel] = useState<DamageLevel>('SAFE_MINOR_DAMAGE');
  const [source, setSource] = useState<DamageSource>('FIELD_VISIT');
  const [observations, setObservations] = useState('');
  const [assessedAt, setAssessedAt] = useState('');

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={en ? 'Damage level' : 'مستوى الضرر'} htmlFor="damage-level" required>
          <Select value={level} onValueChange={(value) => setLevel(value as DamageLevel)}>
            <SelectTrigger id="damage-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAMAGE_LEVEL.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.damageLevel[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={en ? 'Source' : 'مصدر التقييم'} htmlFor="damage-source" required>
          <Select value={source} onValueChange={(value) => setSource(value as DamageSource)}>
            <SelectTrigger id="damage-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAMAGE_SOURCE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.damageSource[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Back-dating is allowed and forward-dating is not: an assessment typed
            up a week late describes the visit, not the paperwork. */}
        <Field
          label={en ? 'Inspected on' : 'تاريخ الكشف'}
          htmlFor="damage-date"
          hint={en ? 'Defaults to today' : 'الافتراضي اليوم'}
        >
          <Input
            id="damage-date"
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={assessedAt}
            onChange={(event) => setAssessedAt(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
      </div>

      <Field label={en ? 'What was seen' : 'ما شوهد'} htmlFor="damage-observations">
        <Textarea
          id="damage-observations"
          rows={2}
          value={observations}
          onChange={(event) => setObservations(event.target.value)}
          placeholder={
            en
              ? 'The fourth floor is down, the stairwell is impassable'
              : 'الطابق الرابع مهدوم، الدرج غير سالك'
          }
        />
      </Field>

      <Button
        size="sm"
        disabled={busy}
        onClick={() => onSubmit({ level, source, observations: observations.trim(), assessedAt })}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {en ? `Record for ${target}` : `تسجيل الكشف على ${target}`}
      </Button>
    </div>
  );
}
