import {
  useState,
} from 'react';
import {
  CalendarClock,
  Footprints,
  Loader2,
  MapPin,
  ShieldAlert,
} from 'lucide-react';
import {
  CASE_TYPE,
  getLabels,
  isOccupiableLifecycle,
  isStructuralUnitType,
  isUnoccupied,
  layoutBuildingFloors,
  layoutFloorSpans,
  spanLimits,
  SURVEY_STATUS,
  unitStatusForRole,
  type BuildingLifecycle,
  type CaseType,
  type DamageLevel,
  type StructureType,
  type SurveyStatus,
  type UnitStatus,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  createCase,
  logApiError,
  logUnitVisit,
  REPEAT_VISIT_WINDOW_MS,
  type OccupancyFileLink,
  type RecordedOwnerLink,
  type UnitOccupant,
  type UnitVacancyConfirmation,
  type UnitVisitRow,
  type UnitWithOccupants,
} from '@/lib/api-client';
import {
  formatDate,
} from '@/lib/dates';
import {
  cn,
} from '@/lib/utils';
import {
} from '@/components/ui/alert';
import {
  Badge,
} from '@/components/ui/badge';
import {
  Button,
} from '@/components/ui/button';
import {
  Checkbox,
} from '@/components/ui/checkbox';
import {
  Field,
} from '@/components/ui/field';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Textarea,
} from '@/components/ui/textarea';

export const VISIT_OUTCOMES = SURVEY_STATUS.filter(
  (status): status is Exclude<SurveyStatus, 'NOT_SURVEYED' | 'VACANT_CONFIRMED'> =>
    /*
      `VACANT_CONFIRMED` is excluded for the opposite reason to `NOT_SURVEYED`.

      That one means nobody went. This one is a finding that stops the owner's
      occupancy fee — and a visit form asks for none of what that needs: what
      the vacancy rests on, and a record that can be lifted again. Both existed
      and only one of them exempted anybody, so «شاغرة» on a cell meant two
      different things depending on which control an officer had used. It goes
      through «تأكيد الشغور» now, and `logVisitSchema` refuses it here.
    */
    status !== 'NOT_SURVEYED' && status !== 'VACANT_CONFIRMED',
);

/**
 * The «تأكيد الشغور» standing on a unit, or null.
 *
 * `vacancies` arrives newest first and closed rows are kept, so "is this flat
 * confirmed empty" is the one with no `endedAt` — not merely the newest, and
 * not the unit's حالة, which a confirmation causes but which can also be set
 * by an owner's own answer.
 */
export function activeVacancy(unit: UnitWithOccupants): UnitVacancyConfirmation | null {
  return (unit.vacancies ?? []).find((row) => row.endedAt === null) ?? null;
}

/** The five tints a unit can wear. See `cellBadge` and `UnitStateLegend`. */
export type CellVariant =
  | 'soft-success'
  | 'soft-warning'
  | 'soft-destructive'
  | 'soft-info'
  | 'soft-muted';

export interface CellBadge {
  /** The whole sentence — the tooltip, and the one-line badge in the picker. */
  text: string;
  /** The unit's state alone, short enough for a matrix tile. */
  short: string;
  /** Who, when there is somebody to name — the tile's second line. */
  detail?: string;
  variant: CellVariant;
}

/** Tile-length names for حالة الوحدة. The full labels are for forms. */
const SHORT_UNIT_STATUS: Record<'ar' | 'en', Record<UnitStatus, string>> = {
  ar: {
    OWNER_OCCUPIED: 'مشغولة من المالك',
    RENTED: 'مؤجرة',
    FREE_OCCUPIED: 'مشغولة بتسامح',
    SEASONAL: 'مسكن موسمي',
    VACANT: 'شاغرة',
    UNDER_CONSTRUCTION: 'قيد الإنجاز',
  },
  en: {
    OWNER_OCCUPIED: 'Owner-occupied',
    RENTED: 'Rented',
    FREE_OCCUPIED: 'Rent-free',
    SEASONAL: 'Seasonal home',
    VACANT: 'Vacant',
    UNDER_CONSTRUCTION: 'Under construction',
  },
};

/** The spells running now, newest first. */
export function liveSpells(unit: UnitWithOccupants) {
  return unit.occupants
    .filter((occupant) => occupant.toDate === null)
    .sort((a, b) => (a.fromDate < b.fromDate ? 1 : -1));
}

/**
 * The flat's current owners, first recorded first — co-owners included.
 *
 * What «المالك» offers a tenant: the unit's own owner list is the evidence a
 * picked owner rests on, so nobody outside it is offered.
 */
export function unitOwners(unit: UnitWithOccupants): UnitOccupant[] {
  return unit.occupants
    .filter((occupant) => occupant.toDate === null && occupant.role === 'OWNER')
    .sort((a, b) => ((a.recordedAt ?? a.fromDate) < (b.recordedAt ?? b.fromDate) ? -1 : 1));
}

