'use client';

import { useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import { getLabels, isImpairedDamage, isUninhabitableReading } from '@mechanization/shared-schemas';
import type { DamageAssessmentRow } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';

/**
 * The damage history of one structure: append-only, newest first, and the
 * first row is labelled as the current one (D3).
 *
 * A building assessed unsafe in 2024 and repaired in 2026 keeps both rows, and
 * that is the entire point: the 2024 row is what a compensation claim rests on,
 * while the 2026 row is what decides whether anyone may enter today. Showing
 * only the latest would answer the second question and destroy the first.
 *
 * One component for the matrix drawer and the full-page matrix, which used to
 * paste the same panel twice — the next damage field was going to be added in
 * four places.
 */
export function DamageHistory({
  history,
  current,
  units,
  locale,
}: {
  history: readonly DamageAssessmentRow[];
  current: string | null;
  units: ReadonlyArray<{ id: string; unitCode: string }>;
  locale: string;
}) {
  const t = useTranslations('damage');
  const labels = getLabels(locale);
  if (history.length === 0) return null;
  const levelName = (level: string | null) =>
    level ? (labels.damageLevel as Record<string, string>)[level] ?? level : '—';

  return (
    <div className="space-y-2 rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <ShieldAlert className="size-3.5 text-muted-foreground" aria-hidden />
          {t('history.title')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('history.summary', { count: history.length, level: levelName(current) })}
        </p>
      </div>

      <ul className="divide-y">
        {history.map((row, position) => {
          const unit = row.unitId ? units.find((candidate) => candidate.id === row.unitId) : null;
          const uninhabitable = isUninhabitableReading(row);
          return (
            <li key={row.id} className="space-y-1 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={isImpairedDamage(row.level) ? 'soft-destructive' : 'soft-success'}>
                  {levelName(row.level)}
                </Badge>
                {/* The second axis, beside the level and never folded into it. */}
                {uninhabitable ? (
                  <Badge variant="soft-warning">{t('habitable.no')}</Badge>
                ) : row.habitable === true ? (
                  <Badge variant="soft-muted">{t('habitable.yes')}</Badge>
                ) : null}
                {position === 0 ? <Badge variant="soft-default">{t('history.current')}</Badge> : null}
                <span className="text-muted-foreground">{formatDate(row.assessedAt)}</span>
                <Badge variant="soft-muted">{labels.damageSource[row.source]}</Badge>
                {/*
                  Which part of the structure this reading is about. "Top three
                  floors gone, ground floor shop still trading" is two rows on
                  one building, and a panel that did not say which was which
                  would read as a contradiction.
                */}
                <Badge variant="soft-muted">
                  {row.unitId ? t('history.unit', { code: unit?.unitCode ?? '—' }) : t('history.wholeBuilding')}
                </Badge>
              </div>

              {row.observations ? <p className="leading-relaxed text-muted-foreground">{row.observations}</p> : null}
              {row.reinspectAt ? (
                <p className="text-muted-foreground">
                  {t('history.reinspectDue', { date: formatDate(row.reinspectAt) })}
                </p>
              ) : null}
              {row.assessedByName ? (
                <p className="text-xs text-muted-foreground">{t('history.assessedBy', { name: row.assessedByName })}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
