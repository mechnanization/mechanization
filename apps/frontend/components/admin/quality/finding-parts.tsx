'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { getLabels, type QualityFindingKind } from '@mechanization/shared-schemas';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ActionTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The parts «ملاحظات الجودة» shows in more than one place.
 *
 * The queue is a table, a finding opened from it is a page of its own, and a
 * conflict opened from either is a comparison — and all three carry the same
 * severity mark, the same three controls and the same sentence about what
 * «تم الحل» actually stores. Written once here so the row and the detail view
 * cannot drift into saying different things about the same finding.
 */

export const SEVERITY: Record<
  QualityFinding['severity'],
  { dot: string; text: string; ar: string; en: string }
> = {
  HIGH: { dot: 'bg-destructive', text: 'text-destructive', ar: 'يستحق النظر الآن', en: 'Look now' },
  MEDIUM: { dot: 'bg-warning', text: 'text-warning', ar: 'يستحق التحقق', en: 'Worth checking' },
  LOW: {
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    ar: 'نقص يُستكمل',
    en: 'A gap to fill',
  },
};

/**
 * The severity as a dot with its words beside it — never the dot alone.
 *
 * A colour is not a reading: «يستحق النظر الآن» and «نقص يُستكمل» are three
 * pixels apart for anyone who cannot tell red from grey, and they are the
 * difference between a duplicate person and an unmeasured flat.
 */
