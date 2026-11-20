'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, PencilLine, ShieldCheck } from 'lucide-react';
import {
  getLabels,
  type FeeExemptionPeriodView,
  type FeeExemptionUnitView,
  type SetUnitFeeExemptionInput,
} from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, setUnitFeeExemption } from '@/lib/api-client';
import { formatDate, formatDay } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { useToast } from '@/components/ui/toast';
import { FeeExemptionForm, type FeeExemptionDraft } from './fee-exemption-form';
import { LiftFeeExemptionDialog } from './lift-fee-exemption-dialog';

/** The read keys a grant, an amendment or a lift moves. */
export function invalidateFeeExemptions(queryClient: ReturnType<typeof useQueryClient>, tenant: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['fee-exemptions', tenant] }),
    queryClient.invalidateQueries({ queryKey: ['fee-exemption-unit', tenant] }),
    queryClient.invalidateQueries({ queryKey: ['fee-exemption-citizen', tenant] }),
  ]);
}

function draftOf(period: FeeExemptionPeriodView): FeeExemptionDraft {
  return {
    reason: period.reason,
    note: period.note ?? '',
    decisionRef: period.decisionRef ?? '',
    validUntil: period.validUntil ?? '',
  };
}

/**
 * One unit as «قائمة الإعفاء من الرسوم» shows it (0104): its full reference,
 * building and type, who holds it now (staff only: these are names), whether it
 * is exempt today, the standing exemption with its decision number and last
 * day, and every earlier period. The manager (`canGrant`) grants, amends or
 * lifts it here, through the same `PUT` the unit drawer uses; the exemption
 * belongs to the unit, never to the person found it through.
 */
