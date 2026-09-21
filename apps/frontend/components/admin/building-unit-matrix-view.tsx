'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  ClipboardList,
  DoorClosed,
  Footprints,
  Loader2,
  Grid2X2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {
  getLabels,
  defaultUnitTypeFor,
  isOccupiableLifecycle,
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
  type DuplicateUnitCandidate,
  type UnitOccupant,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatDate } from '@/lib/dates';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';
import { endTenancyMessage } from '@/components/admin/after-tenancy-question';
import {
  type EndOccupancyAnswer,
  activeVacancy,
  AddPersonForm,
  CaseForm,
  cellBadge,
  ConfirmVacancyForm,
  DamageForm,
  effectiveUnitStatus,
  floorLabel,
  groupUnitsByFloor,
  layoutFloor,
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

const READ_ONLY_ROLES = ['AUDITOR', 'ACCOUNTANT'];

const DAMAGED_LEVELS: readonly DamageLevel[] = [
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
];

type ActionKind = 'occupant' | 'case' | 'damage' | 'visit' | 'vacancy' | null;

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
 * 5rem, because a tile carries up to four lines: the unit code, its state
 * («شاغرة»), who is recorded on it, and the visit count. The old `min-h-14`
 * (3.5rem) grew with its content, and 4rem held the code and the count but
 * clipped the two state lines — a fixed height has to fit the fullest tile, or
 * the fullest tile is the one whose state disappears.
 */
const MATRIX_ROW_HEIGHT = 'h-20';

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
  /** The signed-in officer — lets the visit form recognise their own visit from earlier today. */
  const [viewerId, setViewerId] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role ?? null);
    setViewerId(session.user.id);
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

  /*
    Why «تأكيد الشغور» cannot be pressed here — a مستأجر or شاغل بتسامح living
    in the unit, or a seasonal home. Never the owner. See `vacancyBlocker`; the
    server applies the same rules.
  */
  const vacancyBlocked = useMemo(
    () => (selectedUnit ? vacancyBlocker(selectedUnit, en) : null),
    [selectedUnit, en],
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

  /*
    «تأكيد الشغور» is a form under the unit now, like «كشف ضرر», so it goes
    through `run`: a refusal lands in the error line under the form, which
    stays open. The drawer does the same.
  */
  const saveVacancy = (
    unit: UnitWithOccupants,
    input: { basis: VacancyBasis; observedAt?: string; notes: string },
  ) =>
    run(
      async () => {
        if (!token) throw new Error('unauthenticated');
        const result = await confirmVacancy(tenant, token, unit.id, {
          basis: input.basis,
          ...(input.observedAt ? { observedAt: input.observedAt } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        });
        return [
          en ? `Unit ${unit.unitCode} confirmed vacant` : `تم تأكيد شغور الوحدة ${unit.unitCode}`,
          result.casesResolved > 0
            ? en
              ? `${result.casesResolved} case(s) closed`
              : `أُغلقت ${result.casesResolved} حالة`
            : null,
        ]
          .filter(Boolean)
          .join('، ');
      },
      en ? 'Could not confirm the vacancy.' : 'تعذّر تأكيد الشغور.',
    );

  /*
    Lifting a vacancy is still a dialog (`EndVacancyDialog`), so it does not go
    through `run`: a refusal belongs in the dialog the officer is looking at,
    and this rethrows for the dialog to show.
  */
  const liftVacancy = async (
    unit: UnitWithOccupants,
    input: { reason: VacancyEndReason; endedAt?: string; notes: string },
  ) => {
    if (!token) throw new Error('unauthenticated');
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
    // «لم تعد شاغرة» leaves somebody unrecorded in the flat; the form for
    // recording them opens rather than being looked for.
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
    Ending a spell, after `EndOccupancyDialog` has asked why.

    Not routed through `run`: a refusal belongs in the dialog the officer is
    looking at, not in a toast behind it, so the error is rethrown for the
    dialog to show and the dialog stays open.
  */
  const closeSpell = async (occupant: UnitOccupant, input: EndOccupancyAnswer) => {
    if (!token) throw new Error('unauthenticated');
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
    toast.success(endTenancyMessage(result, locale));
  };

  /** «ربط بالمالك» — a refusal is rethrown for the dialog to show, as `closeSpell`'s is. */
  const linkOwner = async (occupant: UnitOccupant, ownerId: string, confirmRecordedAfter: boolean) => {
    if (!token) throw new Error('unauthenticated');
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
    toast.success(ownerLinkMessage(result, en));
  };

  const saveSeasonal = (
    unit: UnitWithOccupants,
    values: { presenceMonths: number[]; ownerLastStayAt: string | null; vacancyDeclaredAt: string | null },
  ) =>
    run(
      async () => {
        if (!token) throw new Error('unauthenticated');
        await updateUnit(tenant, token, unit.id, values);
        return en ? 'Seasonal details saved' : 'تم حفظ بيانات السكن الموسمي';
      },
      en ? 'Could not save the seasonal details.' : 'تعذّر حفظ بيانات السكن الموسمي.',
    );

  const cancelHref = `${base}/buildings`;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
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
          <div className="space-y-4 border-b border-border/80 pb-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-xl font-bold text-foreground" dir="ltr">
                  {building.code}
                </h1>
                {building.name ? (
                  <span className="text-sm font-medium text-muted-foreground">{building.name}</span>
                ) : null}
              </div>

              {/*
                The actions come before the facts, and all three are one width.

                Packed to their own labels they were three different buttons of
                three different sizes, which reads as a ranking nobody intended;
                on a phone they are a stack, on a desk a row of equal thirds.
              */}
              {canWrite ? (
                <div className="grid grid-cols-1 gap-2 sm:shrink-0 sm:grid-cols-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setSelectedUnitId(null);
                      setActionError(null);
                      setAction('damage');
                    }}
                  >
                    <ShieldAlert className="size-4" aria-hidden />
                    {en ? 'Assess the building' : 'كشف ضرر على المبنى'}
                  </Button>
                  {/*
                    Two buttons where there was one, because they were two jobs
                    behind a single label. «تعديل معلومات المبنى» corrects the
                    shell and never opens the matrix; «تعديل مصفوفة الوحدات»
                    lands directly on the grid, which is what someone reading
                    this screen usually came to change.
                  */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      router.push(
                        `${base}/buildings/${encodeURIComponent(building.id)}/edit?step=units`,
                      )
                    }
                  >
                    <Grid2X2 className="size-4" aria-hidden />
                    {en ? 'Edit unit matrix' : 'تعديل مصفوفة الوحدات'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      router.push(
                        `${base}/buildings/${encodeURIComponent(building.id)}/edit?scope=info`,
                      )
                    }
                  >
                    <Pencil className="size-4" aria-hidden />
                    {en ? 'Edit building details' : 'تعديل معلومات المبنى'}
                  </Button>
                </div>
              ) : null}
            </div>

            {/*
              What the structure is, then where it stands cadastrally — one fact
              per row, as «ملخص المنشأة» shows it before saving, so a building
              reads the same on the way in and on the way back.

              «قائم ومستعمل» is left unsaid, as it was on the badges: it is the
              answer on nineteen buildings in twenty. The same goes for the rows
              that are empty for most of the register — shared parcels, a posted
              number, damage — and for the فرز, which is three-valued: «لم يُسأل»
              is the default for every building recorded before the column
              existed, and printing «غير مفروزة» for those would be asserting a
              finding nobody made — see `Building.isPartitioned`.

              Capped in width: on a desk, a label at one edge of the page and its
              value at the other are too far apart to read as a pair.
            */}
            <SummaryList>
              <SummaryRow label={en ? 'Structure Type' : 'نوع المنشأة'}>
                {labels.structureType[building.structureType]}
              </SummaryRow>

              {building.lifecycleStatus !== 'IN_USE' ? (
                <SummaryRow
                  label={en ? 'Construction Status' : 'الحالة الإنشائية'}
                  className="text-amber-700 dark:text-amber-400"
                >
                  {labels.buildingLifecycle[building.lifecycleStatus]}
                </SummaryRow>
              ) : null}

              <SummaryRow label={en ? 'Floors' : 'الطوابق'}>
                {en ? `${building.floorsCount} floors` : `${building.floorsCount} طابق`}
                {/* The range the floors are labelled by — «B1–B2» — so it names the rows the matrix shows. */}
                {building.basementsCount
                  ? ` · ${building.basementsCount === 1 ? 'B1' : `B1–B${building.basementsCount}`}`
                  : ''}
              </SummaryRow>

              {/*
                A matrix on a structure nobody can be inside is an inventory, not
                outstanding work — and the ledger's figures leave it out.
              */}
              <SummaryRow
                label={en ? 'Units' : 'الوحدات'}
                className={
                  isOccupiableLifecycle(building.lifecycleStatus) &&
                  building.unitsTotal > 0 &&
                  building.unitsSurveyed === building.unitsTotal
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : undefined
                }
              >
                {!isOccupiableLifecycle(building.lifecycleStatus)
                  ? en
                    ? `${building.unitsTotal} units recorded — not counted as survey work`
                    : `${building.unitsTotal} وحدة مسجَّلة — غير محتسبة ضمن أعمال المسح`
                  : en
                    ? `${building.unitsSurveyed} of ${building.unitsTotal} units surveyed`
                    : `${building.unitsSurveyed} من ${building.unitsTotal} وحدة ممسوحة`}
              </SummaryRow>

              {damage?.current ? (
                <SummaryRow label={en ? 'Damage level' : 'مستوى الضرر'} className="text-destructive">
                  {labels.damageLevel[damage.current]}
                </SummaryRow>
              ) : null}

              {building.postedNumber ? (
                <SummaryRow label={en ? 'Posted number' : 'الرقم المكتوب'} className="font-mono">
                  {building.postedNumber}
                </SummaryRow>
              ) : null}

              <SummaryRow label={en ? 'Parcel Number' : 'رقم العقار'} className="font-mono">
                {building.parcelNumber}
              </SummaryRow>

              {building.sharedParcelNumbers?.length ? (
                <SummaryRow label={en ? 'Shared parcels' : 'عقارات مشتركة'} className="font-mono">
                  {building.sharedParcelNumbers.join(en ? ', ' : '، ')}
                </SummaryRow>
              ) : null}

              {/*
                The فرز with its أقسام where they have been collected: «مفروزة»
                on its own does not answer the question anybody asks it — «which
                قسم?». A ticked فرز with no numbers yet is still stated.
              */}
              {building.isPartitioned != null ? (
                <SummaryRow label={en ? 'Partition' : 'الفرز'}>
                  {building.isPartitioned
                    ? building.partitionNumbers?.length
                      ? en
                        ? `Partitioned — parts ${building.partitionNumbers.join(', ')}`
                        : `مفروزة — الأقسام ${building.partitionNumbers.join('، ')}`
                      : en
                        ? 'Partitioned'
                        : 'مفروزة'
                    : en
                      ? 'Not partitioned'
                      : 'غير مفروزة'}
                </SummaryRow>
              ) : null}

              {building.zoneName ? (
                <SummaryRow label={en ? 'Sector' : 'القطاع'}>
                  {building.zoneCode ? `${building.zoneCode} · ${building.zoneName}` : building.zoneName}
                </SummaryRow>
              ) : null}

              <SummaryRow
                label={en ? 'Location' : 'الموقع'}
                className={building.latitude != null ? undefined : 'text-muted-foreground'}
              >
                {building.latitude != null
                  ? en
                    ? 'Located'
                    : 'محدَّد الموقع'
                  : en
                    ? 'Not on the map'
                    : 'غير محدَّد على الخريطة'}
              </SummaryRow>
            </SummaryList>
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

              {/*
                The units themselves — the only thing that scrolls, and only
                sideways.

                `overflow-y-hidden` is not a default being restated. CSS turns
                the other axis of an `overflow-x-auto` box into `auto` as well,
                so this strip was a scroll container in both directions, and any
                pixel of vertical overflow grew a vertical scrollbar — which on
                Windows then took 17px of width and forced a horizontal one
                beside it. The rows have a fixed height; there is nothing below
                them to scroll to.

                `pb-1` keeps a real scrollbar, where a floor is wide enough to
                need one, off the bottom row of tiles.
              */}
              <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 [scrollbar-width:thin]">
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
                            /*
                              Every ring inset, and the selected tile no longer
                              scaled up.

                              `scale-[1.03]` pushed the chosen tile a few pixels
                              past its row on every side. Inside a scroll
                              container that is overflow, so selecting a flat
                              was what made the scrollbars appear, and the ring
                              around it was clipped to one blue line between
                              two floors. An inset ring is drawn inside the tile
                              and can be neither; the keyboard focus ring is
                              inset for the same reason.
                            */
                            className={cn(
                              'flex h-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-center ring-1 ring-inset transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              STATUS_BLOCK_CLASSES[badge.variant],
                              selected && 'ring-2 ring-primary',
                            )}
                          >
                            <span className="font-mono text-xs font-bold">{unit.unitCode}</span>
                            {/*
                              The state is written on the tile, not only in its
                              tooltip: a phone has no hover, and «شاغرة» beside an
                              owner's name was the one thing the matrix could
                              not show. Truncated rather than wrapped so a
                              narrow block keeps its height.
                            */}
                            <span className="block max-w-full truncate text-[10px] font-medium leading-tight">
                              {badge.short}
                            </span>
                            {badge.detail ? (
                              <span className="hidden max-w-full truncate text-[10px] leading-tight opacity-80 sm:block">
                                {badge.detail}
                              </span>
                            ) : null}
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

          {building.units.length > 0 ? <UnitStateLegend locale={locale} /> : null}

          {/* ── Add-unit inline flow, open for at most one floor ─────── */}
          {addingFloor !== null ? (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <p className="text-xs font-semibold text-muted-foreground">
                {floorLabel(addingFloor, en)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={addingType} onValueChange={setAddingType}>
                  <SelectTrigger className="h-9 min-w-0 flex-1 basis-full text-xs sm:basis-0">
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

          {/* ── The selected unit, and what can be done with it ─ */}
          {selectedUnit ? (
            /*
              Laid out the way the building above it is: the code, then what can
              be done, then what is known — so the form a button opens lands
              directly under that button rather than under a list of occupants.
            */
            <div className="space-y-4 rounded-lg border border-primary/40 bg-primary/[0.03] p-4">
              <p className="text-base font-bold">
                <span dir="ltr" className="font-mono">
                  {building.code}-{selectedUnit.unitCode}
                </span>
              </p>

              {/*
                One width for every action: a stack on a phone, where «إضافة
                شخص إلى الوحدة» does not fit half a screen, and even columns from
                `sm` up.
              */}
              {canWrite ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <Button
                      size="sm"
                      className="w-full"
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
                      className="w-full"
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
                      Hidden once a confirmation is standing: the panel above
                      carries it and the control that lifts it, and a greyed-out
                      «تأكيد الشغور» beside it would read as unavailable rather
                      than already done.
                    */}
                    {activeVacancy(selectedUnit) ? null : (
                      <Button
                        size="sm"
                        className="w-full"
                        variant={action === 'vacancy' ? 'default' : 'outline'}
                        disabled={busy || vacancyBlocked !== null}
                        title={vacancyBlocked ?? undefined}
                        onClick={() => {
                          setActionError(null);
                          setAction(action === 'vacancy' ? null : 'vacancy');
                        }}
                      >
                        <DoorClosed className="size-4" aria-hidden />
                        {en ? 'Confirm vacant' : 'تأكيد الشغور'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="w-full"
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
                      className="w-full"
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
                  </div>
                  {/*
                    Out of the grid on purpose. It deletes on a single tap, with no
                    dialog behind it, so it does not get a cell the same size as
                    «تسجيل زيارة» right beside the thumb that meant to press that.
                  */}
                  {selectedUnit.occupants.length === 0 && selectedUnit.visitCount === 0 ? (
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
                <AddPersonForm
                  tenant={tenant}
                  token={token}
                  busy={busy}
                  locale={locale}
                  newFileHref={(residence, name) =>
                    `${base}/citizens/new?buildingId=${encodeURIComponent(building.id)}&unitId=${encodeURIComponent(selectedUnit.id)}&residence=${residence}${
                      name ? `&name=${encodeURIComponent(name)}` : ''
                    }`
                  }
                  vacancy={activeVacancy(selectedUnit)}
                  owners={unitOwners(selectedUnit)}
                  // Opens «مساحة الوحدة» when the census holds none — a matrix
                  // painted from the street records that a flat exists, not
                  // that anyone has measured it.
                  unitArea={selectedUnit.unitArea}
                  onSubmit={({ citizen, role: occRole, endsVacancy, ...rest }) =>
                    void run(
                      async () => {
                        if (!token) throw new Error('unauthenticated');
                        const result = await recordOccupancy(tenant, token, {
                          unitId: selectedUnit.id,
                          citizenId: citizen.id,
                          role: occRole,
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
                  viewerId={viewerId}
                  visits={selectedUnit.visits}
                  onSubmit={(values) =>
                    void run(
                      async () => {
                        if (!token) throw new Error('unauthenticated');
                        return logVisitWithFollowUp(
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
                        );
                      },
                      en ? 'Could not log the visit.' : 'تعذّر تسجيل الزيارة.',
                    )
                  }
                />
              ) : null}

              {action === 'vacancy' ? (
                <ConfirmVacancyForm
                  key={selectedUnit.id}
                  unit={selectedUnit}
                  locale={locale}
                  busy={busy}
                  onSubmit={(values) => void saveVacancy(selectedUnit, values)}
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

              <SummaryList>
                <SummaryRow label={en ? 'Floor' : 'الطابق'}>
                  {floorLabel(selectedUnit.floor, en)}
                </SummaryRow>
                <SummaryRow label={en ? 'Unit type' : 'نوع الوحدة'}>
                  {labels.unitType[selectedUnit.unitType]}
                </SummaryRow>
                <SummaryRow
                  label={en ? 'Survey status' : 'حالة المسح'}
                  className={
                    selectedUnit.surveyStatus === 'COMPLETE'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : undefined
                  }
                >
                  {labels.surveyStatus[selectedUnit.surveyStatus]}
                </SummaryRow>
              </SummaryList>

              <OccupantList
                unit={selectedUnit}
                locale={locale}
                canWrite={canWrite}
                busy={busy}
                citizenHref={(citizenId) => `${base}/citizens/${citizenId}`}
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

      {/*
        «سجل الموظفين على هذا القيد» used to sit here.

        Creating a building lands the officer on this page, and the first thing
        under their new record was a panel telling them they had just created
        it — the one moment the trail has nothing to say that the person
        reading it does not already know. It also only ever rendered for
        SUPER_ADMIN and AUDITOR, so for everyone else it was a request that
        returned nothing on every visit.

        The trail itself is not gone: «سجل النشاطات» filters to this building
        by record type and date, and the citizen profile still carries its own
        panel. Removed here rather than hidden behind a flag, because a flag
        would keep firing the request.
      */}
    </div>
  );
}
