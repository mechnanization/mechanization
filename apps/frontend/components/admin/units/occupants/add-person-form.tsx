import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Landmark, Loader2, MapPin, Ruler, Search, UserRound, UsersRound } from 'lucide-react';
import { contradictsVacancy, getLabels, NON_PERSON_RESIDENCE, OCCUPANCY_ROLE, UNIT_STATUS, type CitizenResidence, type OccupancyRole, type UnitStatus, isDwellingUnitType } from '@mechanization/shared-schemas';
import { type CitizenListItem, type UnitOccupant, type UnitVacancyConfirmation } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { stashLinkSeed } from '@/lib/tab-search';
import { useCitizenSearch } from '@/lib/use-citizen-search';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldFlagProvider } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * «إضافة شخص إلى الوحدة» — the one way a person reaches a flat from the matrix.
 *
 * ## Search first, and «ملف جديد» once it has answered
 *
 * This used to be two buttons: «تسجيل شاغل», which linked somebody already on
 * file, and «تسجيل أسرة في هذه الوحدة», which opened a blank registration. The
 * labels said neither thing — the first was mostly used for owners, who are
 * by definition not a شاغل (D2), and the second also created owner records,
 * which have no household — and nothing made the officer look before creating.
 *
 * So there is one entry and it searches, and the new-file choices appear only
 * once the search has answered the name typed *now*: nobody matched, or the
 * register could not be reached. A list of matches offers them behind «ليس
 * بينهم؟» instead, so the person on file is the first thing the officer sees.
 *
 * This gate was tried once before and removed, and the two ways it failed are
 * why it is shaped as it is:
 *
 *  - A failed lookup cleared the term it was waiting on, so an officer with no
 *    signal could not reach «ملف جديد» at all. This form is used in the field,
 *    offline, in settlements nobody is going back to; a dead end there is a
 *    household that goes unregistered. An unreachable register therefore
 *    counts as answered — said as such, never as «لا نتيجة».
 *  - Two «محمد خليل»s on one parcel are a real afternoon, and a gate that only
 *    opens on zero matches never opens for the second one. Hence «ليس بينهم؟».
 *
 * It still gates on a search having *run*, not on the right one — «asdfgh»
 * opens it. The duplicate check that «asdfgh» cannot pass stays where it was:
 * `CitizenEditor` matches on the *name* as it is typed and shows whoever it
 * finds. That is the one that matters for «غير مقيم في البلدة» — a record
 * carrying a name, a phone and a town, no document number, so the one least
 * able to be merged after the fact.
 *
 * The search term also travels: whatever the officer typed seeds the new
 * file — its phone when the term is a number, its name otherwise
 * (`withSeededSearch`) — so a search that found nobody is not retyped.
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
  /** «لم تُقَس» and why, when neither the census nor the officer has an area. */
  unitAreaMissingReason?: string;
  /** Owners: «لم يُعرف من يشغلها» and why. */
  unitStatusMissingReason?: string;
}

/** Local «غير مؤكَّد» keys for the add-person form. Shaped as the shared `Field` expects. */
const AREA_FLAG_PATH = 'properties.0.unitArea';
const STATUS_FLAG_PATH = 'properties.0.unitStatus';
const NO_UNVERIFIED: ReadonlyMap<string, string> = new Map();

