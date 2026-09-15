'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  ClipboardList,
  DoorClosed,
  Footprints,
  Loader2,
  Pencil,
  ShieldAlert,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {
  getLabels,
  defaultUnitTypeFor,
  type CitizenResidence,
  type DamageLevel,
  type UpsertUnitInput,
  type VacancyBasis,
  type VacancyEndReason,
} from '@mechanization/shared-schemas';
import {
  addUnit,
  ApiRequestError,
  confirmVacancy,
  createCase,
  deleteUnit,
  duplicateUnitsOf,
  type DuplicateUnitCandidate,
  endOccupancy,
  endVacancy,
  getBuilding,
  getBuildingDamage,
  linkOccupancyOwner,
  logApiError,
  recordDamage,
  recordOccupancy,
  updateUnit,
  type BuildingDetail,
  type DamageAssessmentRow,
  type UnitOccupant,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';
import { endTenancyMessage } from '@/components/admin/after-tenancy-question';
import {
  type EndOccupancyAnswer,
  activeVacancy,
  AddPersonForm,
  BuildingSummaryBadges,
  CaseForm,
  cellBadge,
  ConfirmVacancyDialog,
  DamageForm,
  effectiveUnitStatus,
  floorLabel,
  groupUnitsByFloor,
  logVisitWithFollowUp,
  occupancyMessage,
  OccupantList,
  ownerLinkMessage,
  SeasonalHomePanel,
  UnitStateLegend,
  unitOwners,
  vacancyBlocker,
  VacancyPanel,
  VisitForm,
  withDeclaredBasements,
} from './building-unit-forms';

/**
 * One building's units, floor by floor, with the things an officer standing in
 * its stairwell actually does.
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
 * The actions are here rather than on their own pages because each one is
 * something learned at the door and lost by the time a form is found: who
 * answered, why nobody did, that the flat is empty, that the ceiling is down.
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

/** Which unit action is open, if any. `null` = just the matrix. */
type ActionKind = 'occupant' | 'case' | 'damage' | 'visit' | null;

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
   * Where «إضافة شخص إلى الوحدة» sends a person who is not on file yet — the
   * registration form, pointed at this unit, with نوع الملف preset.
   *
   * A URL the caller builds, rather than a router push from in here: this
   * drawer is opened from two different routes (the ledger and the map) whose
   * admin base paths it has no business reconstructing.
   */
  registerHref?: (
    buildingId: string,
    unitId: string,
    residence: CitizenResidence,
    /** Whatever the officer typed into the occupant search — seeds the name. */
    name: string,
  ) => string;
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
  /** Whether «تأكيد الشغور» is asking its questions. */
  const [confirmingVacancy, setConfirmingVacancy] = useState(false);

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
      setConfirmingVacancy(false);
      return;
    }
    void load();
  }, [open, buildingId, load]);

  /** Floors top-down, so the matrix stands the way the building does, with a
   *  row for every basement the register declares even when it is still empty. */
  const floors = useMemo(
    () =>
      withDeclaredBasements(
        groupUnitsByFloor(building?.units ?? []),
        building?.basementsCount,
      ),
    [building],
  );

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
   * empty and may be marked so. Only somebody *living* there contradicts it —
   * a مستأجر or شاغل بتسامح — or a seasonal home, whose owners being away is
   * what the state means. An owner does not: refusing over the owner is what
   * taught inspectors to end an ownership just to record an empty flat. See
   * `vacancyBlocker`.
   */
  const vacancyBlocked = useMemo(
    () => (selectedUnit ? vacancyBlocker(selectedUnit, en) : null),
    [selectedUnit, en],
  );

  /** Which floor's «إضافة وحدة» row is open, and the type chosen in it. */
  const [addingFloor, setAddingFloor] = useState<number | null>(null);
  const [addingType, setAddingType] = useState('');
  /**
   * The units the server held out when «إضافة وحدة» hit its duplicate guard.
   *
   * Carries the floor and type it was asked about, not just the candidates:
   * the confirmation re-sends the *same* addition with the flag set, and the
   * add row it came from may already have been closed or moved to another
   * floor by the time the officer answers.
   */
  const [duplicateUnits, setDuplicateUnits] = useState<{
    floor: number;
    unitType: string;
    candidates: DuplicateUnitCandidate[];
  } | null>(null);

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
  const addOnFloor = async (floor: number, unitType: string, acknowledged = false) => {
    if (!building || !unitType) return;

    setBusy(true);
    setActionError(null);
    try {
      const created = await addUnit(tenant, token, building.id, {
        floor,
        unitType: unitType as UpsertUnitInput['unitType'],
        ...(acknowledged ? { acknowledgedDuplicates: true } : {}),
      });
      await load();
      onChanged?.();
      setAddingFloor(null);
      setAddingType('');
      setDuplicateUnits(null);
      toast.success(
        en ? `Unit ${created.unitCode} added` : `تمت إضافة الوحدة ${created.unitCode}`,
      );
    } catch (caught) {
      logApiError(caught);

      /*
        The floor already has a unit of this type, and the server is holding it
        out rather than refusing outright.

        This whole branch is why `addOnFloor` no longer goes through `run`.
        `run` treats every rejection as final — it prints the server's message
        and stops — so the one refusal that is *a question* arrived here as a
        wall: «يوجد على هذا الطابق ٢ وحدات مسجَّلة من النوع نفسه… تأكَّد أن هذه
        وحدة مختلفة قبل المتابعة» told the officer exactly what to confirm and
        gave them nothing to confirm it with. A floor with four flats on it is
        ordinary, so the commonest legitimate addition in the building was the
        one this screen could not make.

        The picker has had the acknowledgement since D18; the drawer never got
        it, which is how the same guard became helpful in one place and a dead
        end in the other. The answer is allowed to be yes.
      */
      const clashes = duplicateUnitsOf(caught);
      if (clashes) {
        setDuplicateUnits({ floor, unitType, candidates: clashes });
        return;
      }

      const failure = en ? 'Could not add the unit.' : 'تعذّرت إضافة الوحدة.';
      const message = caught instanceof ApiRequestError ? caught.payload.message : failure;
      setActionError(message);
      toast.error(failure, { description: message });
    } finally {
      setBusy(false);
    }
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

  /*
    Both halves of «تأكيد الشغور» are dialogs, so neither goes through `run`:
    a refusal belongs in the dialog the officer is looking at — «يسكنها مستأجر
    مسجَّل» is a thing to act on, not a toast behind a closed dialog — and each
    rethrows for the dialog to show.
  */
  const saveVacancy = async (
    unit: UnitWithOccupants,
    input: { basis: VacancyBasis; observedAt?: string; notes: string },
  ) => {
    let result;
    try {
      result = await confirmVacancy(tenant, token, unit.id, {
        basis: input.basis,
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      });
    } catch (caught) {
      logApiError(caught);
      throw new Error(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not confirm the vacancy.'
            : 'تعذّر تأكيد الشغور.',
      );
    }
    await load();
    onChanged?.();
    toast.success(
      [
        en ? `Unit ${unit.unitCode} confirmed vacant` : `تم تأكيد شغور الوحدة ${unit.unitCode}`,
        result.casesResolved > 0
          ? en
            ? `${result.casesResolved} case(s) closed`
            : `أُغلقت ${result.casesResolved} حالة`
          : null,
      ]
        .filter(Boolean)
        .join('، '),
    );
  };

  const liftVacancy = async (
    unit: UnitWithOccupants,
    input: { reason: VacancyEndReason; endedAt?: string; notes: string },
  ) => {
    try {
      await endVacancy(tenant, token, unit.id, {
        reason: input.reason,
        ...(input.endedAt ? { endedAt: input.endedAt } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      });
    } catch (caught) {
      logApiError(caught);
      throw new Error(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not lift the vacancy.'
            : 'تعذّر إلغاء تأكيد الشغور.',
      );
    }
    await load();
    onChanged?.();
    /*
      «لم تعد شاغرة» leaves the flat occupied by somebody unrecorded, so the
      next step is to record them — the form opens rather than being looked for.
    */
    if (input.reason === 'NO_LONGER_VACANT') setAction('occupant');
    toast.success(
      input.reason === 'NO_LONGER_VACANT'
        ? en
          ? 'Vacancy lifted — record whoever lives there now'
          : 'أُلغي تأكيد الشغور — سجّل من يسكنها الآن'
        : en
          ? 'Vacancy lifted and the unit restored'
          : 'أُلغي تأكيد الشغور وعادت الوحدة إلى حالتها السابقة',
    );
  };

  /*
    Ending a spell also changes the citizen's own file — an owner's claim is
    released, a tenant's card is kept as an ended tenancy — see
    `TenancyService.endOccupancy`, and the message says so, because that half
    happens inside a file the officer is not looking at.
  */
  const closeSpell = async (occupant: UnitOccupant, input: EndOccupancyAnswer) => {
    // Not through `run`: a refusal belongs in the dialog the officer is
    // looking at, so it is rethrown for `EndOccupancyDialog` to show.
    let result: Awaited<ReturnType<typeof endOccupancy>>;
    try {
      result = await endOccupancy(tenant, token, occupant.id, input);
    } catch (caught) {
      logApiError(caught);
      throw new Error(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not end the occupancy.'
            : 'تعذّر إنهاء الإشغال.',
      );
    }
    await load();
    onChanged?.();
    toast.success(endTenancyMessage(result, locale));
  };

  /** «ربط بالمالك» — a refusal is rethrown for the dialog to show, as `closeSpell`'s is. */
  const linkOwner = async (occupant: UnitOccupant, ownerId: string, confirmRecordedAfter: boolean) => {
    let result: Awaited<ReturnType<typeof linkOccupancyOwner>>;
    try {
      result = await linkOccupancyOwner(tenant, token, occupant.id, ownerId, confirmRecordedAfter);
    } catch (caught) {
      logApiError(caught);
      throw new Error(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not link the owner.'
            : 'تعذّر الربط بالمالك.',
      );
    }
    await load();
    onChanged?.();
    toast.success(ownerLinkMessage(result, en));
  };

  const saveSeasonal = (
    unit: UnitWithOccupants,
    values: { presenceMonths: number[]; ownerLastStayAt: string | null; vacancyDeclaredAt: string | null },
  ) =>
    run(
      async () => {
        await updateUnit(tenant, token, unit.id, values);
        return en ? 'Seasonal details saved' : 'تم حفظ بيانات السكن الموسمي';
      },
      en ? 'Could not save the seasonal details.' : 'تعذّر حفظ بيانات السكن الموسمي.',
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
          <BuildingSummaryBadges
            building={building}
            locale={locale}
            damageLevel={damage?.current ?? null}
          />

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
                  {/* Matches the page view's wording. The drawer's host decides
                      where this goes, so it does not promise info-only here —
                      it promises the building rather than its units, which is
                      what every current caller opens. */}
                  {en ? 'Edit building details' : 'تعديل معلومات المبنى'}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* ── The matrix ────────────────────────────────────────── */}
          {/* Keyed on the units rather than on `floors`, which now also carries
              a row for each declared-but-empty basement — a building with no
              matrix at all still needs the offer to generate one. */}
          {building.units.length === 0 ? (
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
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b bg-muted/30 px-3 py-1.5">
                    <p className="text-xs font-semibold">{floorLabel(floor, en)}</p>
                    <div className="flex items-center gap-3">
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
                            // What this structure is made of — and, below
                            // ground, what is actually down there rather than
                            // what the block is made of above it.
                            setAddingType(defaultUnitTypeFor(building.structureType, floor));
                            setActionError(null);
                          }}
                          // A real target, and a gutter in front of it. It was
                          // 11px text in 2px of padding sitting beside the unit
                          // count — on a tablet, one thumb covering both. The
                          // floor header is the only place a unit can be added
                          // from in this drawer, so a mis-tap here is the
                          // difference between recording a flat and reading a
                          // number.
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                        >
                          <UserPlus className="size-3.5 shrink-0" aria-hidden />
                          {en ? 'Add unit' : 'إضافة وحدة'}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {addingFloor === floor ? (
                    <div className="space-y-2 border-b bg-background px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
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
                          disabled={busy || !addingType || duplicateUnits !== null}
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
                            setDuplicateUnits(null);
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

                      {/*
                        The floor already has one of these — the moment of
                        noticing, and the answer is allowed to be yes.

                        `addUnit` takes the next free position on the floor, so
                        no database constraint could ever refuse a second محل
                        beside an existing محل. That is how one physical shop
                        came to be in the register twice, and the guard exists
                        to make somebody look. What it must not be is a wall:
                        four flats a floor is ordinary, and the names below are
                        the only thing that tells two identical-looking units
                        apart.
                      */}
                      {duplicateUnits && duplicateUnits.floor === floor ? (
                        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
                          <p className="flex items-start gap-1.5 text-[11px] font-medium leading-relaxed">
                            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                            {en
                              ? 'This floor already has a unit of the same type. Is the one you are adding different?'
                              : 'يوجد على هذا الطابق وحدة من النوع نفسه. هل الوحدة التي تضيفها مختلفة عنها؟'}
                          </p>

                          <ul className="space-y-1">
                            {duplicateUnits.candidates.map((row) => (
                              <li
                                key={row.id}
                                className="rounded-md bg-background/70 px-2 py-1.5 text-[11px] leading-relaxed"
                              >
                                <span className="font-mono font-medium" dir="ltr">
                                  {row.unitCode}
                                </span>
                                {row.postedNumber && row.postedNumber !== row.unitCode ? (
                                  <span className="text-muted-foreground" dir="ltr">
                                    {' '}
                                    ({row.postedNumber})
                                  </span>
                                ) : null}
                                <span className="text-muted-foreground">
                                  {' — '}
                                  {[
                                    labels.unitType[row.unitType],
                                    row.side,
                                    row.unitArea != null
                                      ? en
                                        ? `${row.unitArea} m²`
                                        : `${row.unitArea} م²`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                                {/*
                                  The fact that actually settles it. A floor
                                  whose محل already has a named مستأجر is a
                                  floor where «إضافة وحدة» is almost certainly
                                  the wrong button, and no amount of code and
                                  area says that as directly as a name does.
                                */}
                                {row.occupants.length > 0 ? (
                                  <span className="block font-medium">
                                    {row.occupants
                                      .map(
                                        (occupant) =>
                                          `${labels.occupancyRole[occupant.role]}: ${
                                            occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')
                                          }`,
                                      )
                                      .join('، ')}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void addOnFloor(
                                  duplicateUnits.floor,
                                  duplicateUnits.unitType,
                                  true,
                                )
                              }
                            >
                              {busy ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                              ) : null}
                              {en ? 'Yes, it is a different unit' : 'نعم، هذه وحدة مختلفة'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                setDuplicateUnits(null);
                                setAddingFloor(null);
                                setAddingType('');
                              }}
                            >
                              {en ? 'No, it is one of these' : 'لا، إنها إحداها'}
                            </Button>
                          </div>
                        </div>
                      ) : null}
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
                              {badge.short}
                            </Badge>
                            {badge.detail ? (
                              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                {badge.detail}
                              </span>
                            ) : null}
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

          {building.units.length > 0 ? <UnitStateLegend locale={locale} /> : null}

          {/* ── The selected unit, and what can be done with it ─ */}
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

              <OccupantList
                unit={selectedUnit}
                locale={locale}
                canWrite={canWrite}
                busy={busy}
                citizenHref={citizenHref}
                onEnd={closeSpell}
                onLinkOwner={linkOwner}
              />

              {/* Why the flat reads «شاغرة», and the control that lifts it. */}
              <VacancyPanel
                unit={selectedUnit}
                unitCode={`${building.code}-${selectedUnit.unitCode}`}
                locale={locale}
                busy={busy}
                canWrite={canWrite}
                onEnd={(values) => liftVacancy(selectedUnit, values)}
              />

              {effectiveUnitStatus(selectedUnit) === 'SEASONAL' ? (
                <SeasonalHomePanel
                  unit={selectedUnit}
                  locale={locale}
                  busy={busy}
                  canWrite={canWrite}
                  onSave={(values) => void saveSeasonal(selectedUnit, values)}
                />
              ) : null}

              <ConfirmVacancyDialog
                unit={selectedUnit}
                unitCode={`${building.code}-${selectedUnit.unitCode}`}
                locale={locale}
                open={confirmingVacancy}
                onOpenChange={setConfirmingVacancy}
                onConfirm={(values) => saveVacancy(selectedUnit, values)}
              />

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
                    {en ? 'Add a person to this unit' : 'إضافة شخص إلى الوحدة'}
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
                    A flat cannot be empty and lived in at the same time.

                    This was enabled over live occupancies and wrote «شاغرة»
                    straight across them — leaving a unit that says nobody is
                    there beside the rows naming who is, and quietly dropping
                    the owner's occupancy fee, because `isUnoccupied` exempts a
                    vacant flat. The server refuses that outright now, and a
                    seasonal home as well; the button says why rather than
                    letting an officer discover it from an error.

                    Hidden entirely once a confirmation is standing: the panel
                    above carries the vacancy and the control that lifts it, and
                    a greyed-out «تأكيد الشغور» beside it would read as the
                    action being unavailable rather than already done.
                  */}
                  {activeVacancy(selectedUnit) ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || vacancyBlocked !== null}
                      title={vacancyBlocked ?? undefined}
                      onClick={() => {
                        setActionError(null);
                        setConfirmingVacancy(true);
                      }}
                    >
                      <DoorClosed className="size-4" aria-hidden />
                      {en ? 'Confirm vacant…' : 'تأكيد الشغور…'}
                    </Button>
                  )}
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
                    {en ? 'Assess this unit' : 'كشف ضرر على الوحدة'}
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
                    {en ? 'Open a follow-up case' : 'فتح حالة متابعة'}
                  </Button>

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
                <AddPersonForm
                  tenant={tenant}
                  token={token}
                  busy={busy}
                  locale={locale}
                  newFileHref={
                    registerHref
                      ? (residence, name) =>
                          registerHref(building.id, selectedUnit.id, residence, name)
                      : undefined
                  }
                  vacancy={activeVacancy(selectedUnit)}
                  owners={unitOwners(selectedUnit)}
                  // See the matrix page's own call — the field opens only where
                  // the census has no area for this flat.
                  unitArea={selectedUnit.unitArea}
                  onSubmit={({ citizen, role, endsVacancy, ...rest }) =>
                    void run(
                      async () => {
                        const result = await recordOccupancy(tenant, token, {
                          unitId: selectedUnit.id,
                          citizenId: citizen.id,
                          role,
                          ...rest,
                          ...(endsVacancy ? { endsVacancy } : {}),
                        });
                        return occupancyMessage(
                          citizen.fullName,
                          selectedUnit.unitCode,
                          result,
                          en,
                          unitOwners(selectedUnit).find((owner) => owner.citizenId === rest.landlordCitizenId)
                            ?.citizenName,
                        );
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
                        // No survey-status side effect any more: the door that
                        // did not open is a visit, and `VisitForm` records it
                        // with its attempt. See `FOLLOW_UP_CASE`.
                        return en ? 'Follow-up case opened' : 'تم فتح حالة المتابعة';
                      },
                      en ? 'Could not open the case.' : 'تعذّر فتح الحالة.',
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
                      () =>
                        logVisitWithFollowUp(
                          tenant,
                          token,
                          {
                            unitId: selectedUnit.id,
                            buildingId: building.id,
                            parcelNumber: building.parcelNumber,
                            buildingName: building.name,
                          },
                          values,
                          en,
                        ),
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

