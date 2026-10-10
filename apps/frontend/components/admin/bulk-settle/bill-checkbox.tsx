'use client';

import { useTranslations } from 'next-intl';
import { BULK_SETTLE_MAX_BILLS } from '@mechanization/shared-schemas';
import type { BulkBlockReason } from '@/lib/bulk-settle';
import { Checkbox } from '@/components/ui/checkbox';
import { ActionTooltip } from '@/components/ui/tooltip';

/** What a box ticks: one bill, by its title, or every settleable bill on the page. */
export type BillCheckboxSubject =
  /** `name` where rows of several citizens share the list (/fees), so «رسم النفايات» says whose. */
  | { kind: 'row'; title: string; name?: string }
  | { kind: 'page'; allSelected: boolean };

/**
 * The box that ticks one bill — or a page of them — for «تسديد الفواتير
 * المحددة», on /fees and on the citizen file alike (UX-1).
 *
 * A box that may not be ticked is off and says why: the reason is in its
 * accessible name, read with it by a screen reader, and in a tooltip for a
 * mouse. The tooltip hangs off a wrapper because a disabled button takes no
 * pointer events. The sticky bar says the same once, for the whole list.
 */
export function BillCheckbox({
  subject,
  checked,
  blocked,
  onToggle,
  id,
}: {
  subject: BillCheckboxSubject;
  checked: boolean;
  /** Why it is off, or null when it may be pressed. */
  blocked: BulkBlockReason | null;
  onToggle: () => void;
  /** For a visible `<label htmlFor>` beside it. */
  id?: string;
}): React.JSX.Element {
  const t = useTranslations('bulkSettle.select');
  const tBlocked = useTranslations('bulkSettle.blocked');

  if (!blocked) {
    const label =
      subject.kind === 'row'
        ? subject.name
          ? t('rowOf', { title: subject.title, name: subject.name })
          : t('row', { title: subject.title })
        : subject.allSelected
          ? t('pageClear')
          : t('page');
    return <Checkbox id={id} checked={checked} onCheckedChange={onToggle} aria-label={label} />;
  }

  const reason = tBlocked(blocked, { max: BULK_SETTLE_MAX_BILLS });
  const label =
    subject.kind === 'page'
      ? t('pageBlocked', { reason })
      : subject.name
        ? t('rowOfBlocked', { title: subject.title, name: subject.name, reason })
        : t('rowBlocked', { title: subject.title, reason });
  return (
    <ActionTooltip label={reason}>
      <span className="inline-flex">
        <Checkbox id={id} checked={checked} disabled aria-label={label} />
      </span>
    </ActionTooltip>
  );
}