/**
 * The people actually *living* in a unit — a مستأجر or a شاغل بتسامح.
 *
 * An owner is deliberately not one of them: the deed is not a statement of
 * residence (D2). This is the set «تأكيد الشغور» is refused over, on the screen
 * and on the server alike — it used to be refused over the owner too, which is
 * what taught inspectors to end an owner's ownership to record an empty flat.
 */
export function livingOccupants(unit: UnitWithOccupants) {
  return liveSpells(unit).filter((occupant) => occupant.role !== 'OWNER');
}

/**
 * حالة الوحدة as the register bills it: the unit's own value, or — where
 * nobody set one — what the owner's card says. The same order billing reads
 * them in (P2-T8), so a tile can never describe a unit differently from how it
 * is charged.
 */
export function effectiveUnitStatus(unit: UnitWithOccupants): UnitStatus | null {
  return unit.unitStatus ?? unit.ownerDeclaredStatus ?? null;
}

/**
 * The badge a cell wears — two questions answered separately.
 *
 * ## Why this changed
 *
 * It used to lead with *who is recorded*: any current spell, owner included,
 * turned the cell green «مسجلة (مالك: فلان)». So an owner recorded on a flat
 * they had just called «شاغرة» looked exactly like an owner living in it — the
 * one fact the owner had stated was the one the matrix could not show — and on a
 * phone the state was only in a tooltip nobody can hover.
 *
 * Now the colour and the short label say **what state the unit is in**, and
 * the second line says **who** is recorded against it. The colours keep one
 * meaning each, shown in `UnitStateLegend`:
 *
 *   • green — answered and billed (somebody lives there);
 *   • blue — answered and not billed as lived in (شاغرة، قيد الإنجاز، موسمي);
 *   • amber — something is missing that decides a bill;
 *   • red — the record contradicts itself, or the survey was refused.
 *
 * ## The cases, in order
 *
 * 1. A مستأجر or شاغل بتسامح is recorded. If the unit also says it is empty,
 *    that is a contradiction (red «تعارض»); otherwise their capacity is the
 *    state, named after them.
 * 2. The unit has a state. Empty/unfinished/seasonal is blue with the owner on
 *    the second line. «مؤجرة» or «مشغولة بتسامح» with nobody recorded is amber:
 *    the owner is exempt because someone else lives there, and that someone is
 *    billed nowhere — revenue to go and find. Owner-occupied is green.
 * 3. Only an owner is recorded and nobody asked whether anyone lives there —
 *    amber, because an unanswered unit bills the owner by default.
 * 4. Nobody at all — the survey status speaks, as it always did. «غير ممسوحة»
 *    stays untinted: on a freshly generated matrix every cell is that, and a
 *    wall of amber says nothing.
 */
export function cellBadge(
  unit: UnitWithOccupants,
  labels: ReturnType<typeof getLabels>,
  en: boolean,
): CellBadge {
  const short = SHORT_UNIT_STATUS[en ? 'en' : 'ar'];
  const living = livingOccupants(unit)[0];
  const owner = liveSpells(unit).find((occupant) => occupant.role === 'OWNER');
  const status = effectiveUnitStatus(unit);
  const named = (occupant: { citizenName: string | null } | undefined) =>
    occupant?.citizenName ?? (en ? 'Unnamed' : 'بلا اسم');
  const ownerLine = owner ? (en ? `Owner: ${named(owner)}` : `المالك: ${named(owner)}`) : undefined;
  const badge = (text: string, variant: CellVariant, detail?: string): CellBadge => ({
    short: text,
    detail,
    text: detail ? `${text} — ${detail}` : text,
    variant,
  });

  /*
    A طابق أعمدة or طابق فارغ is not survey work, and must not be labelled as
    any.

    Every branch below asks a question about a unit — who lives in it, who owns
    it, whether anyone has been to the door. A structural block answers none of
    them, so it fell through to the default and came out «غير ممسوحة»: the
    matrix telling an officer there is a door here they have not knocked on,
    about a floor of open columns. That is the one tile that would send someone
    back to a building for nothing, and `UnitStateLegend` now prints the
    grey swatch's meaning underneath, which turned an unexplained colour into a
    stated and wrong one.

    Same wording as the picker's own structural branch, which said it first.
  */
  if (isStructuralUnitType(unit.unitType)) {
    return badge(
      en ? 'Structure — not a unit' : 'جزء من البناء — ليست وحدة',
      'soft-muted',
      labels.unitType[unit.unitType],
    );
  }

  if (living) {
    const who = `${labels.occupancyRole[living.role]}: ${named(living)}`;
    if (isUnoccupied(status)) {
      return badge(en ? 'Conflict' : 'تعارض', 'soft-destructive', `${who} — ${short[status!]}`);
    }
    const lived = (unitStatusForRole(living.role) ?? 'RENTED') as UnitStatus;
    return badge(short[lived], 'soft-success', named(living));
  }

  if (status) {
    switch (status) {
      case 'VACANT':
      case 'UNDER_CONSTRUCTION':
      case 'SEASONAL':
        return badge(short[status], 'soft-info', ownerLine);
      case 'RENTED':
        return badge(
          en ? 'Rented — tenant not recorded' : 'مؤجرة — المستأجر غير مسجَّل',
          'soft-warning',
          ownerLine,
        );
      case 'FREE_OCCUPIED':
        return badge(
          en ? 'Rent-free — occupant not recorded' : 'بتسامح — الشاغل غير مسجَّل',
          'soft-warning',
          ownerLine,
        );
      case 'OWNER_OCCUPIED':
        return badge(short.OWNER_OCCUPIED, 'soft-success', owner ? named(owner) : undefined);
    }
  }

  if (owner) {
    return badge(
      en ? 'Owner recorded — occupancy not established' : 'مالك مسجَّل — الإشغال غير محدد',
      'soft-warning',
      named(owner),
    );
  }

  switch (unit.surveyStatus) {
    case 'VACANT_CONFIRMED':
      return badge(short.VACANT, 'soft-info');
    case 'VISITED_NO_ANSWER':
      return badge(en ? 'Revisit' : 'إعادة زيارة', 'soft-warning');
    case 'REFUSED':
    case 'INACCESSIBLE':
    case 'DEMOLISHED':
      return badge(labels.surveyStatus[unit.surveyStatus], 'soft-destructive');
    case 'PARTIAL':
      return badge(labels.surveyStatus[unit.surveyStatus], 'soft-warning');
    case 'COMPLETE':
      return badge(labels.surveyStatus[unit.surveyStatus], 'soft-success');
    default:
      return badge(en ? 'Not surveyed' : 'غير ممسوحة', 'soft-muted');
  }
}

