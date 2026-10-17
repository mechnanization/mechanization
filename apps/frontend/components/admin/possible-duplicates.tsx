'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, CloudOff, ExternalLink, GitMerge, ShieldAlert, UsersRound } from 'lucide-react';
import {
  duplicateMatchedOnLabels,
  type PossibleDuplicateMatch,
} from '@mechanization/shared-schemas';
import { checkPossibleDuplicates, logApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { RecordKindBadge } from '@/components/admin/record-kind-badge';
import { Button, buttonVariants } from '@/components/ui/button';

const DEBOUNCE_MS = 500;
const MAX_SHOWN = 5;

/**
 * «قد يكون مسجَّلاً مسبقاً» — people already on file who match what is being typed.
 *
 * ## Asked by the save's own rule, not the search box
 *
 * Until 2026-09-28 this ran the register's search: the first name and family
 * name as two words, each allowed to appear anywhere in a row's folded text —
 * which holds the father's and the mother's names too. «حسين وطفى» offered
 * «ابراهيم حسين برو» (حسين his father, وطفى his mother's family) beside three
 * other people the save's check would never have asked about. Now it asks the
 * server the save's own question (`isLikelySamePerson`) with everything typed
 * so far — father's name, mother, phone, رقم السجل, رقم الإقامة — and shows only
 * who the save would stop on, each with the facts that agreed.
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
 * `usePossibleDuplicates` asks; `DuplicateAlert` only shows, in the form's
 * sticky step bar on every step and every screen size.
 */
export interface DuplicateCheck {
  matches: PossibleDuplicateMatch[];
  /** The lookup could not reach the register — see `usePossibleDuplicates`. */
  failed: boolean;
}

/**
 * Looks the typed name and phone up in the register, debounced.
 *
 * It runs on a correction as well as a new filing, with the open file itself
 * dropped from its own matches (`excludeId`): an officer correcting a surname,
 * or adding the phone the household actually answers on, is doing the very
 * thing that turns two files into recognisable duplicates.
 *
 * A null `token` asks nothing and answers nothing, without breaking the rules
 * of hooks — which is how a caller with no session switches it off.
 */
export function usePossibleDuplicates({
  tenant,
  token,
  firstName,
  middleName,
  lastName,
  motherName,
  civilRecordNumber,
  residencyNumber,
  gender,
  isLebanese,
  unitIds,
  phone,
  whatsapp,
  excludeId,
}: {
  tenant: string;
  token: string | null | undefined;
  firstName: unknown;
  /** اسم الأب — what tells two cousins of one name apart. */
  middleName?: unknown;
  lastName: unknown;
  /** Two records naming different mothers are two people; the same one counts toward one. */
  motherName?: unknown;
  /** رقم السجل and رقم الإقامة — facts that add up with a name that already agrees. */
  civilRecordNumber?: unknown;
  residencyNumber?: unknown;
  /** Facts that say «two people» when they disagree. */
  gender?: unknown;
  isLebanese?: unknown;
  /** The flats the cards being typed name: the same door, filed twice. */
  unitIds?: ReadonlyArray<unknown>;
  phone: unknown;
  /** The WhatsApp number, only when it is a different number from `phone`. */
  whatsapp?: unknown;
  /**
   * The file this form is editing, dropped from its own matches.
   *
   * Without it the panel opens on every edit announcing that the person on
   * screen may already be registered — as themselves. A warning that is wrong
   * every single time is one officers learn to close without reading, which
   * costs the panel the record where it was right (§8.6 is the same lesson from
   * a flaky test).
   */
  excludeId?: string;
}): DuplicateCheck {
  const [matches, setMatches] = useState<PossibleDuplicateMatch[]>([]);
  /**
   * The lookup could not reach the register.
   *
   * Kept apart from "no matches" because the two used to render as the same
   * nothing. Field officers file households with no signal, and a panel that
   * silently shows no duplicates when it could not look is a check that
   * reports "clean" exactly when it did not run.
   */
  const [failed, setFailed] = useState(false);

  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const first = text(firstName);
  const last = text(lastName);
  const middle = text(middleName);
  const mother = text(motherName);
  const civil = text(civilRecordNumber);
  const permit = text(residencyNumber);
  const sex = gender === 'MALE' || gender === 'FEMALE' ? gender : undefined;
  const lebanese = typeof isLebanese === 'boolean' ? isLebanese : undefined;
  // A string, so the effect below re-asks only when the set of flats changes.
  const flats = [...new Set((unitIds ?? []).filter((id): id is string => typeof id === 'string' && Boolean(id)))]
    .sort()
    .join(',');
  const name = first.length >= 2 && last.length >= 2;

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
      const optional = (value: string) => value || undefined;
      checkPossibleDuplicates(tenant, token, {
        firstName: optional(first),
        middleName: optional(middle),
        lastName: optional(last),
        motherName: optional(mother),
        civilRecordNumber: optional(civil),
        residencyNumber: optional(permit),
        gender: sex,
        isLebanese: lebanese,
        unitIds: flats ? flats.split(',') : undefined,
        phone: optional(digits),
        whatsapp: optional(whatsappDigits),
        excludeId,
      })
        .then((found) => {
          if (cancelled) return;
          setMatches(found.slice(0, MAX_SHOWN));
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
  }, [tenant, token, name, first, middle, last, mother, civil, permit, sex, lebanese, flats, digits, whatsappDigits, excludeId]);

  return { matches, failed };
}

/** «عقار واحد», «عقاران», «٣ عقارات», «١١ عقاراً», «لا عقارات» — the count agrees with its noun. */
function propertiesAr(count: number): string {
  if (count <= 0) return 'لا عقارات';
  if (count === 1) return 'عقار واحد';
  if (count === 2) return 'عقاران';
  if (count <= 10) return `${count} عقارات`;
  return `${count} عقاراً`;
}

function propertiesEn(count: number): string {
  if (count <= 0) return 'no properties';
  return `${count} propert${count === 1 ? 'y' : 'ies'}`;
}

/**
 * A match's own file, under whichever `/citizens/…` route this form is on.
 *
 * Anchored at `/citizens/` and told to drop everything after it, because the
 * form renders on three: `citizens/new`, `citizens/<id>/edit` and
 * `citizens/queue/<id>`.
 */
function useFileHref(): (id: string) => string {
  const pathname = usePathname();
  return (id) => pathname.replace(/(\/citizens)\/.*$/, `$1/${encodeURIComponent(id)}`);
}

/** One person already on file: who they are, what agreed, and where to go. */
function MatchRow({
  match,
  locale,
  href,
  onMerge,
}: {
  match: PossibleDuplicateMatch;
  locale: string;
  href: string;
  onMerge?: (match: PossibleDuplicateMatch) => void;
}) {
  const en = locale === 'en';
  const agreed = duplicateMatchedOnLabels(locale);

  return (
    <li
      className={cn(
        'rounded-lg border bg-card p-2.5 sm:p-3',
        match.certain ? 'border-destructive/40' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{match.fullName}</span>
            {match.certain ? (
              <Badge variant="soft-destructive">{en ? 'Same person' : 'الشخص نفسه'}</Badge>
            ) : null}
            <RecordKindBadge residence={match.residence} locale={locale} />
          </p>

          {/*
            What tells two people of one name apart, in the order a clerk checks
            it. A fact the file does not hold is left out rather than shown as
            «—», which would read as a difference between the two.
          */}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {match.motherName ? <span>{en ? `Mother: ${match.motherName}` : `والدته: ${match.motherName}`}</span> : null}
            {match.phone ? (
              <span dir="ltr" className="tabular-nums">
                {formatPhone(match.phone)}
              </span>
            ) : null}
            <span>{en ? propertiesEn(match.propertyCount) : propertiesAr(match.propertyCount)}</span>
            {match.registeredAt ? (
              <span>
                {en
                  ? `Filed ${formatDate(match.registeredAt)}${match.registeredBy ? ` by ${match.registeredBy}` : ''}`
                  : `سُجِّل ${formatDate(match.registeredAt)}${match.registeredBy ? ` — ${match.registeredBy}` : ''}`}
              </span>
            ) : null}
          </p>

          <p className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-muted-foreground">{en ? 'Agrees on:' : 'متطابق في:'}</span>
            {match.matchedOn.map((fact) => (
              <Badge key={fact} variant="soft-muted" className="px-1.5 py-0 text-[11px] font-medium">
                {agreed[fact]}
              </Badge>
            ))}
          </p>
        </div>

        <div className="flex w-full shrink-0 gap-1.5 sm:w-auto">
          <Link
            href={href}
            target="_blank"
            rel="noopener"
            className={cn(
              buttonVariants({ variant: match.certain ? 'default' : 'outline', size: 'sm' }),
              'h-9 flex-1 gap-1.5 text-xs sm:flex-none',
            )}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {en ? 'Open file' : 'فتح الملف'}
            <span className="sr-only">{en ? ` of ${match.fullName}, in a new tab` : ` ${match.fullName}، في تبويب جديد`}</span>
          </Link>
          {onMerge ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 flex-1 gap-1.5 text-xs sm:flex-none"
              onClick={() => onMerge(match)}
            >
              <GitMerge className="size-3.5" aria-hidden />
              {en ? 'Merge' : 'دمج'}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * «قد يكون مسجَّلاً مسبقاً», on every step of the form.
 *
 * ## Where it lives
 *
 * In the sticky step bar, on every screen size. It used to be two things: a
 * panel under الهاتف in step ٢ on a desktop, and this bar on phones and
 * tablets. An officer types the name in step ١ — where most matches are found
 * — and the property in step ٣, where the duplicate is actually made; a
 * warning that existed only beside the phone field was one most officers never
 * saw. The step bar is on screen at every step and every scroll position.
 *
 * ## How loud it is
 *
 *  - **Certain** (`certain`: the save will refuse a new file): the destructive
 *    tone, a sentence that says so, and «فتح الملف» as the first thing on it —
 *    the way on is the file on record, not the rest of this form.
 *  - **Possible**: the warning tone, and a question.
 *  - **Could not check** (no connection): muted, one line. It is true of every
 *    record typed offline, and it says so rather than rendering as «clean».
 *
 * ## Why it folds itself
 *
 * A sticky bar that holds five cards eats the screen the officer is typing on,
 * and can sit over the very field they are in (WCAG 2.4.11). So the list
 * opens when the matches change — new information — and folds to its one-line
 * summary when the officer moves to another field. Folded, it keeps its tone,
 * its count and its primary action; it is never hidden while a match stands.
 *
 * One live region carries the summary, so a screen reader hears «هذا الشخص
 * مسجَّل مسبقاً» once, not the whole list on every keystroke.
 */
export function DuplicateAlert({
  check,
  locale,
  mode,
  canOverride = false,
  onMerge,
  className,
}: {
  check: DuplicateCheck;
  locale: string;
  mode: 'create' | 'edit';
  /** SUPER_ADMIN: the save does not refuse them, it asks for a reason. */
  canOverride?: boolean;
  /** An administrator editing a saved file — «دمج» on each match. */
  onMerge?: (match: PossibleDuplicateMatch) => void;
  className?: string;
}) {
  const en = locale === 'en';
  const fileHref = useFileHref();
  const rootRef = useRef<HTMLDivElement>(null);
  const matchKey = check.matches.map((match) => match.id).join(',');
  /** The match set the officer folded (or moved away from). Any other set opens again. */
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  const open = foldedFor !== matchKey;
  const listId = useId();

  // Moving to another field folds the list, so it never sits over what is being typed.
  useEffect(() => {
    if (!open || !matchKey) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || rootRef.current?.contains(target)) return;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) setFoldedFor(matchKey);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [open, matchKey]);

  if (check.failed) {
    return (
      <p
        role="status"
        className={cn(
          'flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed',
          className,
        )}
      >
        <CloudOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          <span className="font-semibold">
            {en ? 'Could not check for an existing file.' : 'تعذّر التحقق من وجود ملف سابق.'}
          </span>{' '}
          <span className="text-muted-foreground">
            {en
              ? 'Search for this person once you have a connection, before saving a new file.'
              : 'ابحث عن هذا الشخص عند عودة الاتصال، قبل حفظ ملف جديد.'}
          </span>
        </span>
      </p>
    );
  }

  if (check.matches.length === 0) return null;

  const certain = check.matches.filter((match) => match.certain);
  const first = certain[0] ?? null;
  const tone = certain.length > 0 ? 'certain' : 'possible';
  const count = check.matches.length;

  const headline =
    tone === 'certain'
      ? mode === 'edit'
        ? en
          ? `${first!.fullName} is very likely this same person`
          : `${first!.fullName} على الأرجح الشخص نفسه`
        : en
          ? `Already registered: ${first!.fullName}`
          : `مسجَّل مسبقاً: ${first!.fullName}`
      : en
        ? `Possibly already registered — ${count} similar file${count === 1 ? '' : 's'}`
        : `قد يكون مسجَّلاً مسبقاً — ${count === 1 ? 'ملف مشابه' : count === 2 ? 'ملفان مشابهان' : `${count} ملفات مشابهة`}`;

  const guidance =
    tone === 'certain'
      ? mode === 'edit'
        ? en
          ? 'Two files for one person. An administrator merges them; correct this file only if it is wrong.'
          : 'ملفان لشخص واحد. يدمجهما مدير النظام؛ ولا تصحّح هذا الملف إلا إن كان خاطئاً.'
        : canOverride
          ? en
            ? 'A new file will be refused for an officer. As an administrator you may still file it as a different person, with a reason.'
            : 'يُرفض الملف الجديد لأي موظف. بصفتك مدير النظام يمكنك حفظه كشخص مختلف مع ذكر السبب.'
          : en
            ? 'A new file will be refused. Open their file and add the property to it instead.'
            : 'لن يُقبل ملف جديد. افتح ملفه وأضف العقار إليه بدلاً من ذلك.'
      : en
        ? 'If it is the same person, add the property to their file instead of creating a new one. Open the file and check.'
        : 'إن كان الشخص نفسه فأضف العقار إلى ملفه بدل إنشاء ملف جديد. افتح الملف وتحقَّق.';

  const Icon = tone === 'certain' ? ShieldAlert : UsersRound;

  return (
    <div
      ref={rootRef}
      className={cn(
        'rounded-lg border text-xs shadow-sm',
        tone === 'certain' ? 'border-destructive/40 bg-destructive/10' : 'border-warning/40 bg-warning/10',
        className,
      )}
    >
      {/* The one live region: the summary, said once when it changes. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {headline}. {guidance}
      </p>

      <div className="flex min-h-11 items-center gap-2 px-2.5 py-1.5 sm:px-3">
        <Icon
          className={cn('size-4 shrink-0', tone === 'certain' ? 'text-destructive' : 'text-warning')}
          aria-hidden
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setFoldedFor(open ? matchKey : null)}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span
            className={cn(
              'min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-snug sm:line-clamp-1',
              tone === 'certain' ? 'text-destructive' : 'text-warning',
            )}
          >
            {headline}
          </span>
          {count > 1 ? (
            <span className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-xs font-bold tabular-nums">
              {count}
            </span>
          ) : null}
          <span className="hidden shrink-0 text-xs font-medium text-muted-foreground sm:inline">
            {open ? (en ? 'Hide' : 'إخفاء') : en ? 'Details' : 'التفاصيل'}
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
        {/*
          Folded, a certain match keeps its one action on the line itself: the
          file to add the property to is the whole answer.
        */}
        {first && !open ? (
          <Link
            href={fileHref(first.id)}
            target="_blank"
            rel="noopener"
            className={cn(buttonVariants({ size: 'sm' }), 'h-8 shrink-0 gap-1.5 text-xs')}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {en ? 'Open file' : 'فتح ملفه'}
          </Link>
        ) : null}
      </div>

      {/* Height eased rather than snapped; still under reduced motion. */}
      <div
        id={listId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-[30dvh] space-y-2 sm:max-h-[38dvh] overflow-y-auto border-t border-border/60 px-2.5 pb-2.5 pt-2 sm:px-3">
            <p className="leading-relaxed text-foreground/80">{guidance}</p>
            <ul className="space-y-1.5">
              {check.matches.map((match) => (
                <MatchRow
                  key={match.id}
                  match={match}
                  locale={locale}
                  href={fileHref(match.id)}
                  onMerge={onMerge}
                />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
