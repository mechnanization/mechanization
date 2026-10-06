'use client';

import { CheckCircle2, CloudOff, Loader2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { acknowledgeBuilding, useOfflineQueue } from '@/lib/offline-sync';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Buildings created with no signal, and the codes that changed on the way in
 * (§4.4, P3-T8).
 *
 * The reconciliation half is the reason this is its own strip rather than a
 * line in the citizen queue's notice. A pending record is *work*; a reconciled
 * code is a *message*, and it is the one message this feature exists to
 * deliver: an officer who wrote `A-1042-A` on a form in somebody's stairwell
 * has to be told it became `A-1042-B`. They clear it by reading it — nothing
 * dismisses it for them, because a notice that vanished on the next drain would
 * be a notice nobody read.
 *
 * `canSend` is false for a session that cannot survey — «مشاهد فقط», an
 * auditor, the accountant — on a device an officer queued buildings on. The
 * strip still says they are there, but offers neither «مزامنة الآن» nor «تم
 * الاطلاع»: the first would be refused and the second would clear another
 * officer's message before they read it.
 */
export function BuildingQueueNotice({ tenant, canSend }: { tenant: string; canSend: boolean }) {
  const t = useTranslations('offlineQueue.buildings');
  const queue = useOfflineQueue(tenant);

  const reconciled = queue.buildings.filter((item) => item.status === 'reconciled');
  const blocked = queue.buildings.filter((item) => item.status === 'blocked');

  if (queue.buildingsPending === 0 && reconciled.length === 0 && blocked.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {queue.buildingsPending > 0 || blocked.length > 0 ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-lg border p-2.5 text-xs',
            blocked.length > 0
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-warning/40 bg-warning/5',
          )}
        >
          {blocked.length > 0 ? (
            <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />
          )}

          <div className="min-w-0 flex-1 space-y-0.5">
            {queue.buildingsPending > 0 ? <p>{t('pending', { count: queue.buildingsPending })}</p> : null}
            {blocked.map((item) => (
              <p key={item.id} className="font-medium text-destructive">
                <span dir="ltr" className="font-mono">
                  {item.provisionalCode}
                </span>
                {' — '}
                {item.lastError ?? t('refused')}
              </p>
            ))}
            {!canSend ? <p className="text-muted-foreground">{t('writerRequired')}</p> : null}
          </div>

          {canSend ? (
            <Button variant="outline" size="sm" onClick={queue.sync} disabled={queue.syncing}>
              {queue.syncing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              {t('syncNow')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {reconciled.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs"
        >
          <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1">
            {t.rich('reconciled', {
              parcel: item.parcelNumber ?? '',
              code: item.reconciledCode ?? '',
              provisional: item.provisionalCode,
              ltr: (chunks) => (
                <span dir="ltr" className="font-mono">
                  {chunks}
                </span>
              ),
              now: (chunks) => (
                <strong dir="ltr" className="font-mono">
                  {chunks}
                </strong>
              ),
              was: (chunks) => (
                <span dir="ltr" className="font-mono line-through">
                  {chunks}
                </span>
              ),
            })}
          </p>
          {canSend ? (
            <Button variant="outline" size="sm" onClick={() => void acknowledgeBuilding(tenant, item.id)}>
              {t('acknowledge')}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
