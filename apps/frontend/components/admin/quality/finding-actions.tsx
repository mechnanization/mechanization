'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { QualityFinding } from '@/lib/quality-api';
import { Button } from '@/components/ui/button';
import { ActionTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { comparablePairOf, subjectHref } from './finding-parts';

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
    // Keyed by the unit: the matrix opens on it, where «توزيع الرسم على المالكين» is chosen.
    case 'OWNER_BILLING_BLOCKED':
    case 'OWNER_SHARES_INCOMPLETE':
      return building
        ? `${base}/buildings/${encodeURIComponent(building.id)}/matrix?unit=${encodeURIComponent(finding.subjectKey)}`
        : null;
    // UNINHABITED_WITHOUT_READING: the reading is recorded from the matrix («كشف ضرر على المبنى»).
    case 'UNITS_WITHOUT_AREA':
    case 'UNIT_STATUS_CONTRADICTION':
    case 'UNIT_UNDER_REVIEW':
    case 'UNINHABITED_WITHOUT_READING':
      return building ? `${base}/buildings/${encodeURIComponent(building.id)}/matrix` : null;
    default:
      return citizen ? subjectHref(citizen, base) : building ? subjectHref(building, base) : null;
  }
}

/** What «الإجراء» does on this row, and what to call it. */
export function actionFor(
  finding: QualityFinding,
  base: string,
): { mode: 'compare' } | { mode: 'open'; href: string } | null {
  if (comparablePairOf(finding)) return { mode: 'compare' };
  const href = fixHref(finding, base);
  return href ? { mode: 'open', href } : null;
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
  const t = useTranslations('qualityFindings.actions');
  const action = actionFor(finding, base);

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
          label={t('details')}
          onClick={onDetails}
        />
      ) : null}

      {finding.dismissal ? (
        <Control
          compact={compact}
          icon={busy ? Loader2 : Undo2}
          label={t('reopen')}
          disabled={busy}
          onClick={onReopen}
        />
      ) : (
        <Control
          compact={compact}
          icon={CheckCircle2}
          label={t('resolve')}
          disabled={busy || !finding.dismissable}
          /*
            Not every finding can be closed by hand, and the ones that cannot are
            not disabled in the sense of "you lack a permission" — they close
            when the record they describe stops being wrong. The tooltip says
            which, because a greyed control with no explanation reads as a fault.
          */
          hint={finding.dismissable ? undefined : t('closesByFixing')}
          onClick={onResolve}
        />
      )}

      {action?.mode === 'compare' ? (
        <Control
          compact={compact}
          icon={ArrowLeftRight}
          tone="primary"
          label={t('compare')}
          onClick={onCompare}
        />
      ) : action?.mode === 'open' ? (
        <Control
          compact={compact}
          icon={ExternalLink}
          tone="primary"
          label={t('open')}
          href={action.href}
        />
      ) : null}
    </div>
  );
}
