'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { municipalToday } from '@mechanization/shared-schemas';
import { scheduleInstant } from '@/lib/news-article-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DayTimeFields } from './day-time-fields';

/**
 * «جدولة…»: the day and time, on the municipality's clock, an article is
 * published at. It hands back the instant in UTC and the host makes the call,
 * so a refusal (a published article cannot be scheduled) is shown where the
 * host shows its other refusals, in this dialog's alert.
 */
export function ArticleScheduleDialog({
  locale,
  initial,
  onSchedule,
  onClose,
}: {
  locale: 'ar' | 'en';
  /** The time it is scheduled for now, when it is being moved. */
  initial: { day: string; time: string } | null;
  /** Makes the call. Rejects with the localised refusal. */
  onSchedule: (publishAtIso: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('news.articles.editor');
  const [day, setDay] = useState(initial?.day ?? '');
  const [time, setTime] = useState(initial?.time ?? '08:00');
  const [problem, setProblem] = useState<'incomplete' | 'past' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const picked = scheduleInstant(day, time);
    if (!picked.ok) {
      setProblem(picked.reason);
      return;
    }
    setProblem(null);
    setFailure(null);
    setBusy(true);
    try {
      await onSchedule(picked.iso);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{t('schedule.title')}</DialogTitle>
          <DialogDescription>{t('schedule.description')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <DayTimeFields
            idPrefix="news-schedule"
            locale={locale}
            day={day}
            time={time}
            dayLabel={t('schedule.day')}
            timeLabel={t('schedule.time')}
            minDay={municipalToday()}
            disabled={busy}
            error={problem ? t(`schedule.${problem}`) : undefined}
            onDay={(next) => {
              setDay(next);
              setProblem(null);
            }}
            onTime={(next) => {
              setTime(next);
              setProblem(null);
            }}
          />

          {failure ? (
            <Alert variant="destructive" live="alert">
              {failure}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {busy ? t('saving') : t('schedule.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
