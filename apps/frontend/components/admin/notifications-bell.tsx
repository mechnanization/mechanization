'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, Check, CheckCheck, ChevronLeft } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getPendingPayments,
  logApiError,
  markAllPendingPaymentsAsSeen,
  markPaymentAsSeen,
  type PendingPayment,
} from '@/lib/api-client';
import { formatLbp, formatLbpCompact } from '@/lib/currency';
import { formatDate } from '@/lib/dates';

const POLL_INTERVAL_MS = 60_000;
const REVIEW_ROLES = ['SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT'];
const MAX_LISTED = 6;

export function NotificationsBell({
  tenant,
  token,
  role,
  base,
  locale: propLocale,
}: {
  tenant: string;
  token: string | undefined;
  role: string | undefined;
  base: string;
  locale?: string;
}): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<PendingPayment[]>([]);
  const canReview = Boolean(role && REVIEW_ROLES.includes(role));

  const locale = propLocale ?? (pathname?.includes('/en/') || pathname?.endsWith('/en') ? 'en' : 'ar');
  const labels = getLabels(locale);

  const reviewHref = `${base}/fees#verify`;

  const load = useCallback(async (): Promise<void> => {
    if (!token || !canReview) return;
    if (document.visibilityState !== 'visible') return;
    try {
      const result = await getPendingPayments(tenant, token, true);
      setItems(result.items);
    } catch (caught) {
      logApiError(caught);
    }
  }, [tenant, token, canReview]);

  useEffect(() => {
    if (!token || !canReview) return;

    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load, token, canReview, pathname]);

  const openQueue = useCallback(() => router.push(reviewHref), [router, reviewHref]);

  const handleMarkAsSeen = useCallback(
    async (e: React.MouseEvent, paymentId: string) => {
      e.stopPropagation();
      e.preventDefault();
      if (!token) return;
      setItems((prev) => prev.filter((p) => p.id !== paymentId));
      try {
        await markPaymentAsSeen(tenant, token, paymentId);
      } catch (err) {
        logApiError(err);
        void load();
      }
    },
    [tenant, token, load],
  );

  const handleMarkAllAsSeen = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!token) return;
      setItems([]);
      try {
        await markAllPendingPaymentsAsSeen(tenant, token);
      } catch (err) {
        logApiError(err);
        void load();
      }
    },
    [tenant, token, load],
  );

  if (!canReview) return null;

  const count = items.length;
  const en = locale === 'en';

  /*
    Simple on purpose: who, how much, for what, and a tick to clear it. The
    avatar letter, the method chip, the transaction reference and the clock
    each took a line or a box of their own, so six payments filled a phone; the
    reference is still one tap away on the queue.

    Every Arabic string here was rewritten: a save in the wrong encoding
    (commit 01d3836) had replaced them all with U+FFFD replacement marks,
    which is what the popover showed in their place until this rewrite.
  */
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0"
          aria-label={
            count > 0
              ? en
                ? `Notifications, ${count} payments pending confirmation`
                : `الإشعارات، ${count} دفعة بانتظار التأكيد`
              : en
                ? 'Notifications, all clear'
                : 'الإشعارات، لا جديد'
          }
        >
          <Bell className="size-5" />
          {count > 0 ? (
            <span
              aria-hidden
              className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold tabular-nums text-destructive-foreground ring-2 ring-background"
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl p-0"
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <p className="text-sm font-semibold">
            {en ? 'Pending confirmation' : 'بانتظار التأكيد'}
            {count > 0 ? <span className="ms-1.5 tabular-nums text-muted-foreground">({count})</span> : null}
          </p>
          {count > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={(e) => void handleMarkAllAsSeen(e)}
            >
              <CheckCheck className="size-3.5" aria-hidden />
              {en ? 'Mark all as seen' : 'تعليم الكل كمقروء'}
            </Button>
          ) : null}
        </div>

        {/* ── Body ───────────────────────────────────────────────── */}
        {count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <CheckCheck className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">{en ? 'Nothing pending review' : 'لا شيء بانتظار المراجعة'}</p>
            <p className="text-xs text-muted-foreground">
              {en ? 'Every payment citizens declared has been handled.' : 'كل ما أعلنه المواطنون تمّت معالجته.'}
            </p>
          </div>
        ) : (
          <div className="max-h-[min(60vh,22rem)] divide-y overflow-y-auto">
            {items.slice(0, MAX_LISTED).map((payment) => (
              <DropdownMenuItem
                key={payment.id}
                onSelect={openQueue}
                className="flex cursor-pointer items-center gap-3 rounded-none px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-semibold">{payment.citizenName}</span>
                    <span
                      title={formatLbp(payment.amount, locale)}
                      className="shrink-0 text-sm font-semibold tabular-nums"
                    >
                      {formatLbpCompact(payment.amount, locale)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      payment.title,
                      payment.paymentMethod
                        ? (labels.paymentMethod?.[payment.paymentMethod as never] ?? payment.paymentMethod)
                        : null,
                      formatDate(payment.dueDate),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-success"
                  onClick={(e) => void handleMarkAsSeen(e, payment.id)}
                  title={en ? 'Mark as seen' : 'تعليم كمقروء'}
                  aria-label={en ? 'Mark as seen' : 'تعليم كمقروء'}
                >
                  <Check className="size-4" aria-hidden />
                </Button>
              </DropdownMenuItem>
            ))}
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────── */}
        {count > 0 ? (
          <button
            type="button"
            onClick={openQueue}
            className="flex w-full items-center justify-center gap-1.5 border-t px-4 py-2.5 text-xs font-semibold text-primary transition-colors hover:bg-muted/50"
          >
            {count > MAX_LISTED
              ? en
                ? `View all (${count})`
                : `عرض الكل (${count})`
              : en
                ? 'Open the confirmation list'
                : 'فتح قائمة التأكيد'}
            <ChevronLeft className="size-3.5 ltr:rotate-180" aria-hidden />
          </button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
