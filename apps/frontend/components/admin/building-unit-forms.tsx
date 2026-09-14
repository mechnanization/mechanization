'use client';

import { useEffect, useState } from 'react';
import {
  CalendarClock,
  Footprints,
  Loader2,
  MapPin,
  Ruler,
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
  OCCUPANCY_ROLE,
  SURVEY_STATUS,
  UNIT_STATUS,
  unitStatusForRole,
  type BuildingLifecycle,
  type CaseType,
  type DamageLevel,
  type DamageSource,
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
export function cellBadge(
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
export function OccupantForm({
  tenant,
  token,
  busy,
  locale,
  unitArea: recordedArea,
  onSubmit,
}: {
  tenant: string;
  token: string;
  busy: boolean;
  locale: string;
  /**
   * The area the census already holds for this flat, or null if it holds none.
   *
   * Null is what opens the field. Passing `undefined` — a caller that has not
   * been updated — is treated the same as null rather than as "measured", so a
   * surface that forgets to wire it asks a redundant question instead of
   * silently dropping the only one that can fill the gap.
   */
  unitArea: number | null | undefined;
  onSubmit: (
    citizen: CitizenListItem,
    role: OccupancyRole,
    shares?: number,
    unitStatus?: UnitStatus,
    unitArea?: number,
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
      ) : (
        <p className="text-xs text-muted-foreground">
          {en
            ? `The unit will be recorded as ${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}.`
            : `ستُسجَّل الوحدة «${labels.unitStatus[unitStatusForRole(role) as UnitStatus]}».`}
        </p>
      )}

      <Button
        size="sm"
        disabled={busy || !chosen || !areaIsValid}
        onClick={() => {
          if (!chosen || !areaIsValid) return;
          const parsed = Number(shares);
          onSubmit(
            chosen,
            role,
            role === 'OWNER' && shares.trim() && Number.isFinite(parsed) ? parsed : undefined,
            // Sent for an owner only, and only when actually chosen. The
            // server refuses it on anyone else, whose capacity settles the
            // unit's حالة without being asked.
            role === 'OWNER' && unitStatus ? unitStatus : undefined,
            /*
              Omitted rather than sent as 0 when the box is empty, and never
              sent at all when the census already has an answer.

              An empty box means «لم تُقَس», which the unit already records as
              null; sending a zero would replace "unmeasured" with a
              measurement of zero, and the difference between those two is
              whether a PER_AREA notice refuses to price the flat or prices it
              at nothing.
            */
            !areaFromCensus && unitArea.trim() ? parsedArea : undefined,
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
