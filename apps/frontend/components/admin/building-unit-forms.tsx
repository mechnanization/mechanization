'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  DoorClosed,
  EllipsisVertical,
  Footprints,
  Loader2,
  MapPin,
  Ruler,
  Search,
  ShieldAlert,
  Undo2,
  UserRound,
  UsersRound,
} from 'lucide-react';
import {
  CASE_TYPE,
  contradictsVacancy,
  DAMAGE_LEVEL,
  DAMAGE_SOURCE,
  getLabels,
  isOccupiableLifecycle,
  isUnoccupied,
  OCCUPANCY_ROLE,
  SURVEY_STATUS,
  UNIT_STATUS,
  unitStatusForRole,
  VACANCY_BASIS,
  VACANCY_END_REASON,
  type BuildingLifecycle,
  type CaseType,
  type CitizenResidence,
  type DamageLevel,
  type DamageSource,
  type OccupancyEndReason,
  type OccupancyRole,
  type StructureType,
  type SurveyStatus,
  type UnitStatus,
  type VacancyBasis,
  type VacancyEndReason,
} from '@mechanization/shared-schemas';
import {
  createCase,
  listCitizens,
  logApiError,
  logUnitVisit,
  type AfterTenancyAnswer,
  type CitizenListItem,
  type OccupancyFileLink,
  type OccupantOwnerLink,
  type RecordedOwnerLink,
  type UnitOccupant,
  type UnitVacancyConfirmation,
  type UnitVisitRow,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { formatDate, monthNames } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  AfterTenancyQuestion,
  afterTenancyComplete,
  afterTenancyPayload,
} from '@/components/admin/after-tenancy-question';

/**
 * The per-unit forms and small display helpers shared by
 * `building-unit-matrix-drawer.tsx` (the map/cases slide-over) and
 * `building-unit-matrix-view.tsx` (the ledger's full-page spatial matrix).
 * Extracted rather than duplicated so the two surfaces can never quietly
 * diverge on what "add a person to a unit" or "open a follow-up case" means.
 */

export const SEARCH_DEBOUNCE_MS = 350;

