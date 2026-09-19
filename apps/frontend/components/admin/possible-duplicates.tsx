'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, CloudOff, ExternalLink, UsersRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { listCitizens, logApiError, type CitizenListItem } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

const DEBOUNCE_MS = 500;
const MAX_SHOWN = 5;

/**
 * «قد يكون مسجَّلاً مسبقاً» — people already on file who match what is being typed.
 *
 * ## Why this exists now
 *
 * The identity document used to be what recognised a returning person, and it
 * did so by *merging*: a repeated number wrote the new filing over the old
 * citizen. That merge is gone (a filing never overwrites anyone), and so is the
 * document for a Lebanese citizen. What is left to recognise a duplicate is a
 * person looking at a name and a phone number — so the form shows them the
 * matches while they type, rather than after a second record exists.
 *
 * It only ever **shows**. Nothing is linked or merged from here: a phone is
 * shared by a household and a name by cousins, so the officer opens the match
 * (in a new tab, so the form in progress survives) and decides. Registering the
 * same person again is recoverable; merging two people is not.
 *
 * ## What makes a row decidable
 *
 * اسم الأم وشهرتها, since migration 0044. Two «محمد خليل»s with a shared
 * household line were, until then, two rows this panel could show and nobody
 * could choose between — which is the failure mode of a warning that cannot be
 * acted on: it gets dismissed on the tenth record, including the one where it
 * was right.
 *
 * Printed only where the register holds it. A «والدته: —» beside a row that
 * names a mother reads as a difference between two people, when all it records
 * is that one file was opened before the field existed.
 *
 * ## One lookup, two ways of showing it
 *
 * `usePossibleDuplicates` asks; `PossibleDuplicatesPanel` and
 * `PossibleDuplicatesBar` only show. The form runs the lookup once and hands
 * the answer to whichever of the two the screen size calls for, so a phone
 * does not query the register twice for one keystroke. See the bar for why
 * phones and tablets get a different one.
 */
export interface DuplicateCheck {
  matches: CitizenListItem[];
  /** The lookup could not reach the register — see `usePossibleDuplicates`. */
  failed: boolean;
}

/**
 * Looks the typed name and phone up in the register, debounced.
 *
 * A null `token` asks nothing and answers nothing, which is how the edit form
 * — where every match is the open file itself — switches it off without
 * breaking the rules of hooks.
 */
