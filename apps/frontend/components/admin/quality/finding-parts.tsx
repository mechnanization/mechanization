'use client';

import { useTranslations } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
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

export const SEVERITY: Record<QualityFinding['severity'], { dot: string; text: string }> = {
  HIGH: { dot: 'bg-destructive', text: 'text-destructive' },
  MEDIUM: { dot: 'bg-warning', text: 'text-warning' },
  LOW: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
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
  withText = true,
}: {
  severity: QualityFinding['severity'];
  withText?: boolean;
}): React.JSX.Element {
  const t = useTranslations('qualityFindings.severity');
  const tone = SEVERITY[severity];
  const label = t(severity);
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
