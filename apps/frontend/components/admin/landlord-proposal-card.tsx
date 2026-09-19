'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpLeft,
  Building2,
  Check,
  CircleAlert,
  Equal,
  Loader2,
  Phone,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import {
  ApiRequestError,
  confirmLandlordLink,
  dismissLandlordLink,
  logApiError,
  restoreLandlordLink,
  unlinkLandlord,
  type LandlordProposal,
  type LandlordProposalCandidate,
  type LinkBlock,
  type LinkOutcome,
} from '@/lib/api-client';
import { compareNames, formatPhone, type NameMatch } from '@/lib/landlord-display';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * One owner claim, laid out as the single question it asks:
 * **«من هو المالك الذي ذكره هذا المستأجر؟»**
 *
 * ## Why it reads top to bottom as a sentence
 *
 * The old card put the typed name in one box, the phone on a hinge, and — when
 * the number was a shared household line — the registered people *only inside
 * the button labels*. The officer had to compare a name against two blue
 * buttons that looked identical and did opposite things. Here the claim is one
 * line («ذكر أن المالك: … ☎ …»), the people are a list under it, each marked
 * with how their name compares, and nothing happens until one is chosen.
 *
 * ## Why choosing and confirming are two steps
 *
 * A link moves a flat onto somebody's bill. One tap on the wrong row of two
 * similar names is the one mistake this screen exists to prevent, so the row
 * selects and a single button — which names the person it will link — commits.
 * An exact name match is preselected (nothing links itself), so the common case
 * still costs one tap.
 *
 * ## What the consequences line is for
 *
 * The server says, per candidate, what the link will do on the owner's file —
 * a new card, a unit added to their card, already on file — and the flats it
 * covers. That is stated under the selection before the button is pressed,
 * rather than discovered afterwards from a toast.
 */
