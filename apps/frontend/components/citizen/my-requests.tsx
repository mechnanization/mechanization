'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, FileCheck, Plus } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { onlineCopy } from '@/lib/online-payment';
import { requestStatusBadge } from '@/lib/request-status';
import { getMyRequests, type MyCitizenRequestView } from '@/lib/requests-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «طلباتي» on the citizen's file: the requests they filed, online or at the
 * counter, newest first, each a link to its own page — and «طلب جديد», which
 * opens the wizard (docs/municipal-requests-plan.md).
 *
 * One line per request: what it is, its number, where it stands, and the one
 * thing the citizen has to do next, if any — attach their identity copy, pay
 * the fee (at the municipality while online payment is paused, `lib/online-payment.ts`),
 * or come in with their identity card for a paper that is ready.
 */
export function MyRequests({
  tenant,
  locale,
  token,
  base,
  onSignedOut,
}: {
  tenant: string;
  locale: string;
  token: string;
  /** `/{tenant}/{locale}` — the portal's root. */
  base: string;
  /** A 401: the page's own handling of an ended session. True when it took over. */
  onSignedOut: (caught: unknown) => boolean;
}): React.JSX.Element {
  const t = useTranslations('citizenRequests.list');
  const labels = getLabels(locale);
  const [requests, setRequests] = useState<MyCitizenRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Chevron = locale === 'en' ? ChevronRight : ChevronLeft;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const mine = await getMyRequests(tenant, token, signal);
        setRequests(mine);
        setError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        logApiError(caught);
        if (onSignedOut(caught)) return;
        setError(t('loadError'));
      }
    },
    [tenant, token, onSignedOut, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** The next step that is the citizen's, in a word; null when the municipality has it. */
  const nextStep = (request: MyCitizenRequestView): string | null => {
    if (request.status === 'AWAITING_PAYMENT') {
      if (request.needsIdentityCopy) return t('needsIdentity', onlineCopy());
      // A payment declared and waiting for a clerk to confirm it: nothing more is theirs to do.
      return request.bill?.paymentStatus === 'PENDING_REVIEW' ? t('paymentPending') : t('needsPayment', onlineCopy());
    }
    if (request.status === 'READY_FOR_PICKUP') return t('ready');
    return null;
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b">
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileCheck className="size-5" aria-hidden />
          <h2>{t('title')}</h2>
        </CardTitle>
        <Button asChild size="sm">
          <Link href={`${base}/my-file/requests/new`}>
            <Plus className="size-4" aria-hidden />
            {t('new')}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : requests === null ? (
          <div className="space-y-2 p-4" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : requests.length === 0 ? (
          <div className="space-y-1 p-4">
            <p className="text-sm font-medium">{t('empty')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
          </div>
        ) : (
          <ul className="divide-y">
            {requests.map((request) => {
              const step = nextStep(request);
              return (
                <li key={request.id}>
                  <Link
                    href={`${base}/my-file/requests/${request.id}`}
                    className="flex min-h-touch items-center gap-3 p-4 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{labels.requestType[request.requestType]}</span>
                        <Badge variant={requestStatusBadge(request.status)}>{labels.requestStatus[request.status]}</Badge>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        <bdi dir="ltr" className="font-mono">
                          {request.requestNumber}
                        </bdi>
                        {' · '}
                        {t('filedOn', { date: formatDate(request.createdAt) })}
                      </span>
                      {step ? <span className="block text-sm text-foreground">{step}</span> : null}
                    </span>
                    <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
