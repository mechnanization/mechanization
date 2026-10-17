'use client';

import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { isUninhabitableReading } from '@mechanization/shared-schemas';
import type { DamageAssessmentRow } from '@/lib/api-client';
import { governingReading, reinspectOverdue, type DamageTarget } from '@/lib/damage-reading';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

/**
 * «غير صالحة للسكن — بانتظار إعادة الكشف» — on a flat or a structure whose
 * current reading says nobody can live in it.
 *
 * For a flat the reading that decides is the one that applies to it now — its
 * own, or a later whole-building one — among those that make a finding
 * (`governingReading`), which is what the biller exempts every fee on. It
 * stays until the next reading of that target that answers habitability; a
 * «غير مصنّف» with no answer judged nothing and leaves it standing. The
 * history keeps every reading.
 */
export function ReinspectNotice({
  history,
  target,
}: {
  history: readonly DamageAssessmentRow[];
  target: DamageTarget;
}) {
  const t = useTranslations('damage');
  const reading = governingReading(history, target);
  if (!reading || !isUninhabitableReading(reading)) return null;

  const due = reading.reinspectAt ?? null;
  const overdue = reinspectOverdue(due);
  const fromBuilding = 'unitId' in target && reading.unitId === null;

  return (
    <p
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed',
        overdue ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning',
      )}
    >
      <CalendarClock className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="space-y-0.5">
        <span className="block font-semibold">{t('notice.title')}</span>
        <span className="block">
          {due
            ? overdue
              ? t('notice.overdue', { date: formatDate(due) })
              : t('notice.due', { date: formatDate(due) })
            : t('notice.noDate')}
          {fromBuilding ? ` · ${t('notice.wholeBuilding')}` : ''}
        </span>
        <span className="block opacity-90">{t('notice.feeHeld')}</span>
      </span>
    </p>
  );
}
