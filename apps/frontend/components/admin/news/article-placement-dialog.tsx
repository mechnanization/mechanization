'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { municipalToday, type NewsPlacementInput } from '@mechanization/shared-schemas';
import { scheduleInstant } from '@/lib/news-article-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DayTimeFields } from './day-time-fields';

/**
 * «تثبيت وتمييز…»: pins a published article on top of the feed, and/or features
 * it in the carousel until a time on the municipality's clock. Unticking
 * «featured» removes it from the carousel (Day3ati takes an empty time as
 * removal). The host makes the call with what this hands back.
 */
export function ArticlePlacementDialog({
  locale,
  current,
  onSave,
  onClose,
}: {
  locale: 'ar' | 'en';
  /** What the article has now: pinned, and the day and time it is featured until (null: not featured). */
  current: { isPinned: boolean; featuredUntil: { day: string; time: string } | null };
  /** Makes the call. Rejects with the localised refusal. */
  onSave: (placement: NewsPlacementInput) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('news.articles.editor');
  const [isPinned, setIsPinned] = useState(current.isPinned);
  const [featured, setFeatured] = useState(current.featuredUntil !== null);
  const [day, setDay] = useState(current.featuredUntil?.day ?? '');
  const [time, setTime] = useState(current.featuredUntil?.time ?? '23:59');
  const [problem, setProblem] = useState<'incomplete' | 'past' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    let featuredUntil: string | null = null;
    if (featured) {
      const picked = scheduleInstant(day, time);
      if (!picked.ok) {
        setProblem(picked.reason);
        return;
      }
      featuredUntil = picked.iso;
    }

    setProblem(null);
    setFailure(null);
    setBusy(true);
    try {
      await onSave({ isPinned, featuredUntil });
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
          <DialogTitle>{t('placement.title')}</DialogTitle>
          <DialogDescription>{t('placement.description')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <label htmlFor="news-placement-pinned" className="flex w-fit cursor-pointer select-none items-center gap-2 text-sm font-medium">
            <Checkbox
              id="news-placement-pinned"
              checked={isPinned}
              disabled={busy}
              onCheckedChange={(next) => setIsPinned(next === true)}
            />
            {t('placement.pinned')}
          </label>

          <label htmlFor="news-placement-featured" className="flex w-fit cursor-pointer select-none items-center gap-2 text-sm font-medium">
            <Checkbox
              id="news-placement-featured"
              checked={featured}
              disabled={busy}
              onCheckedChange={(next) => {
                setFeatured(next === true);
                setProblem(null);
              }}
            />
            {t('placement.featured')}
          </label>

          {featured ? (
            <DayTimeFields
              idPrefix="news-placement"
              locale={locale}
              day={day}
              time={time}
              dayLabel={t('placement.day')}
              timeLabel={t('placement.time')}
              minDay={municipalToday()}
              disabled={busy}
              error={problem ? t(`placement.${problem}`) : undefined}
              onDay={(next) => {
                setDay(next);
                setProblem(null);
              }}
              onTime={(next) => {
                setTime(next);
                setProblem(null);
              }}
            />
          ) : null}

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
              {busy ? t('saving') : t('placement.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
