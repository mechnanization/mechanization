import { getLabels, type TreasuryDayStatus } from '@mechanization/shared-schemas';
import { Badge, type BadgeProps } from '@/components/ui/badge';

/**
 * Open, closed, or opened again — the word on a soft tint (PRIM-9), never the
 * colour alone (COL-3). Closed is `success` (settled, COL-2); reopened is
 * `warning`, because a day the manager unlocked is waiting for someone to close
 * it again; open is `muted`, the ordinary state of every day still running.
 */
const VARIANT: Record<TreasuryDayStatus, NonNullable<BadgeProps['variant']>> = {
  OPEN: 'soft-muted',
  CLOSED: 'soft-success',
  REOPENED: 'soft-warning',
};

export function DayStatusBadge({
  status,
  locale,
  className,
}: {
  status: TreasuryDayStatus;
  locale: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Badge variant={VARIANT[status]} className={className}>
      {getLabels(locale).treasuryDayStatus[status]}
    </Badge>
  );
}