export function SeverityMark({
  severity,
  locale,
  withText = true,
}: {
  severity: QualityFinding['severity'];
  locale: string;
  withText?: boolean;
}): React.JSX.Element {
  const tone = SEVERITY[severity];
  const label = locale === 'en' ? tone.en : tone.ar;
  return (
    // `title` on the dot-only form: the words are already there for a screen
    // reader, and this puts them within reach of a mouse without spending a
    // tooltip — and a column of tooltips — on every row.
    <span className="inline-flex items-center gap-1.5" title={withText ? undefined : label}>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
      {withText ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}

/**
 * The evidence sentence, with the part that is actually wrong picked out.
 *
 * ## The two conventions the server's own sentences already follow
 *
 * Every `detail` the scans produce is built the same way, and reading them as
 * one shape is what lets this be a renderer rather than eight special cases:
 *
 *  - **An em dash separates the finding from what it means.** «… وعلى بطاقة
 *    المالك «RENTED» — الفوترة تقرأ الوحدة»، «… بلا مساحة — لم يُذكر سبب». What
 *    is before it is the conflict; what is after it is the consequence, or the
 *    screen that fixes it. So the head is the sentence and the tail is a
 *    second, quieter line — which is also what stops a queue row being three
 *    lines of equally loud text with the fact buried in the middle.
 *  - **Guillemets hold the values that disagree.** In the head, and only in the
 *    head: «روابط المالكين» in a tail is the name of a screen, not a conflict,
 *    and painting it red would be the highlight lying about which two values
 *    the reviewer has to choose between.
 *
 * ## Why the quoted values are translated here
 *
 * The scans put the raw column value in the sentence — «VACANT», «RENTED» — and
 * a raw enum is not shown to anybody anywhere else in this portal. Where the
 * quoted token is a value the register has a name for, the name is what shows;
 * anything else is printed exactly as the server wrote it.
 */
const valueName = (token: string, locale: string): string => {
  const labels = getLabels(locale);
  return (
    (labels.unitStatus as Record<string, string>)[token] ??
    (labels.occupancyType as Record<string, string>)[token] ??
    token
  );
};

/** The whole sentence as a reader would say it — for a `title`, which takes no markup. */
export function readableDetail(detail: string, locale: string): string {
  return detail.replace(/«([^»]*)»/g, (_match, token: string) => `«${valueName(token, locale)}»`);
}

export function FindingDetail({
  detail,
  locale,
  className,
  tail = true,
}: {
  detail: string;
  locale: string;
  className?: string;
  /**
   * Off in the queue, where the row is one line and the consequence is one of
   * the things «عرض التفاصيل» is for.
   */
  tail?: boolean;
}): React.JSX.Element {
  const [head, ...rest] = detail.split(' — ');
  const note = rest.join(' — ');

  /*
    An odd index is what sat inside the guillemets — `String.split` with a
    capturing group alternates literal, captured, literal.
  */
  const sentence = head!.split(/«([^»]*)»/g).map((part, index) =>
    index % 2 === 0 ? (
      <span key={index}>{part}</span>
    ) : (
      <span key={index} className="font-semibold text-destructive">
        «<bdi>{valueName(part, locale)}</bdi>»
      </span>
    ),
  );

  if (!tail) {
    /*
      One clipped line in the table, and the whole sentence in the phone card.

      `DataTable` swaps the table for a stack of cards below `sm`, and there the
      value sits in a narrow column with no header row to hover and no room to
      clip against: an ellipsis after four words is not a shorter sentence, it
      is no sentence. So it wraps there and truncates from `sm` up, where the
      hover title and «عرض التفاصيل» are both a pointer away.
    */
    return (
      <span
        className={cn('block whitespace-normal sm:truncate', className)}
        title={readableDetail(detail, locale)}
      >
        {sentence}
      </span>
    );
  }

  return (
    <span className={cn('block leading-relaxed', className)}>
      <span className="block">{sentence}</span>
      {note ? <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span> : null}
    </span>
  );
}

/** The record itself — a citizen's file, or a structure's unit matrix. */
export function subjectHref(subject: FindingSubject, base: string): string {
  return subject.kind === 'citizen'
    ? `${base}/citizens/${encodeURIComponent(subject.id)}`
    : `${base}/buildings/${encodeURIComponent(subject.id)}/matrix`;
}

/**
 * The two records a finding sets against each other, when it has two of one
 * kind.
 *
 * Only «شخص مسجَّل مرتين» and «مبانٍ متلاصقة» do: everything else names one
 * record, or names a structure *and* an occupant, and standing those two side
 * by side would line a building's floor count up against a mother's name. Those
 * findings send «الإجراء» to the record that has to change instead.
 */
export function comparablePairOf(
  finding: QualityFinding,
): { kind: 'citizen' | 'building'; a: FindingSubject; b: FindingSubject } | null {
  if (finding.subjects.length !== 2) return null;
  const [a, b] = finding.subjects as [FindingSubject, FindingSubject];
  if (a.kind !== b.kind) return null;
  return { kind: a.kind, a, b };
}

/**
 * Where a finding is actually put right.
 *
 * Nothing is fixed on this screen except the three fields a duplicate is
 * decided on — a missing entrance pin is set in the building editor, an owner
 * is linked in «روابط المالكين», and «سجل مشابه» is answered on the record's own
 * edit form, which is the only place somebody can say «شخص آخر» and have the
 * flag clear. Sending «الإجراء» anywhere else would be a button that looks like
 * it resolves something and does not.
 */
export function fixHref(finding: QualityFinding, base: string): string | null {
  const citizen = finding.subjects.find((subject) => subject.kind === 'citizen');
  const building = finding.subjects.find((subject) => subject.kind === 'building');

  switch (finding.kind) {
    case 'UNLINKED_LANDLORDS':
      return `${base}/citizens/landlord-links`;
    case 'HELD_AS_POSSIBLE_DUPLICATE':
    case 'OCCUPANT_HAS_LANDLORD_PHONE':
      return citizen ? `${base}/citizens/${encodeURIComponent(citizen.id)}/edit` : null;
    case 'BUILDING_WITHOUT_PIN':
      return building ? `${base}/buildings/${encodeURIComponent(building.id)}/edit` : null;
    case 'UNITS_WITHOUT_AREA':
    case 'UNIT_STATUS_CONTRADICTION':
      return building ? `${base}/buildings/${encodeURIComponent(building.id)}/matrix` : null;
    default:
      return citizen ? subjectHref(citizen, base) : building ? subjectHref(building, base) : null;
  }
}

/** What «الإجراء» does on this row, and what to call it. */
export function actionFor(
  finding: QualityFinding,
  base: string,
  locale: string,
): { mode: 'compare'; label: string } | { mode: 'open'; label: string; href: string } | null {
  const en = locale === 'en';
  if (comparablePairOf(finding)) {
    return { mode: 'compare', label: en ? 'Compare' : 'مقارنة' };
  }
  const href = fixHref(finding, base);
  if (!href) return null;
  return { mode: 'open', label: en ? 'Open the record' : 'فتح السجل', href };
}

/** One control, drawn as an icon in a row and as a labelled button anywhere else. */
function Control({
  label,
  icon: Icon,
  compact,
  tone = 'neutral',
  disabled = false,
  spin = false,
  hint,
  onClick,
  href,
}: {
  label: string;
  icon: LucideIcon;
  /** Icon only, with the label on hover and to a screen reader. */
  compact: boolean;
  /** `primary` for the row's main action — the one thing it is mostly for. */
  tone?: 'neutral' | 'primary';
  disabled?: boolean;
  /** Turns the icon — for the moment between pressing and the server answering. */
  spin?: boolean;
  /** Replaces the label in the tooltip — for a control that cannot be pressed. */
  hint?: string;
  onClick?: () => void;
  /** Renders as a link instead of a button. */
  href?: string;
}): React.JSX.Element {
  const button = compact ? (
    <Button
      asChild={Boolean(href) && !disabled}
      variant="outline"
      size="icon-sm"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(tone === 'primary' && 'border-primary/40 text-primary hover:bg-primary/5')}
    >
      {href && !disabled ? (
        <Link href={href}>
          <Icon className={cn('size-4', spin && 'animate-spin')} aria-hidden />
        </Link>
      ) : (
        <Icon className={cn('size-4', spin && 'animate-spin')} aria-hidden />
      )}
    </Button>
  ) : (
    <Button
      asChild={Boolean(href) && !disabled}
      variant={tone === 'primary' ? 'default' : 'outline'}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      /*
        `!w-auto`: `DataTable`'s phone card pins its action column to a footer
        that sizes every button inside it to a 36px square — right for the
        icon-only controls a row carries, and a clipped box around
        «عرض التفاصيل». The footer's rule is a descendant selector and would win
        on specificity whatever this set without the `!`.
      */
      className="h-9 gap-1.5 whitespace-nowrap px-2.5 !w-auto"
    >
      {href && !disabled ? (
        <Link href={href}>
          <Icon className={cn('size-3.5 shrink-0', spin && 'animate-spin')} aria-hidden />
          {label}
        </Link>
      ) : (
        <>
          <Icon className={cn('size-3.5 shrink-0', spin && 'animate-spin')} aria-hidden />
          {label}
        </>
      )}
    </Button>
  );

  // A disabled control swallows its own pointer events, so the tooltip has to
  // hang off a wrapper or it never opens — which is exactly the case where the
  // reader most needs to be told why.
  return (
    <ActionTooltip label={hint ?? label}>
      {disabled ? <span>{button}</span> : button}
    </ActionTooltip>
  );
}

/**
 * The three controls every finding carries, in the order the queue reads them:
 * look at it, close it, act on it.
 *
 * ## Icons in a row, words everywhere else
 *
 * `compact` is the table. Three labelled buttons in a row are a paragraph of
 * controls at the end of every line — they out-weigh the finding itself, and
 * eleven rows of them is the same three sentences read eleven times. As icons
 * they are what every other table in this portal puts in its action column
 * (`icon-sm`, outlined, tooltip + `aria-label`), and the words are still there
 * on hover and for a screen reader.
 *
 * The detail view is not compact: there is one finding on screen, the controls
 * sit in a footer with room, and an action somebody is about to take on a record
 * deserves to be named.
 *
 * «تم الحل» becomes «إعادة فتحها» once a finding has been closed rather than
 * sitting there disabled — the row still needs a way back, and two controls for
 * one state is one more than a row has width for.
 */
export function FindingActions({
  finding,
  base,
  locale,
  busy,
  onDetails,
  onResolve,
  onReopen,
  onCompare,
  showDetails = true,
  compact = false,
  className,
}: {
  finding: QualityFinding;
  base: string;
  locale: string;
  busy: boolean;
  onDetails: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onCompare: () => void;
  /** Off on the detail view itself, where it would only reopen the page you are on. */
  showDetails?: boolean;
  /** Icon-only. The table sets it; nothing else does. */
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const en = locale === 'en';
  const action = actionFor(finding, base, locale);

  return (
    /*
      One line, never a stack. `flex-nowrap` plus a shrink-to-fit column (`w-px`
      on the header) keeps the controls on the row's own line and lets the column
      ask the table for exactly the width they need. Below `sm` the table is a
      stack of cards and the controls get a full-width footer, so there they wrap.
    */
    <div className={cn('flex flex-wrap items-center gap-1.5 sm:flex-nowrap', className)}>
      {showDetails ? (
        <Control
          compact={compact}
          icon={Eye}
          label={en ? 'View details' : 'عرض التفاصيل'}
          onClick={onDetails}
        />
      ) : null}

      {finding.dismissal ? (
        <Control
          compact={compact}
          icon={busy ? Loader2 : Undo2}
          label={en ? 'Reopen' : 'إعادة فتحها'}
          disabled={busy}
          onClick={onReopen}
        />
      ) : (
        <Control
          compact={compact}
          icon={CheckCircle2}
          label={en ? 'Resolved' : 'تم الحل'}
          disabled={busy || !finding.dismissable}
          /*
            Not every finding can be closed by hand, and the ones that cannot are
            not disabled in the sense of "you lack a permission" — they close
            when the record they describe stops being wrong. The tooltip says
            which, because a greyed control with no explanation reads as a fault.
          */
          hint={
            finding.dismissable
              ? undefined
              : en
                ? 'Closes by fixing the record itself.'
                : 'تُغلَق بتصحيح السجل نفسه.'
          }
          onClick={onResolve}
        />
      )}

      {action?.mode === 'compare' ? (
        <Control
          compact={compact}
          icon={ArrowLeftRight}
          tone="primary"
          label={action.label}
          onClick={onCompare}
        />
      ) : action?.mode === 'open' ? (
        <Control
          compact={compact}
          icon={ExternalLink}
          tone="primary"
          label={action.label}
          href={action.href}
        />
      ) : null}
    </div>
  );
}

/**
 * «تم الحل» — and the reason, which is the only part of a finding that is ever
 * stored.
 *
 * A finding is recomputed from the register on every read, so a record that was
 * actually corrected drops out of the queue by itself. What this writes is the
 * other case: two genuine neighbours four metres apart, two cousins with one
 * name and one household phone — a standing answer that stops the scan asking
 * again. The dialog says so plainly, because a reviewer who presses it on a
 * record they mean to fix later has silenced the reminder, not fixed anything.
 *
 * The reason is required by the server (four characters), and required for a
 * better reason than validation: it is what the next reviewer reads instead of
 * re-deciding the same pair.
 */
export function ResolveDialog({
  finding,
  title,
  locale,
  open,
  onOpenChange,
  onConfirm,
}: {
  finding: QualityFinding | null;
  /** The finding's own headline, already localised by the caller. */
  title: string;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Awaited — the dialog stays open and busy until it settles. */
  onConfirm: (reason: string) => Promise<void>;
}): React.JSX.Element {
  const en = locale === 'en';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setReason('');
      setFailure(null);
    }
    onOpenChange(next);
  };

  const run = async () => {
    if (reason.trim().length < 4 || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      onOpenChange(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : en ? 'Not saved.' : 'لم يُحفظ.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle>{en ? 'Mark as resolved' : 'تعليم الملاحظة «تم الحل»'}</DialogTitle>
          <DialogDescription>
            {en
              ? 'This clears the finding from the queue and stores your reason against it.'
              : 'يرفع هذا الملاحظة من القائمة ويحفظ سببك معها.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-semibold">{title}</p>
            {finding ? (
              <FindingDetail detail={finding.detail} locale={locale} className="mt-1" />
            ) : null}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {en
              ? 'Findings are recomputed on every read — a record you actually correct leaves the queue on its own. Use this for the ones that are not a problem: two genuine neighbours, two cousins on one household phone.'
              : 'تُحتسب الملاحظات عند كل فتح للشاشة — فالسجل الذي يُصحَّح فعلاً يخرج من القائمة وحده. استعمل هذا لما ليس مشكلة: جاران حقيقيان، أو ابنا عم على هاتف منزل واحد.'}
          </p>

          <div className="space-y-1.5">
            <label htmlFor="resolve-reason" className="text-sm font-medium">
              {en ? 'Why is this settled?' : 'لماذا اعتُبرت محلولة؟'}
            </label>
            <Textarea
              id="resolve-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
              autoFocus
              placeholder={
                en
                  ? 'e.g. two separate houses, different families'
                  : 'مثال: بيتان منفصلان وعائلتان مختلفتان'
              }
            />
            <p className="text-xs text-muted-foreground">
              {en ? 'At least four characters.' : 'أربعة أحرف على الأقل.'}
            </p>
          </div>

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
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={() => close(false)}
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            className="w-full gap-1.5 sm:w-auto"
            disabled={busy || reason.trim().length < 4}
            onClick={run}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Mark resolved' : 'تم الحل'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The kinds whose findings name no record at all — the roll-ups. */
export const ROLLUP_KINDS: readonly QualityFindingKind[] = ['UNLINKED_LANDLORDS'];
