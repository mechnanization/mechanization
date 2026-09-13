'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  EllipsisVertical,
  Footprints,
  Loader2,
  MapPin,
  Search,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import {
  CASE_TYPE,
  DAMAGE_LEVEL,
  DAMAGE_SOURCE,
  getLabels,
  isOccupiableLifecycle,
  isUnoccupied,
  OCCUPANCY_ROLE,
  SURVEY_STATUS,
  UNIT_STATUS,
  unitStatusForRole,
  type BuildingLifecycle,
  type CaseType,
  type DamageLevel,
  type DamageSource,
  type OccupancyEndReason,
  type OccupancyRole,
  type StructureType,
  type SurveyStatus,
  type UnitStatus,
} from '@mechanization/shared-schemas';
import {
  listCitizens,
  logApiError,
  type CitizenListItem,
  type OccupancyFileLink,
  type UnitOccupant,
  type UnitVisitRow,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

/**
 * The per-unit forms and small display helpers shared by
 * `building-unit-matrix-drawer.tsx` (the map/cases slide-over) and
 * `building-unit-matrix-view.tsx` (the ledger's full-page spatial matrix).
 * Extracted rather than duplicated so the two surfaces can never quietly
 * diverge on what "register an occupant" or "log a case" means.
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
  (status): status is Exclude<SurveyStatus, 'NOT_SURVEYED'> => status !== 'NOT_SURVEYED',
);

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
  result: { casesResolved: number; fileLink: OccupancyFileLink },
  en: boolean,
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

  return parts.join(' — ');
}
/**
 * Who is in the flat — searched for, because the person at the door is very
 * often already on file from a different property.
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
 */
export function OccupantForm({
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
  onSubmit: (
    citizen: CitizenListItem,
    role: OccupancyRole,
    shares?: number,
    unitStatus?: UnitStatus,
  ) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<CitizenListItem | null>(null);
  const [role, setRole] = useState<OccupancyRole>('OWNER');
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
      ) : (
        <p className="text-xs text-muted-foreground">
          {en
            ? `The unit will be recorded as ${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}.`
            : `ستُسجَّل الوحدة «${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}».`}
        </p>
      )}

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
            // Sent for an owner only, and only when actually chosen. The
            // server refuses it on anyone else, whose capacity settles the
            // unit's حالة without being asked.
            role === 'OWNER' && unitStatus ? unitStatus : undefined,
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
  locale,
  onOpenChange,
  onConfirm,
}: {
  /** The spell being ended; the dialog is open while this is set. */
  occupant: UnitOccupant | null;
  unitCode: string;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { reason: OccupancyEndReason; toDate?: string }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [reason, setReason] = useState<OccupancyEndReason | null>(null);
  const [toDate, setToDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh question every time it opens — never the previous person's answer.
  useEffect(() => {
    if (occupant) {
      setReason(null);
      setToDate(today());
      setFailure(null);
      setBusy(false);
    }
  }, [occupant]);

  if (!occupant) return null;

  const name = occupant.citizenName ?? (en ? 'this person' : 'هذا الشخص');
  const action = endActionLabel(occupant.role, en);

  const confirm = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // Today is the server's default; only a back-dated end is sent.
      await onConfirm({ reason, ...(toDate && toDate !== today() ? { toDate } : {}) });
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
                {en
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
            disabled={busy || !reason}
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
}: {
  unit: UnitWithOccupants;
  locale: string;
  canWrite: boolean;
  busy: boolean;
  /** Where a name links to; plain text when absent. */
  citizenHref?: (citizenId: string) => string;
  onEnd: (occupant: UnitOccupant, input: { reason: OccupancyEndReason; toDate?: string }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [ending, setEnding] = useState<UnitOccupant | null>(null);

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
                      <DropdownMenuItem
                        className="min-h-10 text-destructive focus:text-destructive"
                        onSelect={() => setEnding(occupant)}
                      >
                        {endActionLabel(occupant.role, en)}…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
        locale={locale}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        onConfirm={(input) => onEnd(ending!, input)}
      />
    </>
  );
}

// ─────────────────────────────  «مسكن موسمي»  ─────────────────────────────

const MONTHS: Record<'ar' | 'en', string[]> = {
  ar: [
    'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
  ],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

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
          {MONTHS[en ? 'en' : 'ar'].map((label, index) => {
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