export function usePossibleDuplicates({
  tenant,
  token,
  firstName,
  lastName,
  phone,
  whatsapp,
}: {
  tenant: string;
  token: string | null | undefined;
  firstName: unknown;
  lastName: unknown;
  phone: unknown;
  /** The WhatsApp number, only when it is a different number from `phone`. */
  whatsapp?: unknown;
}): DuplicateCheck {
  const [matches, setMatches] = useState<CitizenListItem[]>([]);
  /**
   * The lookup could not reach the register.
   *
   * Kept apart from "no matches" because the two used to render as the same
   * nothing. Field officers file households with no signal, and a panel that
   * silently shows no duplicates when it could not look is a check that
   * reports "clean" exactly when it did not run.
   */
  const [failed, setFailed] = useState(false);

  const name = useMemo(() => {
    const first = typeof firstName === 'string' ? firstName.trim() : '';
    const last = typeof lastName === 'string' ? lastName.trim() : '';
    return first.length >= 2 && last.length >= 2 ? `${first} ${last}` : '';
  }, [firstName, lastName]);

  const digits = useMemo(() => {
    const raw = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
    return raw.length >= 6 ? raw : '';
  }, [phone]);

  // A WhatsApp number of its own is a second number somebody may already answer on.
  const whatsappDigits = useMemo(() => {
    const raw = typeof whatsapp === 'string' ? whatsapp.replace(/\D/g, '') : '';
    return raw.length >= 6 && raw !== digits ? raw : '';
  }, [whatsapp, digits]);

  useEffect(() => {
    if (!token || (!name && !digits)) {
      setMatches([]);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const searches = [name, digits, whatsappDigits]
        .filter(Boolean)
        .map((search) => listCitizens(tenant, token, { search, limit: MAX_SHOWN }));

      Promise.all(searches)
        .then((results) => {
          if (cancelled) return;
          const byId = new Map<string, CitizenListItem>();
          for (const result of results) {
            for (const item of result.items) byId.set(item.id, item);
          }
          setMatches([...byId.values()].slice(0, MAX_SHOWN));
          setFailed(false);
        })
        .catch((caught) => {
          // Never a reason to stop somebody saving a household — but said, so
          // an empty panel is not read as "nobody like this is on file".
          logApiError(caught);
          if (!cancelled) {
            setMatches([]);
            setFailed(true);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tenant, token, name, digits, whatsappDigits]);

  return { matches, failed };
}

const COULD_NOT_CHECK = {
  en: 'Could not check for an existing record.',
  ar: 'تعذّر التحقق من وجود ملف سابق.',
};
const HEADLINE = { en: 'Possibly already registered', ar: 'قد يكون مسجَّلاً مسبقاً' };
const EXPLANATION = {
  en: 'Same name or phone. If it is the same person, add the property to their file instead of creating a new one. A shared phone or a common name is not proof — open the file and check.',
  ar: 'الاسم أو الهاتف نفسه. إن كان الشخص نفسه فأضف العقار إلى ملفه بدل إنشاء ملف جديد. الهاتف المشترك أو الاسم المتكرر ليس دليلاً — افتح الملف وتحقَّق.',
};

/** The matches themselves, each opening its file in a new tab. */
function MatchList({ matches, locale }: { matches: CitizenListItem[]; locale: string }) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const pathname = usePathname();
  const fileHref = (id: string) =>
    pathname.replace(/\/citizens\/new(\/.*)?$/, `/citizens/${encodeURIComponent(id)}`);

  return (
    <ul className="space-y-1">
      {matches.map((match) => (
        <li key={match.id}>
          <Link
            href={fileHref(match.id)}
            target="_blank"
            rel="noopener"
            className="flex min-h-9 flex-wrap items-center gap-2 rounded-md bg-background/70 px-2.5 py-1.5 hover:bg-background"
          >
            <span className="font-medium">{match.fullName}</span>
            {match.motherName ? (
              <span className="text-muted-foreground">
                {en ? `mother: ${match.motherName}` : `والدته: ${match.motherName}`}
              </span>
            ) : null}
            {match.phone ? (
              <span dir="ltr" className="text-muted-foreground">
                {match.phone}
              </span>
            ) : null}
            {match.residence === 'NON_RESIDENT_OWNER' ? (
              <Badge variant="soft-info">{labels.citizenResidence.NON_RESIDENT_OWNER}</Badge>
            ) : null}
            <span className="text-muted-foreground">
              {en
                ? `${match.propertyCount} propert${match.propertyCount === 1 ? 'y' : 'ies'}`
                : `${match.propertyCount} عقار`}
            </span>
            <ExternalLink className="ms-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The panel in place, under the phone number it is mostly about.
 *
 * For a desktop, where the whole form is on screen at once and the panel is in
 * view from the name fields too. Phones and tablets get the bar instead.
 */
export function PossibleDuplicatesPanel({
  check,
  locale,
  className,
}: {
  check: DuplicateCheck;
  locale: string;
  className?: string;
}) {
  const en = locale === 'en';

  if (check.failed) {
    return (
      <div
        role="status"
        className={cn(
          'flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs',
          className,
        )}
      >
        <CloudOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="leading-relaxed">
          <span className="font-semibold">{en ? COULD_NOT_CHECK.en : COULD_NOT_CHECK.ar}</span>{' '}
          <span className="text-muted-foreground">
            {en
              ? 'The register could not be reached. If this person may already be on file, search for them once you have a connection before saving a new record.'
              : 'لم يُتح الوصول إلى السجل. إن كان هذا الشخص قد يكون مسجَّلاً فابحث عنه عند توفّر الاتصال قبل حفظ ملف جديد.'}
          </span>
        </p>
      </div>
    );
  }

  if (check.matches.length === 0) return null;

  return (
    <div
      role="status"
      className={cn('space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs', className)}
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <UsersRound className="size-3.5 shrink-0" aria-hidden />
        {en ? HEADLINE.en : HEADLINE.ar}
      </p>
      <p className="leading-relaxed text-muted-foreground">{en ? EXPLANATION.en : EXPLANATION.ar}</p>
      <MatchList matches={check.matches} locale={locale} />
    </div>
  );
}

/**
 * The same warning, pinned to the bar that never scrolls away.
 *
 * ## Why phones and tablets get this instead of the panel
 *
 * The panel lives under الهاتف, in step ٢. On a phone the form is a wizard, so
 * an officer typing a name in step ١ — which is where most matches are found —
 * could not see it at all, and neither could anyone in step ٣, which is where
 * the duplicate actually gets made. On a tablet every section is on one page,
 * but the page is long, and the panel has usually been scrolled past before
 * the register has answered. A warning that only exists while one field is on
 * screen is one most officers never saw.
 *
 * So below `lg` it sits in the sticky header — the step pills on a phone, the
 * section nav on a tablet — which is on screen on every step and at every
 * scroll position.
 *
 * ## Why it opens itself
 *
 * A pinned header cannot hold five rows of matches permanently without eating
 * the screen the form is typed on, so the officer can fold it to its one-line
 * headline. What it cannot be is folded *in advance*: it opens by itself
 * whenever the set of matches changes, because a new match is new information
 * and whoever folded the last list has not seen this one. Folded, it keeps its
 * warning colour and its count, and it is never hidden.
 *
 * «تعذّر التحقق» is shown here too, as one line. Offline that is on every
 * record — and it is true of every record: none of them was checked.
 */
export function PossibleDuplicatesBar({
  check,
  locale,
  className,
}: {
  check: DuplicateCheck;
  locale: string;
  className?: string;
}) {
  const en = locale === 'en';
  const matchKey = check.matches.map((match) => match.id).join(',');
  /** The match set the officer folded. Any other set opens again. */
  const [foldedFor, setFoldedFor] = useState<string | null>(null);

  if (check.failed) {
    return (
      <p
        role="status"
        className={cn(
          'flex items-start gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-xs leading-relaxed',
          className,
        )}
      >
        <CloudOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          <span className="font-semibold">{en ? COULD_NOT_CHECK.en : COULD_NOT_CHECK.ar}</span>{' '}
          <span className="text-muted-foreground">
            {en ? 'Search for them once back online, before saving.' : 'ابحث عنه عند عودة الاتصال، قبل الحفظ.'}
          </span>
        </span>
      </p>
    );
  }

  if (check.matches.length === 0) return null;

  const open = foldedFor !== matchKey;

  return (
    <div
      role="status"
      className={cn('rounded-lg border border-warning/50 bg-warning/15 text-xs', className)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setFoldedFor(open ? matchKey : null)}
        className="flex min-h-10 w-full items-center gap-1.5 px-2.5 py-1.5 text-start font-semibold"
      >
        <UsersRound className="size-3.5 shrink-0" aria-hidden />
        <span className="flex-1">{en ? HEADLINE.en : HEADLINE.ar}</span>
        <span className="rounded-full bg-warning/25 px-1.5 py-0.5 text-[10px] font-bold">
          {check.matches.length}
        </span>
        <span className="text-[11px] font-medium text-muted-foreground">
          {open ? (en ? 'Hide' : 'إخفاء') : en ? 'Show' : 'عرض'}
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="max-h-[40vh] space-y-2 overflow-y-auto border-t border-warning/30 px-2.5 pb-2.5 pt-2">
          <p className="leading-relaxed text-muted-foreground">{en ? EXPLANATION.en : EXPLANATION.ar}</p>
          <MatchList matches={check.matches} locale={locale} />
        </div>
      ) : null}
    </div>
  );
}
