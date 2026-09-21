'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowRight,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  CreditCard,
  Inbox,
  Sparkles,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0 rounded-full hover:bg-muted/80 transition-colors"
          aria-label={
            count > 0
              ? (locale === 'en' ? `Notifications, ${count} unread payments pending confirmation` : `��������ʡ ${count} ���� ��� ������ ������� �������`)
              : (locale === 'en' ? 'Notifications, all clear' : '��������ʡ �� ����')
          }
        >
          <Bell className={cn('size-5', count > 0 && 'text-foreground animate-none')} />
          {count > 0 ? (
            <span
              aria-hidden
              className="absolute -end-0.5 -top-0.5 flex size-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-xs font-bold tabular-nums text-destructive-foreground shadow-xs ring-2 ring-background"
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[24rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border/80 bg-popover p-0 shadow-xl backdrop-blur-sm overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/35 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-3.5" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground">
                {locale === 'en' ? 'Pending Confirmations' : '������� �������'}
              </span>
              {count > 0 ? (
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 text-xs font-bold rounded-full bg-destructive/10 text-destructive border-0 tabular-nums"
                >
                  {count}
                </Badge>
              ) : null}
            </div>
          </div>

          {count > 0 ? (
            <button
              type="button"
              onClick={(e) => void handleMarkAllAsSeen(e)}
              title={locale === 'en' ? 'Mark all as seen' : '����� ���� ������'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-2xs hover:bg-background hover:text-foreground hover:border-border transition-all cursor-pointer"
            >
              <CheckCheck className="size-3.5 text-primary" />
              <span>{locale === 'en' ? 'Mark all seen' : '����� ���� ������'}</span>
            </button>
          ) : null}
        </div>

        {/* Body */}
        {count === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
              <CheckCircle2 className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                {locale === 'en' ? 'All caught up!' : '�� ���� ������� �����'}
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed max-w-[17rem]">
                {locale === 'en'
                  ? 'All citizen declarations have been processed or marked as seen.'
                  : '��� ������ �� ���� ���� ������� ������ ������� �����.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="max-h-[min(65vh,24rem)] overflow-y-auto divide-y divide-border/40">
            {items.slice(0, MAX_LISTED).map((payment) => {
              const citizenInitial = payment.citizenName?.trim()?.[0]?.toUpperCase() ?? '�';
              return (
                <DropdownMenuItem
                  key={payment.id}
                  onSelect={openQueue}
                  className="group relative flex items-start gap-3 p-3.5 transition-colors hover:bg-muted/50 cursor-pointer focus:bg-muted/60"
                >
                  {/* Avatar / Icon */}
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary border border-primary/20 text-xs font-bold shadow-2xs">
                    {citizenInitial}
                  </div>

                  {/* Details */}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                        {payment.citizenName}
                      </span>
                      <span
                        title={formatLbp(payment.amount, locale)}
                        className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-bold tabular-nums text-foreground border border-border/50"
                      >
                        {formatLbpCompact(payment.amount, locale)}
                      </span>
                    </div>

                    <p className="truncate text-xs font-medium text-muted-foreground/90">
                      {payment.title}
                    </p>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {payment.paymentMethod ? (
                        <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-medium text-foreground/80">
                          <CreditCard className="size-3 shrink-0 text-muted-foreground" />
                          <span>
                            {labels.paymentMethod?.[payment.paymentMethod as never] ?? payment.paymentMethod}
                          </span>
                          {payment.whishTransactionRef ? (
                            <span className="font-mono text-xs text-muted-foreground">
                              � {payment.whishTransactionRef}
                            </span>
                          ) : null}
                        </span>
                      ) : null}

                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3 shrink-0" />
                        <span>{formatDate(payment.dueDate)}</span>
                      </span>
                    </div>
                  </div>

                  {/* Mark as seen action */}
                  <button
                    type="button"
                    onClick={(e) => void handleMarkAsSeen(e, payment.id)}
                    title={locale === 'en' ? 'Mark as seen' : '����� ������'}
                    className="shrink-0 mt-0.5 flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground shadow-2xs hover:bg-success hover:text-success-foreground hover:border-success transition-all cursor-pointer group-hover:border-border"
                  >
                    <Check className="size-3.5" />
                    <span className="sr-only">{locale === 'en' ? 'Mark as seen' : '����� ������'}</span>
                  </button>
                </DropdownMenuItem>
              );
            })}
          </div>
        )}

        {/* Footer */}
        {count > 0 ? (
          <div className="border-t border-border/60 bg-muted/20 p-2">
            <button
              type="button"
              onClick={openQueue}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-background/60 hover:bg-background py-2 text-xs font-semibold text-primary transition-all border border-border/40 hover:border-border shadow-2xs cursor-pointer"
            >
              <Inbox className="size-3.5" />
              <span>
                {count > MAX_LISTED
                  ? (locale === 'en' ? `View all pending (${count})` : `��� ���� ��������� (${count})`)
                  : (locale === 'en' ? 'Open verification list' : '��� ����� �������')}
              </span>
              <ArrowRight className="size-3.5 rtl:rotate-180 text-muted-foreground" />
            </button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

