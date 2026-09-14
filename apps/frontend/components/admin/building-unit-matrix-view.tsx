'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ChevronRight,
  ClipboardList,
  DoorClosed,
  Footprints,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  UserPlus,
  UserRound,
  UserRoundPlus,
} from 'lucide-react';
import {
  getLabels,
  defaultUnitTypeFor,
  type DamageLevel,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import {
  addUnit,
  ApiRequestError,
  createCase,
  deleteUnit,
  duplicateUnitsOf,
  endOccupancy,
  getBuilding,
  getBuildingDamage,
  logApiError,
  logUnitVisit,
  recordDamage,
  recordOccupancy,
  updateUnit,
  type BuildingDetail,
  type DamageAssessmentRow,
  type DuplicateUnitCandidate,
  type UnitOccupant,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';
import {
  BuildingSummaryBadges,
  CaseForm,
  cellBadge,
  DamageForm,
  floorLabel,
  groupUnitsByFloor,
  occupancyMessage,
  OccupantForm,
  VisitForm,
  withDeclaredBasements,
} from './building-unit-forms';

const READ_ONLY_ROLES = ['AUDITOR', 'ACCOUNTANT'];

const DAMAGED_LEVELS: readonly DamageLevel[] = [
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
];

type ActionKind = 'occupant' | 'case' | 'damage' | 'visit' | null;

/**
 * One colour per confirmed-unit *status*, not identity — the inverse of the
 * creation wizard's grid, which colours by identity because nothing has a
 * status yet. Here the operationally useful signal is "what state is this
 * unit in," reusing `cellBadge`'s existing occupancy/survey classification so
 * this page and the drawer can never disagree about what a colour means.
 */
const STATUS_BLOCK_CLASSES: Record<
  'soft-success' | 'soft-warning' | 'soft-destructive' | 'soft-info' | 'soft-muted',
  string
> = {
  'soft-success': 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 ring-emerald-600/40',
  'soft-warning': 'bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/40',
  'soft-destructive': 'bg-destructive/15 text-destructive ring-destructive/40',
  'soft-info': 'bg-sky-500/15 text-sky-700 dark:text-sky-400 ring-sky-500/40',
  'soft-muted': 'bg-muted text-muted-foreground ring-border',
};

interface LaidOutUnit {
  unit: UnitWithOccupants;
  startCol: number;
  endCol: number;
}

/**
 * The height of one floor's row, in all three of the matrix's columns.
 *
 * Stated once and applied identically to the floor label, the unit blocks and
 * the «+», because those three live in separate columns now and nothing else
 * would keep them aligned. An intrinsic height would not: a floor holding a
 * unit with a visit count is taller than one that does not, so the columns
 * would drift apart by one visit badge at a time until the «+» beside «الثالث»
 * belonged to the second floor.
 *
 * 4rem rather than the old `min-h-14` (3.5rem), which is both comfortably past
 * any touch-target minimum and enough for a unit code with a visit count under
 * it without the block growing.
 */
const MATRIX_ROW_HEIGHT = 'h-16';

/**
 * Reconstructs the floor plan a unit was painted on. Units carrying a stored
 * `startCol`/`endCol` (painted through the creation wizard's grid) keep their
 * exact span; a unit with neither (the blueprint generator, a hand-added
 * single unit) is laid out as one column, appended after the highest
 * positioned column, in `sequence` order — an honest default rather than a
 * guess at a layout that was never drawn.
 */
function layoutFloor(units: UnitWithOccupants[]): { blocks: LaidOutUnit[]; width: number } {
  const positioned = units.filter((u) => u.startCol != null && u.endCol != null);
  const unpositioned = units.filter((u) => u.startCol == null || u.endCol == null);

  const blocks: LaidOutUnit[] = positioned.map((unit) => ({
    unit,
    startCol: unit.startCol as number,
    endCol: unit.endCol as number,
  }));

  let nextCol = blocks.reduce((max, b) => Math.max(max, b.endCol), 0) + 1;
  for (const unit of unpositioned) {
    blocks.push({ unit, startCol: nextCol, endCol: nextCol });
    nextCol += 1;
  }

  blocks.sort((a, b) => a.startCol - b.startCol);
  const width = blocks.reduce((max, b) => Math.max(max, b.endCol), 1);
  return { blocks, width };
}

export function BuildingUnitMatrixView({
  tenant,
  locale,
  adminPath,
  buildingId,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  buildingId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role ?? null);
  }, [tenant, base, router]);

  const canWrite = role !== null && !READ_ONLY_ROLES.includes(role);

  const [building, setBuilding] = useState<BuildingDetail | null>(null);
  const [damage, setDamage] = useState<{
    current: DamageLevel | null;
    history: DamageAssessmentRow[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, condition] = await Promise.all([
        getBuilding(tenant, token, buildingId),
        getBuildingDamage(tenant, token, buildingId).catch(() => null),
      ]);
      setBuilding(detail);
      setDamage(condition);
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
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
  }, [tenant, token, buildingId, en, router, base]);

  useEffect(() => {
    void load();
  }, [load]);

  const floors = useMemo(
    () =>
      withDeclaredBasements(
        groupUnitsByFloor(building?.units ?? []),
        building?.basementsCount,
      ).map(({ floor, units }) => ({ floor, ...layoutFloor(units) })),
    [building],
  );

  const selectedUnit = useMemo(
    () => building?.units.find((unit) => unit.id === selectedUnitId) ?? null,
    [building, selectedUnitId],
  );

  const liveOccupants = useMemo(
    () => (selectedUnit?.occupants ?? []).filter((occupant) => occupant.toDate === null),
    [selectedUnit],
  );

  const [addingFloor, setAddingFloor] = useState<number | null>(null);
  const [addingType, setAddingType] = useState('');
  const [duplicateUnits, setDuplicateUnits] = useState<{
    floor: number;
    unitType: string;
    candidates: DuplicateUnitCandidate[];
  } | null>(null);

  const run = useCallback(
    async (task: () => Promise<string>, failure: string) => {
      if (!token) return;
      setBusy(true);
      setActionError(null);
      try {
        const message = await task();
        await load();
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
    [load, toast, token],
  );

  const addOnFloor = async (floor: number, unitType: string, acknowledged = false) => {
    if (!building || !unitType || !token) return;

    setBusy(true);
    setActionError(null);
    try {
      const created = await addUnit(tenant, token, building.id, {
        floor,
        unitType: unitType as UpsertUnitInput['unitType'],
        ...(acknowledged ? { acknowledgedDuplicates: true } : {}),
      });
      await load();
      setAddingFloor(null);
      setAddingType('');
      setDuplicateUnits(null);
      toast.success(en ? `Unit ${created.unitCode} added` : `تمت إضافة الوحدة ${created.unitCode}`);
    } catch (caught) {
      logApiError(caught);
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

  const removeUnit = (unit: UnitWithOccupants) =>
    run(
      async () => {
        if (!token) throw new Error('unauthenticated');
        await deleteUnit(tenant, token, unit.id);
        setSelectedUnitId(null);
        return en ? `Unit ${unit.unitCode} removed` : `تم حذف الوحدة ${unit.unitCode}`;
      },
      en ? 'Could not remove the unit.' : 'تعذّر حذف الوحدة.',
    );

  const markVacant = (unit: UnitWithOccupants) =>
    run(
      async () => {
        if (!token) throw new Error('unauthenticated');
        await updateUnit(tenant, token, unit.id, {
          surveyStatus: 'VACANT_CONFIRMED',
          unitStatus: 'VACANT',
        });
        return en ? `Unit ${unit.unitCode} confirmed vacant` : `تم تأكيد شغور الوحدة ${unit.unitCode}`;
      },
      en ? 'Could not update the unit.' : 'تعذّر تحديث الوحدة.',
    );

  const closeSpell = (occupant: UnitOccupant) =>
    run(
      async () => {
        if (!token) throw new Error('unauthenticated');
        await endOccupancy(tenant, token, occupant.id);
        return en
          ? 'Occupancy ended, and the property released from their file'
          : 'تم إنهاء الإشغال وفصل العقار عن ملف المواطن';
      },
      en ? 'Could not end the occupancy.' : 'تعذّر إنهاء الإشغال.',
    );

  const cancelHref = `${base}/buildings`;

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
        <Link
          href={cancelHref}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground font-medium"
        >
          <ArrowLeft className="size-3.5 sm:size-4 rtl:rotate-180" aria-hidden />
          <span>{en ? 'Building Census' : 'سجل المباني'}</span>
        </Link>
        <ChevronRight className="size-3.5 rtl:rotate-180 text-muted-foreground/60" aria-hidden />
        <span className="text-foreground font-semibold">
          {building ? building.code : en ? 'Unit Matrix' : 'مصفوفة الوحدات'}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {en ? 'Loading…' : 'جاري التحميل…'}
        </div>
      ) : error ? (
        <div className="space-y-3 py-12 text-center">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {en ? 'Retry' : 'إعادة المحاولة'}
          </Button>
        </div>
      ) : building ? (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 border-b border-border/80 pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-xl font-bold text-foreground" dir="ltr">
                  {building.code}
                </h1>
                {building.name ? (
                  <span className="text-sm font-medium text-muted-foreground">{building.name}</span>
                ) : null}
              </div>
              <BuildingSummaryBadges
                building={building}
                locale={locale}
                damageLevel={damage?.current ?? null}
              />
              {/*
                Where the structure stands, cadastrally — all of it.

                The two facts added beside the parcel are the two the wizard now
                asks for, and a field somebody fills in and can never see again
                is a field they stop filling in. Both are stated only when there
                is something to state:

                  • فرز is three-valued, and «لم يُسأل» is the default answer for
                    every building recorded before the column existed. Printing
                    «غير مفروزة» for those would be asserting a finding nobody
                    made — see `Building.isPartitioned`.
                  • The shared parcels are empty for the overwhelming majority,
                    which stand on exactly one عقار, and «— لا عقارات أخرى» on
                    every building in the register would be noise.
              */}
              <p className="text-xs text-muted-foreground">
                {[
                  en ? `Parcel ${building.parcelNumber}` : `عقار ${building.parcelNumber}`,
                  building.sharedParcelNumbers?.length
                    ? en
                      ? `also on ${building.sharedParcelNumbers.join(', ')}`
                      : `وعلى العقارات ${building.sharedParcelNumbers.join('، ')}`
                    : null,
                  /*
                    The فرز, with its أقسام where they have been collected.

                    «مفروزة» on its own does not answer the question anybody
                    asks it — «which قسم?» — so the numbers are printed beside
                    it rather than left to the editor. A ticked فرز with no
                    numbers yet is still stated: a block is visibly مفروزة long
                    before somebody has the صحيفة in front of them.
                  */
                  building.isPartitioned == null
                    ? null
                    : building.isPartitioned
                      ? building.partitionNumbers?.length
                        ? en
                          ? `Partitioned — parts ${building.partitionNumbers.join(', ')}`
                          : `مفروزة — الأقسام ${building.partitionNumbers.join('، ')}`
                        : en
                          ? 'Partitioned'
                          : 'مفروزة'
                      : en
                        ? 'Not partitioned'
                        : 'غير مفروزة',
                  building.zoneName,
                ]
                  .filter(Boolean)
                  .join(' — ')}
              </p>
            </div>

            {canWrite ? (
              <div className="flex flex-wrap gap-2 shrink-0">
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`${base}/buildings/${encodeURIComponent(building.id)}/edit`)}
                >
                  <Pencil className="size-4" aria-hidden />
                  {en ? 'Edit building' : 'تعديل المبنى'}
                </Button>
              </div>
            ) : null}
          </div>

          {/* ── The matrix, painted the way it was drawn ─────────────── */}
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
              {canWrite ? (
                <Link
                  href={`${base}/buildings/${encodeURIComponent(building.id)}/edit?step=units`}
                  className={buttonVariants({ size: 'sm' })}
                >
                  {en ? 'Generate the matrix' : 'توليد المصفوفة'}
                </Link>
              ) : null}
            </div>
          ) : (
            <div
              dir="ltr"
              className="flex items-stretch gap-2 rounded-xl border border-border/80 bg-muted/10 p-2 sm:gap-3 sm:p-3"
            >
              {/*
                ── Three columns, and only the middle one scrolls ─────────

                The matrix used to be one scroll container holding rows of
                «label · blocks · add», which put both the floor label and the
                «+» *inside* the scrollable area. On a tablet that had two
                consequences and neither was survivable:

                  • A twelve-flat floor is wider than the viewport, so the «+»
                    sat past the right-hand edge — the officer scrolled to find
                    it, and by the time it was on screen the floor label had
                    scrolled off the left, so they were adding a unit to a floor
                    they could no longer identify.
                  • The row could not shrink below its own content, so the
                    label, the last block and the «+» ended up abutting with no
                    gutter between them at all — a 36px «+» pressed against a
                    unit block, both of them tap targets, doing entirely
                    different things.

                So the label column and the «+» column are lifted out of the
                scroll container and pinned either side of it. Nothing overlaps
                anything, because nothing shares a stacking context with
                anything: the three columns are siblings, and the only one that
                scrolls carries only unit blocks.

                The rows of all three columns are given the same fixed height
                rather than an intrinsic one — see `MATRIX_ROW_HEIGHT`. That is
                what keeps them aligned, and it is not optional: a floor whose
                units carry a visit count is taller than one whose units do not,
                and three columns measuring themselves independently would drift
                apart by exactly that much, one floor at a time.
              */}

              {/* Floor labels — outside the scroll, so they never leave */}
              <div className="flex shrink-0 flex-col gap-1.5 sm:gap-2">
                {floors.map(({ floor }) => (
                  <div
                    key={floor}
                    className={cn(
                      MATRIX_ROW_HEIGHT,
                      'flex w-12 items-center justify-end text-[11px] font-medium tabular-nums text-muted-foreground sm:w-20',
                      floor < 0 && 'font-mono text-foreground/70',
                    )}
                  >
                    {floorLabel(floor, en)}
                  </div>
                ))}
              </div>

              {/* The units themselves — the only thing that scrolls */}
              <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
                <div className="flex flex-col gap-1.5 sm:gap-2">
                  {floors.map(({ floor, blocks, width }) => (
                    <div
                      key={floor}
                      className={cn(MATRIX_ROW_HEIGHT, 'grid gap-1.5 sm:gap-2')}
                      style={{
                        // 2.75rem = 44px, the smallest block an officer can hit
                        // reliably while holding a tablet in one hand.
                        gridTemplateColumns: `repeat(${width}, minmax(2.75rem, 1fr))`,
                      }}
                    >
                      {blocks.map(({ unit, startCol, endCol }) => {
                        const badge = cellBadge(unit, labels, en);
                        const selected = unit.id === selectedUnitId;
                        return (
                          <button
                            key={unit.id}
                            type="button"
                            style={{ gridColumn: `${startCol} / ${endCol + 1}` }}
                            onClick={() => {
                              setSelectedUnitId(selected ? null : unit.id);
                              setAction(null);
                              setActionError(null);
                            }}
                            aria-pressed={selected}
                            title={`${unit.unitCode} — ${badge.text}`}
                            className={cn(
                              'flex h-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-center ring-1 transition-transform',
                              STATUS_BLOCK_CLASSES[badge.variant],
                              selected && 'scale-[1.03] ring-2 ring-primary',
                            )}
                          >
                            <span className="font-mono text-xs font-bold">{unit.unitCode}</span>
                            {unit.visitCount > 0 ? (
                              <span className="flex items-center gap-0.5 text-[10px] opacity-80">
                                <Footprints className="size-2.5 shrink-0" aria-hidden />
                                {unit.visitCount}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* «+» per floor — outside the scroll, so it is always reachable */}
              {canWrite ? (
                <div className="flex shrink-0 flex-col gap-1.5 sm:gap-2">
                  {floors.map(({ floor }) =>
                    addingFloor === floor ? (
                      /*
                        A spacer, not nothing.

                        The inline add-form for this floor is open below, so the
                        button is withdrawn — but removing the row outright
                        would shorten this column by one and slide every floor
                        beneath it up against the wrong label.
                      */
                      <div key={floor} className={cn(MATRIX_ROW_HEIGHT, 'w-11')} aria-hidden />
                    ) : (
                      <button
                        key={floor}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setAddingFloor(floor);
                          setAddingType(defaultUnitTypeFor(building.structureType, floor));
                          setActionError(null);
                        }}
                        aria-label={
                          en
                            ? `Add unit on floor ${floorLabel(floor, en)}`
                            : `إضافة وحدة على الطابق ${floorLabel(floor, en)}`
                        }
                        className={cn(
                          MATRIX_ROW_HEIGHT,
                          'flex w-11 items-center justify-center rounded-md border border-dashed border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
                        )}
                      >
                        <Plus className="size-4" aria-hidden />
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* ── Add-unit inline flow, open for at most one floor ─────── */}
          {addingFloor !== null ? (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <p className="text-xs font-semibold text-muted-foreground">
                {floorLabel(addingFloor, en)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={addingType} onValueChange={setAddingType}>
                  <SelectTrigger className="h-9 w-44 text-xs">
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
                  onClick={() => void addOnFloor(addingFloor, addingType)}
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
                  {en ? 'The code is assigned from the floor.' : 'يُشتق رمز الوحدة من الطابق.'}
                </span>
              </div>

              {duplicateUnits && duplicateUnits.floor === addingFloor ? (
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
                      onClick={() => void addOnFloor(duplicateUnits.floor, duplicateUnits.unitType, true)}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
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

          {/* ── The selected unit, and the four things to do with it ─ */}
          {selectedUnit ? (
            <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/[0.03] p-4">
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

              {selectedUnit.occupants.length > 0 ? (
                <ul className="space-y-1.5">
                  {selectedUnit.occupants.map((occupant) => {
                    const current = occupant.toDate === null;
                    /*
                      No card on their file claims this flat — so billing,
                      which reads the file, has nothing to charge for it.

                      This used to fire on every occupant «تسجيل شاغل»
                      created, because that path wrote the matrix half of
                      the record and never the file half. It writes both now
                      (`BuildingsService.claimOnFile`), which leaves the one
                      case no write can fix: a person with no registration to
                      hang a property card on. The copy below says that, and
                      says what to do about it, rather than describing a gap
                      the officer had no way to close from here.

                      Only said of a *current* occupant. A former spell whose
                      link was released on the way out is missing nothing.
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
                        <Link
                          href={`${base}/citizens/${occupant.citizenId}`}
                          className={cn(
                            'underline-offset-2 hover:underline',
                            current ? 'font-medium' : 'font-normal line-through',
                          )}
                        >
                          {occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}
                        </Link>
                        <Badge variant="soft-muted">{labels.occupancyRole[occupant.role]}</Badge>
                        {!current ? <Badge variant="outline">{en ? 'Former' : 'سابق'}</Badge> : null}
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
                                ? 'This citizen has no registration, so nothing on their file claims this unit and it cannot be billed. Register them to link it.'
                                : 'لا يوجد ملف لهذا المواطن، فلا شيء يربطه بالوحدة ولن تُحتسب الرسوم. سجّله ليُربط العقار.'
                            }
                          >
                            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                            {en ? 'No file yet' : 'لا ملف له بعد'}
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
                  <Link
                    href={`${base}/citizens/new?buildingId=${encodeURIComponent(building.id)}&unitId=${encodeURIComponent(selectedUnit.id)}`}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    <UserRoundPlus className="size-4" aria-hidden />
                    {en ? 'Register a household here' : 'تسجيل أسرة في هذه الوحدة'}
                  </Link>
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

              {action === 'occupant' && token ? (
                <OccupantForm
                  tenant={tenant}
                  token={token}
                  busy={busy}
                  locale={locale}
                  // Opens «مساحة الوحدة» when the census holds none — a matrix
                  // painted from the street records that a flat exists, not
                  // that anyone has measured it.
                  unitArea={selectedUnit.unitArea}
                  onSubmit={(citizen, occRole, shares, unitStatus, unitArea) =>
                    void run(
                      async () => {
                        if (!token) throw new Error('unauthenticated');
                        const result = await recordOccupancy(tenant, token, {
                          unitId: selectedUnit.id,
                          citizenId: citizen.id,
                          role: occRole,
                          shares,
                          unitStatus,
                          unitArea,
                        });
                        return occupancyMessage(
                          citizen.fullName,
                          selectedUnit.unitCode,
                          result,
                          en,
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
                        if (!token) throw new Error('unauthenticated');
                        await createCase(tenant, token, {
                          notes: values.notes,
                          caseType: values.caseType,
                          buildingId: building.id,
                          unitId: selectedUnit.id,
                          propertyNumber: building.parcelNumber,
                          buildingName: building.name ?? undefined,
                          scheduledRevisitAt: values.revisitAt || undefined,
                        });
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
                        if (!token) throw new Error('unauthenticated');
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
                        if (!token) throw new Error('unauthenticated');
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

          {!selectedUnit && action === 'damage' && canWrite ? (
            <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/[0.03] p-4">
              <DamageForm
                busy={busy}
                locale={locale}
                target={en ? `building ${building.code}` : `المبنى ${building.code}`}
                onSubmit={(values) =>
                  void run(
                    async () => {
                      if (!token) throw new Error('unauthenticated');
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
    </div>
  );
}
