'use client';

import { CheckCircle2, CloudOff, Loader2, TriangleAlert } from 'lucide-react';
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
 */
export function BuildingQueueNotice({
  tenant,
  locale = 'ar',
}: {
  tenant: string;
  locale?: string;
}) {
  const en = locale === 'en';
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
            {queue.buildingsPending > 0 ? (
              <p>
                {en
                  ? `${queue.buildingsPending} building(s) saved on this device, waiting to sync. Their codes are provisional until they are delivered.`
                  : `${queue.buildingsPending} مبنى محفوظ على هذا الجهاز بانتظار الإرسال. رموزها مؤقتة حتى تُرسل.`}
              </p>
            ) : null}
            {blocked.map((item) => (
              <p key={item.id} className="font-medium text-destructive">
                <span dir="ltr" className="font-mono">
                  {item.provisionalCode}
                </span>
                {' — '}
                {item.lastError ??
                  (en ? 'refused by the server' : 'رفضه الخادم')}
              </p>
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={queue.sync} disabled={queue.syncing}>
            {queue.syncing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {en ? 'Sync now' : 'مزامنة الآن'}
          </Button>
        </div>
      ) : null}

      {reconciled.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs"
        >
          <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1">
            {en ? (
              <>
                The building you created on parcel{' '}
                <span dir="ltr" className="font-mono">
                  {item.parcelNumber}
                </span>{' '}
                was saved as{' '}
                <strong dir="ltr" className="font-mono">
                  {item.reconciledCode}
                </strong>
                , not{' '}
                <span dir="ltr" className="font-mono line-through">
                  {item.provisionalCode}
                </span>
                . Another building already held that letter on the parcel.
              </>
            ) : (
              <>
                المبنى الذي أنشأته على العقار{' '}
                <span dir="ltr" className="font-mono">
                  {item.parcelNumber}
                </span>{' '}
                حُفظ بالرمز{' '}
                <strong dir="ltr" className="font-mono">
                  {item.reconciledCode}
                </strong>{' '}
                وليس{' '}
                <span dir="ltr" className="font-mono line-through">
                  {item.provisionalCode}
                </span>
                . كان ذلك الحرف محجوزاً لمبنى آخر على العقار نفسه.
              </>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void acknowledgeBuilding(tenant, item.id)}
          >
            {en ? 'Got it' : 'تم الاطلاع'}
          </Button>
        </div>
      ))}
    </div>
  );
}