/**
 * What the colours mean, said once under every matrix.
 *
 * A colour code nobody explains is a colour code people guess at — and the
 * guess that matters here is amber, which is not "in progress" but "a bill
 * depends on something nobody has recorded".
 *
 * Grey carries two meanings and they are listed separately, because the
 * difference between them is whether anyone should go back to the building:
 * «غير ممسوحة» is a door nobody has knocked on, «جزء من البناء» is a floor
 * with no door to knock on. One entry for both would have made the legend
 * agree with the bug it exists to prevent.
 */
export function UnitStateLegend({ locale, className }: { locale: string; className?: string }) {
  const en = locale === 'en';
  const entries: Array<{ variant: CellVariant; text: string }> = [
    { variant: 'soft-success', text: en ? 'Lived in — billed' : 'مسكونة — تُحتسب الرسوم' },
    {
      variant: 'soft-info',
      text: en ? 'Vacant, unfinished or seasonal' : 'شاغرة أو قيد الإنجاز أو موسمية',
    },
    {
      variant: 'soft-warning',
      text: en ? 'Missing what decides the bill' : 'ينقصها ما يحدد الرسوم',
    },
    { variant: 'soft-destructive', text: en ? 'Contradiction or refused' : 'تعارض أو رفض' },
    { variant: 'soft-muted', text: en ? 'Not surveyed' : 'غير ممسوحة' },
    {
      variant: 'soft-muted',
      text: en ? 'Structure — not a unit' : 'جزء من البناء — ليست وحدة',
    },
  ];
  return (
    <ul
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground', className)}
      aria-label={en ? 'What the colours mean' : 'دلالة الألوان'}
    >
      {/* Keyed by the text, not the variant: grey now has two entries. */}
      {entries.map((entry) => (
        <li key={entry.text} className="flex items-center gap-1.5">
          <Badge variant={entry.variant} className="size-3 rounded-sm p-0" aria-hidden />

          {entry.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * «الطابق الثالث» / «B1» — the floor as it is spoken above ground, and as the
 * unit code spells it below.
 *
 * Basements are `B1`, `B2` in both locales and on every surface, deliberately
 * untranslated. `formatUnitCode` prints a basement unit as `B102`, and
 * `parseFloorLabel`'s basement pattern accepts `b1` *because* that is what the
 * code shows — so a floor labelled `B1` is the one label that matches the code
 * on the row, survives being copied into the card's free-text floor column, and
 * reads back out of it as −1. A translated «القبو ١» beside a code reading
 * `B102` is two vocabularies for one floor.
 *
 * It also sidesteps the reason the code avoids a minus sign: a leading `-` in
 * an RTL line renders on whichever side the bidi algorithm picks.
 */
export function floorLabel(floor: number, en: boolean): string {
  if (floor < 0) return `B${Math.abs(floor)}`;
  if (en) return floor === 0 ? 'Ground floor' : `Floor ${floor}`;
  return floor === 0 ? 'الطابق الأرضي' : `الطابق ${floor}`;
}

/**
 * Floors top-down, so a matrix stands the way the building does, and each
 * floor's units in the order they run along it.
 *
 * Shared by every surface that draws a matrix — the drawer, the ledger's
 * full-page view and the citizen card's picker — so none of them can quietly
 * disagree about which way a building is drawn.
 */
export function groupUnitsByFloor<T extends { floor: number; sequence: number }>(
  units: readonly T[],
): Array<{ floor: number; units: T[] }> {
  const grouped = new Map<number, T[]>();
  for (const unit of units) {
    grouped.set(unit.floor, [...(grouped.get(unit.floor) ?? []), unit]);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([floor, floorUnits]) => ({
      floor,
      units: [...floorUnits].sort((a, b) => a.sequence - b.sequence),
    }));
}

/**
 * Adds a row for every basement the register declares and no unit occupies.
 *
 * Above ground an empty storey needs no row: the «إضافة وحدة» control at the
 * foot of every matrix seeds `max(floor) + 1`, so the next empty floor up is
 * always one tap away. Nothing seeds downward, so a building recorded as having
 * two basements — which is the entire point of `Building.basementsCount` —
 * would draw no B1, no B2, and offer nowhere to record what is in them.
 *
 * Takes the already-grouped floors rather than the units, so it composes with
 * `groupUnitsByFloor` on every surface that draws a matrix without any of them
 * having to agree on how a floor is laid out.
 */
export function withDeclaredBasements<T>(
  grouped: Array<{ floor: number; units: T[] }>,
  basementsCount: number | undefined,
): Array<{ floor: number; units: T[] }> {
  const declared = basementsCount ?? 0;
  if (declared === 0) return grouped;

  const present = new Set(grouped.map((entry) => entry.floor));
  const empties: Array<{ floor: number; units: T[] }> = [];
  for (let depth = 1; depth <= declared; depth += 1) {
    if (!present.has(-depth)) empties.push({ floor: -depth, units: [] });
  }
  if (empties.length === 0) return grouped;

  return [...grouped, ...empties].sort((a, b) => b.floor - a.floor);
}

/** One unit placed on its floor's column grid — see `layoutFloor`. */
export interface LaidOutUnit<T = UnitWithOccupants> {
  unit: T;
  startCol: number;
  endCol: number;
  /**
   * An upper level of a home entering on a floor below — a «دوبلكس» or
   * «تريبلكس» (`Unit.levels`, 0095). Drawn joined to its entrance, opening the
   * same unit; nothing else is drawn on it.
   */
  continuation?: true;
}

/**
 * Every floor of a building as the matrix draws it, top floor first: each
 * unit at its entrance, the upper levels of a home on the floors above it in
 * the same columns (`layoutBuildingFloors`), and an empty row for every
 * basement the register declares and nothing occupies.
 */
export function layoutBuilding<
  T extends { floor: number; sequence: number; levels?: number | null; startCol?: number | null; endCol?: number | null },
>(
  units: readonly T[],
  basementsCount: number | undefined,
): Array<{ floor: number; blocks: Array<LaidOutUnit<T>>; width: number }> {
  const ordered = [...units].sort((a, b) => a.floor - b.floor || a.sequence - b.sequence);
  const rows = [...layoutBuildingFloors(ordered).values()].map(({ floor, blocks, width }) => ({
    floor,
    blocks,
    width,
  }));
  const present = new Set(rows.map((row) => row.floor));
  for (let depth = 1; depth <= (basementsCount ?? 0); depth += 1) {
    if (!present.has(-depth)) rows.push({ floor: -depth, blocks: [], width: 1 });
  }
  return rows.sort((a, b) => b.floor - a.floor);
}

/**
 * How far a unit's edges may move: on every floor it occupies at once, so a
 * «دوبلكس» widens only as far as both of its floors allow. `null` when the
 * unit is not drawn.
 */
export function spanLimitsAcross<T>(
  floors: ReadonlyArray<{ blocks: ReadonlyArray<LaidOutUnit<T>> }>,
  target: T,
  maxCol: number,
): { minStart: number; maxEnd: number } | null {
  let result: { minStart: number; maxEnd: number } | null = null;
  for (const { blocks } of floors) {
    const limits = spanLimits(blocks, target, maxCol);
    if (!limits) continue;
    result = result
      ? { minStart: Math.max(result.minStart, limits.minStart), maxEnd: Math.min(result.maxEnd, limits.maxEnd) }
      : limits;
  }
  return result;
}

/**
 * Reconstructs the floor plan a unit was painted on, unpositioned units
 * appended in `sequence` order — see `layoutFloorSpans`. That lives in
 * shared-schemas because the server, resizing a neighbour, pins an
 * unpositioned unit exactly where this draws it.
 */
export function layoutFloor<T extends { startCol?: number | null; endCol?: number | null }>(
  units: T[],
): { blocks: Array<LaidOutUnit<T>>; width: number } {
  return layoutFloorSpans(units);
}

/** What a structure is, in the badges every census surface shows it with. */
export interface BuildingBadgeFacts {
  structureType: StructureType;
  lifecycleStatus: BuildingLifecycle;
  floorsCount: number;
  /** Levels below ground, as a depth. Absent on a payload predating the column. */
  basementsCount?: number;
  unitsTotal: number;
  unitsSurveyed: number;
  postedNumber: string | null;
  latitude: number | null;
  /** Present on a ledger row; a detail carries its damage separately. */
  damageLevel?: DamageLevel | null;
}

/**
 * The architectural and survey summary of one structure.
 *
 * «قائم ومستعمل» is left unsaid because it is the answer on nineteen buildings
 * in twenty and a badge that appears on all of them stops being read; every
 * other badge here is a fact that changes what an officer does next.
 */
export function BuildingSummaryBadges({
  building,
  locale,
  damageLevel,
  className,
}: {
  building: BuildingBadgeFacts;
  locale: string;
  /** The current level where the caller holds it separately from the row. */
  damageLevel?: DamageLevel | null;
  className?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const damage = damageLevel ?? building.damageLevel ?? null;
  const total = building.unitsTotal;
  const surveyed = building.unitsSurveyed;
  const occupiable = isOccupiableLifecycle(building.lifecycleStatus);

  return (
    <div className={className ?? 'flex flex-wrap items-center gap-2'}>
      <Badge variant="soft-default">{labels.structureType[building.structureType]}</Badge>
      {building.lifecycleStatus !== 'IN_USE' ? (
        <Badge variant="soft-warning">{labels.buildingLifecycle[building.lifecycleStatus]}</Badge>
      ) : null}
      <Badge variant="soft-muted">
        {en ? `${building.floorsCount} floors` : `${building.floorsCount} طابق`}
      </Badge>
      {/* Said only where there is one, and said as the range the floors are
          labelled by — «B1–B2» rather than a count, so it names the same rows
          the matrix shows. */}
      {building.basementsCount ? (
        <Badge variant="soft-muted" className="font-mono">
          {building.basementsCount === 1 ? 'B1' : `B1–B${building.basementsCount}`}
        </Badge>
      ) : null}
      {/*
        A matrix on a structure nobody can be inside is an inventory, not
        outstanding work — and the ledger's figures leave it out. Saying «٠ من ٦
        ممسوحة» beside a total the census does not count would read as six doors
        somebody is failing to knock on.
      */}
      <Badge
        variant={occupiable && total > 0 && surveyed === total ? 'soft-success' : 'soft-muted'}
      >
        {!occupiable
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
      {damage ? (
        <Badge variant="soft-destructive" className="gap-1">
          <ShieldAlert className="size-3" aria-hidden />
          {labels.damageLevel[damage]}
        </Badge>
      ) : null}
      {building.latitude != null ? (
        <Badge variant="soft-muted" className="gap-1">
          <MapPin className="size-3" aria-hidden />
          {en ? 'Located' : 'محدَّد الموقع'}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * What to tell the officer after recording an occupant.
 *
 * Two facts, and the second is new: how many حالة closed, and what happened to
 * the citizen’s own file.
 *
 * The case count is surfaced rather than swallowed for the reason it always
 * was — silently closing somebody else’s dispatch item is how a case list stops
 * being believed. The file half is surfaced because it used to be invisible
 * until the matrix re-rendered with an amber «غير مرتبط بملفه» beside the row
 * the officer had just created, carrying no explanation and no remedy.
 *
 * The link is now made on the way in, so the ordinary answer is that it was
 * made. The exception — a citizen with no registration to hang a property card
 * on — is stated once, at the moment it can still be acted on, and names what
 * to do. Outcomes where nothing was written and nothing is wrong say nothing at
 * all: a line of reassurance on the commonest path of all is noise, and noise is
 * what teaches people to stop reading these.
 */
export function occupancyMessage(
  name: string,
  unitCode: string,
  result: { casesResolved: number; fileLink: OccupancyFileLink; ownerLink?: RecordedOwnerLink | null },
  en: boolean,
  ownerName?: string | null,
): string {
  const parts = [
    en ? `${name} recorded in unit ${unitCode}` : `تم تسجيل ${name} في الوحدة ${unitCode}`,
  ];

  if (result.casesResolved > 0) {
    parts.push(
      en ? `${result.casesResolved} case(s) resolved` : `أُغلقت ${result.casesResolved} حالة`,
    );
  }

  switch (result.fileLink.outcome) {
    case 'ENTRY_CREATED':
      parts.push(en ? 'the property was added to their file' : 'وأُضيف العقار إلى ملفه');
      break;
    case 'UNIT_ADDED':
      parts.push(en ? 'the unit was added to their file' : 'وأُضيفت الوحدة إلى ملفه');
      break;
    case 'NO_FILE':
      parts.push(
        en
          ? 'they have no registration, so it cannot be billed — register them to link it'
          : 'لا ملف لهذا المواطن فلن تُحتسب الرسوم — سجّله ليُربط العقار',
      );
      break;
    case 'UNLINKABLE_STRUCTURE':
      parts.push(en ? 'a tent carries no property card' : 'الخيمة لا تحمل بطاقة عقار');
      break;
    default:
      // ALREADY_CLAIMED, NO_BUILDING — nothing written, nothing wrong.
      break;
  }

  // Said because it happens inside the tenant's file, which the officer is not looking at.
  if (result.ownerLink?.linked || result.ownerLink?.alreadyLinked) {
    const who = ownerName ? (en ? ` to ${ownerName}` : ` بالمالك ${ownerName}`) : '';
    parts.push(
      result.ownerLink.split
        ? en
          ? `linked${who} on a tenancy card of its own`
          : `ورُبط${who} في بطاقة إيجار مستقلة`
        : en
          ? `linked${who}`
          : `ورُبط${who}`,
    );
  }

  return parts.join(' — ');
}
/** What «ربط بالمالك» from the unit did, for the toast. */
export function ownerLinkMessage(result: RecordedOwnerLink, en: boolean): string {
  if (result.reason === 'TENANT_NO_FILE') {
    return en
      ? 'The tenant has no file to hold the link — register them first'
      : 'لا ملف لهذا المستأجر يحمل الربط — سجّله أولاً';
  }
  if (result.reason === 'UNLINKABLE_STRUCTURE') {
    return en ? 'A tent carries no tenancy card to link' : 'الخيمة لا تحمل بطاقة إيجار تُربط';
  }
  if (result.alreadyLinked) {
    return en ? 'The tenancy already names this owner' : 'بطاقة الإيجار مربوطة بهذا المالك مسبقاً';
  }
  return result.split
    ? en
      ? 'Linked to the owner, on a tenancy card of its own for this unit'
      : 'رُبط المستأجر بالمالك في بطاقة إيجار مستقلة لهذه الوحدة'
    : en
      ? 'Linked to the owner'
      : 'رُبط المستأجر بالمالك';
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
 *
 * A door that did not open can also carry a return date, which opens the
 * follow-up حالة in the same step — see `FOLLOW_UP_CASE`.
 */
export function VisitForm({
  busy,
  locale,
  attempts,
  visits,
  viewerId,
  onSubmit,
}: {
  busy: boolean;
  locale: string;
  /** Every attempt ever made, uncapped — the number the cell shows. */
  attempts: number;
  /** The recent ones, newest first. */
  visits: UnitVisitRow[];
  /** The signed-in officer, so their own visit from earlier today can be recognised. */
  viewerId?: string | null;
  onSubmit: (values: VisitValues) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [outcome, setOutcome] = useState<SurveyStatus>('VISITED_NO_ANSWER');
  const [visitedAt, setVisitedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [revisitAt, setRevisitAt] = useState('');
  const [repeatConfirmed, setRepeatConfirmed] = useState(false);
  const followUp = FOLLOW_UP_CASE[outcome];

  /*
    This officer's own visit to this door within the server's window.

    Asked here, before the tap, because the second submit is the mistake: on
    2026-09-15 one officer logged the same closed shop twice in a day, each with
    its own follow-up case. The server asks the same question if this list was
    stale; an evening retry is one tick away.
  */
  const claimedAt = visitedAt ? new Date(visitedAt).getTime() : Date.now();
  const myRecentVisit = viewerId
    ? visits.find(
        (visit) =>
          visit.officerId === viewerId &&
          visit.outcome === outcome &&
          Date.now() - new Date(visit.createdAt).getTime() < REPEAT_VISIT_WINDOW_MS &&
          // The same rule as the server: logged recently, dated the same day, same finding.
          Math.abs(new Date(visit.visitedAt).getTime() - claimedAt) < 24 * 60 * 60 * 1000,
      )
    : undefined;

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
                className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2 py-1 text-xs"
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

      <div className="grid gap-3">
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
        >
          <DatePicker
            id="visit-date"
            value={visitedAt}
            onChange={setVisitedAt}
            max={today()}
            locale={en ? 'en' : 'ar'}
            clearable
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

      {followUp ? (
        <Field
          label={en ? 'Come back on' : 'موعد إعادة الزيارة'}
          htmlFor="visit-revisit"
        >
          <DatePicker
            id="visit-revisit"
            value={revisitAt}
            onChange={setRevisitAt}
            min={today()}
            locale={en ? 'en' : 'ar'}
            clearable
          />
        </Field>
      ) : null}

      {myRecentVisit ? (
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
          <Checkbox
            className="mt-0.5"
            checked={repeatConfirmed}
            onCheckedChange={(checked) => setRepeatConfirmed(checked === true)}
          />
          <span className="leading-relaxed">
            <span className="font-semibold">
              {en
                ? `You already logged this unit ${formatDate(myRecentVisit.createdAt)} («${labels.surveyStatus[myRecentVisit.outcome]}»).`
                : `سجَّلتَ زيارة لهذه الوحدة ${formatDate(myRecentVisit.createdAt)} («${labels.surveyStatus[myRecentVisit.outcome]}»).`}
            </span>{' '}
            {en ? 'This is a new attempt, not the same one again.' : 'هذه محاولة جديدة وليست تكراراً للسابقة.'}
          </span>
        </label>
      ) : null}

      <Button
        size="sm"
        disabled={busy || (Boolean(myRecentVisit) && !repeatConfirmed)}
        onClick={() =>
          onSubmit({
            outcome,
            visitedAt,
            notes: notes.trim(),
            // Only an outcome that has a follow-up carries its date: a date typed
            // under «لم يتم الرد» and then left behind by switching to «مكتملة»
            // must not open a case on a door that was answered.
            revisitAt: followUp ? revisitAt : '',
            ...(myRecentVisit && repeatConfirmed ? { acknowledgedRepeat: true } : {}),
          })
        }
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Footprints className="size-4" aria-hidden />}
        {en ? 'Log the visit' : 'تسجيل الزيارة'}
      </Button>
    </div>
  );
}

export interface VisitValues {
  outcome: SurveyStatus;
  visitedAt: string;
  notes: string;
  /** Empty unless the outcome has a follow-up and a date was given. */
  revisitAt: string;
  /** The officer confirmed a second visit of their own within the window. */
  acknowledgedRepeat?: boolean;
}

/**
 * The follow-up حالة a door that did not open becomes, when a return is dated.
 *
 * These two case types used to be opened from «تسجيل حالة» on the unit panel
 * as well, and that was two records for one knock: the case form moved the unit
 * to «زيارة بلا رد» without logging a visit, so the attempt count — the number
 * D10 escalates on — missed every door recorded that way, and an officer who
 * used both buttons counted it twice. From the unit panel they are opened here
 * only, after the visit, so one knock is always exactly one attempt.
 */
export const FOLLOW_UP_CASE: Partial<Record<SurveyStatus, CaseType>> = {
  VISITED_NO_ANSWER: 'UNIT_UNREACHABLE',
  REFUSED: 'ACCESS_REFUSED',
};

/**
 * The case types «فتح حالة متابعة» offers on a unit — the ones no visit outcome
 * opens, and not «تعارض في حالة الوحدة», which the status rule opens and closes
 * itself (the server refuses it from here).
 */
const UNIT_CASE_TYPES = CASE_TYPE.filter(
  (type) => !Object.values(FOLLOW_UP_CASE).includes(type) && type !== 'STATUS_CONFLICT',
);

/**
 * Logs a visit and, where it was given a return date, opens its follow-up.
 *
 * Shared by the drawer and the full-page matrix so the two cannot disagree
 * about what one knock writes. The visit goes first: if the case then fails,
 * the attempt is still counted and the message says the follow-up was not
 * opened, rather than the whole step reporting a failure the officer would
 * retry — and log a second visit for.
 */
export async function logVisitWithFollowUp(
  tenant: string,
  token: string,
  target: { unitId: string; buildingId: string; parcelNumber: string; buildingName: string | null },
  values: VisitValues,
  en: boolean,
): Promise<string> {
  const result = await logUnitVisit(tenant, token, {
    unitId: target.unitId,
    outcome: values.outcome,
    visitedAt: values.visitedAt || undefined,
    notes: values.notes || undefined,
    ...(values.acknowledgedRepeat ? { acknowledgedRepeat: true } : {}),
  });
  const logged = [
    en
      ? `Visit logged — ${result.visitCount} attempt(s) on this unit`
      : `تم تسجيل الزيارة — ${result.visitCount} محاولة على هذه الوحدة`,
    /*
      The unit's حالة المسح did not move to this outcome, and saying so is the
      point: a confirmed vacancy is a finding with an exemption resting on it,
      so a visit does not overwrite it. If the officer found somebody home, the
      confirmation is what has to be lifted — and this is where they learn that.
    */
    result.vacancyStands
      ? en
        ? 'the unit stays confirmed vacant — lift that if you found it occupied'
        : 'وتبقى الوحدة مؤكَّدة الشغور — ألغِ التأكيد إن وجدتها مشغولة'
      : null,
  ]
    .filter(Boolean)
    .join('، ');

  const caseType = FOLLOW_UP_CASE[values.outcome];
  if (!caseType || !values.revisitAt) return logged;

  const labels = getLabels(en ? 'en' : 'ar');
  try {
    await createCase(tenant, token, {
      // A case needs a description; a visit does not. The outcome's own name is
      // the honest one when the officer wrote nothing.
      notes: values.notes || labels.surveyStatus[values.outcome],
      caseType,
      buildingId: target.buildingId,
      unitId: target.unitId,
      propertyNumber: target.parcelNumber,
      buildingName: target.buildingName ?? undefined,
      scheduledRevisitAt: values.revisitAt,
    });
  } catch (caught) {
    logApiError(caught);
    // One open follow-up per door: the visit counts, the case already exists.
    if (caught instanceof ApiRequestError && caught.status === 409) {
      return en
        ? `${logged} — a follow-up case of this kind is already open on this unit`
        : `${logged} — توجد حالة متابعة مفتوحة من النوع نفسه على هذه الوحدة`;
    }
    return en
      ? `${logged} — but the follow-up case could not be opened`
      : `${logged} — لكن تعذّر فتح حالة المتابعة`;
  }
  return en ? `${logged}, follow-up case opened` : `${logged}، وفُتحت حالة متابعة`;
}

/**
 * Why «تأكيد الشغور» cannot be pressed on this unit, or null when it can.
 *
 * Shared so the drawer and the full-page matrix give the same refusal; the
 * server applies both rules as well (`BuildingsService.updateUnit`).
 *
 * A seasonal home is refused because its owners being away is what the state
 * *means*. Pressing it on a summer house visited in January wrote «شاغرة» over
 * «مسكن موسمي» — and a seasonal home is billed to its owner
 * (`OWNER_BILLED_WHILE_ABSENT`) while a vacant one is exempt, so a routine
 * winter survey quietly cancelled the summer's fees. The months without the
 * owners are settled by a تصريح بالشغور in the seasonal panel above.
 */
export function vacancyBlocker(unit: UnitWithOccupants, en: boolean): string | null {
  if (activeVacancy(unit)) {
    return en ? 'This unit is already confirmed vacant.' : 'الوحدة مؤكَّد شغورها مسبقاً.';
  }
  if (livingOccupants(unit).length > 0) {
    return en
      ? 'A tenant or occupant is recorded here — end their occupancy first. An owner does not block this.'
      : 'يسكن الوحدة مستأجر أو شاغل مسجَّل — أنهِ إشغاله أولاً. وجود المالك لا يمنع تأكيد الشغور.';
  }
  if (effectiveUnitStatus(unit) === 'SEASONAL') {
    return en
      ? 'A seasonal home is not vacant while its owners are away. Record a vacancy declaration in the seasonal details, or re-add the owner with «Vacant» if they no longer come.'
      : 'غياب أصحاب المسكن الموسمي لا يجعله شاغراً. سجّل تصريح الشغور في بيانات السكن الموسمي، أو أعد ربط المالك بحالة «شاغرة» إن لم يعودوا يأتون.';
  }
  return null;
}

/**
 * «فتح حالة متابعة» — something a later visit or a reviewer has to act on,
 * pinned to this exact unit.
 *
 * Named for what it opens, not «تسجيل حالة»: on a panel whose header already
 * shows the survey state and whose forms ask «حالة الوحدة», "record a status"
 * read as setting مؤجرة or شاغرة. «متابعة» is the word the cases page is
 * searched by; «حالة» keeps it recognisably the thing listed there.
 */
export function CaseForm({
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

  // No default, for the reason the capacity above has none.
  const [caseType, setCaseType] = useState<CaseType | ''>('');
  const [notes, setNotes] = useState('');
  const [revisitAt, setRevisitAt] = useState('');

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        
      </p>
      <div className="grid gap-3">
        <Field label={en ? 'What needs following up' : 'نوع الحالة'} htmlFor="case-type" required>
          <Select value={caseType} onValueChange={(value) => setCaseType(value as CaseType)}>
            <SelectTrigger id="case-type">
              <SelectValue placeholder={en ? 'Choose…' : 'اختر…'} />
            </SelectTrigger>
            <SelectContent>
              {UNIT_CASE_TYPES.map((value) => (
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

        >
          <DatePicker
            id="case-revisit"
            value={revisitAt}
            onChange={setRevisitAt}
            locale={en ? 'en' : 'ar'}
            clearable
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
        disabled={busy || !notes.trim() || !caseType}
        onClick={() => {
          if (!caseType) return;
          onSubmit({ notes: notes.trim(), caseType, revisitAt });
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CalendarClock className="size-4" aria-hidden />}
        {en ? 'Open the case' : 'فتح الحالة'}
      </Button>
    </div>
  );
}

/* The damage form, its notice and its history live in `components/admin/damage/`. */

export const today = () => new Date().toISOString().slice(0, 10);




