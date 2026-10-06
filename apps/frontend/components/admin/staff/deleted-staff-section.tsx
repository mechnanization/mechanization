'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getDeletedStaff,
  logApiError,
  restoreStaff,
  type DeletedStaffSummary,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/**
 * «الموظفون المحذوفون» — deleted accounts, kept with their history and
 * restorable. Read beside the directory and refreshed with it (its query key
 * sits under `['staff', tenant]`, which the page invalidates), folded shut
 * below it: rarely wanted, but the only way back for an account — and for its
 * email — once it has been deleted.
 *
 * Shown whenever there is something to say: accounts to restore, a read still
 * loading, or a read that failed — a failed read here hides the only way back
 * for a deleted account (STA-1).
 */
export function DeletedStaffSection({
  tenant,
  base,
  token,
  locale,
  onRestored,
  onError,
}: {
  tenant: string;
  /** The admin path prefix, for the sign-in redirect on an expired session. */
  base: string;
  token: string | null;
  locale: string;
  /** Re-reads the directory, which a restored account rejoins (disabled, in «الأرشيف»). */
  onRestored: () => Promise<unknown>;
  /** A refused restore, for the page's banner — beside the toast, as every other write there. */
  onError: (message: string) => void;
}) {
  const t = useTranslations('staff.deleted');
  const tToast = useTranslations('staff.toast');
  const tCommon = useTranslations('common');
  const toast = useToast();
  const roles = getLabels(locale).staffRole as Record<string, string> | undefined;
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const query = useStaffQuery({
    queryKey: ['staff', tenant, 'deleted'],
    queryFn: (accessToken, signal) => getDeletedStaff(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const deleted: DeletedStaffSummary[] = query.data?.items ?? [];

  const restore = async (staff: DeletedStaffSummary) => {
    if (!token || restoringId) return;
    setRestoringId(staff.id);
    try {
      await restoreStaff(tenant, token, staff.id);
      await onRestored();
      toast.success(tToast('restored'), { description: tToast('restoredDescription', { name: staff.fullName }) });
    } catch (caught) {
      logApiError(caught);
      const message = caught instanceof ApiRequestError ? caught.message : tToast('restoreFailed');
      onError(message);
      toast.error(tToast('restoreFailed'), { description: message });
    } finally {
      setRestoringId(null);
    }
  };

  if (deleted.length === 0 && !query.loading && !query.error) return null;

  return (
    <CollapsibleSection
      title={t('title')}
      icon={Trash2}
      summary={deleted.length > 0 ? <span className="tabular-nums">({deleted.length})</span> : undefined}
      defaultOpen={false}
    >
      {query.loading ? (
        <LoadingState compact label={t('loading')} />
      ) : query.error ? (
        <ErrorState
          compact
          title={tCommon('error')}
          description={query.error}
          onRetry={() => void query.refetch()}
          retryLabel={tCommon('retry')}
        />
      ) : (
        <ul className="divide-y">
          {deleted.map((staff) => (
            <li key={staff.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{staff.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <bdi dir="ltr">{staff.email}</bdi>
                  {' · '}
                  {roles?.[staff.role] ?? staff.role}
                  {' · '}
                  {t('deletedOn', { date: formatDate(staff.deletedAt) })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={restoringId === staff.id}
                onClick={() => void restore(staff)}
              >
                {restoringId === staff.id ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ArchiveRestore className="size-4" aria-hidden />
                )}
                {t('restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
