'use client';

import { useTranslations } from 'next-intl';
import { formatRelative } from '@/lib/dates';
import { CellTag } from '@/components/ui/cell-tag';

/**
 * «متصل الآن», or «غير متصل» with «آخر ظهور» — one staff account's presence.
 *
 * `online` is decided by the caller on the server's clock (`useStaffPresence`),
 * and a disabled account is never online whatever its stamp says: deactivation
 * revokes every session, so a fresh stamp on one only means it was disabled
 * moments ago. «آخر ظهور» is relative to the same clock (`now`).
 */
export function PresenceCell({
  online,
  lastSeenAt,
  now,
  locale,
}: {
  online: boolean;
  lastSeenAt: string | null;
  now: number;
  locale: string;
}) {
  const t = useTranslations('staff.presence');

  if (online) {
    return (
      <CellTag tone="success">
        <span className="size-2 rounded-full bg-current" aria-hidden />
        {t('online')}
      </CellTag>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <CellTag tone="muted">
        <span className="size-2 rounded-full bg-current opacity-60" aria-hidden />
        {t('offline')}
      </CellTag>
      {lastSeenAt ? (
        <span className="truncate text-xs text-muted-foreground" title={t('lastSeen')}>
          {formatRelative(lastSeenAt, locale, now)}
        </span>
      ) : null}
    </div>
  );
}
