import { useState } from 'react';
import { DoorClosed, Undo2 } from 'lucide-react';
import { getLabels, type VacancyEndReason } from '@mechanization/shared-schemas';
import { type UnitVacancyConfirmation, type UnitWithOccupants } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { activeVacancy } from '../../building-unit-forms';
import { EndVacancyDialog } from './end-vacancy-dialog';

/**
 * Why this flat reads «شاغرة», and the one control that changes it.
 *
 * Shown wherever a confirmation is standing. The three facts on it are the ones
 * a dispute turns on — since when, on what basis, and by whom — and they used
 * to exist nowhere: the matrix said «شاغرة» and that was the whole of the
 * record. Underneath, the confirmations already closed, because a flat that has
 * been confirmed empty twice before is telling an officer something about the
 * building.
 *
 * Ones closed «سُجِّل بالخطأ» are left out and counted, exactly as occupancies
 * recorded in error are: they are not history, and a list that shows them
 * invites reading a correction as a fact.
 */
export function VacancyPanel({
  unit,
  unitCode,
  locale,
  busy,
  canWrite,
  onEnd,
}: {
  unit: UnitWithOccupants;
  unitCode: string;
  locale: string;
  busy: boolean;
  canWrite: boolean;
  onEnd: (input: {
    reason: VacancyEndReason;
    endedAt?: string;
    notes: string;
  }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [ending, setEnding] = useState<UnitVacancyConfirmation | null>(null);

  const standing = activeVacancy(unit);
  const closed = (unit.vacancies ?? []).filter(
    (row) => row.endedAt !== null && row.endReason !== 'RECORDED_IN_ERROR',
  );
  const corrections = (unit.vacancies ?? []).filter(
    (row) => row.endReason === 'RECORDED_IN_ERROR',
  ).length;

  if (!standing && closed.length === 0 && corrections === 0) return null;

  return (
    <>
      {standing ? (
        <div className="space-y-2 rounded-md border border-info/30 bg-info/5 p-3">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
            <DoorClosed className="size-3.5 shrink-0 text-info" aria-hidden />
            {en ? 'Confirmed vacant since ' : 'مؤكَّدة الشغور منذ '}
            {formatDate(standing.observedAt)}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {standing.basis
              ? labels.vacancyBasis[standing.basis]
              : en
                ? 'Recorded before the basis was asked for'
                : 'سُجِّل قبل أن يُسأل عن المستند'}
            {standing.confirmedByName ? ` — ${standing.confirmedByName}` : ''}
          </p>
          {standing.notes ? (
            <p className="text-xs leading-relaxed">{standing.notes}</p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {en
              ? 'The owner is not billed the occupancy fee for it while this stands.'
              : 'لا تُحتسب على المالك رسوم الإشغال عنها ما دام هذا التأكيد قائماً.'}
          </p>
          {canWrite ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEnding(standing)}
            >
              <Undo2 className="size-4" aria-hidden />
              {en ? 'Lift the vacancy…' : 'إلغاء تأكيد الشغور…'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {closed.length > 0 ? (
        <ul className="space-y-1">
          {closed.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              <DoorClosed className="size-3 shrink-0" aria-hidden />
              {en ? 'Vacant ' : 'شاغرة '}
              {formatDate(row.observedAt)} — {formatDate(row.endedAt!)}
              {row.endReason ? (
                <Badge variant="soft-muted">{labels.vacancyEndReason[row.endReason]}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {corrections > 0 ? (
        <p className="text-xs text-muted-foreground">
          {en
            ? `${corrections} vacancy confirmation(s) recorded in error — kept, not shown.`
            : `${corrections} تأكيد شغور سُجِّل بالخطأ — محفوظ ولا يُعرض.`}
        </p>
      ) : null}

      <EndVacancyDialog
        vacancy={ending}
        unitCode={unitCode}
        locale={locale}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        onConfirm={onEnd}
      />
    </>
  );
}