export function LandlordProposalCard({
  tenant,
  token,
  proposal,
  citizenHref,
  onResolved,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  proposal: LandlordProposal;
  citizenHref: (citizenId: string) => string;
  onResolved: (resolution: LandlordResolution) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const toast = useToast();
  const titleId = useId();

  const matches = useMemo(
    () =>
      new Map(
        proposal.candidates.map((candidate) => [
          candidate.id,
          compareNames(proposal.landlordName, candidate.name),
        ]),
      ),
    [proposal],
  );

  /*
    Preselected only on an exact name match, and only when exactly one
    linkable person has it. Two «SAME» rows is a father and son with one name,
    which is precisely where the officer has to look.
  */
  /*
    And only among people the card's *number* found. A candidate found by the
    typed name alone is by construction a «SAME» name, so preselecting it would
    turn the weaker match into the default one — the reverse of what the name
    match was added for.
  */
  const preselected = useMemo(() => {
    if (proposal.blocked) return null;
    const same = proposal.candidates.filter(
      (candidate) =>
        !candidate.blocked &&
        candidate.matchedBy !== 'NAME' &&
        matches.get(candidate.id) === 'SAME',
    );
    return same.length === 1 ? same[0]!.id : null;
  }, [proposal, matches]);
  const foundByName = proposal.candidates.some((candidate) => candidate.matchedBy === 'NAME');

  const [selectedId, setSelectedId] = useState<string | null>(preselected);
  const [busy, setBusy] = useState<'link' | 'dismiss' | null>(null);

  const selected = proposal.candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const shared = proposal.candidates.length > 1;

  const link = async () => {
    if (!selected || busy) return;
    setBusy('link');
    try {
      await confirmLandlordLink(tenant, token, proposal.propertyEntryId, selected.id);
      onResolved({
        kind: 'linked',
        propertyEntryId: proposal.propertyEntryId,
        ownerName: selected.name,
        candidateIds: [selected.id],
      });
    } catch (caught) {
      logApiError(caught);
      toast.error(en ? 'The owner was not linked' : 'لم يتم ربط المالك', {
        description:
          caught instanceof ApiRequestError
            ? caught.payload.message
            : en
              ? 'Check the connection and try again.'
              : 'تحقّق من الاتصال وحاول مرة أخرى.',
      });
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy('dismiss');
    const candidateIds = proposal.candidates.map((candidate) => candidate.id);
    try {
      await dismissLandlordLink(tenant, token, proposal.propertyEntryId, candidateIds);
      onResolved({
        kind: 'dismissed',
        propertyEntryId: proposal.propertyEntryId,
        ownerName: null,
        candidateIds,
      });
    } catch (caught) {
      logApiError(caught);
      toast.error(en ? 'Could not record the answer.' : 'تعذّر تسجيل الإجابة.', {
        description: caught instanceof ApiRequestError ? caught.payload.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const tenantName = proposal.filedBy?.name ?? (en ? 'A registered household' : 'أسرة مسجَّلة');
  const units = proposal.units.map((unit) => unit.unitCode).filter(Boolean) as string[];

  return (
    <article
      aria-labelledby={titleId}
      className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm"
    >
      {/* ── Who filed it, and where ─────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-4 py-3">
        <Badge variant="soft-muted" className="shrink-0">
          {proposal.occupancyType === 'FREE_OCCUPANT'
            ? en
              ? 'Free occupant'
              : 'شاغل بتسامح'
            : en
              ? 'Tenant'
              : 'مستأجر'}
        </Badge>
        <h3 id={titleId} className="min-w-0 text-sm font-semibold">
          {proposal.filedBy ? (
            <Link
              href={citizenHref(proposal.filedBy.citizenId)}
              className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tenantName}
            </Link>
          ) : (
            tenantName
          )}
        </h3>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 className="size-4 shrink-0" aria-hidden />
          <span className="truncate">
            {[
              proposal.buildingName,
              proposal.propertyNumber
                ? en
                  ? `Parcel ${proposal.propertyNumber}`
                  : `العقار ${proposal.propertyNumber}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || (en ? 'No building named' : 'لا اسم للمبنى')}
          </span>
        </span>
        {units.length > 0 ? (
          <span className="flex flex-wrap gap-1" aria-label={en ? 'Units' : 'الوحدات'}>
            {units.map((code) => (
              <bdi
                key={code}
                dir="ltr"
                className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground ring-1 ring-border"
              >
                {code}
              </bdi>
            ))}
          </span>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground">
          {en ? 'Filed ' : 'قُدِّمت '}
          {formatDate(proposal.filedAt)}
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* ── The claim, as one sentence ──────────────────────────────── */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {en ? 'Named as the owner' : 'ذكر أن المالك هو'}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p
              className={cn(
                'text-lg font-bold leading-snug',
                !proposal.landlordName && 'font-normal text-muted-foreground',
              )}
            >
              {proposal.landlordName ?? (en ? 'No name given' : 'لم يُذكر اسم')}
            </p>
            {proposal.landlordPhone ? (
              <span
                dir="ltr"
                className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-sm tabular-nums"
              >
                <Phone className="size-3.5 text-muted-foreground" aria-hidden />
                {formatPhone(proposal.landlordPhone)}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {en ? 'no number given' : 'لم يُذكر رقم'}
              </span>
            )}
          </div>
        </div>

        {proposal.blocked ? (
          <BlockNotice
            block={proposal.blocked}
            href={proposal.filedBy ? citizenHref(proposal.filedBy.citizenId) : null}
            hrefLabel={en ? 'Open the tenant’s file' : 'فتح ملف المستأجر'}
            locale={locale}
          />
        ) : null}

        {/* ── Who it could be ─────────────────────────────────────────── */}
        <fieldset className="space-y-2" disabled={Boolean(busy)}>
          <legend className="mb-2 text-sm font-semibold">
            {proposal.blocked
              ? foundByName
                ? en
                  ? 'Registered on this number or name'
                  : 'المسجَّلون بهذا الرقم أو الاسم'
                : en
                  ? 'Registered on this number'
                  : 'المسجَّلون على هذا الرقم'
              : shared
                ? en
                  ? `Which of these ${proposal.candidates.length} people is the owner?`
                  : foundByName
                    ? `من هو المالك؟ ${proposal.candidates.length} مواطنين مسجَّلين بهذا الرقم أو الاسم`
                    : `من هو المالك؟ ${proposal.candidates.length} مواطنين مسجَّلين على هذا الرقم`
                : en
                  ? 'Is this the owner?'
                  : 'هل هذا هو المالك؟'}
          </legend>

          <div role="radiogroup" aria-label={en ? 'Registered citizens' : 'المواطنون المسجَّلون'} className="space-y-2">
            {proposal.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                match={matches.get(candidate.id) ?? 'DIFFERENT'}
                selectable={!proposal.blocked && !candidate.blocked}
                selected={selectedId === candidate.id}
                onSelect={() => setSelectedId(candidate.id)}
                group={`owner-${proposal.propertyEntryId}`}
                href={citizenHref(candidate.id)}
                locale={locale}
              />
            ))}
          </div>
        </fieldset>

        {selected && !proposal.blocked ? (
          <Consequences
            candidate={selected}
            units={units}
            locale={locale}
          />
        ) : null}
      </div>

      {/* ── The two answers ─────────────────────────────────────────── */}
      <footer className="flex flex-col-reverse gap-2 border-t bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="ghost"
          onClick={() => void dismiss()}
          disabled={Boolean(busy)}
          className={cn(PRESSABLE, 'h-11 text-muted-foreground hover:text-foreground sm:h-10')}
        >
          {busy === 'dismiss' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <X className="size-4" aria-hidden />
          )}
          {shared
            ? en
              ? 'None of them'
              : 'لا أحد منهم'
            : en
              ? 'Not this person'
              : 'ليس هو'}
        </Button>

        {proposal.blocked ? null : (
          <Button
            onClick={() => void link()}
            disabled={!selected || Boolean(busy)}
            className={cn(PRESSABLE, 'h-11 min-w-0 sm:h-10')}
          >
            {busy === 'link' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            <span className="truncate">
              {selected
                ? en
                  ? `Link ${selected.name} as the owner`
                  : `ربط ${selected.name} كمالك`
                : en
                  ? 'Choose the owner first'
                  : 'اختر المالك أولاً'}
            </span>
          </Button>
        )}
      </footer>
    </article>
  );
}

/**
 * Press feedback on the two answers — a 3% scale, not a colour flash, so the
 * control acknowledges the tap before the request returns. Motion-reduced
 * readers keep the colour change and lose the movement.
 */
const PRESSABLE =
  'transition-[transform,background-color,color] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none motion-reduce:transition-colors';

function CandidateRow({
  candidate,
  match,
  selectable,
  selected,
  onSelect,
  group,
  href,
  locale,
}: {
  candidate: LandlordProposalCandidate;
  match: NameMatch;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  /** One name for the whole list, so the radios are one group to a keyboard. */
  group: string;
  href: string;
  locale: string;
}) {
  const en = locale === 'en';
  const inputId = useId();

  const details = [
    candidate.fatherName ? `${en ? 'Father' : 'الأب'}: ${candidate.fatherName}` : null,
    candidate.motherName ? `${en ? 'Mother' : 'الأم'}: ${candidate.motherName}` : null,
    candidate.registeredAt
      ? `${en ? 'Registered' : 'سُجِّل'} ${formatDate(candidate.registeredAt)}`
      : null,
  ].filter(Boolean);

  return (
    <div
      className={cn(
        'relative rounded-lg border transition-colors duration-150',
        selectable ? 'hover:border-primary/50' : 'bg-muted/20',
        selected && 'border-primary bg-primary/10 ring-1 ring-primary',
      )}
    >
      <label
        htmlFor={inputId}
        className={cn(
          'flex min-h-14 items-start gap-3 p-3 pe-24',
          selectable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        {/*
          No radio at all on a row that cannot be chosen. A faded one reads as a
          control that is broken rather than a choice that is not available, and
          the reason is written under the name instead.
        */}
        {selectable ? (
          <input
            id={inputId}
            type="radio"
            name={group}
            checked={selected}
            onChange={onSelect}
            className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
          />
        ) : (
          <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{candidate.name}</span>
            <MatchBadge match={match} locale={locale} />
            {candidate.matchedBy === 'NAME' ? (
              <Badge variant="soft-warning">
                {en ? 'Matched by name only — check the number' : 'مطابقة بالاسم فقط — تحقَّق من الرقم'}
              </Badge>
            ) : null}
            {candidate.residence === 'NON_RESIDENT_OWNER' ? (
              <Badge variant="soft-info">{en ? 'Lives elsewhere' : 'غير مقيم'}</Badge>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {candidate.referenceNumber ? (
              <bdi dir="ltr" className="font-mono">
                {candidate.referenceNumber}
              </bdi>
            ) : null}
            {details.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </span>
          {candidate.blocked ? (
            <span className="mt-1 flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {candidate.blocked.message}
            </span>
          ) : null}
        </span>
      </label>

      {/*
        Outside the label so opening the file does not select the row, and in a
        new tab so the queue — and the choice half-made on it — stays where it is.
      */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute end-2 top-2 inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {en ? 'File' : 'الملف'}
        <ArrowUpLeft className="size-3.5 ltr:rotate-90" aria-hidden />
      </a>
    </div>
  );
}

/**
 * The name comparison, in words and an icon — never in colour alone.
 */
function MatchBadge({ match, locale }: { match: NameMatch; locale: string }) {
  const en = locale === 'en';
  switch (match) {
    case 'SAME':
      return (
        <Badge variant="soft-success" className="gap-1">
          <Equal className="size-3" aria-hidden />
          {en ? 'Same name' : 'الاسم مطابق'}
        </Badge>
      );
    case 'SIMILAR':
      return (
        <Badge variant="soft-info" className="gap-1">
          <CircleAlert className="size-3" aria-hidden />
          {en ? 'Similar name' : 'اسم مشابه'}
        </Badge>
      );
    case 'DIFFERENT':
      return (
        <Badge variant="soft-warning" className="gap-1">
          <TriangleAlert className="size-3" aria-hidden />
          {en ? 'Different name' : 'اسم مختلف'}
        </Badge>
      );
    case 'OTHER_SCRIPT':
      return (
        <Badge variant="soft-muted" className="gap-1">
          <UserRound className="size-3" aria-hidden />
          {en ? 'Compare by reading' : 'قارن الاسمين بنفسك'}
        </Badge>
      );
    default:
      return null;
  }
}

/** What pressing the button will write, for the person selected. */
function Consequences({
  candidate,
  units,
  locale,
}: {
  candidate: LandlordProposalCandidate;
  units: string[];
  locale: string;
}) {
  const en = locale === 'en';
  const unitList = units.join(en ? ', ' : '، ');

  const lines = [
    units.length > 0
      ? en
        ? `Recorded as owner of ${units.length === 1 ? 'unit' : 'units'} ${unitList}.`
        : `يُسجَّل مالكاً ${units.length === 1 ? 'للوحدة' : 'للوحدات'} ${unitList}.`
      : null,
    outcomeLine(candidate.outcome, locale),
    en
      ? 'The owner field on the tenant’s card shows their registered name and stays locked until the link is undone.'
      : 'يظهر اسمه المسجَّل في خانة المالك على بطاقة المستأجر، وتبقى مقفلة حتى يُلغى الربط.',
  ].filter(Boolean) as string[];

  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="mb-1.5 text-xs font-semibold">
        {en ? `Linking ${candidate.name} will:` : `عند ربط ${candidate.name}:`}
      </p>
      <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function outcomeLine(outcome: LinkOutcome | null, locale: string): string | null {
  const en = locale === 'en';
  switch (outcome) {
    case 'NEW_CARD':
      return en
        ? 'Add the property to their file as a new ownership card, so it is billed.'
        : 'يُضاف العقار إلى ملفه كبطاقة «مالك» جديدة، فيدخل في فواتيره.';
    case 'ADDED_TO_CARD':
      return en
        ? 'Add the unit to the ownership card already on their file.'
        : 'تُضاف الوحدة إلى بطاقة «مالك» موجودة في ملفه.';
    case 'ALREADY_ON_FILE':
      return en
        ? 'Nothing new on their file — the property is already there. Only the link is recorded.'
        : 'العقار مسجَّل في ملفه مسبقاً — يُسجَّل الربط فقط.';
    case 'OCCUPANCY_ONLY':
      return en
        ? 'Record them as owner in the buildings register; this structure carries no property card.'
        : 'يُسجَّل مالكاً في سجل المباني؛ هذه المنشأة لا تحمل بطاقة عقار.';
    default:
      return null;
  }
}

/** A reason no link can be made yet, with the step that fixes it. */
export function BlockNotice({
  block,
  href,
  hrefLabel,
  locale,
}: {
  block: LinkBlock;
  href: string | null;
  hrefLabel: string;
  locale: string;
}) {
  const en = locale === 'en';
  return (
    <div role="note" className="flex items-start gap-3 rounded-lg bg-warning/10 p-3">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-warning">
          {en ? 'This card cannot be linked yet' : 'لا يمكن ربط هذه البطاقة بعد'}
        </p>
        <p className="text-sm leading-relaxed">{block.message}</p>
        {href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-1 pt-0.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {hrefLabel}
            <ArrowUpLeft className="size-3.5 ltr:rotate-90" aria-hidden />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────  Resolving  ─────────────────────────────

export interface LandlordResolution {
  kind: 'linked' | 'dismissed';
  propertyEntryId: string;
  ownerName: string | null;
  candidateIds: string[];
}

/**
 * The settled rows on a list, and the «تراجع» for each.
 *
 * A settled card is replaced by a one-line placeholder rather than removed, so
 * the rows below never jump up under the cursor — which is how the next card
 * gets answered by accident. The undo is offered twice: in the toast, for the
 * moment right after, and on the placeholder, for as long as the list is on
 * screen.
 */
export function useLandlordResolutions({
  tenant,
  token,
  locale,
}: {
  tenant: string;
  token: string;
  locale: string;
}) {
  const en = locale === 'en';
  const toast = useToast();
  const [resolved, setResolved] = useState<Record<string, LandlordResolution>>({});
  const [undoing, setUndoing] = useState<string | null>(null);

  const undo = useCallback(
    async (resolution: LandlordResolution) => {
      setUndoing(resolution.propertyEntryId);
      try {
        if (resolution.kind === 'linked') {
          const result = await unlinkLandlord(tenant, token, resolution.propertyEntryId);
          if (result.kept.length > 0) {
            toast.warning(en ? 'Link undone — some records were kept' : 'أُلغي الربط — وبقيت بعض السجلات', {
              description: en
                ? 'Somebody changed them after the link. Review the owner’s file.'
                : 'عُدِّلت بعد الربط فلم تُحذف. راجع ملف المالك.',
            });
          }
        } else {
          await restoreLandlordLink(tenant, token, resolution.propertyEntryId, resolution.candidateIds);
        }
        setResolved((current) => {
          const next = { ...current };
          delete next[resolution.propertyEntryId];
          return next;
        });
      } catch (caught) {
        logApiError(caught);
        toast.error(en ? 'Could not undo it.' : 'تعذّر التراجع.', {
          description: caught instanceof ApiRequestError ? caught.payload.message : undefined,
        });
      } finally {
        setUndoing(null);
      }
    },
    [tenant, token, toast, en],
  );

  const resolve = useCallback(
    (resolution: LandlordResolution) => {
      setResolved((current) => ({ ...current, [resolution.propertyEntryId]: resolution }));
      const action = { label: en ? 'Undo' : 'تراجع', onClick: () => void undo(resolution) };
      if (resolution.kind === 'linked') {
        toast.success(en ? 'Owner linked' : 'تم ربط المالك', {
          description: en
            ? `${resolution.ownerName} is now the owner on this card, and the property is on their file.`
            : `أصبح ${resolution.ownerName} مالكاً على هذه البطاقة، وأُضيف العقار إلى ملفه.`,
          action,
          duration: 8000,
        });
      } else {
        toast.info(en ? 'Answer recorded' : 'سُجِّلت الإجابة', {
          description: en
            ? 'These people will not be offered on this card again. Someone registering later on the number still will be.'
            : 'لن يُقترح هؤلاء على هذه البطاقة مجدداً. من يُسجَّل لاحقاً على الرقم نفسه سيُقترح.',
          action,
          duration: 8000,
        });
      }
    },
    [toast, undo, en],
  );

  const clear = useCallback(() => setResolved({}), []);

  return { resolved, resolve, undo, undoing, clear };
}

/** The line a settled card leaves behind, with its undo. */
export function LandlordProposalResolved({
  resolution,
  onUndo,
  undoing,
  locale = 'ar',
}: {
  resolution: LandlordResolution;
  onUndo: () => void;
  undoing: boolean;
  locale?: string;
}) {
  const en = locale === 'en';
  const linked = resolution.kind === 'linked';

  return (
    <div
      role="status"
      className={cn(
        'flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-4 py-3 text-sm',
        linked ? 'border-success/40 bg-success/10' : 'bg-muted/20',
      )}
    >
      {linked ? (
        <Check className="size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <X className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className={cn('min-w-0 flex-1', !linked && 'text-muted-foreground')}>
        {linked
          ? en
            ? `Linked to ${resolution.ownerName}.`
            : `رُبطت بـ ${resolution.ownerName}.`
          : en
            ? 'Recorded: none of them is the owner.'
            : 'سُجِّل: ليس أحد منهم المالك.'}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onUndo}
        disabled={undoing}
        className={cn(PRESSABLE, 'h-9')}
      >
        {undoing ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Undo2 className="size-4" aria-hidden />
        )}
        {en ? 'Undo' : 'تراجع'}
      </Button>
    </div>
  );
}
