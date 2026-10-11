'use client';

import { useState } from 'react';
import { CheckCircle2, CloudOff, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { acknowledgeBuilding, registrationsOnBuilding, useOfflineQueue } from '@/lib/offline-sync';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
 * strip still says they are there, but offers none of «مزامنة الآن»,
 * «إعادة المحاولة», «حذف» or «تم الاطلاع»: sending would be refused, and the
 * rest would change another officer's queue or clear their message before
 * they read it.
 *
 * A refused building can be retried or discarded (`retryBuilding`,
 * `discardBuilding`). Editing one is not offered: no editor loads a queued
 * building's payload, and that would need a route of its own.
 */
export function BuildingQueueNotice({ tenant, canSend }: { tenant: string; canSend: boolean }) {
  const t = useTranslations('offlineQueue.buildings');
  const tCommon = useTranslations('common');
  const queue = useOfflineQueue(tenant);
  /** The refused building whose «حذف» confirmation is open, or none. */
  const [discarding, setDiscarding] = useState<string | null>(null);

  const reconciled = queue.buildings.filter((item) => item.status === 'reconciled');
  const blocked = queue.buildings.filter((item) => item.status === 'blocked');
  const discardTarget = blocked.find((item) => item.id === discarding);
  // Registrations still queued that name it: sent without it, they are refused.
  const affected = discardTarget ? registrationsOnBuilding(discardTarget, queue.items) : 0;

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
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 font-medium text-destructive">
                  <span dir="ltr" className="font-mono">
                    {item.provisionalCode}
                  </span>
                  {' — '}
                  {item.lastError ?? t('refused')}
                </p>
                {/*
                  A refusal can stop being true (a duplicate removed from the
                  parcel), and a building nobody wants any more must be able
                  to leave the queue: `drainBuildings` never sends a refused
                  one again by itself. Gated like «مزامنة الآن».
                */}
                {canSend ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => queue.retryBuilding(item.id)}
                      disabled={queue.syncing}
                      className="h-7 shrink-0 px-2 text-xs"
                    >
                      {t('retry')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDiscarding(item.id)}
                      className="h-7 shrink-0 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      {t('discard')}
                    </Button>
                  </>
                ) : null}
              </div>
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

      {/* The building exists nowhere else, so discarding it is confirmed, and says what it takes with it. */}
      <ConfirmDialog
        open={discardTarget !== undefined}
        onOpenChange={(open) => setDiscarding(open ? discarding : null)}
        title={t('discardTitle')}
        description={
          <>
            {t.rich('discardBody', {
              parcel: discardTarget?.parcelNumber ?? '',
              ltr: (chunks) => (
                <span dir="ltr" className="font-mono">
                  {chunks}
                </span>
              ),
            })}
            {affected > 0 ? <> {t('discardAffected', { count: affected })}</> : null}
          </>
        }
        confirmLabel={t('discardConfirm')}
        cancelLabel={tCommon('cancel')}
        busyLabel={t('discarding')}
        onConfirm={async () => {
          if (discarding) await queue.discardBuilding(discarding);
          setDiscarding(null);
        }}
      />
    </div>
  );
}