export function AddPersonForm({
  tenant,
  token,
  busy,
  locale,
  newFileHref,
  vacancy,
  owners = [],
  unitArea: recordedArea,
  unitType,
  onSubmit,
}: {
  tenant: string;
  token: string;
  busy: boolean;
  /** The unit's type: a body («جهة أو وقف») is offered as a tenant only of what nobody lives in. */
  unitType?: string | null;
  locale: string;
  /**
   * The registration form, pointed at this unit, with نوع الملف preset. The
   * officer's search term goes across too, as the name or phone to start from —
   * stashed in tab storage on the click (`stashLinkSeed`), never in the URL,
   * because it is a person's name or number.
   *
   * Absent where the caller cannot build an admin URL; the search still works
   * and the no-match line says to register the person first.
   */
  newFileHref?: (residence: CitizenResidence) => string;
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
  const tPicker = useTranslations('citizenPicker');
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
  const [chosen, setChosen] = useState<CitizenListItem | null>(null);
  /*
    The register's citizen search, the one every picker uses (`useCitizenSearch`).
    An archived file is offered: a person come back is restored, not filed twice.

    `failed` is kept apart from «no results», which it is not: the officer is
    told the register is unreachable rather than that nobody matched, because
    those two lead to different decisions about whether to open a new file. A
    failed search still answers its term (`searched`), so an officer with no
    signal can reach «ملف جديد» — an unregistered household is worse than a
    duplicate, and a duplicate here is still detectable by name.
  */
  const { results, searching, failed, searched } = useCitizenSearch(tenant, token, term, true, {
    includeArchived: true,
  });
  /** The term whose matches the officer has said «ليس بينهم؟» to. */
  const [notAmong, setNotAmong] = useState('');
  /** The shown results answer what is typed now, not a term since changed. */
  const settled = !searching && searched !== '' && searched === term.trim();
  const offerNewFile = settled && (failed || results.length === 0 || notAmong === searched);
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
   * «غير مؤكَّد» on the two questions this form asks about the unit — the same
   * control, and the same reason box, the citizen form puts on every field.
   *
   * Both questions are required now. An empty area or an unanswered «ومن
   * يشغلها؟» read exactly like a question nobody asked (52 of 65 units on
   * 2026-09-16), and an unanswered flat bills its owner. So each is answered,
   * or marked «غير مؤكَّد» with why. The reason travels to the occupancy's
   * audit row; the unit itself keeps its null, so an unknown never passes for a
   * measurement.
   *
   * The paths are local names the shared `Field` accepts, not a submission's —
   * nothing here is sent as a field flag.
   */
  const [unitFlags, setUnitFlags] = useState<ReadonlyMap<string, string>>(new Map());
  const unitFlagApi = useMemo(
    () => ({
      flags: unitFlags,
      unverified: NO_UNVERIFIED,
      set: (path: string, reason: string) =>
        setUnitFlags((current) => new Map(current).set(path, reason)),
      clear: (path: string) =>
        setUnitFlags((current) => {
          const next = new Map(current);
          next.delete(path);
          return next;
        }),
      locale,
    }),
    [unitFlags, locale],
  );
  const areaFlag = unitFlags.get(AREA_FLAG_PATH);
  const statusFlag = unitFlags.get(STATUS_FLAG_PATH);
  const areaAnswered =
    areaFromCensus ||
    (areaFlag !== undefined ? areaFlag.trim().length >= 4 : unitArea.trim() !== '' && areaIsValid);
  const statusAnswered =
    role !== 'OWNER' || (statusFlag !== undefined ? statusFlag.trim().length >= 4 : unitStatus !== '');
  /** What «ومن يشغلها؟» actually says: nothing, while it is marked «غير مؤكَّد». */
  const answeredStatus = role === 'OWNER' && statusFlag === undefined && unitStatus ? unitStatus : null;

  /**
   * Whether what is about to be recorded contradicts the standing vacancy.
   *
   * The same predicate the server applies (`contradictsVacancy`), imported
   * rather than restated: a form that warns about something the server allows
   * teaches officers to ignore the warning, and one that stays quiet about
   * something it refuses is a failed save with no explanation.
   */
  const endsStandingVacancy = Boolean(
    vacancy && role && contradictsVacancy(role, answeredStatus),
  );


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
                // The form opens from «إضافة شخص إلى الوحدة», and searching is
                // the first thing it asks for.
                autoFocus
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                className="ps-9"
                placeholder={en ? 'Name, phone or reference…' : 'الاسم أو الهاتف أو رقم القيد…'}
              />
            </div>
          </Field>

          {!term.trim() ? (
            <p className="text-xs text-muted-foreground">
              
            </p>
          ) : searching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {en ? 'Searching…' : 'جاري البحث…'}
            </p>
          ) : results.length > 0 ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {results.map((citizen) => (
                <li key={citizen.id}>
                  {/*
                    An archived file is shown, so the person is not filed twice,
                    and not taken: nobody is put in a flat on one until it is
                    restored (`CITIZEN_FILE_ARCHIVED`). `aria-disabled` keeps it
                    reachable, so its hint is read.
                  */}
                  <button
                    type="button"
                    aria-disabled={citizen.isActive ? undefined : true}
                    onClick={() => {
                      if (citizen.isActive) setChosen(citizen);
                    }}
                    className={cn(
                      'flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2.5 py-1.5 text-start text-sm transition-colors',
                      citizen.isActive ? 'hover:bg-accent' : 'cursor-not-allowed',
                    )}
                  >
                    <span className="font-medium">{citizen.fullName}</span>
                    {!citizen.isActive ? (
                      <Badge variant="soft-muted">{tPicker('archived')}</Badge>
                    ) : null}
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
                    {!citizen.isActive ? (
                      <span className="basis-full text-xs text-muted-foreground">{tPicker('archivedHint')}</span>
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
          ) : settled && results.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {en ? 'No match in the register.' : 'لا نتيجة في السجل.'}
            </p>
          ) : null}

          {/*
            Held back until the search has answered — see the docblock for why
            an unreachable register and «ليس بينهم؟» both open it. Without
            either, an officer offline or facing a same-name match could not
            register the household at all.
          */}
          {settled && results.length > 0 && !offerNewFile ? (
            <button
              type="button"
              className="py-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setNotAmong(searched)}
            >
              {en ? 'Not one of these? Open a new file' : 'ليس بينهم؟ افتح ملفاً جديداً'}
            </button>
          ) : null}

          {!offerNewFile ? null : newFileHref ? (
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
                  href={newFileHref('RESIDENT')}
                  onClick={() => stashLinkSeed(tenant, newFileHref('RESIDENT'), term)}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <UsersRound className="size-4" aria-hidden />
                  {labels.citizenResidence.RESIDENT}
                </Link>
                <Link
                  href={newFileHref('NON_RESIDENT_OWNER')}
                  onClick={() => stashLinkSeed(tenant, newFileHref('NON_RESIDENT_OWNER'), term)}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <MapPin className="size-4" aria-hidden />
                  {labels.citizenResidence.NON_RESIDENT_OWNER}
                </Link>
                {/*
                  Not a living person (0076): an estate owns and nothing else,
                  so it is offered for an owner only; a waqf or a public body
                  may also rent what nobody lives in.
                */}
                {(role === 'OWNER'
                  ? NON_PERSON_RESIDENCE
                  : isDwellingUnitType(unitType ?? '')
                    ? ([] as const)
                    : (['INSTITUTION'] as const)
                ).map((kind) => (
                  <Link
                    key={kind}
                    href={newFileHref(kind)}
                    onClick={() => stashLinkSeed(tenant, newFileHref(kind), term)}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    <Landmark className="size-4" aria-hidden />
                    {labels.citizenResidence[kind]}
                  </Link>
                ))}
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

      <div className="grid gap-3">
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
      <FieldFlagProvider value={unitFlagApi}>
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
          path={AREA_FLAG_PATH}
          required
          error={
            areaFlag !== undefined || areaIsValid
              ? undefined
              : en
                ? 'The area must be greater than zero.'
                : 'المساحة يجب أن تكون أكبر من صفر.'
          }
          caution={
            en
              ? 'The census has no area for this unit. If it has not been measured, press «Unverified» and say why — never guess: a guess would be billed.'
              : 'لا توجد مساحة مسجَّلة لهذه الوحدة. إن لم تُقَس فاضغط «غير مؤكَّد» واذكر السبب — لا تُقدِّر: الرقم المُقدَّر تُحتسب عليه الرسوم.'
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
        a شاغل بتسامح has already answered it by being recorded, and is not
        asked a second time — see the docblock.
      */}
      {role === 'OWNER' ? (
        <Field
          label={en ? 'And who occupies it?' : 'ومن يشغلها؟'}
          htmlFor="occupant-unit-status"
          path={STATUS_FLAG_PATH}
          required
          caution={
            en
              ? 'Owning a flat is not living in it. If you could not find out, press «Unverified» and say why — never guess.'
              : 'الملكية لا تعني السكن. إن لم تعرف من يشغلها فاضغط «غير مؤكَّد» واذكر السبب — لا تُخمِّن.'
          }
        >
          <Select
            value={unitStatus || undefined}
            onValueChange={(value) => setUnitStatus(value as UnitStatus)}
          >
            <SelectTrigger id="occupant-unit-status">
              <SelectValue placeholder={en ? 'Choose…' : 'اختر…'} />
            </SelectTrigger>
            <SelectContent>
              {UNIT_STATUS.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.unitStatus[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      </FieldFlagProvider>

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
            <div className="grid gap-3">
              <Field
                label={en ? 'Owner’s name' : 'اسم المالك'}
                htmlFor="occupant-landlord-name"
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
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed">
          <Checkbox
            className="mt-0.5"
            checked={acknowledgedVacancy}
            onCheckedChange={(checked) => setAcknowledgedVacancy(checked === true)}
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
          !areaAnswered ||
          !statusAnswered
        }
        onClick={() => {
          if (!chosen || !role || !areaAnswered || !statusAnswered) return;
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
            unitStatus: answeredStatus ?? undefined,
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
            unitArea: !areaFromCensus && areaFlag === undefined && unitArea.trim() ? parsedArea : undefined,
            ...(!areaFromCensus && areaFlag !== undefined
              ? { unitAreaMissingReason: areaFlag.trim() }
              : {}),
            ...(role === 'OWNER' && statusFlag !== undefined
              ? { unitStatusMissingReason: statusFlag.trim() }
              : {}),
          });
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {en ? 'Add to the unit' : 'ربط بالوحدة'}
      </Button>
    </div>
  );
}
