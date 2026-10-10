'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { REOPEN_REASON_MIN } from '@mechanization/shared-schemas';
import {
  closeTreasuryDay,
  logApiError,
  reopenTreasuryDay,
  type DailyCountSheet,
  type DayClosureVerdict,
} from '@/lib/api-client';
import { localizeApiError } from '@/lib/api-errors';
import { formatMoney } from '@/lib/currency';
import { varianceKind } from '@/lib/daily-count';
import { formatDay } from '@/lib/dates';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

const REASON_MAX = 500;

/**
 * Why the day cannot close yet, in the words the server would refuse with.
 *
 * The sheet carries `planClosure`'s verdict — the same function `POST
 * closures` runs — and its codes are `errors.*` codes, so the sentence under a
 * disabled button and the refusal a forced request would get are one text.
 */
function verdictText(verdict: Extract<DayClosureVerdict, { ok: false }>, businessDate: string, locale: string): string {
  return localizeApiError(
    {
      code: verdict.code,
      message: verdict.code,
      params: { date: verdict.day ?? businessDate, count: verdict.days ?? verdict.accounts ?? 0, min: REOPEN_REASON_MIN },
    },
    locale === 'en' ? 'en' : 'ar',
  );
}

/**
 * «إقفال اليومية» — and, for the manager, «إعادة فتح اليومية».
 *
 * Closing is irreversible for the accountant and reversible only by the
 * manager with a reason, so it is confirmed with the figures being signed off
 * on and the consequence stated (DES-1). Not `destructive`: nothing is lost,
 * the day is locked (DES-4). Reopening is the manager's alone and names its
 * reason, which stays in the audit log and on the day's report.
 */
export function DayClosePanel({
  sheet,
  tenant,
  token,
  locale,
  canClose,
  canReopen,
  unsaved,
}: {
  sheet: DailyCountSheet;
  tenant: string;
  token: string;
  locale: string;
  /** `TREASURY_WORK_ROLES`, as `POST closures`. */
  canClose: boolean;
  /** `TREASURY_ADMIN_ROLES`, as `POST closures/reopen`. */
  canReopen: boolean;
  /** Figures typed on the sheet and not saved yet. */
  unsaved: boolean;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);

  const { day, closure } = sheet;
  const date = formatDay(day.businessDate);
  const closed = day.status === 'CLOSED';
  const closable = closure.ok && !unsaved;

  const close = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await closeTreasuryDay(tenant, token, { businessDate: day.businessDate });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('close.done', { date }), {
        description: result.sweptDays.length > 0 ? t('close.doneSwept', { count: result.sweptDays.length }) : undefined,
      });
    } catch (error) {
      logApiError(error);
      // The sheet behind the dialog may be out of date: read it again under the message.
      void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      // `ConfirmDialog` shows `error.message`, already the words for the code (TXT-6).
      throw error;
    } finally {
      inFlight.current = false;
    }
  };

  const reopen = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await reopenTreasuryDay(tenant, token, { businessDate: day.businessDate, reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('reopen.done', { date }));
      setReason('');
    } catch (error) {
      logApiError(error);
      void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      throw error;
    } finally {
      inFlight.current = false;
    }
  };

  const status = closed ? (
    <Alert variant="success">{t('close.closed')}</Alert>
  ) : !closure.ok ? (
    <Alert variant={closure.code === 'DAY_NOT_OVER' ? 'info' : 'warning'} live="status">
      {verdictText(closure, day.businessDate, locale)}
    </Alert>
  ) : unsaved ? (
    <Alert variant="warning" live="status">
      {t('close.unsaved')}
    </Alert>
  ) : (
    <Alert variant="info" live="status">
      {t('close.ready', { date })}
      {closure.sweeps.length > 0 ? (
        <>
          {' '}
          {t('close.sweeps', { count: closure.sweeps.length, days: closure.sweeps.map(formatDay).join('، ') })}
        </>
      ) : null}
    </Alert>
  );

  return (
    <section aria-labelledby="day-close-heading">
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 id="day-close-heading" className="text-base font-semibold">
          {t('close.heading')}
        </h2>
        {status}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!closed && canClose ? (
            <Button onClick={() => setClosing(true)} disabled={!closable} className="w-full sm:w-auto">
              {t('close.action')}
            </Button>
          ) : null}
          {!closed && !canClose && closure.ok ? (
            <p className="me-auto text-xs text-muted-foreground">{t('close.workOnly')}</p>
          ) : null}
          {closed && canReopen && sheet.reopenable ? (
            <Button variant="outline" onClick={() => setReopening(true)} className="w-full sm:w-auto">
              {t('reopen.action')}
            </Button>
          ) : null}
        </div>
      </Card>

      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        destructive={false}
        title={t('close.confirmTitle', { date })}
        description={t('close.confirmBody')}
        confirmLabel={t('close.confirmAction')}
        cancelLabel={t('close.cancel')}
        busyLabel={t('close.confirming')}
        onConfirm={close}
      >
        {/* The figures being signed off on, read down against the count (PRIM-7). */}
        <SummaryList className="rounded-md border bg-muted/20 px-3">
          {sheet.lines.map((line) => {
            const count = line.count;
            const kind = count ? varianceKind(count.difference) : 'MATCH';
            return (
              <SummaryRow key={line.account.id} label={line.account.name} className={kind === 'MATCH' ? undefined : 'text-warning'}>
                {count
                  ? t('close.summaryRow', {
                      expected: formatMoney(line.expectedAmount, line.account.currency, locale),
                      counted: formatMoney(count.countedAmount, line.account.currency, locale),
                    })
                  : '—'}
              </SummaryRow>
            );
          })}
        </SummaryList>
        {closure.ok && closure.sweeps.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('close.sweeps', { count: closure.sweeps.length, days: closure.sweeps.map(formatDay).join('، ') })}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={reopening}
        onOpenChange={(open) => {
          setReopening(open);
          if (!open) setReason('');
        }}
        destructive={false}
        title={t('reopen.title', { date })}
        description={t('reopen.body')}
        confirmLabel={t('reopen.confirm')}
        cancelLabel={t('reopen.cancel')}
        busyLabel={t('reopen.confirming')}
        confirmDisabled={reason.trim().length < REOPEN_REASON_MIN}
        onConfirm={reopen}
      >
        <Field htmlFor="reopen-reason" label={t('reopen.reason')} required>
          <Textarea
            id="reopen-reason"
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            placeholder={t('reopen.reasonPlaceholder')}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <p className="text-xs text-muted-foreground">{t('reopen.reasonShort', { min: REOPEN_REASON_MIN })}</p>
      </ConfirmDialog>
    </section>
  );
}