export function FeeExemptionUnitCard({
  tenant,
  token,
  locale,
  unit,
  canGrant,
  role,
}: {
  tenant: string;
  token: string | null;
  locale: string;
  unit: FeeExemptionUnitView;
  canGrant: boolean;
  /** How the person it was found through holds it, when it was found through a person. */
  role?: string;
}) {
  const t = useTranslations('feeExemption');
  const tList = useTranslations('feeExemptions');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'view' | 'grant' | 'amend'>('view');
  const [lifting, setLifting] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const current = unit.current;
  const ended = current !== null && !unit.exemptToday;
  const past = unit.history.filter((period) => period.liftedAt !== null);
  const occupied = unit.holders.some((holder) => holder.role !== 'OWNER');
  const idPrefix = `fee-exemption-card-${unit.unitId}`;

  /**
   * Writes one change. A refusal is said in a toast and leaves the form as it was
   * (STA-4) — or, from the lift dialog (`inDialog`), is thrown for the dialog to
   * show in place (PRIM-16), so it is not said twice.
   */
  const save = async (input: SetUnitFeeExemptionInput, done: string, inDialog = false): Promise<boolean> => {
    if (!token || inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      await setUnitFeeExemption(tenant, token, unit.unitId, input);
      toast.success(done);
      setMode('view');
      await invalidateFeeExemptions(queryClient, tenant);
      return true;
    } catch (caught) {
      logApiError(caught);
      const message = caught instanceof ApiRequestError ? caught.message : t('failed');
      if (inDialog) throw new Error(message);
      toast.error(message);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <article className="space-y-3 rounded-lg border p-4" aria-labelledby={`${idPrefix}-title`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 id={`${idPrefix}-title`} className="text-sm font-semibold">
            <bdi dir="ltr" className="font-mono">
              {unit.reference}
            </bdi>
          </h3>
          <p className="text-xs text-muted-foreground">
            {[
              unit.unitType ? labels.unitType[unit.unitType] : null,
              unit.unitArea !== null ? tList('area', { area: unit.unitArea }) : null,
              unit.building.name,
              tList('parcel', { number: unit.building.parcelNumber }),
              role ? labels.occupancyRole[role as keyof typeof labels.occupancyRole] : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {/* The word carries the state; the colour only repeats it (COL-3). */}
        {unit.exemptToday ? (
          <Badge variant="soft-success">{tList('exemptToday')}</Badge>
        ) : ended ? (
          <Badge variant="soft-warning">{tList('endedNotLifted')}</Badge>
        ) : (
          <Badge variant="soft-muted">{tList('billed')}</Badge>
        )}
      </header>

      <p className="text-xs">
        <span className="text-muted-foreground">{tList('columns.holders')}: </span>
        {unit.holders.length > 0
          ? unit.holders.map((holder) => `${holder.name} (${labels.occupancyRole[holder.role]})`).join('، ')
          : tList('noHolders')}
      </p>

      {current && mode !== 'amend' ? (
        <SummaryList>
          <SummaryRow label={t('reason')}>{labels.feeExemptionReason[current.reason]}</SummaryRow>
          {current.note ? <SummaryRow label={t('note')}>{current.note}</SummaryRow> : null}
          {current.decisionRef ? (
            <SummaryRow label={t('decisionRef')} className="font-mono">
              {current.decisionRef}
            </SummaryRow>
          ) : null}
          <SummaryRow label={t('validUntil')} className={ended ? 'text-warning' : undefined}>
            {current.validUntil
              ? ended
                ? t('ended', { date: formatDay(current.validUntil) })
                : formatDay(current.validUntil)
              : t('noEnd')}
          </SummaryRow>
          <SummaryRow label={tList('columns.granted')}>
            {tList('grantedOn', { date: formatDate(current.grantedAt), name: current.grantedBy?.name ?? t('unknownGrantor') })}
          </SummaryRow>
        </SummaryList>
      ) : null}

      {mode === 'grant' || mode === 'amend' ? (
        <FeeExemptionForm
          idPrefix={idPrefix}
          locale={locale}
          busy={busy}
          occupied={occupied}
          initial={mode === 'amend' && current ? draftOf(current) : undefined}
          submitLabel={mode === 'amend' ? t('save') : t('grant')}
          onSubmit={(input) => void save(input, mode === 'amend' ? t('amended') : t('granted'))}
          onCancel={() => setMode('view')}
        />
      ) : canGrant && token ? (
        <div className="flex flex-wrap gap-2">
          {current ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('amend')}>
                <PencilLine className="size-4" aria-hidden />
                {t('amend')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setLifting(true)}>
                <Ban className="size-4" aria-hidden />
                {t('lift')}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => setMode('grant')}>
              <ShieldCheck className="size-4" aria-hidden />
              {t('grant')}
            </Button>
          )}
        </div>
      ) : null}

      {past.length > 0 ? (
        <section className="space-y-1.5" aria-labelledby={`${idPrefix}-history`}>
          <h4 id={`${idPrefix}-history`} className="text-xs font-semibold">
            {t('history')}
          </h4>
          <ul className="space-y-1.5 text-xs">
            {past.map((period) => (
              <li key={period.id} className="rounded-md bg-muted/40 p-2">
                <p className="font-medium">
                  {labels.feeExemptionReason[period.reason]}
                  {period.decisionRef ? ` · ${t('decision', { ref: period.decisionRef })}` : ''}
                </p>
                <p className="text-muted-foreground">
                  {t('historyLifted', {
                    from: formatDate(period.grantedAt),
                    to: formatDate(period.liftedAt!),
                    name: period.liftedBy?.name ?? t('unknownGrantor'),
                  })}
                </p>
                {period.liftReason ? <p>{t('historyLiftReason', { reason: period.liftReason })}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canGrant && current ? (
        <LiftFeeExemptionDialog
          open={lifting}
          onOpenChange={setLifting}
          idPrefix={idPrefix}
          unitCode={unit.reference}
          onConfirm={async (liftReason) => {
            if (await save({ reason: null, liftReason }, t('lifted'), true)) setLifting(false);
          }}
        />
      ) : null}
    </article>
  );
}