/**
 * What an attempt can have produced.
 *
 * `SURVEY_STATUS` minus `NOT_SURVEYED`, which means nobody went — a visit
 * carrying it is a contradiction, and `logVisitSchema` refuses it server-side
 * for the same reason. Derived rather than retyped so a status added to the
 * enum shows up here without anyone remembering to add it.
 */
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
function liveSpells(unit: UnitWithOccupants) {
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
 * What the four colours mean, said once under every matrix.
 *
 * A colour code nobody explains is a colour code people guess at — and the
 * guess that matters here is amber, which is not "in progress" but "a bill
 * depends on something nobody has recorded".
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
  ];
  return (
    <ul
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground', className)}
      aria-label={en ? 'What the colours mean' : 'دلالة الألوان'}
    >
      {entries.map((entry) => (
        <li key={entry.variant} className="flex items-center gap-1.5">
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
 * «إضافة شخص إلى الوحدة» — the one way a person reaches a flat from the matrix.
 *
 * ## Both ways out, always offered
 *
 * This used to be two buttons: «تسجيل شاغل», which linked somebody already on
 * file, and «تسجيل أسرة في هذه الوحدة», which opened a blank registration. The
 * labels said neither thing — the first was mostly used for owners, who are
 * by definition not a شاغل (D2), and the second also created owner records,
 * which have no household — and nothing made the officer look before creating.
 *
 * So there is one entry and it searches. For a while it *also* withheld «ملف
 * جديد» until a search had come back, on the theory that this made officers
 * look before creating. It did not, and it cost more than it is worth stating
 * plainly:
 *
 *  - It gated on a search having *run*, not on the right one having run.
 *    «asdfgh» satisfied it, and that is what officers typed — so the guarantee
 *    was nil and the ritual was daily. A control that is noise is one people
 *    route around, including on the tenth card where it mattered.
 *  - A failed lookup cleared the term it was waiting on, so an officer with no
 *    signal could not reach «ملف جديد» at all. This form is used in the field,
 *    offline, in settlements nobody is going back to; a dead end there is a
 *    household that goes unregistered.
 *
 * Both choices are therefore offered from the start, and the duplicate check
 * moved to where it can actually work: `CitizenEditor` matches on the *name*
 * as it is typed and shows whoever it finds. That is a check «asdfgh» cannot
 * pass, and it is the one that matters for «غير مقيم في البلدة» — a record
 * carrying a name, a phone and a town, no document number, so the one least
 * able to be merged after the fact.
 *
 * What the search term still does is travel: whatever the officer typed seeds
 * the new file's name, so a search that found nobody is not retyped.
 *
 * Both new-file choices carry the unit and preset نوع الملف, named with the
 * same labels the form's own chooser uses. Neither answers «ومن يشغلها؟» — an
 * owner living elsewhere may have let the flat, lent it, left it empty or come
 * back for the summer, and the card still asks. What a non-resident may be on
 * a dwelling is the server's to refuse (`assertNonResidentOccupancy`).
 *
 * ## Why the capacity is the whole form
 *
 * Linking an existing citizen to a flat used to be one decision — which
 * person — and the register then had to guess what that meant. It guessed
 * badly in the owner’s direction: an owner recorded here said nothing about
 * whether the flat was lived in, let, lent or empty, so `bearsFee` read the
 * unanswered unit as one to charge them the occupancy fee for, and the tenant
 * downstairs was charged it too on their own card.
 *
 * So the form asks two things, and only ever two. **Capacity** settles it
 * outright for a مستأجر and a شاغل بتسامح: they are the شاغل of what is being
 * recorded, the unit is «مؤجرة» or «مشغولة بتسامح», and there is nothing
 * further to ask — which is why the second field is hidden for them rather
 * than defaulted, the same way the أسهم field already is. **حالة الوحدة** is
 * asked of an owner alone, because an owner is the one capacity that does not
 * settle it: the deed is not a statement of residence (D2).
 *
 * The server refuses the second field on a non-owner, so the two surfaces
 * cannot drift into disagreeing about which question applies to whom.
 *
 * The capacity itself starts unanswered, for the reason «ومن يشغلها؟» does: it
 * used to open on «مالك», and a pre-filled select is indistinguishable from an
 * answered one.
 *
 * ## The third question, and why it is conditional
 *
 * «مساحة الوحدة» is asked only when the census has no answer, and that is the
 * whole point of it. The matrix is painted from the street — `generateUnits`
 * and the grid picker both assert that a flat *exists*, not that anyone has
 * measured it — so `Unit.unitArea` is routinely null. Linking a citizen is the
 * first moment somebody is actually inside, and this form had nowhere to put
 * the tape measure's answer.
 *
 * What that cost: `claimOnFile` mints the citizen's property card from the
 * canonical unit, so the card inherited the null; a PER_AREA notice cannot be
 * priced against a unit with no area, and the citizen's own edit form rendered
 * the absence as «0». One missing question, three symptoms, none of them
 * visible from here.
 *
 * Where the register *does* hold an area it is stated rather than asked — the
 * rule every lock in `UnitFields` follows. Re-asking a measured flat would
 * invite two officers to record two different sizes for one room, and the
 * server refuses the overwrite anyway.
 */
export interface AddPersonValues {
  citizen: CitizenListItem;
  role: OccupancyRole;
  shares?: number;
  unitStatus?: UnitStatus;
  /** «نعم، لم تعد شاغرة» — sent only when the link contradicts a standing vacancy. */
  endsVacancy?: boolean;
  /** Non-owners: the recorded owner they hold the flat from. */
  landlordCitizenId?: string;
  /** Non-owners: the owner as named, when not recorded on the unit. */
  landlordName?: string;
  landlordPhone?: string;
  /** م² — sent only where the census has no area for the unit. See `recordOccupancy`. */
  unitArea?: number;
}

export function AddPersonForm({
  tenant,
  token,
  busy,
  locale,
  newFileHref,
  vacancy,
  owners = [],
  unitArea: recordedArea,
  onSubmit,
}: {
  tenant: string;
  token: string;
  busy: boolean;
  locale: string;
  /**
   * The registration form, pointed at this unit, with نوع الملف preset and the
   * officer's search term carried across as the name to start from.
   *
   * Absent where the caller cannot build an admin URL; the search still works
   * and the no-match line says to register the person first.
   */
  newFileHref?: (residence: CitizenResidence, name: string) => string;
  /**
   * The «تأكيد الشغور» standing on this unit, when there is one.
   *
   * Linking somebody who lives there contradicts it, and the server refuses the
   * pair without an acknowledgement. Asked here rather than left to arrive as a
   * refusal: the officer can see when the flat was confirmed empty and on what
   * basis while they are deciding, instead of after a failed save.
   */
  vacancy?: UnitVacancyConfirmation | null;
  /**
   * The owners recorded on this unit — what «المالك» offers a مستأجر or a شاغل
   * بتسامح. See `unitOwners`.
   */
  owners?: UnitOccupant[];
  /**
   * The area the census already holds for this flat, or null if it holds none.
   *
   * Null is what opens the field. Passing `undefined` — a caller that has not
   * been updated — is treated the same as null rather than as "measured", so a
   * surface that forgets to wire it asks a redundant question instead of
   * silently dropping the only one that can fill the gap.
   */
  unitArea: number | null | undefined;
  onSubmit: (values: AddPersonValues) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [acknowledgedVacancy, setAcknowledgedVacancy] = useState(false);
  /**
   * «المالك»: a recorded owner's citizen id, `OTHER` for an owner not recorded
   * on the unit, or unanswered. A lone owner starts chosen — there is nobody
   * else it could be among the recorded ones — and co-owners start unanswered,
   * because which one the tenant deals with is exactly the question.
   */
  const [landlordChoice, setLandlordChoice] = useState<string>(() =>
    owners.length === 1 ? owners[0]!.citizenId : owners.length === 0 ? 'OTHER' : '',
  );
  const [typedLandlordName, setTypedLandlordName] = useState('');
  const [typedLandlordPhone, setTypedLandlordPhone] = useState('');
  /*
    The unit's owners can change under an open form — somebody records the owner
    first, then comes back to the tenant — so the default is re-derived from the
    list it was a default of, never kept from a list that no longer holds.
  */
  const ownerIds = owners.map((owner) => owner.citizenId).join(',');
  useEffect(() => {
    setLandlordChoice((current) => {
      // An answer still on offer stands; «غير مسجَّل» always is.
      if (current === 'OTHER' || (current && ownerIds.split(',').includes(current))) return current;
      if (ownerIds === '') return 'OTHER';
      return ownerIds.includes(',') ? '' : ownerIds;
    });
  }, [ownerIds]);

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<CitizenListItem | null>(null);
  /** The term the shown results answer — set when a search comes back. */
  const [searched, setSearched] = useState('');
  /**
   * The last lookup could not reach the register.
   *
   * Kept apart from «no results», which it is not: the officer is told the
   * register is unreachable rather than that nobody matched, because those two
   * lead to different decisions about whether to open a new file.
   */
  const [failed, setFailed] = useState(false);
  const [role, setRole] = useState<OccupancyRole | ''>('');
  const [shares, setShares] = useState('');
  /**
   * Deliberately unset rather than pre-filled with «مشغولة من المالك».
   *
   * That default is the very assumption this field exists to stop making, and
   * a pre-filled select is indistinguishable from an answered one. Empty means
   * «لم يُسأل», the server leaves the unit’s حالة alone, and the flat keeps
   * whatever an officer previously established rather than being overwritten by
   * a guess nobody made.
   */
  const [unitStatus, setUnitStatus] = useState<UnitStatus | ''>('');
  /**
   * م², typed only when the census has none. Empty means «لم تُقَس» and sends
   * nothing at all — the unit keeps its null and the matrix goes on showing it
   * as unmeasured, which is honest. An invented number here would be priced.
   */
  const [unitArea, setUnitArea] = useState('');
  /** The register has an answer, so the field states it rather than asks. */
  const areaFromCensus = recordedArea != null;
  const parsedArea = Number(unitArea.trim());
  const areaIsValid = unitArea.trim() === '' || (Number.isFinite(parsedArea) && parsedArea > 0);

  /**
   * Whether what is about to be recorded contradicts the standing vacancy.
   *
   * The same predicate the server applies (`contradictsVacancy`), imported
   * rather than restated: a form that warns about something the server allows
   * teaches officers to ignore the warning, and one that stays quiet about
   * something it refuses is a failed save with no explanation.
   */
  const endsStandingVacancy = Boolean(
    vacancy && role && contradictsVacancy(role, role === 'OWNER' ? unitStatus || null : null),
  );

  useEffect(() => {
    if (!term.trim()) {
      setResults([]);
      setSearched('');
      setFailed(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setFailed(false);
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: term.trim(), limit: 6 })
        .then((result) => {
          if (cancelled) return;
          setResults(result.items);
          setSearched(term.trim());
        })
        .catch((caught) => {
          logApiError(caught);
          /*
            A failed search is not a search that found nobody, and the two are
            told apart by `failed` rather than by withholding the way forward.

            This used to clear the term as well, which left an officer with no
            signal unable to reach «ملف جديد» at all — on a form used in the
            field, offline, in settlements nobody is going back to. The honest
            answer is to say the register could not be reached and let them
            file the household anyway; an unregistered household is worse than
            a duplicate, and a duplicate here is still detectable by name.
          */
          if (!cancelled) {
            setResults([]);
            setSearched(term.trim());
            setFailed(true);
          }
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
                    className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2.5 py-1.5 text-start text-sm transition-colors hover:bg-accent"
                  >
                    <span className="font-medium">{citizen.fullName}</span>
                    {citizen.phone ? (
                      <span dir="ltr" className="text-xs text-muted-foreground">
                        {citizen.phone}
                      </span>
                    ) : null}
                    {/*
                      The line that makes this list decidable.

                      Two «محمد خليل»s on one parcel are a real afternoon, and
                      until migration 0044 nothing on a result told them apart:
                      no identity document is asked any more, and a household
                      shares its phone. Shown only where the register holds it —
                      a row reading «والدته: —» beside one that names a mother
                      invites the reader to treat an unasked question as a
                      difference between two people.
                    */}
                    {citizen.motherName ? (
                      <span className="basis-full text-xs text-muted-foreground">
                        {en ? `Mother: ${citizen.motherName}` : `والدته: ${citizen.motherName}`}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            «The register could not be reached» is said plainly, and never as
            «لا نتيجة». The two lead to different decisions, and an officer who
            reads an unreachable register as an empty one files the duplicate
            they had every means to avoid.
          */}
          {failed ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed">
              {en
                ? 'The register could not be reached, so this is not a “no match”. If you open a new file, check the name against the register once you are back online.'
                : 'تعذّر الوصول إلى السجل، وهذا ليس «لا نتيجة». إن فتحت ملفاً جديداً فراجع الاسم في السجل عند عودة الاتصال.'}
            </p>
          ) : !searching && searched && searched === term.trim() && results.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {en ? 'No match in the register.' : 'لا نتيجة في السجل.'}
            </p>
          ) : null}

          {/*
            Offered from the start, rather than held back until a search has run.

            Withholding these taught officers to type «asdfgh» to reveal them,
            which gated nothing and cost a ritual on every record — see the
            docblock. The look-before-you-create check lives in the form these
            links open, where it matches on the name actually being typed and
            «asdfgh» cannot satisfy it.
          */}
          {newFileHref ? (
            <div className="space-y-2 rounded-md border border-dashed p-2.5">
              <p className="text-xs text-muted-foreground">
                {results.length > 0
                  ? en
                    ? 'Not one of these? Open a new file for this unit:'
                    : 'ليس بينهم؟ افتح ملفاً جديداً لهذه الوحدة:'
                  : en
                    ? 'Not on file yet? Open a new file for this unit:'
                    : 'ليس مسجَّلاً بعد؟ افتح ملفاً جديداً لهذه الوحدة:'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={newFileHref('RESIDENT', term.trim())}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <UsersRound className="size-4" aria-hidden />
                  {labels.citizenResidence.RESIDENT}
                </Link>
                <Link
                  href={newFileHref('NON_RESIDENT_OWNER', term.trim())}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <MapPin className="size-4" aria-hidden />
                  {labels.citizenResidence.NON_RESIDENT_OWNER}
                </Link>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {en
                ? 'Not on file? Register the citizen first, then come back to this unit.'
                : 'ليس مسجَّلاً؟ سجّل المواطن أولاً ثم عد إلى هذه الوحدة.'}
            </p>
          )}
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={en ? 'Their relation to the unit' : 'صفته في الوحدة'} htmlFor="occupant-role" required>
          <Select value={role} onValueChange={(value) => setRole(value as OccupancyRole)}>
            <SelectTrigger id="occupant-role">
              <SelectValue placeholder={en ? 'Choose…' : 'اختر…'} />
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

      {/*
        مساحة الوحدة — asked of everyone, and only where the census is silent.

        Not gated on capacity, unlike the two questions around it: the size of a
        room is not a fact about who is standing in it, and a مستأجر with a tape
        measure knows it as well as the owner does. Gated on the *register*
        instead, which is the rule every lock in `UnitFields` follows: a field
        is stated rather than asked if, and only if, the register has an answer.
      */}
      {areaFromCensus ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Ruler className="size-3.5 shrink-0" aria-hidden />
          {en
            ? `Recorded area: ${recordedArea} m². Correct it from the unit itself.`
            : `المساحة المسجَّلة: ${recordedArea} م². التعديل يتم على الوحدة نفسها.`}
        </p>
      ) : (
        <Field
          label={en ? 'Unit Area (sq. meters)' : 'مساحة الوحدة (متر مربع)'}
          htmlFor="occupant-unit-area"
          error={
            areaIsValid
              ? undefined
              : en
                ? 'The area must be greater than zero.'
                : 'المساحة يجب أن تكون أكبر من صفر.'
          }
          hint={
            en
              ? 'The census has no area for this unit. Leave it empty if it has not been measured — a guess would be billed.'
              : 'لا توجد مساحة مسجَّلة لهذه الوحدة. اتركه فارغاً إن لم تُقَس — الرقم المُقدَّر تُحتسب عليه الرسوم.'
          }
        >
          <Input
            id="occupant-unit-area"
            inputMode="decimal"
            dir="ltr"
            className="text-start"
            invalid={!areaIsValid}
            value={unitArea}
            onChange={(event) => setUnitArea(event.target.value)}
          />
        </Field>
      )}

      {/*
        Asked of an owner alone, and asked plainly: «ومن يشغلها؟». A مستأجر or
        a شاغل بتسامح has already answered it by being recorded, and is shown
        the answer instead of a second question — see the docblock.
      */}
      {role === 'OWNER' ? (
        <Field
          label={en ? 'And who occupies it?' : 'ومن يشغلها؟'}
          htmlFor="occupant-unit-status"
          hint={
            en
              ? 'Owning a flat is not living in it. Leave unset if not established.'
              : 'الملكية لا تعني السكن. اتركه دون تحديد إن لم يُسأل.'
          }
        >
          <Select
            value={unitStatus || 'UNSET'}
            onValueChange={(value) =>
              setUnitStatus(value === 'UNSET' ? '' : (value as UnitStatus))
            }
          >
            <SelectTrigger id="occupant-unit-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNSET">
                {en ? 'Not established' : 'غير محدد'}
              </SelectItem>
              {UNIT_STATUS.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.unitStatus[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : role ? (
        <p className="text-xs text-muted-foreground">
          {en
            ? `The unit will be recorded as ${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}.`
            : `ستُسجَّل الوحدة «${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}».`}
        </p>
      ) : null}

      {/*
        «المالك» — who a مستأجر or شاغل بتسامح holds the flat from.

        Asked here because nothing else will: the matrix used to record the
        tenant with no owner at all, and the flat went onto whatever tenancy card
        they already had in the building — so a flat rented from one owner read
        as rented from another. The choice is among the owners recorded on this
        flat; picking one links the tenancy to them in the same save. An owner
        not recorded here is typed instead, and the owner-link queue matches the
        number once that person is registered.
      */}
      {role && role !== 'OWNER' ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">
            {en ? 'Owner of the unit' : 'المالك'}
            {owners.length > 0 ? <span className="text-destructive"> *</span> : null}
          </legend>
          {owners.length > 1 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {en
                ? 'This unit has more than one owner. Choose the one the occupant deals with; the others stay recorded as owners.'
                : 'للوحدة أكثر من مالك. اختر من يتعامل معه الشاغل منهم، ويبقى الآخرون مسجَّلين مالكين.'}
            </p>
          ) : null}
          {owners.length > 0 ? (
            <div className="grid gap-2" role="radiogroup">
              {[...owners.map((owner) => owner.citizenId), 'OTHER'].map((value) => {
                const owner = owners.find((row) => row.citizenId === value);
                const on = landlordChoice === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setLandlordChoice(value)}
                    className={cn(
                      'flex min-h-11 flex-wrap items-center gap-x-2 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                      on ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                    )}
                  >
                    {owner ? (
                      <>
                        <span>{owner.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}</span>
                        {owner.citizenPhone ? (
                          <span dir="ltr" className="font-mono text-xs font-normal text-muted-foreground">
                            {owner.citizenPhone}
                          </span>
                        ) : null}
                        {owner.shares ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            {en ? `${owner.shares}/2400 shares` : `${owner.shares}/٢٤٠٠ سهم`}
                          </span>
                        ) : null}
                      </>
                    ) : en ? (
                      'Someone not recorded on this unit'
                    ) : (
                      'مالك غير مسجَّل على هذه الوحدة'
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
          {landlordChoice === 'OTHER' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={en ? 'Owner’s name' : 'اسم المالك'}
                htmlFor="occupant-landlord-name"
                hint={en ? 'Optional' : 'اختياري'}
              >
                <Input
                  id="occupant-landlord-name"
                  value={typedLandlordName}
                  onChange={(event) => setTypedLandlordName(event.target.value)}
                />
              </Field>
              <Field
                label={en ? 'Owner’s phone' : 'هاتف المالك'}
                htmlFor="occupant-landlord-phone"
                hint={
                  en
                    ? 'Offered for linking once the owner is registered on this number'
                    : 'يُعرض الربط للتأكيد عندما يُسجَّل المالك على هذا الرقم'
                }
              >
                <Input
                  id="occupant-landlord-phone"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  className="text-start"
                  value={typedLandlordPhone}
                  onChange={(event) => setTypedLandlordPhone(event.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {/*
        The flat is confirmed empty and this says somebody is in it.

        A tick rather than a second dialog: the officer is already in the middle
        of an answer, and what they need is the date and the basis in front of
        them while they give it. Ticking it lifts the vacancy as «لم تعد شاغرة»
        with the link — the two are one event — and the server refuses the pair
        without it, so nothing can override a colleague's finding by accident.
      */}
      {endsStandingVacancy ? (
        <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0"
            checked={acknowledgedVacancy}
            onChange={(event) => setAcknowledgedVacancy(event.target.checked)}
          />
          <span>
            {en
              ? `This unit has been confirmed vacant since ${formatDate(vacancy!.observedAt)}`
              : `الوحدة مؤكَّد شغورها منذ ${formatDate(vacancy!.observedAt)}`}
            {vacancy!.basis ? ` (${labels.vacancyBasis[vacancy!.basis]})` : ''}
            {'. '}
            {en
              ? 'Recording an occupant lifts that confirmation.'
              : 'تسجيل من يشغلها يُنهي تأكيد الشغور.'}
          </span>
        </label>
      ) : null}

      <Button
        size="sm"
        disabled={
          busy ||
          !chosen ||
          !role ||
          (endsStandingVacancy && !acknowledgedVacancy) ||
          // A non-owner on a flat with recorded owners says which one, or that it is none of them.
          (role !== 'OWNER' && owners.length > 0 && !landlordChoice) ||
          !areaIsValid
        }
        onClick={() => {
          if (!chosen || !role || !areaIsValid) return;
          const parsed = Number(shares);
          const nonOwner = role !== 'OWNER';
          const recordedOwner =
            nonOwner && landlordChoice && landlordChoice !== 'OTHER' ? landlordChoice : undefined;
          const typed = nonOwner && landlordChoice === 'OTHER';
          onSubmit({
            citizen: chosen,
            role,
            shares: role === 'OWNER' && shares.trim() && Number.isFinite(parsed) ? parsed : undefined,
            // Sent for an owner only, and only when actually chosen. The
            // server refuses it on anyone else, whose capacity settles the
            // unit's حالة without being asked.
            unitStatus: role === 'OWNER' && unitStatus ? unitStatus : undefined,
            endsVacancy: endsStandingVacancy ? true : undefined,
            landlordCitizenId: recordedOwner,
            landlordName: typed && typedLandlordName.trim() ? typedLandlordName.trim() : undefined,
            landlordPhone: typed && typedLandlordPhone.trim() ? typedLandlordPhone.trim() : undefined,
            /*
              Omitted rather than sent as 0 when the box is empty, and never
              sent at all when the census already has an answer.

              An empty box means «لم تُقَس», which the unit already records as
              null; sending a zero would replace "unmeasured" with a
              measurement of zero, and the difference between those two is
              whether a PER_AREA notice refuses to price the flat or prices it
              at nothing.
            */
            unitArea: !areaFromCensus && unitArea.trim() ? parsedArea : undefined,
          });
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {en ? 'Add to the unit' : 'ربط بالوحدة'}
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
 *
 * A door that did not open can also carry a return date, which opens the
 * follow-up حالة in the same step — see `FOLLOW_UP_CASE`.
 */
export function VisitForm({
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
  onSubmit: (values: VisitValues) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [outcome, setOutcome] = useState<SurveyStatus>('VISITED_NO_ANSWER');
  const [visitedAt, setVisitedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [revisitAt, setRevisitAt] = useState('');
  const followUp = FOLLOW_UP_CASE[outcome];

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

      {followUp ? (
        <Field
          label={en ? 'Come back on' : 'موعد إعادة الزيارة'}
          htmlFor="visit-revisit"
          hint={
            en
              ? `Optional — opens a follow-up case («${labels.caseType[followUp]}») with this date`
              : `اختياري — يفتح حالة متابعة «${labels.caseType[followUp]}» بهذا الموعد`
          }
        >
          <Input
            id="visit-revisit"
            type="date"
            min={today()}
            value={revisitAt}
            onChange={(event) => setRevisitAt(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {en
          ? 'The unit moves to this outcome — one visit, one status, recorded together.'
          : 'تنتقل حالة الوحدة إلى هذه النتيجة — زيارة واحدة وحالة واحدة تُسجَّلان معاً.'}
      </p>

      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          onSubmit({
            outcome,
            visitedAt,
            notes: notes.trim(),
            // Only an outcome that has a follow-up carries its date: a date typed
            // under «لم يتم الرد» and then left behind by switching to «مكتملة»
            // must not open a case on a door that was answered.
            revisitAt: followUp ? revisitAt : '',
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

/** The case types «فتح حالة متابعة» offers on a unit — the ones no visit outcome opens. */
const UNIT_CASE_TYPES = CASE_TYPE.filter(
  (type) => !Object.values(FOLLOW_UP_CASE).includes(type),
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
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {en
          ? 'Nobody answered, or they refused? Use «Log a visit» — it counts the attempt and can set the return date.'
          : 'لم يُرَدّ على الباب أو رُفض إعطاء البيانات؟ استخدم «تسجيل زيارة» — تُحتسب المحاولة ويمكن تحديد موعد العودة.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
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

/**
 * One observation, appended to the log. There is no edit and no delete: a
 * building that was unsafe in 2024 and repaired in 2026 is two facts (D3).
 */
export function DamageForm({
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

// ─────────────────────────  Who is, and was, in a unit  ─────────────────────────

/** «إنهاء الملكية» / «إنهاء الإيجار» / «خروج الشاغل» — the action named for what it ends. */
function endActionLabel(role: OccupancyRole, en: boolean): string {
  if (role === 'OWNER') return en ? 'End ownership' : 'إنهاء الملكية';
  if (role === 'TENANT') return en ? 'End tenancy' : 'إنهاء الإيجار';
  return en ? 'Occupant left' : 'خروج الشاغل';
}

/**
 * The reasons that fit a capacity — mirrored by the server, which refuses the
 * rest. An owner does not «move out» (the deed is not a residence) and a tenant
 * does not sell; «سُجِّل بالخطأ» fits everyone.
 */
function reasonsFor(role: OccupancyRole): OccupancyEndReason[] {
  return role === 'OWNER'
    ? ['OWNERSHIP_TRANSFERRED', 'RECORDED_IN_ERROR']
    : ['MOVED_OUT', 'RECORDED_IN_ERROR'];
}

const today = () => new Date().toISOString().slice(0, 10);

/** What «إنهاء الإشغال» sends — the reason, the date, and for a tenancy what the flat is now. */
export type EndOccupancyAnswer = { reason: OccupancyEndReason; toDate?: string } & AfterTenancyAnswer;

/**
 * The confirmation «إنهاء الإشغال» never had.
 *
 * Field inspectors pressed the old text link by mistake — it sat on the same
 * row as the person's name, on a phone — and the spell ended on the spot,
 * releasing the flat from the citizen's own file and stopping its bill. So this
 * asks three things before anything is written: that this is the person meant
 * (the name and unit are in the title), when they left, and **why** — a choice
 * with no default, because a pre-selected answer is exactly what muscle memory
 * confirms. It does not ask the person to type a name: this is a correction an
 * inspector makes standing in a stairwell, not the deletion of a record.
 */
export function EndOccupancyDialog({
  occupant,
  unitCode,
  asksStatus = false,
  locale,
  onOpenChange,
  onConfirm,
}: {
  /** The spell being ended; the dialog is open while this is set. */
  occupant: UnitOccupant | null;
  unitCode: string;
  /**
   * A tenant or occupant is leaving and nobody else is recorded living in the
   * flat, so what it is now has to be said — see `AfterTenancyQuestion`.
   */
  asksStatus?: boolean;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: EndOccupancyAnswer) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [reason, setReason] = useState<OccupancyEndReason | null>(null);
  const [toDate, setToDate] = useState(today());
  const [after, setAfter] = useState<AfterTenancyAnswer>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh question every time it opens — never the previous person's answer.
  useEffect(() => {
    if (occupant) {
      setReason(null);
      setToDate(today());
      setAfter({});
      setFailure(null);
      setBusy(false);
    }
  }, [occupant]);

  if (!occupant) return null;

  const name = occupant.citizenName ?? (en ? 'this person' : 'هذا الشخص');
  const action = endActionLabel(occupant.role, en);
  const tenancy = occupant.role !== 'OWNER';
  const ready = Boolean(reason) && (!asksStatus || afterTenancyComplete(after));

  const confirm = async () => {
    if (!reason || !ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // Today is the server's default; only a back-dated end is sent.
      await onConfirm({
        reason,
        ...(toDate && toDate !== today() ? { toDate } : {}),
        ...(asksStatus ? afterTenancyPayload(after) : {}),
      });
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not end the occupancy.'
            : 'تعذّر إنهاء الإشغال.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <AlertTriangle className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {en ? `${action}: ${name} in unit ` : `${action}: ${name} في الوحدة `}
                <span dir="ltr" className="font-mono">
                  {unitCode}
                </span>
                {en ? '?' : '؟'}
              </DialogTitle>
              <DialogDescription>
                {tenancy
                  ? en
                    ? 'They move to «Former» on this unit and stop being charged for it. Their card stays on their file as an ended tenancy, documents included, and the owner stays the owner.'
                    : 'ينتقل إلى «سابق» على هذه الوحدة وتتوقف رسومها عليه. تبقى بطاقته في ملفه كإيجار منتهٍ مع مستنداتها، ويبقى المالك مالكاً.'
                  : en
                    ? 'They move to «Former» on this unit, the unit is released from their file, and fees for it stop being charged to them.'
                    : 'ينتقل إلى «سابق» على هذه الوحدة، وتُفصل الوحدة عن ملفه، وتتوقف الرسوم عليه عنها.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">
              {en ? 'Why?' : 'السبب'} <span className="text-destructive">*</span>
            </legend>
            <div className="grid gap-2" role="radiogroup">
              {reasonsFor(occupant.role).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={reason === option}
                  onClick={() => setReason(option)}
                  className={cn(
                    'min-h-11 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                    reason === option
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {labels.occupancyEndReason[option]}
                </button>
              ))}
            </div>
            {reason === 'RECORDED_IN_ERROR' ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {en
                  ? 'Kept on record as what was entered, and hidden from the unit’s history.'
                  : 'يبقى محفوظاً كسجل لما أُدخل، ولا يظهر في تاريخ الوحدة.'}
              </p>
            ) : null}
          </fieldset>

          {reason !== 'RECORDED_IN_ERROR' ? (
            <Field label={en ? 'Left on' : 'تاريخ الانتهاء'} htmlFor="end-occupancy-date">
              <Input
                id="end-occupancy-date"
                type="date"
                min={occupant.fromDate.slice(0, 10)}
                max={today()}
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                dir="ltr"
                className="text-start"
              />
            </Field>
          ) : null}

          {asksStatus && reason ? (
            <AfterTenancyQuestion value={after} onChange={setAfter} locale={locale} />
          ) : null}
          {tenancy && !asksStatus && reason ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {en
                ? 'Someone else is still recorded living in this unit, so its status stays as it is.'
                : 'ما زال شخص آخر مسجَّلاً ساكناً في هذه الوحدة، فتبقى حالتها كما هي.'}
            </p>
          ) : null}

          {failure ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive"
            >
              {failure}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={busy || !ready}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everyone recorded against a unit, current first — shared by the drawer and
 * the full-page matrix so the two cannot disagree about what ending a spell
 * asks, or which history rows are shown.
 *
 * The end action lives behind a ⋯ menu with a finger-sized target, away from
 * the name link it used to sit beside, and opens `EndOccupancyDialog` rather
 * than acting. Spells ended «سُجِّل بالخطأ» are left out of the list — they are
 * not history — and counted underneath so nothing disappears silently.
 */
export function OccupantList({
  unit,
  locale,
  canWrite,
  busy,
  citizenHref,
  onEnd,
  onLinkOwner,
}: {
  unit: UnitWithOccupants;
  locale: string;
  canWrite: boolean;
  busy: boolean;
  /** Where a name links to; plain text when absent. */
  citizenHref?: (citizenId: string) => string;
  onEnd: (occupant: UnitOccupant, input: EndOccupancyAnswer) => Promise<void>;
  /**
   * «ربط بالمالك» — links a tenant to one of the flat's owners. `confirmRecordedAfter`
   * is the officer's confirmation for an owner recorded after the tenant. Throws
   * to report a refusal.
   */
  onLinkOwner?: (occupant: UnitOccupant, ownerId: string, confirmRecordedAfter: boolean) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [ending, setEnding] = useState<UnitOccupant | null>(null);
  const [linking, setLinking] = useState<UnitOccupant | null>(null);
  const owners = unitOwners(unit);
  /** The flat's owners a tenant may be linked to — anyone but themselves. */
  const ownersFor = (occupant: UnitOccupant) =>
    owners.filter((owner) => owner.citizenId !== occupant.citizenId);

  const shown = unit.occupants.filter((occupant) => occupant.endReason !== 'RECORDED_IN_ERROR');
  const hidden = unit.occupants.length - shown.length;

  if (unit.occupants.length === 0) return null;

  return (
    <>
      {shown.length > 0 ? (
        <ul className="space-y-1.5">
          {shown.map((occupant) => {
            const current = occupant.toDate === null;
            /*
              No card on their file claims this flat — so billing, which reads
              the file, has nothing to charge for it. Only said of a current
              spell: a former one released on the way out is missing nothing.
            */
            const unbacked = current && occupant.backedByFile === false;
            const name = occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم');
            const nameClass = cn(current ? 'font-medium' : 'font-normal line-through');

            return (
              <li
                key={occupant.id}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs',
                  current ? 'bg-background' : 'bg-muted/40 text-muted-foreground',
                )}
              >
                <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {citizenHref ? (
                  <Link
                    href={citizenHref(occupant.citizenId)}
                    className={cn('underline-offset-2 hover:underline', nameClass)}
                  >
                    {name}
                  </Link>
                ) : (
                  <span className={nameClass}>{name}</span>
                )}
                <Badge variant="soft-muted">{labels.occupancyRole[occupant.role]}</Badge>
                {!current ? <Badge variant="outline">{en ? 'Former' : 'سابق'}</Badge> : null}
                {!current && occupant.endReason ? (
                  <span className="text-[11px]">{labels.occupancyEndReason[occupant.endReason]}</span>
                ) : null}
                {occupant.shares ? (
                  <span className="text-muted-foreground">
                    {en ? `${occupant.shares}/2400 shares` : `${occupant.shares}/٢٤٠٠ سهم`}
                  </span>
                ) : null}
                {/*
                  The number, beside the name, for owner and occupant alike: the
                  officer at the door is the person who needs to call whoever is
                  recorded here, and opening each file to find it was the detour.
                */}
                {occupant.citizenPhone ? (
                  <a
                    href={`tel:${occupant.citizenPhone}`}
                    dir="ltr"
                    className="font-mono text-primary underline-offset-2 hover:underline"
                  >
                    {occupant.citizenPhone}
                  </a>
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
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={en ? `Actions for ${name}` : `إجراءات ${name}`}
                        className="ms-auto flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        <EllipsisVertical className="size-4" aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/*
                        Offered to a tenant whose card names no registered owner,
                        whenever the flat has an owner recorded. An owner recorded
                        after the tenant is linked only once the officer confirms
                        it in the dialog.
                      */}
                      {onLinkOwner &&
                      occupant.role !== 'OWNER' &&
                      occupant.ownerLink &&
                      (occupant.ownerLink.state === 'UNLINKED' || occupant.ownerLink.state === 'NO_CARD') &&
                      ownersFor(occupant).length > 0 ? (
                        <DropdownMenuItem className="min-h-10" onSelect={() => setLinking(occupant)}>
                          {en ? 'Link to the owner…' : 'ربط بالمالك…'}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        className="min-h-10 text-destructive focus:text-destructive"
                        onSelect={() => setEnding(occupant)}
                      >
                        {endActionLabel(occupant.role, en)}…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {/* After the menu, so it wraps onto its own line and the ⋮ stays beside the name. */}
                {current && occupant.ownerLink ? (
                  <OwnerLinkLine link={occupant.ownerLink} owners={owners} en={en} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {hidden > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {en
            ? `${hidden} entr${hidden === 1 ? 'y' : 'ies'} recorded in error — kept, not shown.`
            : `${hidden} إشغال سُجِّل بالخطأ — محفوظ ولا يُعرض.`}
        </p>
      ) : null}

      <EndOccupancyDialog
        occupant={ending}
        unitCode={unit.unitCode}
        asksStatus={
          Boolean(ending) &&
          ending!.role !== 'OWNER' &&
          !unit.occupants.some(
            // The server's rule: another person, not another row of the same one.
            (other) =>
              other.citizenId !== ending!.citizenId && other.toDate === null && other.role !== 'OWNER',
          )
        }
        locale={locale}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        onConfirm={(input) => onEnd(ending!, input)}
      />

      {onLinkOwner ? (
        <LinkOwnerDialog
          occupant={linking}
          owners={linking ? ownersFor(linking) : []}
          unitCode={unit.unitCode}
          locale={locale}
          onOpenChange={(open) => {
            if (!open) setLinking(null);
          }}
          onConfirm={(ownerId, confirmRecordedAfter) => onLinkOwner(linking!, ownerId, confirmRecordedAfter)}
        />
      ) : null}
    </>
  );
}

/**
 * Who a current tenant holds the flat from, as their own card says — beside
 * their name on the unit, so an owner and a tenant recorded on the same flat
 * are visibly connected, or visibly not.
 */
function OwnerLinkLine({
  link,
  owners,
  en,
}: {
  link: OccupantOwnerLink;
  owners: UnitOccupant[];
  en: boolean;
}) {
  if (link.state === 'NO_CARD') return null;

  if (link.state === 'LINKED') {
    const others = owners.filter((owner) => owner.citizenId !== link.ownerId);
    // The flat's only owner is listed right above — naming them again says nothing.
    if (others.length === 0) return null;
    return (
      <span className="basis-full text-[11px] text-muted-foreground">
        {en ? 'Owner: ' : 'المالك: '}
        <span className="font-medium text-foreground">{link.ownerName}</span>
        {others.length > 0
          ? en
            ? ` — co-owners: ${others.map((owner) => owner.citizenName).join(', ')}`
            : ` — شركاؤه: ${others.map((owner) => owner.citizenName).join('، ')}`
          : null}
      </span>
    );
  }

  if (link.state === 'LINKED_ELSEWHERE') {
    return (
      <span className="inline-flex basis-full items-center gap-1 text-[11px] text-amber-700 dark:text-amber-500">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        {en
          ? `Linked to ${link.ownerName}, who is not recorded as an owner of this unit`
          : `مربوط بـ${link.ownerName}، وهو غير مسجَّل مالكاً لهذه الوحدة`}
      </span>
    );
  }

  return (
    <span className="basis-full text-[11px] text-muted-foreground">
      {en ? 'Not linked to an owner' : 'غير مربوط بمالك'}
      {link.typedName ? (en ? ` (named: ${link.typedName})` : ` (ذكر: ${link.typedName})`) : null}
    </span>
  );
}

/**
 * «ربط بالمالك» — which of the flat's owners a tenant already on it rents from.
 *
 * Among co-owners the one chosen is the one the tenant deals with; the rest
 * stay recorded as owners. Nothing is chosen for the officer when there is more
 * than one.
 *
 * An owner recorded on the flat after the tenant is offered too, but said so,
 * and the link waits for a tick: the owner list is the evidence a pick rests
 * on, and a name added to it later is a later claim about a tenancy already on
 * file — which the officer is the one able to check.
 */
function LinkOwnerDialog({
  occupant,
  owners,
  unitCode,
  locale,
  onOpenChange,
  onConfirm,
}: {
  occupant: UnitOccupant | null;
  owners: UnitOccupant[];
  unitCode: string;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (ownerId: string, confirmRecordedAfter: boolean) => Promise<void>;
}) {
  const en = locale === 'en';
  const [choice, setChoice] = useState<string | null>(null);
  const [confirmedAfter, setConfirmedAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (occupant) {
      setChoice(owners.length === 1 ? owners[0]!.citizenId : null);
      setConfirmedAfter(false);
      setBusy(false);
      setFailure(null);
    }
    // Reset per tenant opened, not per re-render of the owner list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occupant?.id]);

  if (!occupant) return null;

  const recordedAfter = (owner: UnitOccupant) =>
    (owner.recordedAt ?? owner.fromDate) > (occupant.recordedAt ?? occupant.fromDate);
  const chosenOwner = owners.find((owner) => owner.citizenId === choice);
  const needsConfirmation = Boolean(chosenOwner && recordedAfter(chosenOwner));

  const confirm = async () => {
    if (!choice || busy || (needsConfirmation && !confirmedAfter)) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(choice, needsConfirmation);
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not link the owner.'
            : 'تعذّر الربط بالمالك.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle>
            {en
              ? `Who does ${occupant.citizenName ?? 'the tenant'} rent ${unitCode} from?`
              : `ممّن يستأجر ${occupant.citizenName ?? 'المستأجر'} الوحدة ${unitCode}؟`}
          </DialogTitle>
          <DialogDescription>
            {owners.length > 1
              ? en
                ? 'Choose the owner they deal with. The other owners stay recorded as owners of the unit.'
                : 'اختر المالك الذي يتعامل معه. يبقى المالكون الآخرون مسجَّلين مالكين للوحدة.'
              : en
                ? 'The tenancy on their file will name this owner.'
                : 'ستُسجَّل بطاقة الإيجار في ملفه باسم هذا المالك.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2" role="radiogroup">
          {owners.map((owner) => (
            <button
              key={owner.citizenId}
              type="button"
              role="radio"
              aria-checked={choice === owner.citizenId}
              onClick={() => {
                setChoice(owner.citizenId);
                setConfirmedAfter(false);
              }}
              className={cn(
                'flex min-h-11 flex-wrap items-center gap-x-2 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                choice === owner.citizenId
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'hover:bg-accent',
              )}
            >
              <span>{owner.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}</span>
              {owner.citizenPhone ? (
                <span dir="ltr" className="font-mono text-xs font-normal text-muted-foreground">
                  {owner.citizenPhone}
                </span>
              ) : null}
              {owner.shares ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {en ? `${owner.shares}/2400 shares` : `${owner.shares}/٢٤٠٠ سهم`}
                </span>
              ) : null}
              {recordedAfter(owner) ? (
                <span className="basis-full text-[11px] font-normal text-amber-700 dark:text-amber-500">
                  {en ? 'Recorded on the unit after the tenant' : 'سُجِّل على الوحدة بعد المستأجر'}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {needsConfirmation ? (
          <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={confirmedAfter}
              onChange={(event) => setConfirmedAfter(event.target.checked)}
            />
            <span>
              {en
                ? `${chosenOwner?.citizenName ?? 'This owner'} was recorded on the unit after ${occupant.citizenName ?? 'the tenant'}. I confirm this is who they rent from.`
                : `سُجِّل ${chosenOwner?.citizenName ?? 'هذا المالك'} على الوحدة بعد ${occupant.citizenName ?? 'المستأجر'}. أؤكّد أنه من يستأجر منه.`}
            </span>
          </label>
        ) : null}

        {failure ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive"
          >
            {failure}
          </p>
        ) : null}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="w-full sm:w-auto">
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !choice || (needsConfirmation && !confirmedAfter)}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Link' : 'ربط'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────  «تأكيد الشغور»  ────────────────────────────

/**
 * The safeguard «تأكيد الشغور» never had.
 *
 * One tap used to write «شاغرة» over whatever the unit said, and that tap
 * exempts the owner from the occupancy fee — the flat stops being billed as
 * lived in. Nothing asked what the officer had seen, nothing recorded who
 * decided it, and nothing could put it back.
 *
 * So this asks three things and states one. **What it rests on** has no
 * default, because a pre-selected basis is exactly what muscle memory confirms
 * — and the law distinguishes them: a تصريح بالشغور filed by the owner is the
 * strongest, a neighbour's word the weakest, and a unit is presumed occupied
 * until something says otherwise (هيئة التشريع والاستشارات 725/2003). **When**
 * it was seen empty, back-datable from a paper round. **Who said so**, required
 * for hearsay alone. And it states the consequence — including naming the owner
 * whose bill this changes, because that is the fact an officer can check
 * against the person standing in front of them.
 *
 * It also says what it will overwrite where the flat already claims to be
 * occupied: «مؤجرة» on the register and «شاغرة» at the door is a contradiction
 * worth a second look before it is resolved silently.
 */
export function ConfirmVacancyDialog({
  unit,
  unitCode,
  locale,
  open,
  onOpenChange,
  onConfirm,
}: {
  unit: UnitWithOccupants;
  /** The building-qualified code, so the title names the flat the way the panel does. */
  unitCode: string;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { basis: VacancyBasis; observedAt?: string; notes: string }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [basis, setBasis] = useState<VacancyBasis | null>(null);
  const [observedAt, setObservedAt] = useState(today());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh question every time it opens — never the previous flat's answer.
  useEffect(() => {
    if (open) {
      setBasis(null);
      setObservedAt(today());
      setNotes('');
      setFailure(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const owners = liveSpells(unit).filter((occupant) => occupant.role === 'OWNER');
  const status = effectiveUnitStatus(unit);
  const overwriting = status && !isUnoccupied(status) ? status : null;
  // Hearsay names its source; the server refuses it otherwise.
  const needsSource = basis === 'NEIGHBOUR_OR_CARETAKER';

  const confirm = async () => {
    if (!basis || busy || (needsSource && !notes.trim())) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm({
        basis,
        ...(observedAt && observedAt !== today() ? { observedAt } : {}),
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not confirm the vacancy.'
            : 'تعذّر تأكيد الشغور.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-400"
            >
              <DoorClosed className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {en ? 'Confirm unit ' : 'تأكيد شغور الوحدة '}
                <span dir="ltr" className="font-mono">
                  {unitCode}
                </span>
                {en ? ' vacant?' : '؟'}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? 'The unit is recorded as vacant and stops being billed to its owner as occupied. You can lift this at any time.'
                  : 'تُسجَّل الوحدة «شاغرة» وتتوقف عنها رسوم الإشغال على مالكها. يمكنك إلغاء التأكيد في أي وقت.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          {owners.length > 0 ? (
            <p className="rounded-md bg-accent/40 px-2.5 py-2 text-xs">
              {en ? 'Owner on record: ' : 'المالك المسجَّل: '}
              <span className="font-medium">
                {owners
                  .map((owner) => owner.citizenName ?? (en ? 'Unnamed' : 'بلا اسم'))
                  .join('، ')}
              </span>
            </p>
          ) : null}

          {overwriting ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              {en
                ? `The register currently says «${labels.unitStatus[overwriting]}». Confirming replaces that.`
                : `الوحدة مسجَّلة حالياً «${labels.unitStatus[overwriting]}». التأكيد يستبدل هذه الحالة.`}
            </p>
          ) : null}

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">
              {en ? 'What says it is empty?' : 'ما الذي يثبت شغورها؟'}{' '}
              <span className="text-destructive">*</span>
            </legend>
            <div className="grid gap-2" role="radiogroup">
              {VACANCY_BASIS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={basis === option}
                  onClick={() => setBasis(option)}
                  className={cn(
                    'min-h-11 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                    basis === option
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {labels.vacancyBasis[option]}
                </button>
              ))}
            </div>
          </fieldset>

          <Field
            label={en ? 'Seen empty on' : 'تاريخ المعاينة'}
            htmlFor="vacancy-observed"
            hint={en ? 'Defaults to today' : 'الافتراضي اليوم'}
          >
            <Input
              id="vacancy-observed"
              type="date"
              max={today()}
              value={observedAt}
              onChange={(event) => setObservedAt(event.target.value)}
              dir="ltr"
              className="text-start"
            />
          </Field>

          <Field
            label={en ? 'Notes' : 'ملاحظات'}
            htmlFor="vacancy-notes"
            required={needsSource}
            hint={
              needsSource
                ? en
                  ? 'Name who said so — it is what the record rests on'
                  : 'اذكر من أفاد بذلك — عليه يستند التأكيد'
                : undefined
            }
          >
            <Textarea
              id="vacancy-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                en ? 'Locked, no furniture, no meter reading' : 'مقفلة، بلا أثاث، والعداد متوقف'
              }
            />
          </Field>

          {failure ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive"
            >
              {failure}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !basis || (needsSource && !notes.trim())}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Confirm vacant' : 'تأكيد الشغور'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The undo, asked the way `EndOccupancyDialog` asks.
 *
 * The reason is not a formality: it decides what the flat goes back to, and the
 * dialog says which before it is pressed. «سُجِّل بالخطأ» puts back the حالة the
 * confirmation replaced — the register was wrong and this is the correction.
 * «لم تعد شاغرة» leaves the unit occupied-by-someone-unrecorded, which is the
 * presumption the law starts from and the state that bills the owner again
 * until whoever moved in is recorded.
 */
export function EndVacancyDialog({
  vacancy,
  unitCode,
  locale,
  onOpenChange,
  onConfirm,
}: {
  /** The standing confirmation; the dialog is open while this is set. */
  vacancy: UnitVacancyConfirmation | null;
  unitCode: string;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    reason: VacancyEndReason;
    endedAt?: string;
    notes: string;
  }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [reason, setReason] = useState<VacancyEndReason | null>(null);
  const [endedAt, setEndedAt] = useState(today());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (vacancy) {
      setReason(null);
      setEndedAt(today());
      setNotes('');
      setFailure(null);
      setBusy(false);
    }
  }, [vacancy]);

  if (!vacancy) return null;

  const restored = vacancy.previousUnitStatus
    ? labels.unitStatus[vacancy.previousUnitStatus]
    : en
      ? 'Occupancy not established'
      : 'الإشغال غير محدد';

  const confirm = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm({
        reason,
        ...(reason === 'NO_LONGER_VACANT' && endedAt ? { endedAt } : {}),
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not lift the vacancy.'
            : 'تعذّر إلغاء تأكيد الشغور.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <div className="min-w-0 space-y-1.5 text-start">
            <DialogTitle>
              {en ? 'Lift the vacancy on unit ' : 'إلغاء تأكيد شغور الوحدة '}
              <span dir="ltr" className="font-mono">
                {unitCode}
              </span>
              {en ? '?' : '؟'}
            </DialogTitle>
            <DialogDescription>
              {en
                ? 'The confirmation is closed and kept on record — it is not deleted.'
                : 'يُغلق التأكيد ويبقى محفوظاً في السجل — لا يُحذف.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">
              {en ? 'Why?' : 'السبب'} <span className="text-destructive">*</span>
            </legend>
            <div className="grid gap-2" role="radiogroup">
              {VACANCY_END_REASON.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={reason === option}
                  onClick={() => setReason(option)}
                  className={cn(
                    'min-h-11 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                    reason === option
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {labels.vacancyEndReason[option]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* What the flat will read afterwards, said before it is pressed. */}
          {reason ? (
            <p className="rounded-md bg-accent/40 px-2.5 py-2 text-xs leading-relaxed">
              {reason === 'RECORDED_IN_ERROR'
                ? en
                  ? `The unit goes back to «${restored}».`
                  : `تعود الوحدة إلى «${restored}».`
                : en
                  ? 'The unit is treated as occupied by somebody not yet recorded, and is billed to its owner again until they are. Record whoever lives there next.'
                  : 'تُعدّ الوحدة مشغولة بمن لم يُسجَّل بعد، وتعود الرسوم على المالك إلى أن يُسجَّل. سجّل من يسكنها بعد ذلك.'}
            </p>
          ) : null}

          {reason === 'NO_LONGER_VACANT' ? (
            <Field label={en ? 'Occupied again since' : 'تاريخ انتهاء الشغور'} htmlFor="vacancy-ended">
              <Input
                id="vacancy-ended"
                type="date"
                min={vacancy.observedAt.slice(0, 10)}
                max={today()}
                value={endedAt}
                onChange={(event) => setEndedAt(event.target.value)}
                dir="ltr"
                className="text-start"
              />
            </Field>
          ) : null}

          <Field label={en ? 'Notes' : 'ملاحظات'} htmlFor="vacancy-end-notes">
            <Textarea
              id="vacancy-end-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                en ? 'A family moved in at the start of the month' : 'سكنتها أسرة مطلع الشهر'
              }
            />
          </Field>

          {failure ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive"
            >
              {failure}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !reason}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Lift the vacancy' : 'إلغاء تأكيد الشغور'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Why this flat reads «شاغرة», and the one control that changes it.
 *
 * Shown wherever a confirmation is standing. The three facts on it are the ones
 * a dispute turns on — since when, on what basis, and by whom — and they used
 * to exist nowhere: the matrix said «شاغرة» and that was the whole of the
 * record. Underneath, the confirmations already closed, because a flat that has
 * been confirmed empty twice before is telling an officer something about the
 * building.
 *
 * Ones closed «سُجِّل بالخطأ» are left out and counted, exactly as occupancies
 * recorded in error are: they are not history, and a list that shows them
 * invites reading a correction as a fact.
 */
export function VacancyPanel({
  unit,
  unitCode,
  locale,
  busy,
  canWrite,
  onEnd,
}: {
  unit: UnitWithOccupants;
  unitCode: string;
  locale: string;
  busy: boolean;
  canWrite: boolean;
  onEnd: (input: {
    reason: VacancyEndReason;
    endedAt?: string;
    notes: string;
  }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [ending, setEnding] = useState<UnitVacancyConfirmation | null>(null);

  const standing = activeVacancy(unit);
  const closed = (unit.vacancies ?? []).filter(
    (row) => row.endedAt !== null && row.endReason !== 'RECORDED_IN_ERROR',
  );
  const corrections = (unit.vacancies ?? []).filter(
    (row) => row.endReason === 'RECORDED_IN_ERROR',
  ).length;

  if (!standing && closed.length === 0 && corrections === 0) return null;

  return (
    <>
      {standing ? (
        <div className="space-y-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
            <DoorClosed className="size-3.5 shrink-0 text-sky-700 dark:text-sky-400" aria-hidden />
            {en ? 'Confirmed vacant since ' : 'مؤكَّدة الشغور منذ '}
            {formatDate(standing.observedAt)}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {standing.basis
              ? labels.vacancyBasis[standing.basis]
              : en
                ? 'Recorded before the basis was asked for'
                : 'سُجِّل قبل أن يُسأل عن المستند'}
            {standing.confirmedByName ? ` — ${standing.confirmedByName}` : ''}
          </p>
          {standing.notes ? (
            <p className="text-[11px] leading-relaxed">{standing.notes}</p>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {en
              ? 'The owner is not billed the occupancy fee for it while this stands.'
              : 'لا تُحتسب على المالك رسوم الإشغال عنها ما دام هذا التأكيد قائماً.'}
          </p>
          {canWrite ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEnding(standing)}
            >
              <Undo2 className="size-4" aria-hidden />
              {en ? 'Lift the vacancy…' : 'إلغاء تأكيد الشغور…'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {closed.length > 0 ? (
        <ul className="space-y-1">
          {closed.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground"
            >
              <DoorClosed className="size-3 shrink-0" aria-hidden />
              {en ? 'Vacant ' : 'شاغرة '}
              {formatDate(row.observedAt)} — {formatDate(row.endedAt!)}
              {row.endReason ? (
                <Badge variant="soft-muted">{labels.vacancyEndReason[row.endReason]}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {corrections > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {en
            ? `${corrections} vacancy confirmation(s) recorded in error — kept, not shown.`
            : `${corrections} تأكيد شغور سُجِّل بالخطأ — محفوظ ولا يُعرض.`}
        </p>
      ) : null}

      <EndVacancyDialog
        vacancy={ending}
        unitCode={unitCode}
        locale={locale}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        onConfirm={onEnd}
      />
    </>
  );
}

// ─────────────────────────────  «مسكن موسمي»  ─────────────────────────────

/**
 * The facts a council needs to decide how a seasonal home is billed — recorded,
 * not decided.
 *
 * Shown for a unit whose state is «مسكن موسمي». The owner still bears the
 * occupancy fee by default: a building is presumed occupied until a تصريح
 * بالشغور is filed (هيئة التشريع والاستشارات 725/2003), and the fee is owed for
 * months actually occupied (Law 60/1988, Art. 11). So this asks which months
 * the owners are usually here, when they last were, and whether a declaration
 * has been filed — the three things that decision turns on.
 */
export function SeasonalHomePanel({
  unit,
  locale,
  busy,
  canWrite,
  onSave,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  canWrite: boolean;
  onSave: (values: {
    presenceMonths: number[];
    ownerLastStayAt: string | null;
    vacancyDeclaredAt: string | null;
  }) => void;
}) {
  const en = locale === 'en';
  const [months, setMonths] = useState<number[]>(unit.presenceMonths ?? []);
  const [lastStay, setLastStay] = useState(unit.ownerLastStayAt?.slice(0, 10) ?? '');
  const [declared, setDeclared] = useState(unit.vacancyDeclaredAt?.slice(0, 10) ?? '');

  useEffect(() => {
    setMonths(unit.presenceMonths ?? []);
    setLastStay(unit.ownerLastStayAt?.slice(0, 10) ?? '');
    setDeclared(unit.vacancyDeclaredAt?.slice(0, 10) ?? '');
  }, [unit.id, unit.presenceMonths, unit.ownerLastStayAt, unit.vacancyDeclaredAt]);

  const toggle = (month: number) =>
    setMonths((current) =>
      current.includes(month)
        ? current.filter((m) => m !== month)
        : [...current, month].sort((a, b) => a - b),
    );

  return (
    <div className="space-y-3 rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <CalendarDays className="size-3.5 text-sky-700 dark:text-sky-400" aria-hidden />
        {en ? 'Seasonal home — owners live elsewhere' : 'مسكن موسمي — أصحابه مقيمون خارج البلدة'}
      </p>

      <fieldset className="space-y-1.5" disabled={!canWrite}>
        <legend className="text-xs text-muted-foreground">
          {en ? 'Months the owners are usually here' : 'الأشهر التي يحضر فيها أصحابه عادةً'}
        </legend>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {monthNames(locale).map((label, index) => {
            const month = index + 1;
            const on = months.includes(month);
            return (
              <button
                key={month}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(month)}
                className={cn(
                  'min-h-9 rounded-md border px-1.5 text-[11px] transition-colors',
                  on ? 'border-sky-500/60 bg-sky-500/15 font-medium' : 'hover:bg-accent',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={en ? 'Last stayed' : 'آخر إقامة لأصحابه'} htmlFor="seasonal-last-stay">
          <Input
            id="seasonal-last-stay"
            type="date"
            max={today()}
            disabled={!canWrite}
            value={lastStay}
            onChange={(event) => setLastStay(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
        <Field
          label={en ? 'Vacancy declaration filed on' : 'تاريخ تقديم تصريح بالشغور'}
          htmlFor="seasonal-declared"
          hint={
            en
              ? 'Leave empty if none — the full year is then owed.'
              : 'اتركه فارغاً إن لم يُقدَّم — تُستحق عندها رسوم السنة كاملة.'
          }
        >
          <Input
            id="seasonal-declared"
            type="date"
            max={today()}
            disabled={!canWrite}
            value={declared}
            onChange={(event) => setDeclared(event.target.value)}
            dir="ltr"
            className="text-start"
          />
        </Field>
      </div>

      {canWrite ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            onSave({
              presenceMonths: months,
              ownerLastStayAt: lastStay || null,
              vacancyDeclaredAt: declared || null,
            })
          }
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {en ? 'Save seasonal details' : 'حفظ بيانات السكن الموسمي'}
        </Button>
      ) : null}
    </div>
  );
}
