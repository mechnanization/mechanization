'use client';

import { useTranslations } from 'next-intl';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';

/**
 * The damage history could not be read (ERR-02).
 *
 * The matrix and its drawer load the building and its damage log together, and
 * a failed damage read must not take the units down with it. But an empty log
 * reads as an undamaged building, which is a claim: this says the log is
 * missing instead, with a retry that re-reads the log alone.
 */
export function DamageReadFailed({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslations('damage.readFailed');
  return <RefreshFailedAlert title={t('title')} message={t('message')} onRetry={onRetry} />;
}
